// ═══════════════════════════════════════════════════════════════════════════
// EduVid AI — Narration Segmenter
// Splits narration scripts into timed segments with visual cue directives.
// This is the bridge between "what's being said" and "what's being shown."
// ═══════════════════════════════════════════════════════════════════════════

import { generateJSON } from '../services/llm.js';
import { createLogger } from '../core/logger.js';
import type { SceneType, NarrationSegment } from '../core/types.js';
import { z } from 'zod';

const log = createLogger({ module: 'narration-segmenter' });

// ── Visual Cue Taxonomies ────────────────────────────────────────────────────
// ── Schema ───────────────────────────────────────────────────────────────────

const NarrationSegmentsSchema = z.object({
  segments: z.array(z.object({
    text: z.string(),
    estimatedStart: z.number().nonnegative(),
    estimatedEnd: z.number().positive(),
    visualCue: z.string(),
  })).min(1),
});

// Each scene type has a defined set of cues the LLM can use.
// Agents map these cues to specific animation patterns.

const CUE_TAXONOMIES: Record<string, string> = {
  'intro': `
    - "title_appear": Title text fades in
    - "subtitle_reveal": Subtitle/preview sentence appears
    - "badge_show": Topic badge appears
    - "fade_out": Scene fades to transition`,

  'outro': `
    - "summary_title": Summary heading appears
    - "bullet:N": Nth bullet point slides in (N=0,1,2...)
    - "closing_message": Final closing callout appears
    - "fade_out": Scene fades to transition`,

  'step-by-step': `
    - "show_title": Title of the step guide appears
    - "reveal_step:N": Step N becomes the active/highlighted step (N=0,1,2...)
    - "complete_step:N": Step N gets a checkmark, next step activates
    - "fade_out": Scene fades to transition`,

  'formel': `
    - "show_title": Title appears
    - "show_formula": The main formula card scales in
    - "explain_meaning": The explanation callout appears
    - "derivation_step:N": Derivation step N appears (N=0,1,2...)
    - "fade_out": Scene fades to transition`,

  'funfact': `
    - "tease_fact": Build-up/intro text, emoji appears
    - "show_header": The "Did you know?" header appears
    - "reveal_fact": The fact card scales in with the actual fact
    - "fade_out": Scene fades to transition`,

  'zitat': `
    - "introduce": Opening quotation marks/setup
    - "quote_reveal": Quote text reveals word by word
    - "show_author": Author name and context slide in
    - "fade_out": Scene fades to transition`,

  'quiz': `
    - "read_question": Question text appears on screen
    - "show_options": Option cards stagger in
    - "countdown": Countdown timer (3...2...1)
    - "reveal_answer": Correct answer highlighted
    - "explain": Explanation callout appears
    - "fade_out": Scene fades to transition`,

  'zusammenfassung': `
    - "summary_title": Summary/recap heading appears
    - "bullet:N": Nth summary bullet slides in (N=0,1,2...)
    - "closing": Final takeaway callout appears
    - "fade_out": Scene fades to transition`,

  'ken-burns': `
    - "establish_scene": Background atmosphere set, era stamp appears
    - "caption:N": Caption N appears over the image (N=0,1,2...)
    - "narrate": Narration continues over the visual
    - "fade_out": Scene fades to transition`,

  'infografik': `
    - "show_title": Title appears
    - "reveal_point:N": Key point N is revealed/highlighted (N=0,1,2...)
    - "show_image": Infographic image becomes prominent
    - "narrate": General narration with lower-third
    - "fade_out": Scene fades to transition`,
};

// ── Segmentation ─────────────────────────────────────────────────────────────

/**
 * Split a narration script into semantically-timed segments with visual cues.
 * Each segment represents one "visual beat" — a moment where the screen should change.
 *
 * Falls back to even sentence splitting if LLM segmentation fails.
 */
export async function segmentNarration(
  script: string,
  durationSeconds: number,
  sceneType: SceneType,
  language: string = 'en'
): Promise<NarrationSegment[]> {
  const taxonomy = CUE_TAXONOMIES[sceneType] || CUE_TAXONOMIES['infografik'];
  const isGerman = language === 'de';

  try {
    const prompt = isGerman
      ? `Du analysierst ein Narrationsskript für ein Erklärvideo und teilst es in visuell getaktete Segmente auf.

SKRIPT (wird vorgelesen, Gesamtdauer: ${durationSeconds.toFixed(1)} Sekunden):
"${script}"

SZENENTYP: ${sceneType}

VERFÜGBARE VISUAL CUES:
${taxonomy}

Teile das Skript in 3-8 Segmente auf. Jedes Segment ist ein Abschnitt des Sprechertexts, dem ein visuelles Element zugeordnet wird.

REGELN:
- Jedes Segment enthält den EXAKTEN Textabschnitt aus dem Skript (nicht umschreiben!)
- Die Segmente müssen zusammen den gesamten Skripttext ergeben
- estimatedStart/estimatedEnd sind in Sekunden, proportional zur Wortanzahl
- Jedes Segment hat genau EINEN visualCue aus der obigen Liste
- Die Zeiten müssen lückenlos von 0 bis ${durationSeconds.toFixed(1)} reichen

Respond as JSON:
{
  "segments": [
    { "text": "...", "estimatedStart": 0, "estimatedEnd": 3.5, "visualCue": "show_title" },
    { "text": "...", "estimatedStart": 3.5, "estimatedEnd": 8.0, "visualCue": "reveal_step:0" },
    ...
  ]
}`
      : `You are analyzing a narration script for an educational explainer video and splitting it into visually-timed segments.

SCRIPT (to be read aloud, total duration: ${durationSeconds.toFixed(1)} seconds):
"${script}"

SCENE TYPE: ${sceneType}

AVAILABLE VISUAL CUES:
${taxonomy}

Split the script into 3-8 segments. Each segment is a section of the narrator's text paired with a visual element.

RULES:
- Each segment contains the EXACT text excerpt from the script (do not rewrite!)
- The segments must together cover the ENTIRE script text
- estimatedStart/estimatedEnd are in seconds, proportional to word count
- Each segment has exactly ONE visualCue from the list above
- Times must seamlessly span from 0 to ${durationSeconds.toFixed(1)}

Respond as JSON:
{
  "segments": [
    { "text": "...", "estimatedStart": 0, "estimatedEnd": 3.5, "visualCue": "show_title" },
    { "text": "...", "estimatedStart": 3.5, "estimatedEnd": 8.0, "visualCue": "reveal_step:0" },
    ...
  ]
}`;

    const systemPrompt = isGerman
      ? 'Du bist ein Experte für audiovisuelle Synchronisation in Erklärvideos. Antworte ausschließlich als JSON.'
      : 'You are an expert in audiovisual synchronization for educational videos. Respond exclusively as JSON.';

    const result = await generateJSON(prompt, {
      systemPrompt,
      temperature: 0.3,
    }, NarrationSegmentsSchema);

    if (!result.segments || result.segments.length === 0) {
      throw new Error('LLM returned empty segments array');
    }

    // Validate and normalize
    const segments: NarrationSegment[] = result.segments.map((seg, idx) => ({
      text: seg.text || '',
      estimatedStart: Math.max(0, seg.estimatedStart ?? 0),
      estimatedEnd: Math.min(durationSeconds, seg.estimatedEnd ?? durationSeconds),
      visualCue: seg.visualCue || 'narrate',
      index: idx,
    }));

    // Ensure continuous coverage: snap gaps
    for (let i = 1; i < segments.length; i++) {
      if (Math.abs(segments[i].estimatedStart - segments[i - 1].estimatedEnd) > 0.5) {
        segments[i].estimatedStart = segments[i - 1].estimatedEnd;
      }
    }
    // Ensure first starts at 0, last ends at duration
    segments[0].estimatedStart = 0;
    segments[segments.length - 1].estimatedEnd = durationSeconds;

    log.info(
      { sceneType, segmentCount: segments.length, cues: segments.map(s => s.visualCue) },
      'Narration segmented successfully'
    );

    return segments;

  } catch (err) {
    log.warn(
      { sceneType, error: (err as Error).message },
      'LLM narration segmentation failed — falling back to heuristic sentence splitting'
    );
    return fallbackSegmentation(script, durationSeconds, sceneType);
  }
}

// ── Fallback: Heuristic Sentence Splitting ───────────────────────────────────

function fallbackSegmentation(
  script: string,
  durationSeconds: number,
  sceneType: SceneType
): NarrationSegment[] {
  if (!script) {
    return [{
      text: '',
      estimatedStart: 0,
      estimatedEnd: durationSeconds,
      visualCue: 'narrate',
      index: 0,
    }];
  }

  // Split by sentence endings
  const sentences = script
    .split(/(?<=[.!?])\s+/)
    .filter(s => s.trim().length > 0);

  if (sentences.length === 0) {
    return [{
      text: script,
      estimatedStart: 0,
      estimatedEnd: durationSeconds,
      visualCue: 'narrate',
      index: 0,
    }];
  }

  // Distribute time proportional to word count
  const totalWords = sentences.reduce((sum, s) => sum + s.split(/\s+/).length, 0);
  let currentTime = 0;

  // Pick default cues based on scene type
  const defaultCues = getDefaultCues(sceneType, sentences.length);

  return sentences.map((text, idx) => {
    const wordCount = text.split(/\s+/).length;
    const segDuration = (wordCount / totalWords) * durationSeconds;
    const segment: NarrationSegment = {
      text,
      estimatedStart: currentTime,
      estimatedEnd: currentTime + segDuration,
      visualCue: defaultCues[idx] ?? 'narrate',
      index: idx,
    };
    currentTime += segDuration;
    return segment;
  });
}

/**
 * Get sensible default visual cues for even time-based fallback.
 */
function getDefaultCues(sceneType: SceneType, count: number): string[] {
  switch (sceneType) {
    case 'step-by-step':
      return ['show_title', ...Array.from({ length: count - 2 }, (_, i) => `reveal_step:${i}`), 'fade_out'];
    case 'formel':
      return ['show_title', 'show_formula', 'explain_meaning',
        ...Array.from({ length: Math.max(0, count - 4) }, (_, i) => `derivation_step:${i}`),
        'fade_out'];
    case 'quiz':
      return ['read_question', 'show_options', 'countdown', 'reveal_answer', 'explain', 'fade_out'].slice(0, count);
    case 'zusammenfassung':
      return ['summary_title', ...Array.from({ length: count - 2 }, (_, i) => `bullet:${i}`), 'closing'];
    case 'funfact':
      return ['tease_fact', 'show_header', 'reveal_fact', 'fade_out'].slice(0, count);
    case 'zitat':
      return ['introduce', 'quote_reveal', 'show_author', 'fade_out'].slice(0, count);
    case 'intro':
      return ['title_appear', 'subtitle_reveal', 'badge_show', 'fade_out'].slice(0, count);
    case 'outro':
      return ['summary_title', ...Array.from({ length: count - 2 }, (_, i) => `bullet:${i}`), 'closing_message'];
    case 'ken-burns':
      return ['establish_scene', ...Array.from({ length: count - 2 }, (_, i) => `caption:${i}`), 'fade_out'];
    case 'infografik':
      return ['show_title', ...Array.from({ length: count - 2 }, (_, i) => `reveal_point:${i}`), 'fade_out'];
    default:
      return Array.from({ length: count }, () => 'narrate');
  }
}

// ── Segment Utilities ────────────────────────────────────────────────────────

/**
 * Find which segment is active at a given time.
 * Returns the segment index and the progress within that segment (0→1).
 */
export function getActiveSegment(
  segments: NarrationSegment[],
  time: number
): { index: number; progress: number } {
  for (let i = 0; i < segments.length; i++) {
    if (time >= segments[i].estimatedStart && time < segments[i].estimatedEnd) {
      const segDuration = segments[i].estimatedEnd - segments[i].estimatedStart;
      const progress = segDuration > 0 ? (time - segments[i].estimatedStart) / segDuration : 1;
      return { index: i, progress: Math.min(1, progress) };
    }
  }
  // Past all segments — return last one at 100%
  return { index: segments.length - 1, progress: 1 };
}

/**
 * Find the segment that matches a given visual cue.
 * If the cue appears multiple times, returns the first match.
 */
export function findSegmentByCue(
  segments: NarrationSegment[],
  cue: string
): NarrationSegment | undefined {
  return segments.find(s => s.visualCue === cue);
}

/**
 * Find all segments matching a cue prefix (e.g., "bullet:" matches "bullet:0", "bullet:1", etc.)
 */
export function findSegmentsByCuePrefix(
  segments: NarrationSegment[],
  prefix: string
): NarrationSegment[] {
  return segments.filter(s => s.visualCue.startsWith(prefix));
}
