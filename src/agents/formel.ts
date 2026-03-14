// ═══════════════════════════════════════════════════════════════════════════
// EduVid AI — Formel Agent v3
// Segment-driven: formula appears when narrator introduces it,
// derivation steps reveal as narrator explains each one
// ═══════════════════════════════════════════════════════════════════════════

import { BaseAgent } from './base.js';
import { renderFormulaLayout, type FormulaLayoutData } from '../rendering/layouts.js';
import { drawSegmentIndicator } from '../rendering/renderer.js';
import { getActiveSegment } from '../rendering/narrationSegmenter.js';
import type { SubAgentInput, SubAgentOutput, SceneType } from '../core/types.js';

interface FormelPlan {
  script: string;
  title: string;
  formula: string;
  explanation: string;
  derivationSteps: string[];
}

export class FormelAgent extends BaseAgent {
  readonly type: SceneType = 'formel';

  async execute(input: SubAgentInput): Promise<SubAgentOutput> {
    this.log.info({ scene: input.sceneSpec.title }, 'Starting formel agent v3');

    const maxWords = this.estimateWordCount(input.sceneSpec.timeBudget);
    const isGerman = input.language === 'de';
    const plan = await this.generatePlanJSON<FormelPlan>(
      isGerman
        ? `Erstelle eine Formel-Erklärungsszene für ein Erklärvideo.

Thema: ${input.sceneSpec.content}
Schwierigkeitsgrad: ${input.difficulty}
Zeitbudget: ${input.sceneSpec.timeBudget} Sekunden (ca. ${maxWords} Wörter)
Sprache: Deutsch

Respond as JSON:
{
  "script": "Narrations-Text der die Formel erklärt und JEDEN Ableitungsschritt durchgeht...",
  "title": "Name der Formel/des Gesetzes",
  "formula": "E = mc²",
  "explanation": "Kurze Erklärung was die Variablen bedeuten...",
  "derivationSteps": ["Schritt 1: ...", "Schritt 2: ..."]
}
Maximal 4 Ableitungsschritte.`
        : `Create a formula explanation scene for an educational explainer video.

Topic: ${input.sceneSpec.content}
Difficulty: ${input.difficulty}
Time budget: ${input.sceneSpec.timeBudget} seconds (approx. ${maxWords} words)
Language: English

Respond as JSON:
{
  "script": "Narration text that explains the formula and walks through EACH derivation step...",
  "title": "Name of the formula/law",
  "formula": "E = mc²",
  "explanation": "Brief explanation of what the variables mean...",
  "derivationSteps": ["Step 1: ...", "Step 2: ..."]
}
Maximum 4 derivation steps.`,
      isGerman
        ? 'Du bist ein Mathematik- und Physik-Experte der komplexe Formeln verständlich erklärt.'
        : 'You are a math and physics expert who explains complex formulas clearly.'
    );

    // TTS
    const audio = await this.synthesizeSpeech(plan.script, input.workDir, 'formel_audio', input.voiceId);
    const duration = audio.durationSeconds;

    // ── Segment narration → segment-driven timeline ──
    const segments = await this.segmentScript(plan.script, duration, 'formel', input.language);
    const timeline = this.buildTimelineFromSegments(segments, duration);

    const layoutData: FormulaLayoutData = {
      title: plan.title,
      formula: plan.formula,
      explanation: plan.explanation,
      steps: plan.derivationSteps,
    };

    const videoPath = await this.renderScene('formel', duration, input.workDir, audio.filePath,
      (rc, anim) => {
        renderFormulaLayout(rc, layoutData, anim);

        // Segment progress indicator
        const { index, progress } = getActiveSegment(segments, rc.time);
        drawSegmentIndicator(rc, rc.height - 20, segments.length, index, progress);
      },
      timeline
    );

    return {
      sceneId: input.sceneSpec.id,
      sceneType: 'formel',
      audio,
      visuals: [{ type: 'video', filePath: videoPath, durationSeconds: duration }],
      script: plan.script,
      durationSeconds: duration,
      segments,
    };
  }
}
