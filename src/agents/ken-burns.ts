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
    const plan = await this.generatePlanJSON<KenBurnsPlan>(
      isGerman
        ? `Erstelle eine Ken-Burns-Szene (langsamer Zoom/Schwenk über ein historisches Bild).

Thema: ${input.sceneSpec.content}
Zeitbudget: ${input.sceneSpec.timeBudget} Sekunden (ca. ${maxWords} Wörter)
Sprache: Deutsch

Respond as JSON:
{
  "script": "Atmosphärischer Narrations-Text...",
  "imageQuery": "Suchbegriff für Google Images",
  "captions": [{"text": "Kurze Beschriftung 1", "timestamp": 2}, ...],
  "era": "1939-1945",
  "direction": "zoom-in"
}`
        : `Create a Ken Burns scene (slow zoom/pan over a historical image).

Topic: ${input.sceneSpec.content}
Time budget: ${input.sceneSpec.timeBudget} seconds (approx. ${maxWords} words)
Language: English

Respond as JSON:
{
  "script": "Atmospheric narration text...",
  "imageQuery": "Search term for Google Images",
  "captions": [{"text": "Short caption 1", "timestamp": 2}, ...],
  "era": "1939-1945",
  "direction": "zoom-in"
}`,
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

    // ── Segment-driven timeline ──
    const segments = await this.segmentScript(plan.script, duration, 'ken-burns', input.language);
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
        if (era) {
          const revealProgress = anim.revealProgress ?? 1;
          const eraText = era.slice(0, Math.floor(era.length * revealProgress));
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

        // Floating captions — synced to segment timing
        for (let i = 0; i < captions.length; i++) {
          const capOpacity = anim[`cap${i}Opacity`] ?? 0;
          const capOffsetY = anim[`cap${i}OffsetY`] ?? 20;
          if (capOpacity > 0.01) {
            ctx.save();
            ctx.globalAlpha = capOpacity;
            const capY = height * 0.7 + capOffsetY;
            drawRoundedRect(ctx, layout.margin.x, capY, width - layout.margin.x * 2, 50, 10,
              'rgba(255, 255, 255, 0.92)');
            // Accent left border
            ctx.fillStyle = scheme.accent;
            ctx.fillRect(layout.margin.x, capY, 4, 50);
            drawText(rc, captions[i].text, layout.margin.x + 20, capY + 12, {
              font: fontString('body', 'sm'),
              color: colors.text.primary,
              maxWidth: width - layout.margin.x * 2 - 40,
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
