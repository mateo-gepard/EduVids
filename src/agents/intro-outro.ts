// ═══════════════════════════════════════════════════════════════════════════
// EduVid AI — Intro/Outro Agent v3
// Segment-driven: title elements sync to narration flow
// ═══════════════════════════════════════════════════════════════════════════

import { BaseAgent } from './base.js';
import { easing } from '../rendering/animations.js';
import { renderTitleLayout, renderBulletListLayout, type TitleLayoutData, type BulletListData } from '../rendering/layouts.js';
import { drawSegmentIndicator } from '../rendering/renderer.js';
import type { CueKeyword } from '../rendering/sttSync.js';
import type { SubAgentInput, SubAgentOutput, SceneType, NarrationSegment } from '../core/types.js';

export class IntroOutroAgent extends BaseAgent {
  readonly type: SceneType = 'intro';

  async execute(input: SubAgentInput): Promise<SubAgentOutput> {
    const isOutro = input.sceneSpec.type === 'outro';
    this.log.info({ type: isOutro ? 'outro' : 'intro', title: input.sceneSpec.title }, 'Starting intro/outro agent v3');

    // Generate script with duration-aware retry
    const isGerman = input.language === 'de';
    const directed = this.getDirectedScript(input);
    const style = isOutro
      ? (isGerman ? 'abschließend, zusammenfassend, motivierend' : 'conclusive, summarizing, motivating')
      : (isGerman ? 'einladend, neugierig machend, kurze Vorschau' : 'inviting, curiosity-sparking, brief preview');
    const maxWords = this.estimateWordCount(input.sceneSpec.timeBudget);

    // TTS — use directed script or generate + budget retry
    let audio: any;
    let script: string;
    if (directed) {
      audio = await this.synthesizeSpeech(directed, input.workDir, `${input.sceneSpec.type}_audio`, input.voiceId);
      script = directed;
    } else {
      const initialScript = await this.generateScript(input.sceneSpec.content, input.language, style, maxWords);
      const result = await this.synthesizeSpeechForBudget(
        initialScript, input.sceneSpec.timeBudget, input.workDir, `${input.sceneSpec.type}_audio`,
        async (targetWords) => this.generateScript(input.sceneSpec.content, input.language, style, targetWords),
        input.voiceId,
      );
      audio = result.audio;
      script = result.script;
    }
    const duration = audio.durationSeconds;

    // ── STT-synced segmentation: real audio timestamps ──
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

      // Build STT cue keywords from the SCRIPT (not the plan),
      // because the audio contains the script text, not the plan text.
      const sentences = script.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 0);
      const totalCues = 2 + plan.keyTakeaways.length; // summary_title + bullets + closing
      const outroCueKeywords: CueKeyword[] = [
        { visualCue: 'summary_title', triggerPhrase: (sentences[0] || script).split(' ').slice(0, 3).join(' ') },
        ...plan.keyTakeaways.map((kt, i) => {
          const sentIdx = Math.min(i + 1, sentences.length - 1);
          return {
            visualCue: `bullet:${i}`,
            triggerPhrase: (sentences[sentIdx] || kt.text).split(' ').slice(0, 3).join(' '),
          };
        }),
        { visualCue: 'closing', triggerPhrase: (sentences[sentences.length - 1] || 'thank').split(' ').slice(0, 3).join(' ') },
      ];
      const { segments } = await this.segmentScriptWithSTT(script, audio.filePath, duration, outroCueKeywords);
      const timeline = this.buildTimelineFromSegments(segments, duration);

      const outroData: BulletListData = {
        title: plan.title,
        items: plan.keyTakeaways,
        footer: plan.closingMessage,
      };

      const videoPath = await this.renderScene('outro', duration, input.workDir, audio.filePath,
        (rc, anim) => {
          // Segment-timing based visibility: show items whose segment has started
          let visibleItemCount = 0;
          for (let i = 0; i < plan.keyTakeaways.length; i++) {
            const seg = segments.find(s => s.visualCue === `bullet:${i}`);
            if (seg && rc.time >= seg.estimatedStart) visibleItemCount = i + 1;
            else if ((anim[`item${i}Opacity`] ?? 0) > 0.1) visibleItemCount = i + 1;
          }
          // At end of scene, always show all items
          if (rc.time >= duration - 1.0) visibleItemCount = plan.keyTakeaways.length;
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
      // Intro: Title card — synced to narration segments via STT
      const titleData: TitleLayoutData = {
        title: input.sceneSpec.title || (isGerman ? 'Willkommen' : 'Welcome'),
        subtitle: script.split('.')[0] + '.',
        badge: isGerman ? '📚 Erklärvideo' : '📚 Tutorial',
      };

      const introCueKeywords: CueKeyword[] = [
        { visualCue: 'badge_show', triggerPhrase: input.sceneSpec.title.split(' ').slice(0, 2).join(' ') },
        { visualCue: 'title_appear', triggerPhrase: input.sceneSpec.title },
        { visualCue: 'subtitle_reveal', triggerPhrase: script.split('.')[0]?.split(' ').slice(1, 4).join(' ') || 'welcome' },
        { visualCue: 'fade_out', triggerPhrase: script.split('.').pop()?.trim().split(' ').slice(0, 3).join(' ') || 'end' },
      ];
      const { segments } = await this.segmentScriptWithSTT(script, audio.filePath, duration, introCueKeywords);
      const timeline = this.buildTimelineFromSegments(segments, duration);

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
