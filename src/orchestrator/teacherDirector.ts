// ═══════════════════════════════════════════════════════════════════════════
// EduVid AI — Teacher Director
// Writes a unified lesson narration across ALL scenes in one pass.
// Agents receive pre-written scripts so the video feels like one cohesive
// lesson instead of a collage of isolated modules.
// ═══════════════════════════════════════════════════════════════════════════

import { generateJSON } from '../services/llm.js';
import { createLogger } from '../core/logger.js';
import { z } from 'zod';
import type { Storyboard, ContentBlock, VideoParams, SceneSpec } from '../core/types.js';

const log = createLogger({ module: 'teacher-director' });

// ── Zod schema for LLM output ────────────────────────────────────────────────

const DirectedSceneSchema = z.object({
  sceneIndex: z.number(),
  script: z.string().min(1),
  timeBudget: z.number().positive(),
});

const TeachingPlanSchema = z.object({
  scenes: z.array(DirectedSceneSchema).min(1),
});

interface DirectedScene {
  sceneIndex: number;
  script: string;
  timeBudget: number;
}

interface TeachingPlan {
  scenes: DirectedScene[];
}

// ── Scene-type descriptions for the prompt ───────────────────────────────────

function sceneTypeGuidance(type: string, isGerman: boolean): string {
  const de: Record<string, string> = {
    'intro': 'Einleitung: Neugier wecken, Thema vorstellen. Kurz und einladend.',
    'outro': 'Abschluss: Kernbotschaft wiederholen, motivierend abschließen. Kurz.',
    'infografik': 'Infografik: Schlüsselbegriffe einzeln erklären. Jeder Begriff wird im Sprechtext explizit genannt.',
    'ken-burns': 'Ken-Burns-Bild: Atmosphärische, bildhafte Erzählung. Kann sehr kurz sein (15-25s).',
    'formel': 'Formel-Erklärung: Schritt für Schritt durch die Formel gehen. Kann lang sein (60-120s).',
    'zitat': 'Zitat: Einleiten, zitieren, einordnen. Eher kurz (15-30s).',
    'step-by-step': 'Schritt-für-Schritt: Jeden Schritt einzeln durchgehen. Kann lang sein (40-90s).',
    'quiz': 'Quiz: Frage vorlesen, Optionen nennen, Countdown, Antwort + Erklärung. Mittel (25-40s).',
    'funfact': 'Fun Fact: Überraschenden Fakt einleiten und erklären. Kurz (15-25s).',
    'zusammenfassung': 'Zusammenfassung: Kernpunkte aufzählen :PUNKT FÜR PUNKT. Mittel (20-40s).',
    'diagram': 'Diagramm: Elemente einzeln erklären, Zusammenhänge aufzeigen. Mittel-Lang (30-60s).',
  };
  const en: Record<string, string> = {
    'intro': 'Introduction: spark curiosity, present the topic. Short and inviting.',
    'outro': 'Closing: repeat key message, motivating end. Short.',
    'infografik': 'Infographic: explain key concepts one by one. Each concept must be named explicitly.',
    'ken-burns': 'Ken Burns image: atmospheric, visual storytelling. Can be very short (15-25s).',
    'formel': 'Formula explanation: walk through step by step. Can be long (60-120s).',
    'zitat': 'Quote: introduce, cite, contextualize. Rather short (15-30s).',
    'step-by-step': 'Step-by-step: walk through each step individually. Can be long (40-90s).',
    'quiz': 'Quiz: read question, present options, countdown, answer + explanation. Medium (25-40s).',
    'funfact': 'Fun fact: tease and explain a surprising fact. Short (15-25s).',
    'zusammenfassung': 'Summary: list key points one by one. Medium (20-40s).',
    'diagram': 'Diagram: explain elements one by one, show relationships. Medium-Long (30-60s).',
  };
  return (isGerman ? de : en)[type] ?? type;
}

// ── Main function ────────────────────────────────────────────────────────────

/**
 * Teacher Director: takes the storyboard + original content and writes
 * a unified narration script for every scene in one LLM call.
 *
 * Returns a NEW storyboard where each scene has `directedScript` set
 * and `timeBudget` adjusted based on content weight.
 */
export async function directTeaching(
  storyboard: Storyboard,
  contentBlocks: ContentBlock[],
  params: VideoParams,
): Promise<Storyboard> {
  const isGerman = params.language === 'de';
  const targetDuration = params.duration;

  // Build scene summary for the LLM
  const sceneSummary = storyboard.scenes.map((s, i) =>
    `[Scene ${i}] type="${s.type}" title="${s.title}"\n  Content notes: ${s.content.slice(0, 300)}`
  ).join('\n\n');

  const contentText = contentBlocks.map(b => b.content).join('\n\n').slice(0, 5000);

  const prompt = isGerman
    ? `Du bist ein erfahrener Lehrer, der aus einem Storyboard ein zusammenhängendes Unterrichtsvideo macht.

## Quellmaterial:
${contentText}

## Storyboard (${storyboard.scenes.length} Szenen, Zieldauer: ${targetDuration}s):
${sceneSummary}

## Szenen-Typ-Leitfaden:
${storyboard.scenes.map(s => `- "${s.type}": ${sceneTypeGuidance(s.type, true)}`).join('\n')}

## Deine Aufgabe:
Schreibe für JEDE Szene den vollständigen Sprechtext. Alle Szenen zusammen ergeben EINE zusammenhängende Unterrichtsstunde.

## REGELN:
1. **Roter Faden**: Jede Szene baut auf der vorherigen auf. Verwende Übergangssätze: "Nachdem wir X verstanden haben, schauen wir uns nun Y an...", "Erinnern wir uns an...", "Das führt uns zu...".
2. **Pausen**: Setze "..." (drei Punkte) an Stellen, wo der Zuschauer kurz nachdenken soll — nach wichtigen Aussagen, vor neuen Abschnitten, nach rhetorischen Fragen.
3. **Zeitbudgets MÜSSEN stark variieren**: Eine Formel-Erklärung kann 60-120 Sekunden brauchen. Ein Ken-Burns-Moment nur 15-25. Ein Fun Fact nur 15-20. NICHT gleichmäßig verteilen!
4. **Wortanzahl pro Szene**: Ca. 2 Wörter pro Sekunde Zeitbudget (130 WPM bei Sprachtempo 0.92).
5. **Keine isolierten Module**: Die Szenen sind TEIL einer Lektion, nicht eigenständige Mini-Videos.
6. **Quiz**: Schreibe den kompletten Text inkl. Frage, Optionen und "Drei, zwei, eins!" + Antwort-Erklärung.
7. Die Summe aller Zeitbudgets MUSS ${targetDuration} Sekunden ergeben (±10%).

## Output als JSON:
{
  "scenes": [
    {"sceneIndex": 0, "script": "Vollständiger Sprechtext für Szene 0...", "timeBudget": 15},
    {"sceneIndex": 1, "script": "...", "timeBudget": 45},
    ...
  ]
}`
    : `You are a master teacher turning a storyboard into one cohesive educational lesson.

## Source Material:
${contentText}

## Storyboard (${storyboard.scenes.length} scenes, target duration: ${targetDuration}s):
${sceneSummary}

## Scene Type Guidance:
${storyboard.scenes.map(s => `- "${s.type}": ${sceneTypeGuidance(s.type, false)}`).join('\n')}

## Your Task:
Write the COMPLETE narration script for EVERY scene. All scenes together form ONE continuous lesson.

## RULES:
1. **Narrative thread**: Each scene builds on the previous one. Use transitions: "Now that we understand X, let's explore Y...", "As we saw earlier...", "This brings us to...".
2. **Pauses**: Use "..." (ellipsis) where the viewer should pause to think — after key statements, before new sections, after rhetorical questions.
3. **Time budgets MUST vary significantly**: A formula explanation might need 60-120 seconds. A Ken Burns moment only 15-25. A fun fact only 15-20. Do NOT distribute evenly!
4. **Word count per scene**: Approximately 2 words per second of time budget (130 WPM at 0.92 speech speed).
5. **No isolated modules**: Scenes are PART of a lesson, not standalone mini-videos.
6. **Quiz**: Write the complete text including question, options, and "Three, two, one!" + answer explanation.
7. The sum of all time budgets MUST equal ${targetDuration} seconds (±10%).

## Output as JSON:
{
  "scenes": [
    {"sceneIndex": 0, "script": "Complete narration text for scene 0...", "timeBudget": 15},
    {"sceneIndex": 1, "script": "...", "timeBudget": 45},
    ...
  ]
}`;

  const systemPrompt = isGerman
    ? 'Du bist ein erfahrener Pädagoge der komplexe Themen als zusammenhängende, packende Unterrichtsstunden aufbereitet. Du denkst in didaktischen Bögen und achtest auf Verständlichkeit.'
    : 'You are a master educator who turns complex topics into coherent, engaging lessons. You think in pedagogical arcs and prioritize understanding.';

  log.info(
    { scenes: storyboard.scenes.length, targetDuration },
    'Generating unified teaching scripts'
  );

  const plan = await generateJSON<TeachingPlan>(prompt, {
    systemPrompt,
    temperature: 0.6,
    maxTokens: 4096,
  }, TeachingPlanSchema);

  // ── Merge directed scripts into storyboard ─────────────────────────────

  const directedMap = new Map<number, DirectedScene>();
  for (const ds of plan.scenes) {
    directedMap.set(ds.sceneIndex, ds);
  }

  // Normalize time budgets to match target duration
  const rawTotal = plan.scenes.reduce((sum, s) => sum + s.timeBudget, 0);
  const scaleFactor = rawTotal > 0 ? targetDuration / rawTotal : 1;

  const updatedScenes: SceneSpec[] = storyboard.scenes.map((scene, i) => {
    const directed = directedMap.get(i);
    if (!directed) {
      log.warn({ sceneIndex: i, title: scene.title }, 'No directed script for scene — keeping original');
      return scene;
    }

    const adjustedBudget = Math.max(8, Math.round(directed.timeBudget * scaleFactor));

    return {
      ...scene,
      directedScript: directed.script,
      timeBudget: adjustedBudget,
    };
  });

  // Post-normalization drift correction (same approach as storyboardPlanner)
  const actualSum = updatedScenes.reduce((sum, s) => sum + s.timeBudget, 0);
  const drift = actualSum - targetDuration;
  if (drift !== 0 && updatedScenes.length > 0) {
    const longestIdx = updatedScenes.reduce(
      (maxI, s, i, arr) => s.timeBudget > arr[maxI].timeBudget ? i : maxI, 0
    );
    updatedScenes[longestIdx].timeBudget = Math.max(8, updatedScenes[longestIdx].timeBudget - drift);
  }

  log.info(
    {
      scenesDirected: directedMap.size,
      budgets: updatedScenes.map(s => `${s.type}:${s.timeBudget}s`),
    },
    'Teaching plan applied — unified scripts assigned'
  );

  return {
    ...storyboard,
    scenes: updatedScenes,
  };
}
