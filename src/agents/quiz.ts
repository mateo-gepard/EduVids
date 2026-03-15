// ═══════════════════════════════════════════════════════════════════════════
// EduVid AI — Quiz Agent v3
// Segment-driven: phase transitions driven by narration segments
// ═══════════════════════════════════════════════════════════════════════════

import { BaseAgent } from './base.js';
import { renderQuizLayout, type QuizLayoutData } from '../rendering/layouts.js';
import { drawSegmentIndicator } from '../rendering/renderer.js';
import { getActiveSegment, findSegmentByCue } from '../rendering/narrationSegmenter.js';
import type { CueKeyword } from '../rendering/sttSync.js';
import type { SubAgentInput, SubAgentOutput, SceneType } from '../core/types.js';

interface QuizPlan {
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  introScript: string;
  revealScript: string;
}

export class QuizAgent extends BaseAgent {
  readonly type: SceneType = 'quiz';

  async execute(input: SubAgentInput): Promise<SubAgentOutput> {
    this.log.info({ scene: input.sceneSpec.title }, 'Starting quiz agent v3');

    // Generate quiz via LLM
    const isGerman = input.language === 'de';
    const directed = this.getDirectedScript(input);
    let planPrompt = isGerman
        ? `Erstelle eine Quiz-Frage für ein Erklärvideo.

Thema: ${input.sceneSpec.content}
Schwierigkeitsgrad: ${input.difficulty}
Sprache: Deutsch
Zeitbudget: ${input.sceneSpec.timeBudget} Sekunden

Respond as JSON:
{
  "question": "Die Quiz-Frage",
  "options": ["Option A", "Option B", "Option C", "Option D"],
  "correctIndex": 0,
  "explanation": "Erklärung warum Option A richtig ist",
  "introScript": "Text der die Frage vorliest und JEDE Option einzeln vorstellt (50-60 Wörter)",
  "revealScript": "Text der die Antwort enthüllt und ausführlich erklärt (40-50 Wörter)"
}`
        : `Create a quiz question for an educational explainer video.

Topic: ${input.sceneSpec.content}
Difficulty: ${input.difficulty}
Language: English
Time budget: ${input.sceneSpec.timeBudget} seconds

Respond as JSON:
{
  "question": "The quiz question",
  "options": ["Option A", "Option B", "Option C", "Option D"],
  "correctIndex": 0,
  "explanation": "Explanation of why Option A is correct",
  "introScript": "Text that reads the question aloud and presents EACH option individually (50-60 words)",
  "revealScript": "Text that reveals the answer and explains it thoroughly (40-50 words)"
}`;
    if (directed) planPrompt = this.withDirectedScript(planPrompt, directed, isGerman);
    const plan = await this.generatePlanJSON<QuizPlan>(
      planPrompt,
      isGerman
        ? 'Du bist ein Experte für interaktive Bildungsquizze.'
        : 'You are an expert in interactive educational quizzes.',
    );

    // Combine scripts for TTS (directed script replaces the combined text if present)
    const countdownPhrase = isGerman ? 'Drei, zwei, eins!' : 'Three, two, one!';
    const fullScript = directed || `${plan.introScript} ... ${countdownPhrase} ... ${plan.revealScript}`;
    const audio = await this.synthesizeSpeech(fullScript, input.workDir, 'quiz_audio', input.voiceId);
    const duration = audio.durationSeconds;

    // ── STT-synced segmentation: real audio timestamps ──
    const cueKeywords: CueKeyword[] = [
      { visualCue: 'read_question', triggerPhrase: plan.question.split(' ').slice(0, 4).join(' ') },
      { visualCue: 'show_options', triggerPhrase: plan.options[0].split(' ').slice(0, 2).join(' ') },
      { visualCue: 'countdown', triggerPhrase: isGerman ? 'Drei' : 'Three' },
      { visualCue: 'reveal_answer', triggerPhrase: plan.revealScript.split(' ').slice(0, 3).join(' ') },
      { visualCue: 'explain', triggerPhrase: plan.explanation.split(' ').slice(0, 3).join(' ') },
    ];
    const { segments } = await this.segmentScriptWithSTT(fullScript, audio.filePath, duration, cueKeywords);
    const timeline = this.buildTimelineFromSegments(segments, duration);

    // Pre-find phase boundaries from segments
    const countdownSeg = findSegmentByCue(segments, 'countdown');
    const revealSeg = findSegmentByCue(segments, 'reveal_answer');
    const explainSeg = findSegmentByCue(segments, 'explain');

    const countdownStart = countdownSeg?.estimatedStart ?? duration * 0.4;
    const countdownEnd = countdownSeg?.estimatedEnd ?? countdownStart + 3;
    const revealStart = revealSeg?.estimatedStart ?? countdownEnd;
    const explainStart = explainSeg?.estimatedStart ?? revealStart + 1;

    const quizData: QuizLayoutData = {
      question: plan.question,
      options: plan.options,
      correctIndex: plan.correctIndex,
      explanation: plan.explanation,
    };

    const videoPath = await this.renderScene('quiz', duration, input.workDir, audio.filePath,
      (rc, anim) => {
        // Phase driven by segment cues instead of duration percentages
        let phase: 'question' | 'countdown' | 'reveal' | 'explanation';
        if (rc.time < countdownStart) phase = 'question';
        else if (rc.time < countdownEnd) phase = 'countdown';
        else if (rc.time < explainStart) phase = 'reveal';
        else phase = 'explanation';

        renderQuizLayout(rc, quizData, anim, phase);

        // Segment progress indicator
        const { index, progress } = getActiveSegment(segments, rc.time);
        drawSegmentIndicator(rc, rc.height - 20, segments.length, index, progress);
      },
      timeline
    );

    return {
      sceneId: input.sceneSpec.id,
      sceneType: 'quiz',
      audio,
      visuals: [{ type: 'video', filePath: videoPath, durationSeconds: duration }],
      script: fullScript,
      durationSeconds: duration,
      segments,
    };
  }
}
