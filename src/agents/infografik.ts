// ═══════════════════════════════════════════════════════════════════════════
// EduVid AI — Infografik Agent v5
// Keyword reveal: find labeled diagram, OCR it, cover labels with
// background-colored boxes, reveal each label when the narrator says it.
// ═══════════════════════════════════════════════════════════════════════════

import { createCanvas, loadImage, type Image, type CanvasRenderingContext2D } from 'canvas';
import { BaseAgent } from './base.js';
import { generateJSON } from '../services/llm.js';
import { searchImages, downloadImage } from '../services/imageSearch.js';
import { recognizeText, checkKeywordCoverage, findKeywordBoundingBoxes } from '../services/ocr.js';
import { easing } from '../rendering/animations.js';
import {
  drawBackground, drawText, drawCard, drawRoundedRect,
  drawSceneTypeBadge, drawSegmentIndicator,
  type RenderContext,
} from '../rendering/renderer.js';
import { fontString, colors, layout, CANVAS_WIDTH, CANVAS_HEIGHT } from '../rendering/designSystem.js';
import { getActiveSegment } from '../rendering/narrationSegmenter.js';
import type { SubAgentInput, SubAgentOutput, SceneType, NarrationSegment } from '../core/types.js';
import type { CueKeyword } from '../rendering/sttSync.js';

interface InfografikPlan {
  script: string;
  keywords: string[];
  imageSearchQueries: string[];
}

/** A keyword overlay: canvas-space bounding box + sampled background color */
interface KeywordOverlay {
  keyword: string;
  canvasBox: { x: number; y: number; width: number; height: number };
  bgColor: string;
}

const MAX_IMAGE_RETRIES = 3;
const KEYWORD_COVERAGE_THRESHOLD = 0.6;

export class InfografikAgent extends BaseAgent {
  readonly type: SceneType = 'infografik';

  async execute(input: SubAgentInput): Promise<SubAgentOutput> {
    this.log.info({ scene: input.sceneSpec.title }, 'Starting infografik pipeline v5');

    // ── Step 1: Generate plan (script + keywords + image queries) ──
    const directed = this.getDirectedScript(input);
    let plan = await this.generatePlan(input, undefined, directed);
    if (!plan.keywords || plan.keywords.length === 0) plan.keywords = [input.sceneSpec.title];
    if (!plan.imageSearchQueries || plan.imageSearchQueries.length === 0) {
      plan.imageSearchQueries = [`${input.sceneSpec.title} labeled diagram`];
    }
    this.log.info({ keywords: plan.keywords, queries: plan.imageSearchQueries.length }, 'Plan generated');

    // ── Step 2: TTS with duration-aware retry ──
    let finalScript: string;
    let audio: import('../core/types.js').AudioResult;
    if (directed) {
      audio = await this.synthesizeSpeech(directed, input.workDir, 'infografik_audio', input.voiceId);
      finalScript = directed;
    } else {
      const result = await this.synthesizeSpeechForBudget(
        plan.script, input.sceneSpec.timeBudget, input.workDir, 'infografik_audio',
        async (targetWords) => {
          const replan = await this.generatePlan(input, targetWords);
          plan.script = replan.script;
          if (replan.keywords?.length) plan.keywords = replan.keywords;
          return replan.script;
        },
        input.voiceId,
      );
      audio = result.audio;
      finalScript = result.script;
    }
    plan.script = finalScript;
    const duration = audio.durationSeconds;

    // ── Step 3: Find infographic image + OCR keyword locations ──
    let loadedImage: Image | null = null;
    let keywordOverlays: KeywordOverlay[] = [];

    try {
      const result = await this.findInfographicWithKeywords(plan, input.workDir);
      if (result) {
        loadedImage = result.image;
        keywordOverlays = result.overlays;
        this.log.info(
          { imageSize: `${loadedImage.width}x${loadedImage.height}`, overlays: keywordOverlays.length },
          'Infographic loaded with keyword overlays'
        );
      }
    } catch (err) {
      this.log.warn({ error: (err as Error).message }, 'Infographic search failed — using fallback');
    }

    // ── Step 4: STT sync — each keyword becomes a cue ──
    const cueKeywords: CueKeyword[] = [
      { visualCue: 'establish', triggerPhrase: plan.script.split(' ').slice(0, 3).join(' ') },
      ...plan.keywords.map((kw, i) => ({
        visualCue: `keyword:${i}`,
        triggerPhrase: kw,
      })),
      { visualCue: 'fade_out', triggerPhrase: plan.script.split('.').pop()?.trim().split(' ').slice(0, 3).join(' ') || 'end' },
    ];
    const { segments } = await this.segmentScriptWithSTT(plan.script, audio.filePath, duration, cueKeywords);
    const timeline = this.buildTimelineFromSegments(segments, duration);

    // ── Step 5: Render ──
    const capturedImage = loadedImage;
    const capturedOverlays = keywordOverlays;
    const keywords = plan.keywords;

    const videoPath = await this.renderScene('infografik', duration, input.workDir, audio.filePath,
      (rc, anim) => {
        const globalAlpha = anim.opacity ?? 1;
        rc.ctx.save();
        rc.ctx.globalAlpha = globalAlpha;

        if (capturedImage && capturedOverlays.length > 0) {
          this.renderImageWithKeywordReveal(rc, capturedImage, capturedOverlays, segments);
        } else {
          this.renderFallbackLayout(rc, keywords, segments);
        }

        rc.ctx.restore();

        drawSceneTypeBadge(rc, '📊 Infografik');
        const { index, progress } = getActiveSegment(segments, rc.time);
        drawSegmentIndicator(rc, rc.height - 20, segments.length, index, progress);
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

  // ═════════════════════════════════════════════════════════════════════════
  // Rendering modes
  // ═════════════════════════════════════════════════════════════════════════

  /** Full-screen infographic with keyword cover/reveal animation */
  private renderImageWithKeywordReveal(
    rc: RenderContext,
    image: Image,
    overlays: KeywordOverlay[],
    segments: NarrationSegment[],
  ): void {
    const { ctx, width, height } = rc;

    // Draw infographic image cover-fit
    const imgRatio = image.width / image.height;
    const canvasRatio = width / height;
    let sx: number, sy: number, sw: number, sh: number;
    if (imgRatio > canvasRatio) {
      sh = image.height; sw = image.height * canvasRatio;
      sx = (image.width - sw) / 2; sy = 0;
    } else {
      sw = image.width; sh = image.width / canvasRatio;
      sx = 0; sy = (image.height - sh) / 2;
    }
    ctx.drawImage(image, sx, sy, sw, sh, 0, 0, width, height);

    // Subtle gradient overlay at top for badge readability
    const grad = ctx.createLinearGradient(0, 0, 0, 90);
    grad.addColorStop(0, 'rgba(0, 0, 0, 0.35)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, 90);

    // Keyword cover/reveal
    for (let i = 0; i < overlays.length; i++) {
      const overlay = overlays[i];
      const seg = segments.find(s => s.visualCue === `keyword:${i}`);
      const revealTime = seg ? rc.time - seg.estimatedStart : -1;
      const revealed = revealTime >= 0;
      const box = overlay.canvasBox;
      const pad = 6;

      if (!revealed) {
        // Cover box — matches image background color, hides the label
        ctx.save();
        ctx.fillStyle = overlay.bgColor;
        ctx.fillRect(box.x - pad, box.y - pad, box.width + pad * 2, box.height + pad * 2);

        // Subtle "?" hint
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${Math.min(Math.round(box.height * 0.7), 22)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('?', box.x + box.width / 2, box.y + box.height / 2);
        ctx.restore();
      } else if (revealTime < 0.8) {
        // Reveal animation — box shrinks + fades
        const progress = revealTime / 0.8;
        const ease = 1 - Math.pow(1 - progress, 3); // easeOutCubic
        const shrink = 1 - ease;

        ctx.save();
        ctx.globalAlpha = 1 - ease;
        ctx.fillStyle = overlay.bgColor;
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        const w = (box.width + pad * 2) * shrink;
        const h = (box.height + pad * 2) * shrink;
        ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
        ctx.restore();

        // Highlight glow around the revealed keyword
        ctx.save();
        ctx.strokeStyle = rc.scheme.accent;
        ctx.lineWidth = 3;
        ctx.globalAlpha = 1 - ease;
        ctx.strokeRect(box.x - pad - 2, box.y - pad - 2, box.width + pad * 2 + 4, box.height + pad * 2 + 4);
        ctx.restore();
      }
      // After 0.8s: keyword is fully visible — no overlay drawn
    }
  }

  /** Fallback: numbered concept cards when no infographic image was found */
  private renderFallbackLayout(
    rc: RenderContext,
    keywords: string[],
    segments: NarrationSegment[],
  ): void {
    drawBackground(rc);

    // Full-width stacked concept cards (like a summary list)
    const startY = layout.margin.y + 60;
    const availableH = rc.height - startY - layout.margin.y - 20;
    const maxItems = Math.min(keywords.length, 6);
    const cardH = Math.min(130, Math.floor(availableH / Math.max(maxItems, 1)) - 14);

    for (let i = 0; i < maxItems; i++) {
      const cy = startY + i * (cardH + 14);

      const seg = segments.find(s => s.visualCue === `keyword:${i}`);
      const revealed = seg ? rc.time >= seg.estimatedStart : false;

      rc.ctx.save();
      rc.ctx.globalAlpha = revealed ? 1 : 0.12;

      drawCard(rc, layout.margin.x, cy, layout.contentWidth, cardH, {
        fill: revealed ? rc.scheme.accentBg : colors.bg.card,
        borderColor: revealed ? rc.scheme.cardBorder : colors.bg.muted,
        accentSide: 'left',
        accentColor: rc.scheme.accent,
      });

      // Number circle
      const circleX = layout.margin.x + 44;
      const circleY = cy + cardH / 2;
      rc.ctx.beginPath();
      rc.ctx.arc(circleX, circleY, 22, 0, Math.PI * 2);
      rc.ctx.fillStyle = revealed ? rc.scheme.accent : colors.bg.muted;
      rc.ctx.fill();
      rc.ctx.font = fontString('bold', 'sm');
      rc.ctx.fillStyle = '#FFFFFF';
      rc.ctx.textAlign = 'center';
      rc.ctx.textBaseline = 'middle';
      rc.ctx.fillText(String(i + 1), circleX, circleY);
      rc.ctx.textBaseline = 'top';
      rc.ctx.textAlign = 'left';

      // Concept text — full phrase, readable size
      drawText(rc, keywords[i], layout.margin.x + 82, cy + (cardH - 30) / 2, {
        font: fontString('bold', 'md'),
        color: revealed ? colors.text.primary : colors.text.muted,
        maxWidth: layout.contentWidth - 120,
      });

      rc.ctx.restore();
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Image search + OCR + keyword localization pipeline
  // ═════════════════════════════════════════════════════════════════════════

  private async findInfographicWithKeywords(
    plan: InfografikPlan,
    workDir: string,
  ): Promise<{ image: Image; overlays: KeywordOverlay[] } | null> {
    for (let attempt = 0; attempt < MAX_IMAGE_RETRIES; attempt++) {
      try {
        const queryIndex = Math.min(attempt, plan.imageSearchQueries.length - 1);
        const query = plan.imageSearchQueries[queryIndex];
        this.log.info({ attempt: attempt + 1, query }, 'Searching for infographic image');

        const results = await searchImages(query, 5, { preferDiagram: true });

        for (let imgIdx = 0; imgIdx < results.length; imgIdx++) {
          try {
            const imgPath = await downloadImage(
              results[imgIdx].url, workDir, `infografik_${attempt}_${imgIdx}`
            );
            // OCR the image
            const ocrResult = await recognizeText(imgPath);
            const coverage = checkKeywordCoverage(ocrResult, plan.keywords, KEYWORD_COVERAGE_THRESHOLD);

            this.log.info(
              { matched: coverage.matchedCount, total: coverage.totalKeywords, passed: coverage.passed, imgIdx },
              'Image OCR coverage check'
            );

            if (!coverage.passed) continue;

            // Get precise bounding boxes for all matched keywords
            const kwBoxes = findKeywordBoundingBoxes(ocrResult, coverage.matchedKeywords);
            if (kwBoxes.length === 0) {
              this.log.info('Coverage passed but no bounding boxes found, skipping');
              continue;
            }

            // Load the image for rendering
            const image = await loadImage(imgPath);
            // Compute canvas-space overlays with sampled background colors
            const overlays = this.computeKeywordOverlays(image, kwBoxes);

            this.log.info(
              { overlays: overlays.length, image: `${image.width}x${image.height}` },
              'Valid infographic with keyword overlays'
            );
            return { image, overlays };
          } catch (imgErr) {
            this.log.warn({ imgIdx, error: (imgErr as Error).message }, 'Image processing failed');
          }
        }
        this.log.warn({ attempt: attempt + 1 }, 'No image passed coverage + bounding box check');
      } catch (err) {
        this.log.warn({ attempt: attempt + 1, error: (err as Error).message }, 'Search attempt failed');
      }
    }
    return null;
  }

  /**
   * Transform OCR bounding boxes from image coordinates → canvas coordinates.
   * Sample the background color around each keyword box by drawing to a temp canvas.
   */
  private computeKeywordOverlays(
    image: Image,
    keywordBoxes: Array<{ keyword: string; box: { x: number; y: number; width: number; height: number } }>,
  ): KeywordOverlay[] {
    // Compute cover-fit transform (same math as render callback)
    const imgRatio = image.width / image.height;
    const canvasRatio = CANVAS_WIDTH / CANVAS_HEIGHT;
    let sx: number, sy: number, sw: number, sh: number;
    if (imgRatio > canvasRatio) {
      sh = image.height; sw = image.height * canvasRatio;
      sx = (image.width - sw) / 2; sy = 0;
    } else {
      sw = image.width; sh = image.width / canvasRatio;
      sx = 0; sy = (image.height - sh) / 2;
    }

    // Draw image to temp canvas for color sampling
    const tempCanvas = createCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.drawImage(image, sx, sy, sw, sh, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    const overlays: KeywordOverlay[] = [];

    for (const { keyword, box } of keywordBoxes) {
      // Transform from image coords → canvas coords
      const canvasBox = {
        x: (box.x - sx) / sw * CANVAS_WIDTH,
        y: (box.y - sy) / sh * CANVAS_HEIGHT,
        width: box.width / sw * CANVAS_WIDTH,
        height: box.height / sh * CANVAS_HEIGHT,
      };

      // Skip if outside visible area
      if (canvasBox.x + canvasBox.width < 0 || canvasBox.x > CANVAS_WIDTH ||
          canvasBox.y + canvasBox.height < 0 || canvasBox.y > CANVAS_HEIGHT) continue;

      // Clamp to canvas bounds
      canvasBox.x = Math.max(0, canvasBox.x);
      canvasBox.y = Math.max(0, canvasBox.y);
      canvasBox.width = Math.min(CANVAS_WIDTH - canvasBox.x, canvasBox.width);
      canvasBox.height = Math.min(CANVAS_HEIGHT - canvasBox.y, canvasBox.height);

      // Sample background color from pixels around the bounding box edges
      const bgColor = this.sampleBackgroundColor(tempCtx, canvasBox);
      overlays.push({ keyword, canvasBox, bgColor });
    }

    return overlays;
  }

  /**
   * Sample the median color from pixels just outside a bounding box.
   * This gives a good match for the background behind text labels.
   */
  private sampleBackgroundColor(
    ctx: CanvasRenderingContext2D,
    box: { x: number; y: number; width: number; height: number },
  ): string {
    const pad = 8;
    const samples: [number, number, number][] = [];

    const regions = [
      { x: Math.round(box.x), y: Math.max(0, Math.round(box.y - pad)), w: Math.round(box.width), h: pad },
      { x: Math.round(box.x), y: Math.round(box.y + box.height), w: Math.round(box.width), h: pad },
      { x: Math.max(0, Math.round(box.x - pad)), y: Math.round(box.y), w: pad, h: Math.round(box.height) },
      { x: Math.round(box.x + box.width), y: Math.round(box.y), w: pad, h: Math.round(box.height) },
    ];

    for (const region of regions) {
      const rw = Math.max(1, Math.min(region.w, CANVAS_WIDTH - region.x));
      const rh = Math.max(1, Math.min(region.h, CANVAS_HEIGHT - region.y));
      if (region.x < 0 || region.y < 0 || region.x >= CANVAS_WIDTH || region.y >= CANVAS_HEIGHT) continue;

      try {
        const imgData = ctx.getImageData(region.x, region.y, rw, rh);
        for (let i = 0; i < imgData.data.length; i += 16) { // every 4th pixel for speed
          samples.push([imgData.data[i], imgData.data[i + 1], imgData.data[i + 2]]);
        }
      } catch { /* out of bounds, skip */ }
    }

    if (samples.length === 0) return 'rgb(240, 240, 240)';

    // Median is more robust than average for mixed backgrounds
    const sorted = (arr: number[]) => [...arr].sort((a, b) => a - b);
    const medianOf = (arr: number[]) => sorted(arr)[Math.floor(arr.length / 2)];

    const r = medianOf(samples.map(s => s[0]));
    const g = medianOf(samples.map(s => s[1]));
    const b = medianOf(samples.map(s => s[2]));

    return `rgb(${r}, ${g}, ${b})`;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // LLM Plan generation
  // ═════════════════════════════════════════════════════════════════════════

  private async generatePlan(input: SubAgentInput, wordCountOverride?: number, directedScript?: string): Promise<InfografikPlan> {
    const maxWords = wordCountOverride ?? this.estimateWordCount(input.sceneSpec.timeBudget);
    const isGerman = input.language === 'de';

    let prompt = isGerman
      ? `Du erstellst eine Infografik-Szene für ein Erklärvideo.

Thema: ${input.sceneSpec.content}
Sprache: Deutsch
Zeitbudget: ${input.sceneSpec.timeBudget} Sekunden (ca. ${maxWords} Wörter)

Erstelle ein JSON-Objekt mit:
1. "script": Der Narrations-Text (ca. ${maxWords} Wörter). MUSS JEDES Konzept einzeln erwähnen und erklären.
2. "keywords": Genau 4-6 Schlüsselkonzepte als kurze, aussagekräftige Phrasen (je 2-6 Wörter). Jedes muss ein **erklärtes Konzept oder eine Erkenntnis** sein, KEIN einzelnes Schlagwort. Beispiel: "Energie-Masse-Äquivalenz", "Zeitdilatation bei hoher Geschwindigkeit", "Krümmung der Raumzeit".
3. "imageSearchQueries": 3-5 Suchbegriffe um ein BESCHRIFTETES DIAGRAMM oder INFOGRAFIK zu finden.
WICHTIG: Jedes Konzept MUSS explizit im Script erwähnt werden, damit die Audio-Erwähnung die visuelle Enthüllung auslöst.`
      : `You are creating an infographic scene for an educational explainer video.

Topic: ${input.sceneSpec.content}
Language: English
Time budget: ${input.sceneSpec.timeBudget} seconds (approx. ${maxWords} words)

Create a JSON object with:
1. "script": Narration text (approx. ${maxWords} words) that explains the topic. MUST explicitly mention and explain EACH concept.
2. "keywords": Exactly 4-6 key concepts as short, meaningful phrases (2-6 words each). Each must be an **explained concept or finding**, NOT a single buzzword. Example: "Energy-mass equivalence", "Time dilation at high speeds", "Curvature of spacetime".
3. "imageSearchQueries": 3-5 search queries to find a LABELED DIAGRAM or INFOGRAPHIC image.
IMPORTANT: Each concept MUST be explicitly mentioned in the script so the narrator's audio triggers its visual reveal.`;

    if (directedScript) prompt = this.withDirectedScript(prompt, directedScript, isGerman);

    const systemPrompt = isGerman
      ? 'Du bist ein Experte für visuelle Bildungskommunikation und Infografiken.'
      : 'You are an expert in visual educational communication and infographics.';

    return generateJSON<InfografikPlan>(prompt, {
      systemPrompt,
      temperature: 0.5,
    });
  }
}
