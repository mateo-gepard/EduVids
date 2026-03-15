// ═══════════════════════════════════════════════════════════════════════════
// EduVid AI — Step-by-Step Agent v3
// Segment-driven: each step reveals when narration talks about it
// ═══════════════════════════════════════════════════════════════════════════

import { BaseAgent } from './base.js';
import { renderStepLayout, type StepLayoutData } from '../rendering/layouts.js';
import { drawHighlightPulse, drawSegmentIndicator } from '../rendering/renderer.js';
import { layout } from '../rendering/designSystem.js';
import { getActiveSegment, findSegmentsByCuePrefix } from '../rendering/narrationSegmenter.js';
import type { CueKeyword } from '../rendering/sttSync.js';
import type { SubAgentInput, SubAgentOutput, SceneType } from '../core/types.js';

interface StepPlan {
  script: string;
  title: string;
  steps: Array<{ title: string; content: string; triggerPhrase: string }>;
}

export class StepByStepAgent extends BaseAgent {
  readonly type: SceneType = 'step-by-step';

  async execute(input: SubAgentInput): Promise<SubAgentOutput> {
    this.log.info({ scene: input.sceneSpec.title }, 'Starting step-by-step agent v3');

    const directed = this.getDirectedScript(input);
    let plan = await this.generateStepPlan(input, undefined, directed);

    let finalScript: string;
    let audio: import('../core/types.js').AudioResult;
    if (directed) {
      // Director provided the script — use it directly, skip budget retry
      audio = await this.synthesizeSpeech(directed, input.workDir, 'steps_audio', input.voiceId);
      finalScript = directed;
    } else {
      const result = await this.synthesizeSpeechForBudget(
        plan.script, input.sceneSpec.timeBudget, input.workDir, 'steps_audio',
        async (targetWords) => {
          const replan = await this.generateStepPlan(input, targetWords);
          plan = replan;
          return replan.script;
        },
        input.voiceId,
      );
      audio = result.audio;
      finalScript = result.script;
    }
    plan.script = finalScript;
    const duration = audio.durationSeconds;

    // ── STT-synced segmentation: real audio timestamps ──
    const cueKeywords: CueKeyword[] = [
      { visualCue: 'show_title', triggerPhrase: plan.title },
      ...plan.steps.map((s, i) => ({
        visualCue: `reveal_step:${i}`,
        triggerPhrase: s.triggerPhrase || s.title,
      })),
      { visualCue: 'fade_out', triggerPhrase: plan.steps[plan.steps.length - 1]?.title || 'finally' },
    ];
    const { segments } = await this.segmentScriptWithSTT(plan.script, audio.filePath, duration, cueKeywords);
    const timeline = this.buildTimelineFromSegments(segments, duration);

    const stepsData: StepLayoutData = {
      title: plan.title,
      steps: plan.steps.map((s, i) => ({
        number: i + 1,
        title: s.title,
        content: s.content,
      })),
    };

    // Pre-compute which segments correspond to which steps
    const stepSegments = findSegmentsByCuePrefix(segments, 'reveal_step:');

    const videoPath = await this.renderScene('step-by-step', duration, input.workDir, audio.filePath,
      (rc, anim) => {
        // Determine active/completed steps from segments
        const { index: segIdx } = getActiveSegment(segments, rc.time);
        const currentCue = segments[segIdx]?.visualCue ?? '';

        // Find which step is active based on the current segment's cue
        let activeStep = 0;
        let completedSteps = 0;

        for (const ss of stepSegments) {
          const stepNum = parseInt(ss.visualCue.split(':')[1]);
          if (rc.time >= ss.estimatedStart) {
            activeStep = stepNum;
          }
          if (rc.time >= ss.estimatedEnd) {
            completedSteps = stepNum + 1;
          }
        }

        renderStepLayout(rc, stepsData, anim, activeStep, completedSteps);

        // Segment progress indicator
        const { index, progress } = getActiveSegment(segments, rc.time);
        drawSegmentIndicator(rc, rc.height - 20, segments.length, index, progress);
      },
      timeline
    );

    return {
      sceneId: input.sceneSpec.id,
      sceneType: 'step-by-step',
      audio,
      visuals: [{ type: 'video', filePath: videoPath, durationSeconds: duration }],
      script: plan.script,
      durationSeconds: duration,
      segments,
    };
  }

  private async generateStepPlan(input: SubAgentInput, wordCountOverride?: number, directedScript?: string): Promise<StepPlan> {
    const maxWords = wordCountOverride ?? this.estimateWordCount(input.sceneSpec.timeBudget);
    const isGerman = input.language === 'de';
    let prompt = isGerman
        ? `Erstelle eine Schritt-für-Schritt Anleitung für ein Erklärvideo.

Thema: ${input.sceneSpec.content}
Schwierigkeitsgrad: ${input.difficulty}
Zeitbudget: ${input.sceneSpec.timeBudget} Sekunden (ca. ${maxWords} Wörter)
Sprache: Deutsch

Respond as JSON:
{
  "script": "Narrations-Text der JEDEN Schritt einzeln erklärt...",
  "title": "Titel der Anleitung",
  "steps": [{"title": "Kurzer Titel", "content": "Vollständige Erklärung des Schrittes auf dem Bildschirm — maximal 1-2 Sätze.", "triggerPhrase": "ein markantes Wort/Phrase aus dem Script das diesen Schritt einleitet"}, ...]
}
Regeln:
- Maximal 6 Schritte, mindestens 3
- Der Script-Text MUSS jeden Schritt verbal durchgehen
- "title" muss KURZ sein: maximal 2-5 Wörter (z.B. "Lichtuhr-Experiment", "Pythagoras anwenden")
- "content" ist der Text der auf dem Bildschirm erscheint — kurz und prägnant (1-2 Sätze)
- "triggerPhrase" muss EXAKT so im Script vorkommen und den Schritt einleiten.`
        : `Create a step-by-step guide for an educational explainer video.

Topic: ${input.sceneSpec.content}
Difficulty: ${input.difficulty}
Time budget: ${input.sceneSpec.timeBudget} seconds (approx. ${maxWords} words)
Language: English

Respond as JSON:
{
  "script": "Narration text that walks through EACH step individually...",
  "title": "Guide Title",
  "steps": [{"title": "Short Label", "content": "Full explanation of the step shown on screen — 1-2 sentences max.", "triggerPhrase": "a distinctive word/phrase from the script that introduces this step"}, ...]
}
Rules:
- Maximum 6 steps, minimum 3
- The script MUST verbally walk through each step
- "title" must be SHORT: 2-5 words max (e.g. "Light Clock Experiment", "Apply Pythagorean Theorem")
- "content" is the on-screen explanation text — keep it concise (1-2 sentences)
- "triggerPhrase" must appear EXACTLY in the script and introduces this step.`;
    if (directedScript) prompt = this.withDirectedScript(prompt, directedScript, isGerman);
    return this.generatePlanJSON<StepPlan>(
      prompt,
      isGerman
        ? 'Du bist ein Experte für strukturierte, pädagogische Anleitungen.'
        : 'You are an expert in structured, pedagogical guides.'
    );
  }
}
