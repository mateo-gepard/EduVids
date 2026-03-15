// ═══════════════════════════════════════════════════════════════════════════
// EduVid AI — Funfact Agent v3
// Segment-driven: fact card reveals when narrator says the fact
// ═══════════════════════════════════════════════════════════════════════════

import { BaseAgent } from './base.js';
import { renderFunfactLayout, type FunfactLayoutData } from '../rendering/layouts.js';
import { drawSegmentIndicator } from '../rendering/renderer.js';
import { getActiveSegment } from '../rendering/narrationSegmenter.js';
import type { CueKeyword } from '../rendering/sttSync.js';
import type { SubAgentInput, SubAgentOutput, SceneType } from '../core/types.js';

interface FunfactPlan {
  script: string;
  header: string;
  fact: string;
  emoji: string;
  triggerPhrases: { header: string; fact: string };
}

export class FunfactAgent extends BaseAgent {
  readonly type: SceneType = 'funfact';

  async execute(input: SubAgentInput): Promise<SubAgentOutput> {
    this.log.info({ scene: input.sceneSpec.title }, 'Starting funfact agent v3');

    const directed = this.getDirectedScript(input);
    let plan = await this.generateFunfactPlan(input, undefined, directed);

    let finalScript: string;
    let audio: import('../core/types.js').AudioResult;
    if (directed) {
      audio = await this.synthesizeSpeech(directed, input.workDir, 'funfact_audio', input.voiceId);
      finalScript = directed;
    } else {
      const result = await this.synthesizeSpeechForBudget(
        plan.script, input.sceneSpec.timeBudget, input.workDir, 'funfact_audio',
        async (targetWords) => {
          const replan = await this.generateFunfactPlan(input, targetWords);
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
    const headerTrigger = plan.triggerPhrases?.header || plan.header;
    const factTrigger = plan.triggerPhrases?.fact || plan.fact.split(' ').slice(0, 4).join(' ');
    const cueKeywords: CueKeyword[] = [
      { visualCue: 'tease_fact', triggerPhrase: plan.emoji },
      { visualCue: 'show_header', triggerPhrase: headerTrigger },
      { visualCue: 'reveal_fact', triggerPhrase: factTrigger },
      { visualCue: 'fade_out', triggerPhrase: factTrigger },
    ];
    const { segments } = await this.segmentScriptWithSTT(plan.script, audio.filePath, duration, cueKeywords);
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

  private async generateFunfactPlan(input: SubAgentInput, wordCountOverride?: number, directedScript?: string): Promise<FunfactPlan> {
    const maxWords = wordCountOverride ?? this.estimateWordCount(input.sceneSpec.timeBudget);
    const isGerman = input.language === 'de';
    let prompt = isGerman
        ? `Erstelle eine Fun-Fact-Szene für ein Erklärvideo.

Thema: ${input.sceneSpec.content}
Zeitbudget: ${input.sceneSpec.timeBudget} Sekunden (ca. ${maxWords} Wörter)
Sprache: Deutsch

Respond as JSON:
{
  "script": "Wusstest du, dass... Lockerer, überraschender Narrations-Text.",
  "header": "Wusstest du...?",
  "fact": "Der überraschende Fakt in 1-2 Sätzen",
  "emoji": "🤯",
  "triggerPhrases": {"header": "Wort aus Script das den Header einleitet", "fact": "Wort aus Script das den Fakt einleitet"}
}
Wähle ein passendes Emoji (🤯, 💡, 🧠, 🔥, ⚡, 🌍, etc.)
WICHTIG: triggerPhrases müssen Wörter/Phrasen sein die EXAKT so im Script vorkommen.`
        : `Create a fun fact scene for an educational explainer video.

Topic: ${input.sceneSpec.content}
Time budget: ${input.sceneSpec.timeBudget} seconds (approx. ${maxWords} words)
Language: English

Respond as JSON:
{
  "script": "Did you know that... Casual, surprising narration text.",
  "header": "Did you know...?",
  "fact": "The surprising fact in 1-2 sentences",
  "emoji": "🤯",
  "triggerPhrases": {"header": "word from script that introduces the header", "fact": "word from script that introduces the fact"}
}
Choose a fitting emoji (🤯, 💡, 🧠, 🔥, ⚡, 🌍, etc.)
IMPORTANT: triggerPhrases must be words/phrases that appear EXACTLY in the script.`;
    if (directedScript) prompt = this.withDirectedScript(prompt, directedScript, isGerman);
    return this.generatePlanJSON<FunfactPlan>(
      prompt,
      isGerman
        ? 'Du bist ein unterhaltsamer Bildungskommunikator mit einer Leidenschaft für überraschende Fakten.'
        : 'You are an entertaining educational communicator with a passion for surprising facts.'
    );
  }
}
