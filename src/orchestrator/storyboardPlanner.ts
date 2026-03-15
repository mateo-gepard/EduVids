// ═══════════════════════════════════════════════════════════════════════════
// EduVid AI — Advanced Storyboard Planner v2
// Multi-pass planning with self-critique and revision
// ═══════════════════════════════════════════════════════════════════════════

import { v4 as uuid } from 'uuid';
import { generateJSON } from '../services/llm.js';
import { planWithBacktracking, type CritiqueResult } from '../core/reasoning.js';
import { createLogger } from '../core/logger.js';
import type { ContentBlock, Storyboard, SceneSpec, SceneType, VideoParams } from '../core/types.js';
import { z } from 'zod';

const log = createLogger({ module: 'storyboard-planner' });

// ── Scene types available ────────────────────────────────────────────────────

const SCENE_TYPES: SceneType[] = [
  'intro', 'infografik', 'ken-burns', 'formel', 'zitat',
  'step-by-step', 'quiz', 'funfact', 'zusammenfassung', 'diagram', 'outro',
];

const QUALITY_CRITERIA = [
  'Does the storyboard cover all key content from the input without gaps?',
  'Is there good scene variety? The same type may repeat if content warrants it, but avoid long runs of identical types.',
  'Does the pacing feel natural? Complex topics (formulas, step-by-step) should get MORE time; lighter scenes (ken-burns, funfact) should be shorter.',
  'Is there a clear narrative arc: intro → build → climax → summary → outro?',
  'Do scene types match their content? (e.g., formulas for math, quotes for quotes)',
  'Is the total duration within ±10% of the target?',
  'Are the difficulty and depth appropriate for the target audience?',
  'Do time budgets vary significantly? NOT every scene the same length — range from 15s to 120s+.',
];

// ── Types ────────────────────────────────────────────────────────────────────

// ── Zod Schemas ──────────────────────────────────────────────────────────────
// Runtime validation for LLM-generated JSON — catches malformed outputs early.

const RawScenePlanSchema = z.object({
  type: z.string(), // validated further in buildStoryboard()
  title: z.string().min(1),
  content: z.string().min(1),
  timeBudget: z.number().positive(),
  visualHints: z.string().optional(),
});

const RawStoryboardSchema = z.object({
  narrativeArc: z.string(),
  scenes: z.array(RawScenePlanSchema).min(1),
  totalDuration: z.number().positive(),
});

interface RawScenePlan {
  type: string; // validated against SceneType enum in buildStoryboard()
  title: string;
  content: string;
  timeBudget: number;
  visualHints?: string;
}

interface RawStoryboard {
  narrativeArc: string;
  scenes: RawScenePlan[];
  totalDuration: number;
}

// ── Main Planner ─────────────────────────────────────────────────────────────

/**
 * Multi-pass storyboard planning with self-critique loop.
 * Plan → Critique → Revise (up to 3 iterations, target score ≥ 7).
 */
export async function planStoryboard(
  contentBlocks: ContentBlock[],
  params: VideoParams,
  projectId: string
): Promise<Storyboard> {
  // Provide enough content context — 6000 chars for proper coverage
  const fullSummary = contentBlocks
    .map(b => `[${b.type}] ${b.content.slice(0, 800)}`)
    .join('\n\n');
  const contentSummary = fullSummary.slice(0, 6000);

  const targetDuration = params.duration;

  log.info({ projectId, targetDuration, blocks: contentBlocks.length }, 'Starting multi-pass storyboard planning');

  // Use plan-with-backtracking for quality-driven iteration
  const { plan: finalPlan, iterations, finalScore } = await planWithBacktracking<RawStoryboard>(
    // Generate initial plan
    () => generateInitialPlan(contentSummary, params, targetDuration),
    // Serialize for critique
    (plan) => JSON.stringify(plan, null, 2),
    // Quality criteria
    QUALITY_CRITERIA,
    // Revision function
    (plan, critique) => revisePlan(plan, critique, contentSummary, params, targetDuration),
    { maxIterations: 3, scoreThreshold: 7 }
  );

  log.info(
    { iterations, finalScore, scenes: finalPlan.scenes.length },
    'Storyboard planning complete'
  );

  // Convert to typed Storyboard
  return buildStoryboard(finalPlan, projectId, targetDuration);
}

// ── Plan Generation ──────────────────────────────────────────────────────────

async function generateInitialPlan(
  contentSummary: string,
  params: VideoParams,
  targetDuration: number
): Promise<RawStoryboard> {
  const isGerman = params.language === 'de';

  const difficultyDesc = isGerman
    ? { overview: 'Kurze Übersicht, nur die wichtigsten Punkte.', standard: 'Ausgewogene Tiefe mit Beispielen.', deep: 'Tiefgehende Analyse und Detailerklärungen.' }[params.difficulty]
    : { overview: 'Brief overview, key points only.', standard: 'Balanced depth with examples and explanations.', deep: 'Deep analysis, complex relationships, detailed explanations.' }[params.difficulty];

  const prompt = isGerman
    ? `Du bist der Storyboard-Architekt für ein Erklärvideo.

## Eingabe-Content:
${contentSummary}

## Parameter:
- Zieldauer: ${targetDuration} Sekunden (${params.durationMinutes} Minuten)
- Schwierigkeitsgrad: ${params.difficulty} — ${difficultyDesc}
- Sprache: Deutsch

## Verfügbare Szenentypen:
${SCENE_TYPES.map(t => `- **${t}**: ${getSceneDescription(t, true)}`).join('\n')}

## Regeln:
1. IMMER mit "intro" beginnen und mit "outro" enden
2. Gleiche Szenentypen dürfen mehrfach vorkommen wenn der Inhalt es erfordert (z.B. zwei verschiedene Formeln = zwei formel-Szenen)
3. Zeitbudgets müssen in Summe = Zieldauer (±10%)
4. Mindestens eine "quiz" oder "step-by-step" Szene
5. Narrative Bogen: Einführung → Aufbau → Höhepunkt → Zusammenfassung → Abschluss
6. WICHTIG: Jede Szene bekommt GENUG Content um das Zeitbudget komplett zu füllen
7. Der content-Text für jede Szene muss ALLE Details enthalten die der Sub-Agent braucht
8. ZEITBUDGETS MÜSSEN STARK VARIIEREN: Komplexe Themen (formel, step-by-step, infografik) bekommen 60-120s, leichte Szenen (ken-burns, funfact, zitat) nur 15-30s

## Output als JSON:
{
  "narrativeArc": "...",
  "scenes": [{"type": "intro", "title": "...", "content": "Ausführlicher Content...", "timeBudget": 15, "visualHints": "..."}],
  "totalDuration": ${targetDuration}
}`
    : `You are the storyboard architect for an educational explainer video.

## Input Content:
${contentSummary}

## Parameters:
- Target duration: ${targetDuration} seconds (${params.durationMinutes} minutes)
- Difficulty: ${params.difficulty} — ${difficultyDesc}
- Language: English

## Available Scene Types:
${SCENE_TYPES.map(t => `- **${t}**: ${getSceneDescription(t, false)}`).join('\n')}

## Rules:
1. ALWAYS start with "intro" and end with "outro"
2. Same scene types MAY appear multiple times if content warrants it (e.g., two different formulas = two formel scenes)
3. Time budgets must sum to target duration (±10%)
4. At least one "quiz" or "step-by-step" scene for interactivity
5. Narrative arc: Introduction → Build-up → Climax/Details → Summary → Closing
6. "zusammenfassung" ideally before "outro"
7. IMPORTANT: Each scene gets ENOUGH content to completely fill its time budget
8. The content text for each scene must include ALL details the sub-agent needs to create a comprehensive narration
9. TIME BUDGETS MUST VARY SIGNIFICANTLY: Complex topics (formel, step-by-step, infografik) get 60-120s, lighter scenes (ken-burns, funfact, zitat) only 15-30s

## Output as JSON:
{
  "narrativeArc": "Description of the narrative arc",
  "scenes": [{"type": "intro", "title": "Scene Title", "content": "Detailed content for this scene — comprehensive enough for the sub-agent.", "timeBudget": 15, "visualHints": "Visual design hints"}],
  "totalDuration": ${targetDuration}
}`;

  const systemPrompt = isGerman
    ? 'Du bist ein erfahrener Regisseur für Bildungsvideos.'
    : 'You are an experienced director for educational videos. Think in narratives and pedagogical arcs.';

  return generateJSON<RawStoryboard>(prompt, { systemPrompt, temperature: 0.5 }, RawStoryboardSchema);
}

// ── Plan Revision ────────────────────────────────────────────────────────────

async function revisePlan(
  currentPlan: RawStoryboard,
  critique: CritiqueResult,
  contentSummary: string,
  params: VideoParams,
  targetDuration: number
): Promise<RawStoryboard> {
  const isGerman = params.language === 'de';

  const prompt = isGerman
    ? `Überarbeite diesen Storyboard-Entwurf basierend auf der Kritik.

## Aktueller Entwurf:
${JSON.stringify(currentPlan, null, 2)}

## Kritik (Score: ${critique.score}/10):
### Schwächen:
${critique.weaknesses.map(w => `- ${w}`).join('\n')}
### Vorschläge:
${critique.suggestions.map(s => `- ${s}`).join('\n')}

## Original-Content:
${contentSummary.slice(0, 2000)}

## Zieldauer: ${targetDuration}s

Behebe alle Schwächen. Respond as JSON (same format).`
    : `Revise this storyboard draft based on the critique.

## Current Draft:
${JSON.stringify(currentPlan, null, 2)}

## Critique (Score: ${critique.score}/10):
### Weaknesses:
${critique.weaknesses.map(w => `- ${w}`).join('\n')}
### Suggestions:
${critique.suggestions.map(s => `- ${s}`).join('\n')}

## Original Content:
${contentSummary.slice(0, 2000)}

## Target Duration: ${targetDuration}s

Fix all weaknesses. Keep what works. Respond as JSON (same format as before):
{ "narrativeArc": "...", "scenes": [...], "totalDuration": ${targetDuration} }`;

  const systemPrompt = isGerman
    ? 'Du überarbeitest den Storyboard-Entwurf basierend auf der Kritik.'
    : 'You are revising the storyboard draft based on critique. Be thorough.';

  return generateJSON<RawStoryboard>(prompt, { systemPrompt, temperature: 0.4 }, RawStoryboardSchema);
}

// ── Build typed Storyboard ───────────────────────────────────────────────────

function buildStoryboard(
  raw: RawStoryboard,
  projectId: string,
  targetDuration: number
): Storyboard {
  // Validate raw storyboard
  if (!raw.scenes || raw.scenes.length === 0) {
    throw new Error('Storyboard planning returned zero scenes');
  }

  // Filter out scenes with invalid types
  const validSceneTypes = new Set(SCENE_TYPES);
  const validRawScenes = raw.scenes.filter((s) => {
    if (!validSceneTypes.has(s.type as SceneType)) {
      log.warn({ type: s.type, title: s.title }, 'Removing scene with invalid type');
      return false;
    }
    if (!s.content || s.content.trim().length === 0) {
      log.warn({ type: s.type, title: s.title }, 'Removing scene with empty content');
      return false;
    }
    if (!s.timeBudget || s.timeBudget <= 0) {
      log.warn({ type: s.type, title: s.title, timeBudget: s.timeBudget }, 'Removing scene with invalid time budget');
      return false;
    }
    return true;
  });

  if (validRawScenes.length === 0) {
    throw new Error('All scenes had invalid types or empty content after validation');
  }

  // Validate and normalize time budgets
  const totalRaw = validRawScenes.reduce((sum, s) => sum + s.timeBudget, 0);
  const scaleFactor = totalRaw > 0 ? targetDuration / totalRaw : 1;

  const scenes: SceneSpec[] = validRawScenes.map((s, i) => ({
    id: uuid(),
    order: i,
    type: s.type as SceneType, // safe: validRawScenes only contains valid types
    title: s.title,
    content: s.content,
    timeBudget: Math.max(8, Math.round(s.timeBudget * scaleFactor)), // minimum 8s per scene
    visualHints: s.visualHints,
  }));

  // Post-normalization: distribute rounding drift across scenes so sum === targetDuration
  const actualSum = scenes.reduce((sum, s) => sum + s.timeBudget, 0);
  const drift = actualSum - targetDuration;
  if (drift !== 0 && scenes.length > 0) {
    // Apply drift correction to the longest scene (least perceptible change)
    const longestIdx = scenes.reduce((maxI, s, i, arr) => s.timeBudget > arr[maxI].timeBudget ? i : maxI, 0);
    scenes[longestIdx].timeBudget = Math.max(8, scenes[longestIdx].timeBudget - drift);
  }

  return {
    projectId,
    scenes,
    totalDuration: targetDuration,
    narrativeArc: raw.narrativeArc,
  };
}

// ── Scene Descriptions ───────────────────────────────────────────────────────

function getSceneDescription(type: SceneType, isGerman: boolean = false): string {
  if (isGerman) {
    const descriptions: Record<SceneType, string> = {
      'intro': 'Titelkarte + Themeneinführung (10-20s)',
      'outro': 'Abschluss, Zusammenfassung der Key Takeaways (10-20s)',
      'infografik': 'Komplexe Infografik mit schrittweiser Enthüllung von Schlüsselbegriffen (30-90s)',
      'ken-burns': 'Historisches Bild mit Zoom/Schwenk-Effekt und atmosphärischer Narration (20-60s)',
      'formel': 'Mathematische/wissenschaftliche Formel schrittweise erklärt (20-60s)',
      'zitat': 'Bedeutendes Zitat dramatisch präsentiert (10-30s)',
      'step-by-step': 'Strukturierte Schritt-für-Schritt Anleitung (30-90s)',
      'quiz': 'Interaktive Quiz-Frage mit Optionen und Erklärung (20-40s)',
      'funfact': 'Überraschender Fakt spielerisch präsentiert (10-25s)',
      'zusammenfassung': 'Kompakte Zusammenfassung der Kernpunkte (15-40s)',
      'diagram': 'Animiertes Diagramm: Flussdiagramm, Mindmap, Venn, Organigramm, Zyklus, Pyramide, Gantt, Fischgräte, Scatter/Line-Graph, Swimlane, Baumdiagramm (20-60s)',
    };
    return descriptions[type] || type;
  }
  const descriptions: Record<SceneType, string> = {
    'intro': 'Title card + topic introduction (10-20s)',
    'outro': 'Closing, key takeaway summary (10-20s)',
    'infografik': 'Complex infographic with step-by-step key point reveals (30-90s)',
    'ken-burns': 'Historical image with zoom/pan effect and atmospheric narration (20-60s)',
    'formel': 'Mathematical/scientific formula explained step by step (20-60s)',
    'zitat': 'Significant quote dramatically presented (10-30s)',
    'step-by-step': 'Structured step-by-step guide (30-90s)',
    'quiz': 'Interactive quiz question with options and explanation (20-40s)',
    'funfact': 'Surprising fact playfully presented (10-25s)',
    'zusammenfassung': 'Compact summary of key points (15-40s)',
    'diagram': 'Animated diagram: flowchart, mind map, Venn, org chart, cycle, pyramid, Gantt, fishbone, scatter/line graph, swimlane, tree diagram (20-60s)',
  };
  return descriptions[type] || type;
}
