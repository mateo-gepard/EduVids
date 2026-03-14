// ═══════════════════════════════════════════════════════════════════════════
// EduVid AI — Funfact Agent v3
// Segment-driven: fact card reveals when narrator says the fact
// ═══════════════════════════════════════════════════════════════════════════

import { BaseAgent } from './base.js';
import { renderFunfactLayout, type FunfactLayoutData } from '../rendering/layouts.js';
import { drawSegmentIndicator } from '../rendering/renderer.js';
import { getActiveSegment } from '../rendering/narrationSegmenter.js';
import type { SubAgentInput, SubAgentOutput, SceneType } from '../core/types.js';

interface FunfactPlan {
  script: string;
  header: string;
  fact: string;
  emoji: string;
}

export class FunfactAgent extends BaseAgent {
  readonly type: SceneType = 'funfact';

  async execute(input: SubAgentInput): Promise<SubAgentOutput> {
    this.log.info({ scene: input.sceneSpec.title }, 'Starting funfact agent v3');

    const maxWords = this.estimateWordCount(input.sceneSpec.timeBudget);
    const isGerman = input.language === 'de';
    const plan = await this.generatePlanJSON<FunfactPlan>(
      isGerman
        ? `Erstelle eine Fun-Fact-Szene für ein Erklärvideo.

Thema: ${input.sceneSpec.content}
Zeitbudget: ${input.sceneSpec.timeBudget} Sekunden (ca. ${maxWords} Wörter)
Sprache: Deutsch

Respond as JSON:
{
  "script": "Wusstest du, dass... Lockerer, überraschender Narrations-Text.",
  "header": "Wusstest du...?",
  "fact": "Der überraschende Fakt in 1-2 Sätzen",
  "emoji": "🤯"
}
Wähle ein passendes Emoji (🤯, 💡, 🧠, 🔥, ⚡, 🌍, etc.)`
        : `Create a fun fact scene for an educational explainer video.

Topic: ${input.sceneSpec.content}
Time budget: ${input.sceneSpec.timeBudget} seconds (approx. ${maxWords} words)
Language: English

Respond as JSON:
{
  "script": "Did you know that... Casual, surprising narration text.",
  "header": "Did you know...?",
  "fact": "The surprising fact in 1-2 sentences",
  "emoji": "🤯"
}
Choose a fitting emoji (🤯, 💡, 🧠, 🔥, ⚡, 🌍, etc.)`,
      isGerman
        ? 'Du bist ein unterhaltsamer Bildungskommunikator mit einer Leidenschaft für überraschende Fakten.'
        : 'You are an entertaining educational communicator with a passion for surprising facts.'
    );

    const audio = await this.synthesizeSpeech(plan.script, input.workDir, 'funfact_audio', input.voiceId);
    const duration = audio.durationSeconds;

    // ── Segment narration → segment-driven timeline ──
    const segments = await this.segmentScript(plan.script, duration, 'funfact', input.language);
    const timeline = this.buildTimelineFromSegments(segments, duration);

    const funfactData: FunfactLayoutData = {
      header: plan.header,
      fact: plan.fact,
      emoji: plan.emoji,
    };

    const videoPath = await this.renderScene('funfact', duration, input.workDir, audio.filePath,
      (rc, anim) => {
        renderFunfactLayout(rc, funfactData, anim);

        // Segment progress indicator
        const { index, progress } = getActiveSegment(segments, rc.time);
        drawSegmentIndicator(rc, rc.height - 20, segments.length, index, progress);
      },
      timeline
    );

    return {
      sceneId: input.sceneSpec.id,
      sceneType: 'funfact',
      audio,
      visuals: [{ type: 'video', filePath: videoPath, durationSeconds: duration }],
      script: plan.script,
      durationSeconds: duration,
      segments,
    };
  }
}
