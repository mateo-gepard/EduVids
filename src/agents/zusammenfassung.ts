// ═══════════════════════════════════════════════════════════════════════════
// EduVid AI — Zusammenfassung Agent v3
// Segment-driven: bullet points sync to narration
// ═══════════════════════════════════════════════════════════════════════════

import { BaseAgent } from './base.js';
import { renderBulletListLayout, type BulletListData } from '../rendering/layouts.js';
import { drawSegmentIndicator } from '../rendering/renderer.js';
import { getActiveSegment } from '../rendering/narrationSegmenter.js';
import type { SubAgentInput, SubAgentOutput, SceneType } from '../core/types.js';

interface ZusammenfassungPlan {
  script: string;
  title: string;
  bulletPoints: Array<{ icon: string; text: string }>;
  closingMessage: string;
}

export class ZusammenfassungAgent extends BaseAgent {
  readonly type: SceneType = 'zusammenfassung';

  async execute(input: SubAgentInput): Promise<SubAgentOutput> {
    this.log.info({ scene: input.sceneSpec.title }, 'Starting zusammenfassung agent v3');

    const maxWords = this.estimateWordCount(input.sceneSpec.timeBudget);
    const isGerman = input.language === 'de';
    const plan = await this.generatePlanJSON<ZusammenfassungPlan>(
      isGerman
        ? `Erstelle eine Zusammenfassungs-Szene für ein Erklärvideo.

Thema: ${input.sceneSpec.content}
Zeitbudget: ${input.sceneSpec.timeBudget} Sekunden (ca. ${maxWords} Wörter)
Sprache: Deutsch

Respond as JSON:
{
  "script": "Zusammenfassender Narrations-Text der JEDEN Kernpunkt erwähnt...",
  "title": "Das Wichtigste auf einen Blick",
  "bulletPoints": [{"icon": "📌", "text": "Kernpunkt 1"}, ...],
  "closingMessage": "Merke dir: Kurze Schlussfolgerung..."
}
Maximal 6 Bulletpoints, mindestens 3. Wähle passende Emojis.`
        : `Create a summary scene for an educational explainer video.

Topic: ${input.sceneSpec.content}
Time budget: ${input.sceneSpec.timeBudget} seconds (approx. ${maxWords} words)
Language: English

Respond as JSON:
{
  "script": "Summary narration text that mentions EACH key point...",
  "title": "Key Takeaways",
  "bulletPoints": [{"icon": "📌", "text": "Key point 1"}, ...],
  "closingMessage": "Remember: Brief conclusion..."
}
Maximum 6 bullet points, minimum 3. Choose fitting emojis.`,
      isGerman
        ? 'Du bist ein Experte für knappe, strukturierte Zusammenfassungen.'
        : 'You are an expert in concise, structured summaries.'
    );

    const audio = await this.synthesizeSpeech(plan.script, input.workDir, 'zusammenfassung_audio', input.voiceId);
    const duration = audio.durationSeconds;

    // ── Segment-driven timeline ──
    const segments = await this.segmentScript(plan.script, duration, 'zusammenfassung', input.language);
    const timeline = this.buildTimelineFromSegments(segments, duration);

    const bulletData: BulletListData = {
      title: plan.title,
      items: plan.bulletPoints,
      footer: plan.closingMessage,
    };

    let visibleItemCount = 0;
    const videoPath = await this.renderScene('zusammenfassung', duration, input.workDir, audio.filePath,
      (rc, anim) => {
        visibleItemCount = 0;
        for (let i = 0; i < plan.bulletPoints.length; i++) {
          if ((anim[`item${i}Opacity`] ?? 0) > 0.1) visibleItemCount = i + 1;
        }
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
}
