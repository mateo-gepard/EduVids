// ═══════════════════════════════════════════════════════════════════════════
// EduVid AI — Intro/Outro Agent v3
// Segment-driven: title elements sync to narration flow
// ═══════════════════════════════════════════════════════════════════════════

import { BaseAgent } from './base.js';
import { easing } from '../rendering/animations.js';
import { renderTitleLayout, renderBulletListLayout, type TitleLayoutData, type BulletListData } from '../rendering/layouts.js';
import { drawSegmentIndicator } from '../rendering/renderer.js';
import type { SubAgentInput, SubAgentOutput, SceneType, NarrationSegment } from '../core/types.js';

export class IntroOutroAgent extends BaseAgent {
  readonly type: SceneType = 'intro';

  async execute(input: SubAgentInput): Promise<SubAgentOutput> {
    const isOutro = input.sceneSpec.type === 'outro';
    this.log.info({ type: isOutro ? 'outro' : 'intro', title: input.sceneSpec.title }, 'Starting intro/outro agent v3');

    // Generate script
    const isGerman = input.language === 'de';
    const style = isOutro
      ? (isGerman ? 'abschließend, zusammenfassend, motivierend' : 'conclusive, summarizing, motivating')
      : (isGerman ? 'einladend, neugierig machend, kurze Vorschau' : 'inviting, curiosity-sparking, brief preview');
    const maxWords = this.estimateWordCount(input.sceneSpec.timeBudget);
    const script = await this.generateScript(input.sceneSpec.content, input.language, style, maxWords);

    // TTS
    const audio = await this.synthesizeSpeech(script, input.workDir, `${input.sceneSpec.type}_audio`, input.voiceId);
    const duration = audio.durationSeconds;

    // ── Segment narration for sync ──
    const segments = await this.segmentScript(script, duration, isOutro ? 'outro' : 'intro', input.language);
    const timeline = this.buildTimelineFromSegments(segments, duration);

    if (isOutro) {
      // Outro: Key takeaways with staggered bullets
      const outroPrompt = isGerman
        ? `Erstelle eine Zusammenfassung für das Outro eines Erklärvideos.
Inhalt: ${input.sceneSpec.content}

Respond as JSON:
{
  "title": "Zusammenfassung",
  "keyTakeaways": [{"icon": "✅", "text": "Punkt 1"}, ...],
  "closingMessage": "Danke fürs Zuschauen! ..."
}
Maximal 5 key takeaways.`
        : `Create a summary for the outro of an educational explainer video.
Content: ${input.sceneSpec.content}

Respond as JSON:
{
  "title": "Summary",
  "keyTakeaways": [{"icon": "✅", "text": "Point 1"}, ...],
  "closingMessage": "Thanks for watching! ..."
}
Maximum 5 key takeaways.`;
      const outroSystemPrompt = isGerman
        ? 'Du bist ein Experte für strukturierte Zusammenfassungen.'
        : 'You are an expert in structured summaries.';
      const plan = await this.generatePlanJSON<{
        title: string;
        keyTakeaways: Array<{ icon: string; text: string }>;
        closingMessage: string;
      }>(outroPrompt, outroSystemPrompt);

      const outroData: BulletListData = {
        title: plan.title,
        items: plan.keyTakeaways,
        footer: plan.closingMessage,
      };

      let visibleItemCount = 0;
      const videoPath = await this.renderScene('outro', duration, input.workDir, audio.filePath,
        (rc, anim) => {
          visibleItemCount = 0;
          for (let i = 0; i < plan.keyTakeaways.length; i++) {
            if ((anim[`item${i}Opacity`] ?? 0) > 0.1) visibleItemCount = i + 1;
          }
          renderBulletListLayout(rc, outroData, anim, visibleItemCount);

          // Segment progress indicator at bottom
          const { index, progress } = this.getSegmentAt(segments, rc.time);
          drawSegmentIndicator(rc, rc.height - 20, segments.length, index, progress);
        },
        timeline
      );

      return {
        sceneId: input.sceneSpec.id,
        sceneType: isOutro ? 'outro' : 'intro',
        audio,
        visuals: [{ type: 'video', filePath: videoPath, durationSeconds: duration }],
        script,
        durationSeconds: duration,
        segments,
      };
    } else {
      // Intro: Title card — synced to narration segments
      const titleData: TitleLayoutData = {
        title: input.sceneSpec.title || (isGerman ? 'Willkommen' : 'Welcome'),
        subtitle: script.split('.')[0] + '.',
        badge: isGerman ? '📚 Erklärvideo' : '📚 Tutorial',
      };

      // Add typewriter for title across the 'title_appear' segment
      const titleSeg = segments.find(s => s.visualCue === 'title_appear');
      if (titleSeg) {
        timeline.add({
          startTime: titleSeg.estimatedStart + 0.3,
          duration: Math.max(0.5, titleSeg.estimatedEnd - titleSeg.estimatedStart - 0.3),
          easing: easing.linear,
          properties: { revealProgress: [0, 1] },
        });
        timeline.add({
          startTime: titleSeg.estimatedStart + 0.5,
          duration: 0.8,
          easing: easing.easeOutCubic,
          properties: { underlineProgress: [0, 1] },
        });
      }

      const videoPath = await this.renderScene('intro', duration, input.workDir, audio.filePath,
        (rc, anim) => renderTitleLayout(rc, titleData, anim),
        timeline
      );

      return {
        sceneId: input.sceneSpec.id,
        sceneType: input.sceneSpec.type,
        audio,
        visuals: [{ type: 'video', filePath: videoPath, durationSeconds: duration }],
        script,
        durationSeconds: duration,
        segments,
      };
    }
  }
}
