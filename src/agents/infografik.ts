// ═══════════════════════════════════════════════════════════════════════════
// EduVid AI — Infografik Agent v4
// Enhanced: uses narration segmenter as STT fallback,
// segment-driven key point reveals
// ═══════════════════════════════════════════════════════════════════════════

import path from 'path';
import { loadImage, type Image } from 'canvas';
import { BaseAgent } from './base.js';
import { generateJSON } from '../services/llm.js';
import { searchImages, downloadImage } from '../services/imageSearch.js';
import { recognizeText, checkKeywordCoverage } from '../services/ocr.js';
import { AnimationTimeline, easing, presets } from '../rendering/animations.js';
import {
  drawBackground, drawText, drawCard, drawRoundedRect,
  drawSceneTypeBadge, drawLowerThird, drawSegmentIndicator,
  drawHighlightPulse, type RenderContext,
} from '../rendering/renderer.js';
import { fontString, colors, layout, CANVAS_WIDTH, CANVAS_HEIGHT } from '../rendering/designSystem.js';
import { getActiveSegment, findSegmentsByCuePrefix } from '../rendering/narrationSegmenter.js';
import type { SubAgentInput, SubAgentOutput, SceneType, NarrationSegment } from '../core/types.js';

interface InfografikPlan {
  script: string;
  keywords: string[];
  imageSearchQueries: string[];
  keyPoints: Array<{ label: string; description: string }>;
}

const MAX_IMAGE_RETRIES = 3;

export class InfografikAgent extends BaseAgent {
  readonly type: SceneType = 'infografik';

  async execute(input: SubAgentInput): Promise<SubAgentOutput> {
    this.log.info({ scene: input.sceneSpec.title }, 'Starting infografik pipeline v4');

    // ── Step 1: Generate plan ──
    const plan = await this.generatePlan(input);

    // Guard against empty arrays
    if (!plan.keywords || plan.keywords.length === 0) plan.keywords = ['Information'];
    if (!plan.keyPoints || plan.keyPoints.length === 0) {
      plan.keyPoints = [{ label: input.sceneSpec.title, description: input.sceneSpec.content.slice(0, 100) }];
    }
    if (!plan.imageSearchQueries || plan.imageSearchQueries.length === 0) {
      plan.imageSearchQueries = [input.sceneSpec.title];
    }

    this.log.info({ keywords: plan.keywords.length, keyPoints: plan.keyPoints.length }, 'Plan generated');

    // ── Step 2: TTS ──
    const audio = await this.synthesizeSpeech(plan.script, input.workDir, 'infografik_audio', input.voiceId);
    this.log.info({ duration: audio.durationSeconds }, 'Audio synthesized');

    // ── Step 3: Narration segmentation (replaces STT as primary sync) ──
    const duration = audio.durationSeconds;
    const segments = await this.segmentScript(plan.script, duration, 'infografik', input.language);
    const timeline = this.buildTimelineFromSegments(segments, duration);


    // ── Step 4: Find infographic image (graceful degradation) ──
    let loadedImage: Image | null = null;
    try {
      const imagePath = await this.findValidImage(plan, input.workDir);
      if (imagePath) {
        loadedImage = await loadImage(imagePath);
        this.log.info({ width: loadedImage.width, height: loadedImage.height }, 'Image pre-loaded');
      }
    } catch (err) {
      this.log.warn({ error: (err as Error).message }, 'Image search/OCR failed — using fallback layout');
    }

    // ── Step 5: Render with segment-driven reveals ──
    const keyPoints = plan.keyPoints;
    const capturedImage = loadedImage;
    const revealPointSegments = findSegmentsByCuePrefix(segments, 'reveal_point:');

    const videoPath = await this.renderScene('infografik', duration, input.workDir, audio.filePath,
      (rc, anim) => {
        drawBackground(rc);
        drawSceneTypeBadge(rc, '📊 Infografik');

        // Title
        drawText(rc, input.sceneSpec.title, layout.margin.x, layout.margin.y + 10, {
          font: fontString('heading', 'sm'),
          color: colors.text.primary,
          shadow: true,
        });

        const imgX = layout.margin.x;
        const imgY = layout.margin.y + 80;

        if (capturedImage) {
          // Draw pre-loaded image synchronously
          const imgW = rc.width * 0.55;
          const imgH = rc.height - imgY - layout.margin.y - 40;

          rc.ctx.save();
          rc.ctx.beginPath();
          rc.ctx.roundRect(imgX, imgY, imgW, imgH, 16);
          rc.ctx.clip();

          const imgRatio = capturedImage.width / capturedImage.height;
          const boxRatio = imgW / imgH;
          let sx = 0, sy = 0, sw = capturedImage.width, sh = capturedImage.height;
          if (imgRatio > boxRatio) { sw = capturedImage.height * boxRatio; sx = (capturedImage.width - sw) / 2; }
          else { sh = capturedImage.width / boxRatio; sy = (capturedImage.height - sh) / 2; }
          rc.ctx.drawImage(capturedImage, sx, sy, sw, sh, imgX, imgY, imgW, imgH);
          rc.ctx.restore();

          // Right side: key points panel
          const panelX = imgX + rc.width * 0.55 + 40;
          const panelW = rc.width - panelX - layout.margin.x;
          const pointH = 80;

          for (let i = 0; i < keyPoints.length; i++) {
            const py = imgY + i * (pointH + 12);

            // Use segment-driven reveals instead of STT-only
            const revealSeg = revealPointSegments.find(s => s.visualCue === `reveal_point:${i}`);
            const revealed = revealSeg ? rc.time >= revealSeg.estimatedStart : (anim[`point${i}Opacity`] ?? 0.3) > 0.5;
            const isActive = revealSeg && rc.time >= revealSeg.estimatedStart && rc.time < revealSeg.estimatedEnd;

            rc.ctx.save();
            rc.ctx.globalAlpha = revealed ? 1 : 0.2;

            drawCard(rc, panelX, py, panelW, pointH, {
              fill: revealed ? rc.scheme.accentBg : colors.bg.card,
              borderColor: revealed ? rc.scheme.cardBorder : colors.bg.muted,
              accentSide: revealed ? 'left' : 'none',
              accentColor: rc.scheme.accent,
            });

            // Highlight pulse on currently-active point
            if (isActive) {
              const pulseT = ((rc.time - revealSeg!.estimatedStart) * 2) % 1;
              drawHighlightPulse(rc, panelX, py, panelW, pointH, Math.sin(pulseT * Math.PI));
            }

            drawText(rc, keyPoints[i].label, panelX + 16, py + 12, {
              font: fontString('bold', 'xs'),
              color: revealed ? rc.scheme.accent : colors.text.muted,
              maxWidth: panelW - 32,
            });
            drawText(rc, keyPoints[i].description, panelX + 16, py + 42, {
              font: fontString('body', 'xs'),
              color: colors.text.secondary,
              maxWidth: panelW - 32,
            });

            rc.ctx.restore();
          }
        } else {
          // Fallback: render key points as card grid
          const cardW = (layout.contentWidth - layout.gutter) / 2;
          const cardH = 140;

          for (let i = 0; i < keyPoints.length; i++) {
            const col = i % 2;
            const row = Math.floor(i / 2);
            const cx = layout.margin.x + col * (cardW + layout.gutter);
            const cy = imgY + row * (cardH + 16);

            const revealSeg = revealPointSegments.find(s => s.visualCue === `reveal_point:${i}`);
            const revealed = revealSeg ? rc.time >= revealSeg.estimatedStart : (anim[`point${i}Opacity`] ?? 0.3) > 0.5;

            rc.ctx.save();
            rc.ctx.globalAlpha = revealed ? 1 : 0.15;

            drawCard(rc, cx, cy, cardW, cardH, {
              fill: revealed ? rc.scheme.accentBg : colors.bg.card,
              borderColor: revealed ? rc.scheme.cardBorder : colors.bg.muted,
              accentSide: 'top',
              accentColor: rc.scheme.accent,
            });

            drawRoundedRect(rc.ctx, cx + 16, cy + 14, 36, 36, 8, rc.scheme.badgeBg);
            rc.ctx.font = fontString('bold', 'sm');
            rc.ctx.fillStyle = rc.scheme.accent;
            rc.ctx.textAlign = 'center';
            rc.ctx.fillText(String(i + 1), cx + 34, cy + 22);

            drawText(rc, keyPoints[i].label, cx + 64, cy + 18, {
              font: fontString('bold', 'xs'),
              color: colors.text.primary,
              maxWidth: cardW - 90,
            });
            drawText(rc, keyPoints[i].description, cx + 64, cy + 50, {
              font: fontString('body', 'xs'),
              color: colors.text.secondary,
              maxWidth: cardW - 90,
            });

            rc.ctx.restore();
          }
        }

        // Lower third with current narration segment
        const { index: segIdx, progress: segProgress } = getActiveSegment(segments, rc.time);
        drawLowerThird(rc, segments[segIdx]?.text ?? '', 0.85);

        // Segment progress indicator
        drawSegmentIndicator(rc, rc.height - 20, segments.length, segIdx, segProgress);
      },
      timeline
    );

    return {
      sceneId: input.sceneSpec.id,
      sceneType: 'infografik',
      audio,
      visuals: [{ type: 'video', filePath: videoPath, durationSeconds: duration }],
      script: plan.script,
      durationSeconds: duration,
      segments,
    };
  }

  // ── Private Methods ──────────────────────────────────────────────────────

  private async generatePlan(input: SubAgentInput): Promise<InfografikPlan> {
    const maxWords = this.estimateWordCount(input.sceneSpec.timeBudget);
    const isGerman = input.language === 'de';

    const prompt = isGerman
      ? `Du erstellst eine Infografik-Szene für ein Erklärvideo.

Thema: ${input.sceneSpec.content}
Sprache: Deutsch
Zeitbudget: ${input.sceneSpec.timeBudget} Sekunden (ca. ${maxWords} Wörter)

Erstelle ein JSON-Objekt mit:
1. "script": Der Narrations-Text (ca. ${maxWords} Wörter). MUSS JEDEN Kernpunkt einzeln erwähnen und erklären.
2. "keywords": 5-8 Schlüsselwörter die schrittweise enthüllt werden.
3. "imageSearchQueries": 3-5 Google-Suchbegriffe für eine passende Infografik.
4. "keyPoints": 4-6 strukturierte Kernpunkte, jeder mit "label" und "description".`
      : `You are creating an infographic scene for an educational explainer video.

Topic: ${input.sceneSpec.content}
Language: English
Time budget: ${input.sceneSpec.timeBudget} seconds (approx. ${maxWords} words)

Create a JSON object with:
1. "script": The narration text (approx. ${maxWords} words). MUST explicitly mention and explain EACH key point individually.
2. "keywords": 5-8 keywords that are revealed step by step.
3. "imageSearchQueries": 3-5 Google search terms for a suitable infographic.
4. "keyPoints": 4-6 structured key points, each with "label" and "description".`;

    const systemPrompt = isGerman
      ? 'Du bist ein Experte für visuelle Bildungskommunikation.'
      : 'You are an expert in visual educational communication.';

    return generateJSON<InfografikPlan>(prompt, {
      systemPrompt,
      temperature: 0.5,
    });
  }

  private async findValidImage(plan: InfografikPlan, workDir: string): Promise<string | null> {
    for (let attempt = 0; attempt < MAX_IMAGE_RETRIES; attempt++) {
      try {
        const queryIndex = Math.min(attempt, plan.imageSearchQueries.length - 1);
        const query = plan.imageSearchQueries[queryIndex];
        this.log.info({ attempt: attempt + 1, query }, 'Searching for infographic image');

        const results = await searchImages(query, 5);

        for (let imgIdx = 0; imgIdx < results.length; imgIdx++) {
          try {
            const imgPath = await downloadImage(
              results[imgIdx].url, workDir, `infografik_candidate_${attempt}_${imgIdx}`
            );
            const ocrResult = await recognizeText(imgPath);
            const coverage = checkKeywordCoverage(ocrResult, plan.keywords, 0.8);
            this.log.info(
              { matched: coverage.matchedCount, total: coverage.totalKeywords, passed: coverage.passed },
              `Image ${imgIdx} OCR check`
            );

            if (coverage.passed) return imgPath;
          } catch (imgErr) {
            this.log.warn(
              { imgIdx, error: (imgErr as Error).message },
              'Individual image download/OCR failed, trying next'
            );
          }
        }
        this.log.warn({ attempt: attempt + 1 }, 'No image passed coverage check');
      } catch (err) {
        this.log.warn(
          { attempt: attempt + 1, error: (err as Error).message },
          'Image search attempt failed'
        );
      }
    }
    return null;
  }
}
