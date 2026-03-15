// ═══════════════════════════════════════════════════════════════════════════
// EduVid AI — Zusammenfassung Agent v3
// Segment-driven: bullet points sync to narration
// ═══════════════════════════════════════════════════════════════════════════

import { BaseAgent } from './base.js';
import { renderBulletListLayout, type BulletListData } from '../rendering/layouts.js';
import { drawSegmentIndicator } from '../rendering/renderer.js';
import { getActiveSegment } from '../rendering/narrationSegmenter.js';
import type { CueKeyword } from '../rendering/sttSync.js';
import type { SubAgentInput, SubAgentOutput, SceneType } from '../core/types.js';

interface ZusammenfassungPlan {
  script: string;
  title: string;
  bulletPoints: Array<{ icon: string; text: string; triggerPhrase: string }>;
  closingMessage: string;
}

export class ZusammenfassungAgent extends BaseAgent {
  readonly type: SceneType = 'zusammenfassung';

  async execute(input: SubAgentInput): Promise<SubAgentOutput> {
    this.log.info({ scene: input.sceneSpec.title }, 'Starting zusammenfassung agent v3');

    const directed = this.getDirectedScript(input);
    let plan = await this.generateSummaryPlan(input, undefined, directed);

    let audio: any;
    let finalScript: string;
    if (directed) {
      const result = await this.synthesizeSpeech(directed, input.workDir, 'zusammenfassung_audio', input.voiceId);
      audio = result;
      finalScript = directed;
    } else {
      const result = await this.synthesizeSpeechForBudget(
        plan.script, input.sceneSpec.timeBudget, input.workDir, 'zusammenfassung_audio',
        async (targetWords) => {
          const replan = await this.generateSummaryPlan(input, targetWords);
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
      { visualCue: 'summary_title', triggerPhrase: plan.title },
      ...plan.bulletPoints.map((bp, i) => ({
        visualCue: `bullet:${i}`,
        triggerPhrase: bp.triggerPhrase || bp.text.split(' ').slice(0, 3).join(' '),
      })),
      { visualCue: 'closing', triggerPhrase: plan.closingMessage.split(' ').slice(0, 3).join(' ') },
    ];
    const { segments } = await this.segmentScriptWithSTT(plan.script, audio.filePath, duration, cueKeywords);
    const timeline = this.buildTimelineFromSegments(segments, duration);

    const bulletData: BulletListData = {
      title: plan.title,
      items: plan.bulletPoints,
      footer: plan.closingMessage,
    };

    const videoPath = await this.renderScene('zusammenfassung', duration, input.workDir, audio.filePath,
      (rc, anim) => {
        // Segment-timing based visibility: show items whose segment has started
        let visibleItemCount = 0;
        for (let i = 0; i < plan.bulletPoints.length; i++) {
          const seg = segments.find(s => s.visualCue === `bullet:${i}`);
          if (seg && rc.time >= seg.estimatedStart) visibleItemCount = i + 1;
          else if ((anim[`item${i}Opacity`] ?? 0) > 0.1) visibleItemCount = i + 1;
        }
        // At end of scene, always show all items
        if (rc.time >= duration - 1.0) visibleItemCount = plan.bulletPoints.length;
        renderBulletListLayout(rc, bulletData, anim, visibleItemCount);

        // Segment progress indicator
        const { index, progress } = getActiveSegment(segments, rc.time);
        drawSegmentIndicator(rc, rc.height - 20, segments.length, index, progress);
      },
      timeline
    );

    return {
      sceneId: input.sceneSpec.id,
      sceneType: 'zusammenfassung',
      audio,
      visuals: [{ type: 'video', filePath: videoPath, durationSeconds: duration }],
      script: plan.script,
      durationSeconds: duration,
      segments,
    };
  }

  private async generateSummaryPlan(input: SubAgentInput, wordCountOverride?: number, directedScript?: string): Promise<ZusammenfassungPlan> {
    const maxWords = wordCountOverride ?? this.estimateWordCount(input.sceneSpec.timeBudget);
    const isGerman = input.language === 'de';
    let prompt = isGerman
        ? `Erstelle eine Zusammenfassungs-Szene für ein Erklärvideo.

Thema: ${input.sceneSpec.content}
Zeitbudget: ${input.sceneSpec.timeBudget} Sekunden (ca. ${maxWords} Wörter)
Sprache: Deutsch

Respond as JSON:
{
  "script": "Zusammenfassender Narrations-Text der JEDEN Kernpunkt erwähnt...",
  "title": "Das Wichtigste auf einen Blick",
  "bulletPoints": [{"icon": "📌", "text": "Kernpunkt 1", "triggerPhrase": "markantes Wort aus dem Script das diesen Punkt einleitet"}, ...],
  "closingMessage": "Merke dir: Kurze Schlussfolgerung..."
}
Maximal 6 Bulletpoints, mindestens 3. Wähle passende Emojis.
WICHTIG: "triggerPhrase" muss ein Wort oder kurze Phrase sein die EXAKT so im Script vorkommt.`
        : `Create a summary scene for an educational explainer video.

Topic: ${input.sceneSpec.content}
Time budget: ${input.sceneSpec.timeBudget} seconds (approx. ${maxWords} words)
Language: English

Respond as JSON:
{
  "script": "Summary narration text that mentions EACH key point...",
  "title": "Key Takeaways",
  "bulletPoints": [{"icon": "📌", "text": "Key point 1", "triggerPhrase": "distinctive word from the script that introduces this point"}, ...],
  "closingMessage": "Remember: Brief conclusion..."
}
Maximum 6 bullet points, minimum 3. Choose fitting emojis.
IMPORTANT: "triggerPhrase" must be a word or short phrase that appears EXACTLY in the script.`;
    if (directedScript) prompt = this.withDirectedScript(prompt, directedScript, isGerman);
    return this.generatePlanJSON<ZusammenfassungPlan>(
      prompt,
      isGerman
        ? 'Du bist ein Experte für knappe, strukturierte Zusammenfassungen.'
        : 'You are an expert in concise, structured summaries.'
    );
  }
}
