// ═══════════════════════════════════════════════════════════════════════════
// EduVid AI — Step-by-Step Agent v3
// Segment-driven: each step reveals when narration talks about it
// ═══════════════════════════════════════════════════════════════════════════

import { BaseAgent } from './base.js';
import { renderStepLayout, type StepLayoutData } from '../rendering/layouts.js';
import { drawHighlightPulse, drawSegmentIndicator } from '../rendering/renderer.js';
import { layout } from '../rendering/designSystem.js';
import { getActiveSegment, findSegmentsByCuePrefix } from '../rendering/narrationSegmenter.js';
import type { SubAgentInput, SubAgentOutput, SceneType } from '../core/types.js';

interface StepPlan {
  script: string;
  title: string;
  steps: Array<{ title: string; content: string }>;
}

export class StepByStepAgent extends BaseAgent {
  readonly type: SceneType = 'step-by-step';

  async execute(input: SubAgentInput): Promise<SubAgentOutput> {
    this.log.info({ scene: input.sceneSpec.title }, 'Starting step-by-step agent v3');

    const maxWords = this.estimateWordCount(input.sceneSpec.timeBudget);
    const isGerman = input.language === 'de';
    const plan = await this.generatePlanJSON<StepPlan>(
      isGerman
        ? `Erstelle eine Schritt-für-Schritt Anleitung für ein Erklärvideo.

Thema: ${input.sceneSpec.content}
Schwierigkeitsgrad: ${input.difficulty}
Zeitbudget: ${input.sceneSpec.timeBudget} Sekunden (ca. ${maxWords} Wörter)
Sprache: Deutsch

Respond as JSON:
{
  "script": "Narrations-Text der JEDEN Schritt einzeln erklärt...",
  "title": "Titel der Anleitung",
  "steps": [{"title": "Schritt-Titel", "content": "Erklärung des Schrittes"}, ...]
}
Maximal 6 Schritte, mindestens 3. Der Script-Text MUSS jeden Schritt verbal durchgehen.`
        : `Create a step-by-step guide for an educational explainer video.

Topic: ${input.sceneSpec.content}
Difficulty: ${input.difficulty}
Time budget: ${input.sceneSpec.timeBudget} seconds (approx. ${maxWords} words)
Language: English

Respond as JSON:
{
  "script": "Narration text that walks through EACH step individually...",
  "title": "Guide Title",
  "steps": [{"title": "Step Title", "content": "Explanation of the step"}, ...]
}
Maximum 6 steps, minimum 3. The script MUST verbally walk through each step.`,
      isGerman
        ? 'Du bist ein Experte für strukturierte, pädagogische Anleitungen.'
        : 'You are an expert in structured, pedagogical guides.'
    );

    const audio = await this.synthesizeSpeech(plan.script, input.workDir, 'steps_audio', input.voiceId);
    const duration = audio.durationSeconds;

    // ── Segment narration → segment-driven timeline ──
    const segments = await this.segmentScript(plan.script, duration, 'step-by-step', input.language);
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
}
