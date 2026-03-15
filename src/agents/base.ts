// ═══════════════════════════════════════════════════════════════════════════
// EduVid AI — Base Agent v2
// Enhanced base class with Canvas rendering, animation, and error isolation
// ═══════════════════════════════════════════════════════════════════════════

import path from 'path';
import fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getFfmpegPath } from '../core/ffmpegPath.js';

const execFileAsync = promisify(execFile);
import { createLogger } from '../core/logger.js';
import { generateText, generateJSON } from '../services/llm.js';
import { textToSpeech } from '../services/tts.js';
import { searchImages, downloadImage, generatePlaceholderImage } from '../services/imageSearch.js';
import { renderAndEncodeStream } from '../rendering/streamEncoder.js';
import { probeAudioDuration } from '../services/videoValidator.js';
import { AnimationTimeline, buildSegmentTimeline, type AnimatedProperties, secondsToFrames, frameToTime } from '../rendering/animations.js';
import { fontString, FPS } from '../rendering/designSystem.js';
import { segmentNarration, getActiveSegment } from '../rendering/narrationSegmenter.js';
import { buildSttSyncedSegments, type CueKeyword, type SttSyncResult } from '../rendering/sttSync.js';
import type { RenderContext } from '../rendering/renderer.js';
import type { SubAgentInput, SubAgentOutput, SceneType, AudioResult, ImageResult, NarrationSegment } from '../core/types.js';

// Default agent execution timeout (10 minutes to allow local rendering)
const AGENT_TIMEOUT_MS = 600_000;

/**
 * Abstract base class for all sub-agents v2.
 * Provides rendering, animation, TTS, LLM helpers, and error isolation.
 */
export abstract class BaseAgent {
  abstract readonly type: SceneType;

  protected log = createLogger({ agent: this.constructor.name });

  /** Main execution — must be implemented by each sub-agent */
  abstract execute(input: SubAgentInput): Promise<SubAgentOutput>;

  // ── Safe Execution (Error Isolation) ──────────────────────────────────

  /**
   * Execute with error isolation and timeout protection.
   * On failure, returns a minimal fallback output (black frame + silence)
   * so the pipeline can continue without this scene.
   */
  async executeSafe(input: SubAgentInput): Promise<{ output: SubAgentOutput; failed: boolean }> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`Agent timeout after ${AGENT_TIMEOUT_MS}ms for scene ${input.sceneSpec.id}`)),
          AGENT_TIMEOUT_MS
        );
      });
      const output = await Promise.race([
        this.execute(input),
        timeoutPromise,
      ]);
      return { output, failed: false };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.log.error(
        { sceneId: input.sceneSpec.id, sceneType: input.sceneSpec.type, error: errMsg },
        'Agent execution failed — generating fallback output'
      );

      try {
        const fallback = await this.createFallbackOutput(input);
        return { output: fallback, failed: true };
      } catch (fallbackError) {
        this.log.error(
          { error: (fallbackError as Error).message },
          'Even fallback output generation failed'
        );
        // Return absolute minimal output
        return {
          output: {
            sceneId: input.sceneSpec.id,
            sceneType: input.sceneSpec.type,
            audio: { filePath: '', durationSeconds: 0 },
            visuals: [],
            script: '',
            durationSeconds: 0,
          },
          failed: true,
        };
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  /**
   * Create a minimal fallback output — a short black clip with silence placeholder.
   */
  private async createFallbackOutput(input: SubAgentInput): Promise<SubAgentOutput> {
    await fs.mkdir(input.workDir, { recursive: true });


    // Create a minimal silent audio placeholder via FFmpeg
    const audioPath = path.join(input.workDir, 'fallback_audio.mp3');
    try {
      const t = Math.min(5, input.sceneSpec.timeBudget);
      await execFileAsync(getFfmpegPath(), [
        '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
        '-t', String(t), '-y', audioPath,
      ]);
    } catch (e) {
      // Very crude fallback if ffmpeg fails
      await fs.writeFile(audioPath, Buffer.alloc(1024));
    }

    return {
      sceneId: input.sceneSpec.id,
      sceneType: input.sceneSpec.type,
      audio: { filePath: audioPath, durationSeconds: Math.min(5, input.sceneSpec.timeBudget) },
      visuals: [],
      script: `[Scene failed: ${input.sceneSpec.title}]`,
      durationSeconds: Math.min(5, input.sceneSpec.timeBudget),
    };
  }

  // ── Plan Validation ───────────────────────────────────────────────────

  /**
   * Validate that an LLM-generated plan has all required fields.
   * Throws a descriptive error if validation fails.
   */
  protected validatePlan<T extends Record<string, unknown>>(
    plan: T,
    requiredFields: string[],
    planName: string
  ): void {
    const missing = requiredFields.filter(
      (field) => plan[field] === undefined || plan[field] === null || plan[field] === ''
    );
    if (missing.length > 0) {
      throw new Error(
        `${planName} is missing required fields: ${missing.join(', ')}. ` +
        `Got keys: ${Object.keys(plan).join(', ')}`
      );
    }
  }

  // ── Script Generation ────────────────────────────────────────────────────

  /** Generate a narration script via LLM */
  protected async generateScript(
    content: string,
    language: string,
    style?: string,
    maxWords?: number
  ): Promise<string> {
    const isGerman = language === 'de';
    const defaultStyle = isGerman ? 'informativ und klar' : 'informative and clear';
    const actualStyle = style ?? defaultStyle;

    const wordLimit = maxWords
      ? (isGerman ? `Maximal ${maxWords} Wörter.` : `Maximum ${maxWords} words.`)
      : '';

    const prompt = isGerman
      ? `Schreibe ein Narrationsskript für ein Erklärvideo.

Inhalt: ${content}
Stil: ${actualStyle}
${wordLimit}

Schreibe NUR den Sprechtext, keine Regieanweisungen, keine Formatierung.
Der Text wird direkt von einer KI-Stimme vorgelesen.
WICHTIG: Der Text muss JEDEN visuellen Inhalt abdecken — jeder Punkt, jeder Schritt, jede Option muss erwähnt werden.`
      : `Write a narration script for an educational explainer video.

Content: ${content}
Style: ${actualStyle}
${wordLimit}

Write ONLY the spoken narration text. No stage directions, no formatting.
The text will be read aloud by an AI voice.
IMPORTANT: The script must cover EVERY visual element — every point, every step, every option must be mentioned verbally.`;

    const systemPrompt = isGerman
      ? 'Du bist ein professioneller Drehbuchautor für Erklärvideos.'
      : 'You are a professional scriptwriter for educational explainer videos.';

    const script = await generateText(prompt, {
      systemPrompt,
      temperature: 0.6,
    });

    // Validate we got something usable
    if (!script || script.trim().length < 10) {
      throw new Error(`Script generation returned empty or too-short script: "${script?.slice(0, 50)}"`);
    }

    return script.trim();
  }

  /** Generate structured JSON from LLM */
  protected async generatePlanJSON<T>(
    prompt: string,
    systemPrompt?: string,
    temperature: number = 0.5
  ): Promise<T> {
    const defaultPrompt = 'You are an expert in educational video creation.';
    return generateJSON<T>(prompt, { systemPrompt: systemPrompt ?? defaultPrompt, temperature });
  }

  // ── Directed Script Helpers ───────────────────────────────────────────

  /**
   * Return the Teacher Director's pre-written script for this scene, if any.
   */
  protected getDirectedScript(input: SubAgentInput): string | undefined {
    return input.sceneSpec.directedScript;
  }

  /**
   * Append directed-script instructions to an LLM plan prompt.
   * Tells the LLM to use the given script verbatim for the "script" field
   * and to design visual elements to match that narration.
   */
  protected withDirectedScript(prompt: string, directedScript: string, isGerman: boolean): string {
    const instruction = isGerman
      ? `\n\n## WICHTIG — Vorgegebenes Narrationsskript:
Verwende EXAKT diesen Text als "script" Feld. Ändere ihn NICHT.
Gestalte alle visuellen Elemente so, dass sie zu diesem Sprechtext passen.

Vorgegebenes Skript:
"""
${directedScript}
"""`
      : `\n\n## IMPORTANT — Pre-written Narration Script:
Use EXACTLY this text as the "script" field. Do NOT modify it.
Design all visual elements to match this narration.

Pre-written script:
"""
${directedScript}
"""`;
    return prompt + instruction;
  }

  // ── TTS ──────────────────────────────────────────────────────────────────

  protected async synthesizeSpeech(
    text: string,
    outputDir: string,
    filename: string,
    voiceId?: string
  ): Promise<AudioResult> {
    return textToSpeech(text, outputDir, filename, { voiceId });
  }

  // ── Image Search ─────────────────────────────────────────────────────────

  protected async searchAndDownloadImage(
    query: string,
    outputDir: string,
    filename: string,
    count: number = 3
  ): Promise<{ results: ImageResult[]; localPath: string | null }> {
    try {
      const results = await searchImages(query, count);
      if (results.length === 0) {
        // No API configured or no results — generate a canvas placeholder
        const placeholderPath = await generatePlaceholderImage(query, outputDir, filename);
        return { results: [], localPath: placeholderPath };
      }
      const localPath = await downloadImage(results[0].url, outputDir, filename);
      return { results, localPath };
    } catch (error) {
      this.log.warn(
        { query, error: (error as Error).message },
        'Image search/download failed, generating placeholder'
      );
      try {
        const placeholderPath = await generatePlaceholderImage(query, outputDir, filename);
        return { results: [], localPath: placeholderPath };
      } catch {
        return { results: [], localPath: null };
      }
    }
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  /**
   * Render frames for this scene and encode directly to MP4 via FFmpeg stdin.
   * No temp PNG files are written to disk — frames are piped directly.
   */
  protected async renderScene(
    sceneType: string,
    durationSeconds: number,
    workDir: string,
    audioPath: string,
    renderFn: import('../rendering/renderer.js').FrameRenderFn,
    timeline?: AnimationTimeline,
    filename: string = 'scene_final.mp4'
  ): Promise<string> {
    // Guard against bad durations
    if (!durationSeconds || durationSeconds <= 0 || !isFinite(durationSeconds)) {
      this.log.warn({ durationSeconds }, 'Invalid duration, defaulting to 5s');
      durationSeconds = 5;
    }
    if (durationSeconds > 300) {
      this.log.warn({ durationSeconds }, 'Duration exceeds 5 minutes, capping');
      durationSeconds = 300;
    }

    // Re-verify actual audio duration via FFprobe to prevent audio-video desync
    const actualAudioDuration = await probeAudioDuration(audioPath);
    if (actualAudioDuration && Math.abs(actualAudioDuration - durationSeconds) > 0.5) {
      this.log.info(
        { claimed: durationSeconds, actual: actualAudioDuration },
        'Audio duration differs from claimed — using actual FFprobe duration'
      );
      durationSeconds = actualAudioDuration;
    }

    this.log.info({ sceneType, durationSeconds }, 'Rendering + encoding scene (streaming, no disk I/O)');

    await fs.mkdir(workDir, { recursive: true });
    const outputPath = path.join(workDir, filename);

    await renderAndEncodeStream(
      sceneType,
      durationSeconds,
      outputPath,
      renderFn,
      timeline ? (time) => timeline.getValues(time) : undefined,
      audioPath,
      { fadeInDuration: 0.3, fadeOutDuration: 0.3 }
    );

    return outputPath;
  }

  // ── Narration Segmentation ──────────────────────────────────────────────

  /**
   * Segment a narration script into timed visual beats.
   * Each segment carries a visualCue that drives the animation timeline.
   * @deprecated Use segmentScriptWithSTT for real audio-synced timing.
   */
  protected async segmentScript(
    script: string,
    durationSeconds: number,
    sceneType: SceneType,
    language: string = 'en'
  ): Promise<NarrationSegment[]> {
    return segmentNarration(script, durationSeconds, sceneType, language);
  }

  /**
   * STT-based segmentation: transcribe the TTS audio with Whisper
   * to get word-level timestamps, then match visual cue keywords
   * to real spoken-word times. Falls back to proportional timing on failure.
   */
  protected async segmentScriptWithSTT(
    script: string,
    audioPath: string,
    durationSeconds: number,
    cueKeywords: CueKeyword[],
  ): Promise<SttSyncResult> {
    return buildSttSyncedSegments(audioPath, script, durationSeconds, cueKeywords);
  }

  /**
   * Build an AnimationTimeline from narration segments.
   * Maps each segment's visualCue to animation keyframes.
   */
  protected buildTimelineFromSegments(
    segments: NarrationSegment[],
    totalDuration: number
  ): AnimationTimeline {
    return buildSegmentTimeline(segments, totalDuration);
  }

  /**
   * Get which segment is active at a given time, plus progress within it.
   */
  protected getSegmentAt(
    segments: NarrationSegment[],
    time: number
  ): { index: number; progress: number } {
    return getActiveSegment(segments, time);
  }

  // ── Utility ──────────────────────────────────────────────────────────────

  /**
   * Estimate word count for a given duration in seconds.
   * Default 120 WPM accounts for TTS providers that speak at ~160-190 WPM,
   * providing a buffer so generated scripts are long enough.
   */
  protected estimateWordCount(durationSeconds: number, wordsPerMinute: number = 130): number {
    return Math.max(20, Math.round((durationSeconds / 60) * wordsPerMinute));
  }

  /**
   * Synthesize speech with duration-aware retry.
   * If TTS audio is >20% shorter than the budget, regenerate a longer script and re-synthesize once.
   */
  protected async synthesizeSpeechForBudget(
    script: string,
    budgetSeconds: number,
    workDir: string,
    filename: string,
    regenerateScript: (targetWords: number) => Promise<string>,
    voiceId?: string,
  ): Promise<{ audio: AudioResult; script: string }> {
    let currentScript = script;
    let currentAudio = await this.synthesizeSpeech(currentScript, workDir, filename, voiceId);

    // Retry up to 2 times if audio is >30% too short (allow breathing room)
    for (let retry = 0; retry < 2; retry++) {
      const shortfall = (budgetSeconds - currentAudio.durationSeconds) / budgetSeconds;
      if (shortfall <= 0.30 || budgetSeconds <= 8) break;

      const actualWPM = currentScript.split(/\s+/).length / (currentAudio.durationSeconds / 60);
      const neededWords = Math.ceil((budgetSeconds / 60) * actualWPM * 1.08);
      this.log.info(
        { budgetSeconds, actualSeconds: currentAudio.durationSeconds, shortfall: `${Math.round(shortfall * 100)}%`, neededWords, retry: retry + 1 },
        'Audio too short — regenerating longer script'
      );

      try {
        currentScript = await regenerateScript(neededWords);
        currentAudio = await this.synthesizeSpeech(currentScript, workDir, `${filename}_v${retry + 2}`, voiceId);
      } catch (err) {
        this.log.warn({ error: (err as Error).message }, 'Script regeneration failed, keeping previous');
        break;
      }
    }

    return { audio: currentAudio, script: currentScript };
  }
}
