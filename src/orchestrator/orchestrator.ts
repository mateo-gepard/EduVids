// ═══════════════════════════════════════════════════════════════════════════
// EduVid AI — Advanced Orchestrator v3
// Stable pipeline with per-scene error isolation, smart quality gating,
// and optimized token usage
// ═══════════════════════════════════════════════════════════════════════════

import { v4 as uuid } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import { Semaphore } from '../core/semaphore.js';
import { config } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { analyzeContent } from '../core/reasoning.js';
import { parseInput } from './inputParser.js';
import { planStoryboard } from './storyboardPlanner.js';
import { directTeaching } from './teacherDirector.js';
import { assembleTimeline } from './timelineAssembler.js';
import { scoreOutput, scoreCoherence } from './qualityScorer.js';
import { buildFinalVideo } from '../services/ffmpeg.js';
import { getAgent } from '../agents/registry.js';
import type {
  Project,
  ProjectInput,
  ProgressEvent,
  SubAgentInput,
  SubAgentOutput,
  SceneSpec,
} from '../core/types.js';

const log = createLogger({ module: 'orchestrator' });

export type ProgressCallback = (event: ProgressEvent) => void;

const MAX_SCENE_RETRIES = 2;
const CONCURRENCY_LIMIT = 4;

// Scenes shorter than this skip quality-gate scoring (not worth the tokens)
const QUALITY_GATE_MIN_DURATION = 15;

// Videos with this many scenes or fewer skip coherence scoring
const COHERENCE_MIN_SCENES = 3;

// ── Types ────────────────────────────────────────────────────────────────────

interface SceneResult {
  output: SubAgentOutput;
  qualityScore: number;
  retries: number;
  failed: boolean;
}

// ── Main Orchestrator ────────────────────────────────────────────────────────

/**
 * Advanced orchestrator v3 — stable pipeline with error isolation.
 *
 * Pipeline:
 * 1. Parse input → ContentBlocks
 * 2. Deep content analysis (CoT reasoning)
 * 3. Multi-pass storyboard planning (plan → critique → revise)
 * 4. Parallel scene dispatch with error isolation + quality gates
 * 5. Coherence pass (skipped for short videos)
 * 6. Timeline assembly + final video build (graceful scene skipping)
 *
 * Key stability guarantees:
 * - One failed scene never kills the entire video
 * - LLM failures are retried with backoff
 * - FFmpeg operations have timeout protection
 * - Timeline assembly validates all files before assembly
 */
export async function orchestrate(
  input: ProjectInput,
  onProgress?: ProgressCallback,
  projectId: string = uuid()
): Promise<Project> {
  const workDir = path.join(config.tmpDir, projectId);
  await fs.mkdir(workDir, { recursive: true });
  await fs.mkdir(config.outputDir, { recursive: true });

  const project: Project = {
    id: projectId,
    status: 'input-received',
    input,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const emit = (status: Project['status'], message: string, progress: number, currentScene?: string) => {
    project.status = status;
    project.updatedAt = new Date().toISOString();
    onProgress?.({ projectId, status, message, progress, currentScene });
  };

  try {
    // ═════════════════════════════════════════════════════════════════════
    // Step 1: Parse Input
    // ═════════════════════════════════════════════════════════════════════
    emit('parsing', 'Analysiere Eingabe...', 3);
    log.info({ projectId }, 'Step 1: Parsing input');
    const contentBlocks = await parseInput(input);
    project.contentBlocks = contentBlocks;

    if (!contentBlocks || contentBlocks.length === 0) {
      throw new Error('Input parsing produced no content blocks');
    }
    log.info({ blocks: contentBlocks.length }, 'Input parsed');

    // ═════════════════════════════════════════════════════════════════════
    // Step 2: Deep Content Analysis
    // ═════════════════════════════════════════════════════════════════════
    emit('parsing', 'Tiefenanalyse des Inhalts...', 8);
    log.info({ projectId }, 'Step 2: Content analysis');
    const contentText = contentBlocks.map(b => b.content).join('\n\n');

    let analysis;
    try {
      analysis = await analyzeContent(
        contentText,
        input.params.difficulty,
        input.params.language
      );
      log.info(
        {
          themes: analysis.themes.length,
          concepts: analysis.keyConcepts.length,
          complexity: analysis.complexity,
        },
        'Content analysis complete'
      );
    } catch (error) {
      // Content analysis is informational — don't fail the pipeline
      log.warn(
        { error: (error as Error).message },
        'Content analysis failed (non-critical), continuing'
      );
    }

    // ═════════════════════════════════════════════════════════════════════
    // Step 3: Multi-Pass Storyboard Planning
    // ═════════════════════════════════════════════════════════════════════
    emit('planning', 'Erstelle Storyboard (Plan-Critique-Revise)...', 15);
    log.info({ projectId }, 'Step 3: Multi-pass storyboard planning');
    const storyboard = await planStoryboard(contentBlocks, input.params, projectId);
    project.storyboard = storyboard;

    if (!storyboard.scenes || storyboard.scenes.length === 0) {
      throw new Error('Storyboard planning produced zero scenes');
    }
    log.info({ scenes: storyboard.scenes.length, arc: storyboard.narrativeArc }, 'Storyboard finalized');

    // ═════════════════════════════════════════════════════════════════════
    // Step 3.5: Teacher Director — Unified Lesson Narration
    // ═════════════════════════════════════════════════════════════════════
    emit('planning', 'Erstelle einheitliches Unterrichtskonzept...', 18);
    log.info({ projectId }, 'Step 3.5: Teacher Director — writing unified lesson scripts');
    let directedStoryboard = storyboard;
    try {
      directedStoryboard = await directTeaching(storyboard, contentBlocks, input.params);
      project.storyboard = directedStoryboard;
      log.info(
        { budgets: directedStoryboard.scenes.map(s => `${s.type}:${s.timeBudget}s`) },
        'Teacher Director applied — unified scripts assigned'
      );
    } catch (error) {
      log.warn(
        { error: (error as Error).message },
        'Teacher Director failed (non-critical) — scenes will generate their own scripts'
      );
    }

    // ═════════════════════════════════════════════════════════════════════
    // Step 4: Parallel Scene Dispatch with Error Isolation
    // ═════════════════════════════════════════════════════════════════════
    emit('rendering', 'Rendere Szenen parallel...', 20);
    log.info({ projectId, scenes: directedStoryboard.scenes.length }, 'Step 4: Dispatching scenes');

    const sceneResults = await dispatchScenesWithQuality(
      directedStoryboard.scenes,
      projectId,
      workDir,
      input,
      emit
    );

    // Filter out completely failed scenes (those with no valid output)
    const validResults = sceneResults.filter(r => r.output.durationSeconds > 0);
    const failedCount = sceneResults.length - validResults.length;

    if (validResults.length === 0) {
      throw new Error(`All ${sceneResults.length} scenes failed — cannot build video`);
    }

    if (failedCount > 0) {
      log.warn(
        { failed: failedCount, valid: validResults.length },
        'Some scenes failed — building video with available scenes'
      );
    }

    const outputs = validResults.map(r => r.output);
    project.agentOutputs = outputs;
    log.info(
      { outputs: outputs.length, avgQuality: avg(validResults.map(r => r.qualityScore)) },
      'Scene rendering complete'
    );

    // ── Per-Scene Content Dump (for review) ──
    console.log('\n' + '═'.repeat(80));
    console.log('  📋 SCENE CONTENT DUMP — Review what the AI generated');
    console.log('═'.repeat(80));
    for (const output of outputs) {
      const scene = directedStoryboard.scenes.find(s => s.id === output.sceneId);
      const scriptPreview = output.script.length > 120
        ? output.script.slice(0, 117) + '...'
        : output.script;
      console.log(`\n  ┌─ [${output.sceneType.toUpperCase()}] ${scene?.title || output.sceneId}`);
      console.log(`  │  Duration: ${output.durationSeconds.toFixed(1)}s`);
      console.log(`  │  Script: "${scriptPreview}"`);
      if (output.segments && output.segments.length > 0) {
        console.log(`  │  Segments (${output.segments.length}):`);
        for (const seg of output.segments) {
          const segText = seg.text.length > 60 ? seg.text.slice(0, 57) + '...' : seg.text;
          console.log(`  │    ${seg.estimatedStart.toFixed(1)}s–${seg.estimatedEnd.toFixed(1)}s  [${seg.visualCue}]  "${segText}"`);
        }
      }
      console.log(`  └${'─'.repeat(76)}`);
    }
    console.log('═'.repeat(80) + '\n');

    // ═════════════════════════════════════════════════════════════════════
    // Step 5: Coherence Pass (conditional)
    // ═════════════════════════════════════════════════════════════════════
    if (validResults.length > COHERENCE_MIN_SCENES) {
      emit('compositing', 'Prüfe Kohärenz und Übergänge...', 82);
      log.info({ projectId }, 'Step 5: Coherence pass');

      try {
        const coherence = await scoreCoherence(
          outputs.map((o, i) => ({
            type: o.sceneType,
            title: directedStoryboard.scenes.find(s => s.id === o.sceneId)?.title || `Scene ${i + 1}`,
            script: o.script,
          }))
        );
        log.info(
          { coherenceScore: coherence.score, issues: coherence.issues.length },
          'Coherence reviewed'
        );
      } catch (error) {
        // Coherence scoring is non-critical — log and move on
        log.warn(
          { error: (error as Error).message },
          'Coherence scoring failed (non-critical), continuing'
        );
      }
    } else {
      log.info(
        { sceneCount: validResults.length },
        'Step 5: Skipping coherence pass (too few scenes)'
      );
    }

    // ═════════════════════════════════════════════════════════════════════
    // Step 6: Assemble Timeline + Build Video
    // ═════════════════════════════════════════════════════════════════════
    emit('compositing', 'Erstelle finales Video...', 88);
    log.info({ projectId }, 'Step 6: Assembling timeline');
    const timeline = await assembleTimeline(directedStoryboard, outputs);
    project.timeline = timeline;

    emit('compositing', 'FFmpeg-Rendering...', 92);
    log.info({ projectId }, 'Step 6: Building final video');
    const outputPath = await buildFinalVideo(timeline);
    project.outputPath = outputPath;

    // buildFinalVideo already validates internally — skip redundant call
    emit('compositing', 'Finalisiere Video...', 96);

    // ═════════════════════════════════════════════════════════════════════
    // Cleanup temp work directory
    // ═════════════════════════════════════════════════════════════════════
    try {
      await fs.rm(workDir, { recursive: true, force: true });
      log.info({ workDir }, 'Temp directory cleaned up');
    } catch (cleanupErr) {
      log.warn({ error: (cleanupErr as Error).message }, 'Temp cleanup failed (non-critical)');
    }

    // ═════════════════════════════════════════════════════════════════════
    // Done
    // ═════════════════════════════════════════════════════════════════════
    emit('done', 'Video fertig!', 100);
    log.info({ projectId, outputPath, validScenes: validResults.length, failedScenes: failedCount }, 'Pipeline complete');

    return project;
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    log.error({ projectId, error: errMsg }, 'Pipeline failed');
    emit('error', `Fehler: ${errMsg}`, -1);
    project.error = errMsg;
    throw error;
  }
}

// ── Parallel Scene Dispatch ──────────────────────────────────────────────────

/**
 * Dispatch scenes with bounded parallelism and quality-gate retries.
 * Uses a semaphore-based work-stealing pool — all scenes launch immediately
 * and compete for CONCURRENCY_LIMIT slots, so fast scenes never idle waiting
 * for slow ones in the same batch.
 */
async function dispatchScenesWithQuality(
  scenes: SceneSpec[],
  projectId: string,
  workDir: string,
  input: ProjectInput,
  emit: (status: Project['status'], msg: string, progress: number, scene?: string) => void
): Promise<SceneResult[]> {
  const totalScenes = scenes.length;
  const results: SceneResult[] = new Array(totalScenes);
  const sem = new Semaphore(CONCURRENCY_LIMIT);

  const scenePromises = scenes.map(async (scene, globalIdx) => {
    await sem.acquire();
    try {
      const progress = 20 + Math.round((globalIdx / totalScenes) * 60);
      const sceneName = `${scene.type}: ${scene.title}`;
      emit('rendering', `Szene ${globalIdx + 1}/${totalScenes}: ${sceneName}`, progress, sceneName);

      const result = await executeSceneWithRetry(scene, projectId, workDir, input, globalIdx);
      results[globalIdx] = result;
    } finally {
      sem.release();
    }
  });

  await Promise.all(scenePromises);

  return results;
}

/**
 * Execute a single scene with error isolation and conditional quality gating.
 * Short scenes (< 15s) skip quality scoring to save tokens.
 */
async function executeSceneWithRetry(
  scene: SceneSpec,
  projectId: string,
  workDir: string,
  input: ProjectInput,
  sceneIndex: number
): Promise<SceneResult> {
  let bestOutput: SubAgentOutput | null = null;
  let bestScore = 0;
  let retries = 0;
  let wasFailed = false;

  // Short scenes skip quality gate (not worth the tokens)
  const skipQualityGate = scene.timeBudget < QUALITY_GATE_MIN_DURATION;

  for (let attempt = 0; attempt <= MAX_SCENE_RETRIES; attempt++) {
    const attemptSuffix = attempt > 0 ? `_retry${attempt}` : '';
    const sceneWorkDir = path.join(workDir, `${scene.id}${attemptSuffix}`);
    await fs.mkdir(sceneWorkDir, { recursive: true });

    const agentInput: SubAgentInput = {
      sceneSpec: scene,
      projectId,
      workDir: sceneWorkDir,
      language: input.params.language,
      voiceId: input.params.voiceId,
      difficulty: input.params.difficulty,
    };

    log.info(
      { sceneId: scene.id, type: scene.type, attempt: attempt + 1, skipQuality: skipQualityGate },
      `Executing scene ${sceneIndex + 1}`
    );

    // Use executeSafe() for error isolation
    const agent = getAgent(scene.type);
    const { output, failed } = await agent.executeSafe(agentInput);
    wasFailed = failed;

    if (failed) {
      // Agent crashed — use fallback, no point retrying quality scoring
      log.warn({ sceneId: scene.id, attempt: attempt + 1 }, 'Scene agent failed, using fallback');
      bestOutput = output;
      bestScore = 0;
      retries = attempt + 1;
      break; // Don't retry a crash — the same agent will likely crash again
    }

    // Skip quality gate for short scenes
    if (skipQualityGate) {
      bestOutput = output;
      bestScore = 7; // Assume acceptable
      break;
    }

    // Quality scoring (with try/catch so scoring failure doesn't kill the scene)
    let qualityScore = 7; // Default assumption
    try {
      const quality = await scoreOutput(output, scene);
      qualityScore = quality.aggregate;

      log.info(
        {
          sceneId: scene.id,
          attempt: attempt + 1,
          score: quality.aggregate,
          passes: quality.passesThreshold,
        },
        'Scene quality assessed'
      );

      if (quality.aggregate > bestScore) {
        bestScore = quality.aggregate;
        bestOutput = output;
      }

      if (quality.passesThreshold) {
        break;
      }

      retries = attempt + 1;
      log.warn(
        { sceneId: scene.id, score: quality.aggregate, issues: quality.issues },
        'Scene below quality threshold, retrying'
      );
    } catch (error) {
      // Quality scoring failed — accept the output as-is
      log.warn(
        { sceneId: scene.id, error: (error as Error).message },
        'Quality scoring failed — accepting output as-is'
      );
      bestOutput = output;
      bestScore = qualityScore;
      break;
    }
  }

  return {
    output: bestOutput!,
    qualityScore: bestScore,
    retries,
    failed: wasFailed,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return Math.round((nums.reduce((s, n) => s + n, 0) / nums.length) * 100) / 100;
}
