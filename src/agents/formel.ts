// ═══════════════════════════════════════════════════════════════════════════
// EduVid AI — Formel Agent v3
// Segment-driven: formula appears when narrator introduces it,
// derivation steps reveal as narrator explains each one
// ═══════════════════════════════════════════════════════════════════════════

import { BaseAgent } from './base.js';
import { renderFormulaLayout, type FormulaLayoutData } from '../rendering/layouts.js';
import { drawSegmentIndicator } from '../rendering/renderer.js';
import { getActiveSegment } from '../rendering/narrationSegmenter.js';
import type { CueKeyword } from '../rendering/sttSync.js';
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
    const directed = this.getDirectedScript(input);
    let planPrompt = isGerman
        ? `Erstelle eine Formel-Erklärungsszene für ein Erklärvideo.

Thema: ${input.sceneSpec.content}
Schwierigkeitsgrad: ${input.difficulty}
Zeitbudget: ${input.sceneSpec.timeBudget} Sekunden (ca. ${maxWords} Wörter)
Sprache: Deutsch

Respond as JSON:
{
  "script": "Narrations-Text der die Formel erklärt und JEDEN Ableitungsschritt durchgeht. Das Script MUSS jeden Schritt explizit beschreiben damit Audio und Bild synchron sind.",
  "title": "Name der Formel/des Gesetzes",
  "formula": "E = mc²",
  "explanation": "Kurze Erklärung was die Variablen bedeuten...",
  "derivationSteps": ["E steht für Energie in Joule", "m steht für Masse in Kilogramm", "c ist die Lichtgeschwindigkeit ≈ 3×10⁸ m/s"]
}
Regeln für derivationSteps:
- Jeder Schritt ist eine KURZE erklärende Phrase (NICHT nummeriert, NICHT mit 'Schritt 1:' beginnen)
- Jeder Schritt MUSS im Narrations-Script erwähnt werden damit Audio und Bild synchron bleiben
- Maximal 4 Schritte.`
        : `Create a formula explanation scene for an educational explainer video.

Topic: ${input.sceneSpec.content}
Difficulty: ${input.difficulty}
Time budget: ${input.sceneSpec.timeBudget} seconds (approx. ${maxWords} words)
Language: English

Respond as JSON:
{
  "script": "Narration text that explains the formula and walks through EACH derivation step. The script MUST explicitly describe each step so the audio matches the visuals.",
  "title": "Name of the formula/law",
  "formula": "E = mc²",
  "explanation": "Brief explanation of what the variables mean...",
  "derivationSteps": ["E represents Energy in joules", "m represents mass in kilograms", "c is the speed of light ≈ 3×10⁸ m/s"]
}
Rules for derivationSteps:
- Each step is a SHORT explanatory phrase (NOT numbered, NOT prefixed with 'Step 1:')
- Each step MUST be mentioned in the script narration so audio and visuals stay in sync
- Maximum 4 steps.`;
    if (directed) planPrompt = this.withDirectedScript(planPrompt, directed, isGerman);
    const plan = await this.generatePlanJSON<FormelPlan>(
      planPrompt,
      isGerman
        ? 'Du bist ein Mathematik- und Physik-Experte der komplexe Formeln verständlich erklärt.'
        : 'You are a math and physics expert who explains complex formulas clearly.'
    );

    // TTS
    const audio = await this.synthesizeSpeech(plan.script, input.workDir, 'formel_audio', input.voiceId);
    const duration = audio.durationSeconds;

    // ── STT-synced segmentation ──
    const cueKeywords: CueKeyword[] = [
      { visualCue: 'show_title', triggerPhrase: plan.title },
      { visualCue: 'show_formula', triggerPhrase: plan.formula.replace(/[^a-zA-Z0-9äöüÄÖÜ\s]/g, '').trim().split(' ')[0] || plan.title },
      { visualCue: 'explain_meaning', triggerPhrase: plan.explanation.split(' ').slice(0, 3).join(' ') },
      ...plan.derivationSteps.map((step, i) => ({
        visualCue: `derivation_step:${i}`,
        triggerPhrase: step.split(':').pop()?.trim().split(' ').slice(0, 3).join(' ') || step.split(' ').slice(0, 3).join(' '),
      })),
      { visualCue: 'fade_out', triggerPhrase: plan.script.split('.').pop()?.trim().split(' ').slice(0, 3).join(' ') || 'finally' },
    ];
    const { segments } = await this.segmentScriptWithSTT(plan.script, audio.filePath, duration, cueKeywords);
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
