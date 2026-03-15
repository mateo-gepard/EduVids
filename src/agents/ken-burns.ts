// ═══════════════════════════════════════════════════════════════════════════
// EduVid AI — Ken Burns Agent v3
// Fixed: uses drawSolidBackground + proper scheme properties
// Segment-driven: captions sync to narration segments
// ═══════════════════════════════════════════════════════════════════════════

import { BaseAgent } from './base.js';
import { loadImage } from 'canvas';
import { easing } from '../rendering/animations.js';
import {
  drawBackground, drawSolidBackground, drawText,
  drawRoundedRect, drawSceneTypeBadge, drawSegmentIndicator,
  type RenderContext,
} from '../rendering/renderer.js';
import { fontString, colors, layout, CANVAS_WIDTH, CANVAS_HEIGHT } from '../rendering/designSystem.js';
import { getActiveSegment, findSegmentsByCuePrefix } from '../rendering/narrationSegmenter.js';
import type { CueKeyword } from '../rendering/sttSync.js';
import type { SubAgentInput, SubAgentOutput, SceneType } from '../core/types.js';

interface KenBurnsPlan {
  script: string;
  imageQuery: string;
  captions: Array<{ text: string; timestamp: number }>;
  era?: string;
  direction: 'zoom-in' | 'zoom-out' | 'pan-left' | 'pan-right';
}

export class KenBurnsAgent extends BaseAgent {
  readonly type: SceneType = 'ken-burns';

  async execute(input: SubAgentInput): Promise<SubAgentOutput> {
    this.log.info({ scene: input.sceneSpec.title }, 'Starting Ken Burns agent v3');

    const maxWords = this.estimateWordCount(input.sceneSpec.timeBudget);
    const isGerman = input.language === 'de';
    const directed = this.getDirectedScript(input);
    let planPrompt = isGerman
        ? `Erstelle eine Ken-Burns-Szene (langsamer Zoom/Schwenk über ein historisches Bild).

Thema: ${input.sceneSpec.content}
Zeitbudget: ${input.sceneSpec.timeBudget} Sekunden (ca. ${maxWords} Wörter)
Sprache: Deutsch

Respond as JSON:
{
  "script": "Atmosphärischer Narrations-Text...",
  "imageQuery": "Suchbegriff für Google Images",
  "captions": [{"text": "Kurze Beschriftung 1", "timestamp": 2}, ...],
  "era": "(korrekte Jahreszahl oder Zeitraum passend zum Thema, z.B. '1905' oder '1915-1920')",
  "direction": "zoom-in"
}
WICHTIG: Das "era" Feld MUSS den tatsächlichen historischen Zeitraum des Themas widerspiegeln. Verwende NICHT einfach ein Beispiel.`
        : `Create a Ken Burns scene (slow zoom/pan over a historical image).

Topic: ${input.sceneSpec.content}
Time budget: ${input.sceneSpec.timeBudget} seconds (approx. ${maxWords} words)
Language: English

Respond as JSON:
{
  "script": "Atmospheric narration text...",
  "imageQuery": "Search term for Google Images",
  "captions": [{"text": "Short caption 1", "timestamp": 2}, ...],
  "era": "(correct year or year range matching the topic, e.g. '1905' or '1915-1920')",
  "direction": "zoom-in"
}
IMPORTANT: The "era" field MUST reflect the actual historical time period of the topic. Do NOT just copy an example value.`;
    if (directed) planPrompt = this.withDirectedScript(planPrompt, directed, isGerman);
    const plan = await this.generatePlanJSON<KenBurnsPlan>(
      planPrompt,
      isGerman
        ? 'Du bist ein atmosphärischer Geschichten-Erzähler mit Expertise in visueller Narration.'
        : 'You are an atmospheric storyteller with expertise in visual narration.'
    );

    // TTS
    const audio = await this.synthesizeSpeech(plan.script, input.workDir, 'kenburns_audio', input.voiceId);
    const duration = audio.durationSeconds;

    // Image search
    const { localPath: imagePath } = await this.searchAndDownloadImage(
      plan.imageQuery, input.workDir, 'kenburns_image'
    );

    // ── STT-synced segmentation ──
    const cueKeywords: CueKeyword[] = [
      { visualCue: 'establish_scene', triggerPhrase: plan.script.split(' ').slice(0, 3).join(' ') },
      ...plan.captions.map((c, i) => ({
        visualCue: `caption:${i}`,
        triggerPhrase: c.text.split(' ').slice(0, 3).join(' '),
      })),
      { visualCue: 'fade_out', triggerPhrase: plan.script.split('.').pop()?.trim().split(' ').slice(0, 3).join(' ') || 'end' },
    ];
    const { segments } = await this.segmentScriptWithSTT(plan.script, audio.filePath, duration, cueKeywords);
    const timeline = this.buildTimelineFromSegments(segments, duration);

    // Ken Burns zoom factor (continuous across full duration)
    const isZoomIn = plan.direction === 'zoom-in';
    timeline.add({
      startTime: 0, duration,
      easing: easing.linear,
      properties: {
        zoomFactor: isZoomIn ? [1, 1.25] : [1.25, 1],
        panX: plan.direction === 'pan-left' ? [0, -100] :
              plan.direction === 'pan-right' ? [0, 100] : [0, 0],
      },
    });

    // Era stamp typewriter (synced to establish_scene segment)
    const establishSeg = segments.find(s => s.visualCue === 'establish_scene');
    if (plan.era && establishSeg) {
      timeline.add({
        startTime: establishSeg.estimatedStart + 0.3,
        duration: Math.max(0.5, establishSeg.estimatedEnd - establishSeg.estimatedStart - 0.3),
        easing: easing.linear,
        properties: { revealProgress: [0, 1] },
      });
    }

    const captions = plan.captions;
    const era = plan.era;
    const captionSegments = findSegmentsByCuePrefix(segments, 'caption:');

    // Pre-load the downloaded image for actual Ken Burns rendering
    let kenBurnsImage: Awaited<ReturnType<typeof loadImage>> | null = null;
    if (imagePath) {
      try {
        kenBurnsImage = await loadImage(imagePath);
      } catch (e) {
        this.log.warn({ error: (e as Error).message }, 'Failed to load Ken Burns image, using gradient fallback');
      }
    }

    const videoPath = await this.renderScene('ken-burns', duration, input.workDir, audio.filePath,
      (rc, anim) => {
        const { ctx, width, height, scheme } = rc;

        // Draw actual image with Ken Burns zoom/pan, or fallback to gradient
        const zoom = anim.zoomFactor ?? 1;
        const panX = anim.panX ?? 0;

        if (kenBurnsImage) {
          ctx.save();
          const cx = width / 2;
          const cy = height / 2;
          ctx.translate(cx + panX, cy);
          ctx.scale(zoom, zoom);
          ctx.translate(-cx, -cy);

          // Cover-fit image to canvas
          const imgAspect = kenBurnsImage.width / kenBurnsImage.height;
          const canvasAspect = width / height;
          let dw: number, dh: number, dx: number, dy: number;
          if (imgAspect > canvasAspect) {
            dh = height;
            dw = height * imgAspect;
          } else {
            dw = width;
            dh = width / imgAspect;
          }
          dx = (width - dw) / 2;
          dy = (height - dh) / 2;
          ctx.drawImage(kenBurnsImage, dx, dy, dw, dh);
          ctx.restore();
        } else {
          drawSolidBackground(rc, colors.bg.primary, true);
        }

        // Vignette overlay
        const vignette = ctx.createRadialGradient(
          width / 2 + panX, height / 2, height * 0.2,
          width / 2, height / 2, height * 0.85
        );
        vignette.addColorStop(0, 'transparent');
        vignette.addColorStop(1, 'rgba(0, 0, 0, 0.6)');
        ctx.fillStyle = vignette;
        ctx.fillRect(0, 0, width, height);

        drawSceneTypeBadge(rc, '🖼️ Ken Burns');

        // Era stamp (typewriter, synced to establish_scene)
        // Only render if era is a valid year or year range (e.g. "1945" or "1939-1945")
        const validEra = era && /^\d{4}(\s*[-–]\s*\d{4})?$/.test(era.trim());
        if (validEra) {
          const cleanEra = era!.trim();
          const revealProgress = anim.revealProgress ?? 1;
          const eraText = cleanEra.slice(0, Math.floor(cleanEra.length * revealProgress));
          ctx.save();
          ctx.font = fontString('code', 'md');
          ctx.fillStyle = scheme.accent;
          ctx.globalAlpha = 0.7;
          ctx.fillText(eraText, layout.margin.x, layout.margin.y + 10);
          // Blinking cursor
          if (revealProgress < 1 && Math.floor(rc.time * 3) % 2 === 0) {
            const cursorX = ctx.measureText(eraText).width;
            ctx.fillRect(layout.margin.x + cursorX + 2, layout.margin.y + 10, 2, 26);
          }
          ctx.restore();
        }

        // Floating captions — compact card, synced to segment timing
        for (let i = 0; i < captions.length; i++) {
          const capOpacity = anim[`cap${i}Opacity`] ?? 0;
          const capOffsetY = anim[`cap${i}OffsetY`] ?? 20;
          if (capOpacity > 0.01) {
            ctx.save();
            ctx.globalAlpha = capOpacity;
            // Measure text to size the card to content, not full-width
            ctx.font = fontString('body', 'sm');
            const textW = Math.min(ctx.measureText(captions[i].text).width + 48, width * 0.6);
            const cardH = 56;
            const cardX = layout.margin.x + 20;
            const capY = height * 0.72 + capOffsetY;
            drawRoundedRect(ctx, cardX, capY, textW, cardH, 12,
              'rgba(0, 0, 0, 0.7)');
            // Accent left border
            ctx.fillStyle = scheme.accent;
            drawRoundedRect(ctx, cardX, capY, 4, cardH, 2, scheme.accent);
            drawText(rc, captions[i].text, cardX + 18, capY + 14, {
              font: fontString('body', 'sm'),
              color: '#FFFFFF',
              maxWidth: textW - 36,
            });
            ctx.restore();
          }
        }

        // Segment progress indicator
        const { index, progress } = getActiveSegment(segments, rc.time);
        drawSegmentIndicator(rc, height - 20, segments.length, index, progress);
      },
      timeline
    );

    return {
      sceneId: input.sceneSpec.id,
      sceneType: 'ken-burns',
      audio,
      visuals: [{ type: 'video', filePath: videoPath, durationSeconds: duration }],
      script: plan.script,
      durationSeconds: duration,
      segments,
    };
  }
}
