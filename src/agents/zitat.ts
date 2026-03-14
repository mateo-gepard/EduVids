// ═══════════════════════════════════════════════════════════════════════════
// EduVid AI — Zitat Agent v3
// Segment-driven: quote reveal paces with narration
// ═══════════════════════════════════════════════════════════════════════════

import { BaseAgent } from './base.js';
import { renderQuoteLayout, type QuoteLayoutData } from '../rendering/layouts.js';
import { drawSegmentIndicator } from '../rendering/renderer.js';
import { getActiveSegment } from '../rendering/narrationSegmenter.js';
import type { SubAgentInput, SubAgentOutput, SceneType } from '../core/types.js';

interface ZitatPlan {
  script: string;
  quote: string;
  author: string;
  context: string;
}

export class ZitatAgent extends BaseAgent {
  readonly type: SceneType = 'zitat';

  async execute(input: SubAgentInput): Promise<SubAgentOutput> {
    this.log.info({ scene: input.sceneSpec.title }, 'Starting zitat agent v3');

    const maxWords = this.estimateWordCount(input.sceneSpec.timeBudget);
    const isGerman = input.language === 'de';
    const plan = await this.generatePlanJSON<ZitatPlan>(
      isGerman
        ? `Erstelle eine Zitat-Szene für ein Erklärvideo.

Thema: ${input.sceneSpec.content}
Zeitbudget: ${input.sceneSpec.timeBudget} Sekunden (ca. ${maxWords} Wörter)
Sprache: Deutsch

Respond as JSON:
{
  "script": "Dramatischer Narrations-Text der das Zitat einleitet und erklärt...",
  "quote": "Das eigentliche Zitat",
  "author": "Name des Autors",
  "context": "Kontext: Wann, wo, warum dieses Zitat relevant ist"
}`
        : `Create a quote scene for an educational explainer video.

Topic: ${input.sceneSpec.content}
Time budget: ${input.sceneSpec.timeBudget} seconds (approx. ${maxWords} words)
Language: English

Respond as JSON:
{
  "script": "Dramatic narration text that introduces and explains the quote...",
  "quote": "The actual quote",
  "author": "Author's name",
  "context": "Context: when, where, and why this quote is relevant"
}`,
      isGerman
        ? 'Du bist ein dramatischer Geschichtenerzähler mit literarischer Expertise.'
        : 'You are a dramatic storyteller with literary expertise.'
    );

    const audio = await this.synthesizeSpeech(plan.script, input.workDir, 'zitat_audio', input.voiceId);
    const duration = audio.durationSeconds;

    // ── Segment-driven timeline ──
    const segments = await this.segmentScript(plan.script, duration, 'zitat', input.language);
    const timeline = this.buildTimelineFromSegments(segments, duration);

    const quoteData: QuoteLayoutData = {
      quote: plan.quote,
      author: plan.author,
      context: plan.context,
    };

    const videoPath = await this.renderScene('zitat', duration, input.workDir, audio.filePath,
      (rc, anim) => {
        renderQuoteLayout(rc, quoteData, anim);
        const { index, progress } = getActiveSegment(segments, rc.time);
        drawSegmentIndicator(rc, rc.height - 20, segments.length, index, progress);
      },
      timeline
    );

    return {
      sceneId: input.sceneSpec.id,
      sceneType: 'zitat',
      audio,
      visuals: [{ type: 'video', filePath: videoPath, durationSeconds: duration }],
      script: plan.script,
      durationSeconds: duration,
      segments,
    };
  }
}
