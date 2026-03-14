// ═══════════════════════════════════════════════════════════════════════════
// EduVid AI — Core Frame Renderer v2
// Clean, bright educational canvas rendering engine
// ═══════════════════════════════════════════════════════════════════════════

import { createCanvas, type Canvas, type CanvasRenderingContext2D, loadImage, registerFont } from 'canvas';
import fs from 'fs/promises';
import path from 'path';
import {
  CANVAS_WIDTH, CANVAS_HEIGHT, FPS,
  colors, fonts, fontString, layout, effects,
  sceneColors, type SceneColorScheme,
} from './designSystem.js';
import { type AnimatedProperties } from './animations.js';
import { createLogger } from '../core/logger.js';

const log = createLogger({ module: 'renderer' });

// ── Types ────────────────────────────────────────────────────────────────────

export interface RenderContext {
  canvas: Canvas;
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  scheme: SceneColorScheme;
  time: number;
  frame: number;
  totalFrames: number;
}

export type FrameRenderFn = (rc: RenderContext, anim: AnimatedProperties) => void;

// ── Canvas Factory ───────────────────────────────────────────────────────────

export function createRenderContext(sceneType: string): RenderContext {
  const canvas = createCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'top';
  ctx.imageSmoothingEnabled = true;
  (ctx as any).imageSmoothingQuality = 'high';

  return {
    canvas,
    ctx,
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
    scheme: sceneColors[sceneType] || sceneColors['intro'],
    time: 0,
    frame: 0,
    totalFrames: 0,
  };
}

// ── Background Renderers ─────────────────────────────────────────────────────

/** Clean, bright background with optional soft color wash */
export function drawBackground(rc: RenderContext): void {
  const { ctx, width, height, scheme } = rc;

  // White → tinted gradient
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, scheme.bgGradientStart);
  grad.addColorStop(1, scheme.bgGradientEnd);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  // Subtle accent wash in the top-right corner
  const wash = ctx.createRadialGradient(width * 0.85, height * 0.15, 0, width * 0.85, height * 0.15, 500);
  wash.addColorStop(0, scheme.accentBg);
  wash.addColorStop(1, 'transparent');
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, width, height);

  // Very subtle bottom border line
  ctx.fillStyle = scheme.cardBorder;
  ctx.fillRect(0, height - 3, width, 3);
}

/** Solid color background — used for cinematic/ken-burns scenes.
 *  When `useDarkGradient` is true, uses scene's dark gradient colors. */
export function drawSolidBackground(
  rc: RenderContext,
  color: string,
  useDarkGradient: boolean = false
): void {
  const { ctx, width, height, scheme } = rc;

  if (useDarkGradient) {
    const grad = ctx.createLinearGradient(0, 0, width, height);
    grad.addColorStop(0, scheme.gradientStart);
    grad.addColorStop(0.5, scheme.gradientEnd);
    grad.addColorStop(1, scheme.gradientStart);
    ctx.fillStyle = grad;
  } else {
    ctx.fillStyle = color;
  }
  ctx.fillRect(0, 0, width, height);
}

// ── Text Rendering ───────────────────────────────────────────────────────────

export interface TextStyle {
  font: string;
  color: string;
  maxWidth?: number;
  align?: CanvasTextAlign;
  lineHeight?: number;
  shadow?: boolean;
}

/** Draw text with optional shadow, returns actual height used */
export function drawText(
  rc: RenderContext,
  text: string,
  x: number,
  y: number,
  style: TextStyle
): number {
  const { ctx } = rc;
  ctx.save();

  ctx.font = style.font;
  ctx.fillStyle = style.color;
  ctx.textAlign = style.align || 'left';

  if (style.shadow) {
    ctx.shadowColor = effects.textShadow.color;
    ctx.shadowBlur = effects.textShadow.blur;
    ctx.shadowOffsetX = effects.textShadow.offsetX;
    ctx.shadowOffsetY = effects.textShadow.offsetY;
  }

  const maxWidth = style.maxWidth || layout.maxTextWidth;
  const lineH = style.lineHeight || layout.lineHeight;
  const lines = wrapText(ctx, text, maxWidth);
  const fontSize = parseInt(style.font.match(/\d+/)?.[0] || '28');
  const actualLineHeight = fontSize * lineH;

  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], x, y + i * actualLineHeight);
  }

  ctx.restore();
  return lines.length * actualLineHeight;
}

/** Draw text with partial reveal (typewriter effect) */
export function drawTextRevealed(
  rc: RenderContext,
  text: string,
  x: number,
  y: number,
  style: TextStyle,
  revealProgress: number
): number {
  const charsToShow = Math.floor(text.length * Math.min(1, Math.max(0, revealProgress)));
  const visibleText = text.slice(0, charsToShow);
  return drawText(rc, visibleText, x, y, style);
}

/** Word wrap text to fit within maxWidth */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';

  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Measure text height (with wrapping) */
export function measureTextHeight(
  rc: RenderContext,
  text: string,
  font: string,
  maxWidth: number,
  lineHeight: number = layout.lineHeight
): number {
  const { ctx } = rc;
  ctx.save();
  ctx.font = font;
  const lines = wrapText(ctx, text, maxWidth);
  const fontSize = parseInt(font.match(/\d+/)?.[0] || '28');
  ctx.restore();
  return lines.length * fontSize * lineHeight;
}

// ── Shape Renderers ──────────────────────────────────────────────────────────

/** Draw a rounded rectangle — with radius clamping for safety */
export function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  radius: number,
  fill?: string,
  stroke?: string,
  strokeWidth: number = 2
): void {
  // Clamp radius to prevent negative/overflow errors
  const safeRadius = Math.max(0, Math.min(radius, w / 2, h / 2));
  ctx.beginPath();
  ctx.roundRect(x, y, Math.max(0, w), Math.max(0, h), safeRadius);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = strokeWidth; ctx.stroke(); }
}

/** Draw a clean white card with colored left border and soft shadow */
export function drawCard(
  rc: RenderContext,
  x: number, y: number, w: number, h: number,
  options: {
    fill?: string;
    borderColor?: string;
    accentSide?: 'left' | 'top' | 'none';
    accentColor?: string;
    radius?: number;
    shadow?: boolean;
  } = {}
): void {
  const { ctx, scheme } = rc;
  const radius = options.radius ?? layout.cornerRadius;
  const fill = options.fill ?? colors.bg.card;
  const border = options.borderColor ?? colors.bg.muted;
  const accentSide = options.accentSide ?? 'none';
  const accentColor = options.accentColor ?? scheme.accent;
  const showShadow = options.shadow !== false;

  ctx.save();

  // Soft drop shadow
  if (showShadow) {
    ctx.shadowColor = effects.cardShadow.color;
    ctx.shadowBlur = effects.cardShadow.blur;
    ctx.shadowOffsetX = effects.cardShadow.offsetX;
    ctx.shadowOffsetY = effects.cardShadow.offsetY;
  }

  // Main card body
  drawRoundedRect(ctx, x, y, w, h, radius, fill);
  ctx.shadowColor = 'transparent';

  // Border
  drawRoundedRect(ctx, x, y, w, h, radius, undefined, border, 1);

  // Colored accent strip
  if (accentSide === 'left') {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
    ctx.clip();
    ctx.fillStyle = accentColor;
    ctx.fillRect(x, y, 5, h);
    ctx.restore();
  } else if (accentSide === 'top') {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
    ctx.clip();
    ctx.fillStyle = accentColor;
    ctx.fillRect(x, y, w, 5);
    ctx.restore();
  }

  ctx.restore();
}

/** Draw a pill/badge with colored background */
export function drawBadge(
  rc: RenderContext,
  text: string,
  x: number, y: number,
  bgColor: string,
  textColor: string
): { width: number; height: number } {
  const { ctx } = rc;
  ctx.save();
  ctx.font = fontString('label', 'md');
  const metrics = ctx.measureText(text);
  const padX = 20, padY = 10;
  const w = metrics.width + padX * 2;
  const h = 22 + padY * 2;

  drawRoundedRect(ctx, x, y, w, h, h / 2, bgColor);
  ctx.font = fontString('label', 'md');
  ctx.fillStyle = textColor;
  ctx.textAlign = 'center';
  ctx.fillText(text, x + w / 2, y + padY);

  ctx.restore();
  return { width: w, height: h };
}

/** Draw a progress bar */
export function drawProgressBar(
  rc: RenderContext,
  x: number, y: number, width: number, height: number,
  progress: number,
  bgColor: string = colors.bg.tertiary,
  fillColor: string = rc.scheme.accent
): void {
  const { ctx } = rc;
  const radius = Math.min(height / 2, width / 2);

  // Track
  drawRoundedRect(ctx, x, y, width, height, radius, bgColor);

  // Fill
  if (progress > 0) {
    const fillWidth = Math.max(height, width * Math.min(1, progress));
    const fillRadius = Math.min(radius, fillWidth / 2);
    drawRoundedRect(ctx, x, y, fillWidth, height, fillRadius, fillColor);
  }
}

/** Draw a horizontal divider line */
export function drawDivider(
  rc: RenderContext,
  y: number,
  color: string = colors.bg.muted,
  xStart?: number,
  xEnd?: number
): void {
  const { ctx } = rc;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(xStart ?? layout.margin.x, y);
  ctx.lineTo(xEnd ?? (rc.width - layout.margin.x), y);
  ctx.stroke();
}

/** Draw a scene-type badge in the top-left corner */
export function drawSceneTypeBadge(rc: RenderContext, label: string): void {
  const { scheme } = rc;
  drawBadge(rc, label.toUpperCase(), layout.margin.x, layout.margin.y - 8, scheme.badgeBg, scheme.badgeText);
}

// ══════════════════════════════════════════════════════════════════════════════
// EDUCATIONAL DRAWING PRIMITIVES
// These go beyond basic shapes — they encode teaching patterns
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Draw a numbered circle — used for step indicators, list numbers, etc.
 * Returns the center X and Y for alignment.
 */
export function drawNumberCircle(
  rc: RenderContext,
  x: number, y: number, radius: number,
  number: number | string,
  options: {
    bgColor?: string;
    textColor?: string;
    borderColor?: string;
    fontCategory?: 'bold' | 'heading';
    fontSize?: 'sm' | 'md' | 'lg';
    completed?: boolean;
  } = {}
): void {
  const { ctx, scheme } = rc;
  const bg = options.completed ? colors.accent.green : (options.bgColor ?? scheme.accent);
  const text = options.textColor ?? colors.text.inverse;
  const displayText = options.completed ? '✓' : String(number);

  ctx.save();

  // Circle
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = bg;
  ctx.fill();

  // Border ring (for active state)
  if (options.borderColor) {
    ctx.strokeStyle = options.borderColor;
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  // Number/check text
  const fontCat = options.fontCategory ?? 'bold';
  const fontSize = options.fontSize ?? 'md';
  ctx.font = fontString(fontCat, fontSize);
  ctx.fillStyle = text;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(displayText, x, y);
  ctx.textBaseline = 'top'; // Reset

  ctx.restore();
}

/**
 * Draw a highlighted keyword/term inline — a colored pill with text.
 * Used for formula variable labels, key term emphasis, etc.
 */
export function drawKeywordPill(
  rc: RenderContext,
  text: string,
  x: number, y: number,
  options: {
    bgColor?: string;
    textColor?: string;
    fontSize?: 'sm' | 'md' | 'lg';
  } = {}
): { width: number; height: number } {
  const { ctx, scheme } = rc;
  const bg = options.bgColor ?? scheme.accentLight;
  const textCol = options.textColor ?? scheme.accent;
  const fontSize = options.fontSize ?? 'sm';

  ctx.save();
  ctx.font = fontString('bold', fontSize);
  const metrics = ctx.measureText(text);
  const padX = 16, padY = 8;
  const w = metrics.width + padX * 2;
  const h = parseInt(fontString('bold', fontSize).match(/\d+/)?.[0] || '24') + padY * 2;

  drawRoundedRect(ctx, x, y, w, h, 8, bg);
  ctx.fillStyle = textCol;
  ctx.textAlign = 'left';
  ctx.fillText(text, x + padX, y + padY);

  ctx.restore();
  return { width: w, height: h };
}

/**
 * Draw a callout box — a colored card with icon + message.
 * Used for tips, warnings, key insights, fun facts.
 */
export function drawCalloutBox(
  rc: RenderContext,
  icon: string,
  text: string,
  x: number, y: number, w: number,
  options: {
    bgColor?: string;
    borderColor?: string;
    textColor?: string;
    iconBgColor?: string;
  } = {}
): number {
  const { ctx, scheme } = rc;
  const bg = options.bgColor ?? scheme.accentBg;
  const border = options.borderColor ?? scheme.cardBorder;
  const textCol = options.textColor ?? colors.text.primary;

  // Measure text to determine box height
  ctx.save();
  ctx.font = fontString('body', 'sm');
  const textWidth = w - 100;
  const lines = wrapText(ctx, text, textWidth);
  const fontSize = 30; // body sm
  const lineH = fontSize * layout.lineHeight;
  const textHeight = lines.length * lineH;
  const h = Math.max(90, textHeight + 40);

  // Card
  drawRoundedRect(ctx, x, y, w, h, 12, bg, border, 1.5);

  // Icon
  ctx.font = '40px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(icon, x + 24, y + (h - 48) / 2);

  // Text
  ctx.font = fontString('body', 'sm');
  ctx.fillStyle = textCol;
  ctx.textAlign = 'left';
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], x + 80, y + 20 + i * lineH);
  }

  ctx.restore();
  return h;
}

// ── Lower Third Bar ──────────────────────────────────────────────────────────

/** Draw a professional lower-third text bar */
export function drawLowerThird(
  rc: RenderContext,
  text: string,
  opacity: number = 1
): void {
  if (opacity <= 0) return;
  const { ctx, width, height, scheme } = rc;

  ctx.save();
  ctx.globalAlpha = opacity;

  const barHeight = 70;
  const barY = height - barHeight - 40;

  // Background — semi-transparent white
  drawRoundedRect(ctx, layout.margin.x, barY, width - layout.margin.x * 2, barHeight, 12, 'rgba(255, 255, 255, 0.95)');

  // Accent line on left
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(layout.margin.x, barY, width - layout.margin.x * 2, barHeight, 12);
  ctx.clip();
  ctx.fillStyle = scheme.accent;
  ctx.fillRect(layout.margin.x, barY, 5, barHeight);
  ctx.restore();

  // Text
  ctx.font = fontString('body', 'sm');
  ctx.fillStyle = colors.text.primary;
  ctx.textAlign = 'left';
  const textX = layout.margin.x + 24;
  const textY = barY + (barHeight - 24) / 2;
  const maxW = width - layout.margin.x * 2 - 48;
  ctx.fillText(text.length > 120 ? text.slice(0, 117) + '...' : text, textX, textY, maxW);

  ctx.restore();
}

// ══════════════════════════════════════════════════════════════════════════════
// PROGRESSIVE DISCLOSURE PRIMITIVES
// Visual teaching tools that emphasize what's being discussed RIGHT NOW
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Draw a pulsing highlight ring around a rectangle.
 * Used to emphasize the currently-discussed element.
 * `pulseProgress` should be a 0→1 animation value (use with sinusoidal easing for pulse).
 */
export function drawHighlightPulse(
  rc: RenderContext,
  x: number, y: number, w: number, h: number,
  pulseProgress: number,
  options: { color?: string; maxRadius?: number; lineWidth?: number } = {}
): void {
  const { ctx, scheme } = rc;
  const color = options.color ?? scheme.accentGlow;
  const maxExpand = options.maxRadius ?? 12;
  const lineWidth = options.lineWidth ?? 3;

  const expand = pulseProgress * maxExpand;
  const alpha = 0.3 + 0.4 * pulseProgress;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;

  const radius = Math.max(0, Math.min(layout.cornerRadius + expand, (w + expand * 2) / 2, (h + expand * 2) / 2));
  ctx.beginPath();
  ctx.roundRect(x - expand, y - expand, w + expand * 2, h + expand * 2, radius);
  ctx.stroke();

  ctx.restore();
}

/**
 * Draw a curved connector arrow between two points.
 * Used to show flow between teaching elements (e.g. step 1 → step 2).
 * `progress` 0→1 controls how much of the arrow is drawn.
 */
export function drawConnectorArrow(
  rc: RenderContext,
  fromX: number, fromY: number,
  toX: number, toY: number,
  progress: number,
  options: { color?: string; lineWidth?: number; curvature?: number } = {}
): void {
  const { ctx, scheme } = rc;
  const color = options.color ?? scheme.accent;
  const lineWidth = options.lineWidth ?? 2;
  const curvature = options.curvature ?? 0.3;

  if (progress <= 0) return;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';

  // Quadratic bezier curve
  const midX = (fromX + toX) / 2 + (toY - fromY) * curvature;
  const midY = (fromY + toY) / 2 - (toX - fromX) * curvature;

  // Use dash offset to animate the path drawing
  const totalLen = Math.sqrt((toX - fromX) ** 2 + (toY - fromY) ** 2) * 1.3;
  const visibleLen = totalLen * Math.min(1, progress);

  ctx.setLineDash([visibleLen, totalLen]);
  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  ctx.quadraticCurveTo(midX, midY, toX, toY);
  ctx.stroke();

  // Arrowhead (only when progress is near complete)
  if (progress > 0.8) {
    const arrowAlpha = (progress - 0.8) / 0.2;
    ctx.globalAlpha = arrowAlpha;
    ctx.fillStyle = color;
    const angle = Math.atan2(toY - midY, toX - midX);
    const arrowSize = 10;
    ctx.beginPath();
    ctx.moveTo(toX, toY);
    ctx.lineTo(
      toX - arrowSize * Math.cos(angle - Math.PI / 6),
      toY - arrowSize * Math.sin(angle - Math.PI / 6)
    );
    ctx.lineTo(
      toX - arrowSize * Math.cos(angle + Math.PI / 6),
      toY - arrowSize * Math.sin(angle + Math.PI / 6)
    );
    ctx.closePath();
    ctx.fill();
  }

  ctx.setLineDash([]);
  ctx.restore();
}

/**
 * Draw a narration segment progress indicator.
 * Shows a horizontal bar with tick marks for each segment,
 * highlighting the current segment with a filled pill.
 */
export function drawSegmentIndicator(
  rc: RenderContext,
  y: number,
  totalSegments: number,
  currentSegment: number,
  segmentProgress: number,
  options: { color?: string; height?: number } = {}
): void {
  const { ctx, width, scheme } = rc;
  const barColor = options.color ?? scheme.accent;
  const h = options.height ?? 6;
  const startX = layout.margin.x;
  const barWidth = width - layout.margin.x * 2;

  ctx.save();

  // Track background
  drawRoundedRect(ctx, startX, y, barWidth, h, h / 2, colors.bg.muted);

  // Segment dividers
  for (let i = 1; i < totalSegments; i++) {
    const tickX = startX + (i / totalSegments) * barWidth;
    ctx.fillStyle = colors.bg.card;
    ctx.fillRect(tickX - 1, y - 1, 2, h + 2);
  }

  // Filled progress — up to current segment + progress within it
  const fillFraction = (currentSegment + segmentProgress) / totalSegments;
  const fillWidth = Math.max(h, barWidth * Math.min(1, fillFraction));
  const fillRadius = Math.min(h / 2, fillWidth / 2);
  drawRoundedRect(ctx, startX, y, fillWidth, h, fillRadius, barColor);

  // Current segment pill indicator
  const pillX = startX + ((currentSegment + 0.5) / totalSegments) * barWidth;
  ctx.beginPath();
  ctx.arc(pillX, y + h / 2, h + 3, 0, Math.PI * 2);
  ctx.fillStyle = barColor;
  ctx.fill();
  ctx.strokeStyle = colors.bg.card;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.restore();
}



/** Save a canvas frame to a PNG file with verification */
export async function saveFrame(rc: RenderContext, outputDir: string, frameIndex: number): Promise<string> {
  const filename = `frame_${String(frameIndex).padStart(6, '0')}.png`;
  const filepath = path.join(outputDir, filename);
  const buffer = rc.canvas.toBuffer('image/png');

  if (!buffer || buffer.length < 100) {
    log.warn({ frameIndex, bufferSize: buffer?.length }, 'Frame buffer suspiciously small');
  }

  await fs.writeFile(filepath, buffer);
  return filepath;
}

/** Render an error-state frame */
function renderErrorFrame(rc: RenderContext, frameIndex: number, errorMsg: string): void {
  const { ctx, width, height } = rc;
  // Light background for error state
  ctx.fillStyle = '#F8FAFC';
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = '#94A3B8';
  ctx.font = '22px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`Frame ${frameIndex}`, width / 2, height / 2);
}

/** Save all frames for a scene using a render function — with per-frame error isolation */
export async function renderFrames(
  sceneType: string,
  durationSeconds: number,
  outputDir: string,
  renderFn: FrameRenderFn,
  animationGetter?: (time: number) => AnimatedProperties
): Promise<{ frameDir: string; frameCount: number }> {
  await fs.mkdir(outputDir, { recursive: true });
  const frameDir = path.join(outputDir, 'frames');
  await fs.mkdir(frameDir, { recursive: true });

  const totalFrames = Math.max(1, Math.ceil(durationSeconds * FPS));
  const rc = createRenderContext(sceneType);
  rc.totalFrames = totalFrames;

  log.info({ sceneType, totalFrames, durationSeconds }, 'Rendering frames');

  let errorFrameCount = 0;
  const logInterval = Math.max(1, Math.floor(totalFrames / 10));

  for (let i = 0; i < totalFrames; i++) {
    rc.frame = i;
    rc.time = i / FPS;

    const anim = animationGetter ? animationGetter(rc.time) : {};

    rc.ctx.save();
    rc.ctx.clearRect(0, 0, rc.width, rc.height);
    rc.ctx.globalAlpha = 1;
    rc.ctx.shadowColor = 'transparent';
    rc.ctx.shadowBlur = 0;
    rc.ctx.shadowOffsetX = 0;
    rc.ctx.shadowOffsetY = 0;
    rc.ctx.textBaseline = 'top';

    try {
      renderFn(rc, anim);
    } catch (err) {
      errorFrameCount++;
      if (errorFrameCount <= 3) {
        log.warn(
          { frameIndex: i, error: (err as Error).message, stack: (err as Error).stack?.split('\n')[1]?.trim() },
          'Render callback threw — drawing error-state frame'
        );
      }
      renderErrorFrame(rc, i, (err as Error).message);
    }

    rc.ctx.restore();
    await saveFrame(rc, frameDir, i);

    if (i > 0 && i % logInterval === 0) {
      const pct = Math.round((i / totalFrames) * 100);
      log.info({ sceneType, progress: `${pct}%`, frame: i, total: totalFrames }, 'Render progress');
    }
  }

  if (errorFrameCount > 0) {
    log.warn(
      { sceneType, errorFrames: errorFrameCount, totalFrames },
      'Some frames had rendering errors (error-state frames were substituted)'
    );
  }

  log.info({ frameDir, frameCount: totalFrames, errorFrames: errorFrameCount }, 'Frames rendered');
  return { frameDir, frameCount: totalFrames };
}

// ── Image Loading ────────────────────────────────────────────────────────────

/** Load and draw an image with proper scaling and optional rounded corners */
export async function drawImage(
  rc: RenderContext,
  imagePath: string,
  x: number, y: number, w: number, h: number,
  options: { radius?: number; shadow?: boolean; opacity?: number } = {}
): Promise<void> {
  const { ctx } = rc;
  try {
    const img = await loadImage(imagePath);

    ctx.save();
    if (options.opacity !== undefined) ctx.globalAlpha = options.opacity;

    if (options.shadow) {
      ctx.shadowColor = effects.cardShadow.color;
      ctx.shadowBlur = effects.cardShadow.blur;
      ctx.shadowOffsetY = effects.cardShadow.offsetY;
    }

    if (options.radius) {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, Math.max(0, options.radius));
      ctx.clip();
    }

    // Draw with cover-fit
    const imgRatio = img.width / img.height;
    const boxRatio = w / h;
    let sx = 0, sy = 0, sw = img.width, sh = img.height;
    if (imgRatio > boxRatio) {
      sw = img.height * boxRatio;
      sx = (img.width - sw) / 2;
    } else {
      sh = img.width / boxRatio;
      sy = (img.height - sh) / 2;
    }
    ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);

    ctx.restore();
  } catch (err) {
    log.warn({ imagePath, error: (err as Error).message }, 'Failed to load image, drawing placeholder');
    drawRoundedRect(ctx, x, y, w, h, options.radius || 0, colors.bg.tertiary);
    ctx.fillStyle = colors.text.muted;
    ctx.font = fontString('body', 'sm');
    ctx.textAlign = 'center';
    ctx.fillText('Image', x + w / 2, y + h / 2 - 12);
  }
}
