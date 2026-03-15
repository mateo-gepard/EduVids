// ═══════════════════════════════════════════════════════════════════════════
// EduVid AI — Layout Templates v2
// Clean, bright, educational layouts with progressive content reveal
// ═══════════════════════════════════════════════════════════════════════════

import {
  colors, fonts, fontString, layout,
  CANVAS_WIDTH, CANVAS_HEIGHT,
} from './designSystem.js';
import {
  type RenderContext,
  drawBackground, drawText, drawTextClamped, drawTextRevealed, drawCard,
  drawRoundedRect, drawBadge, drawSceneTypeBadge,
  drawDivider, drawImage, drawProgressBar,
  drawNumberCircle, drawKeywordPill, drawCalloutBox,
} from './renderer.js';
import type { AnimatedProperties } from './animations.js';

// ── Title Layout (Intro/Outro) ───────────────────────────────────────────────

export interface TitleLayoutData {
  title: string;
  subtitle?: string;
  badge?: string;
}

export function renderTitleLayout(
  rc: RenderContext,
  data: TitleLayoutData,
  anim: AnimatedProperties
): void {
  drawBackground(rc);
  const { ctx, width, height, scheme } = rc;
  const cx = width / 2;

  // Large colored accent bar at top
  const barHeight = 8;
  ctx.fillStyle = scheme.accent;
  ctx.fillRect(0, 0, width, barHeight);

  // Badge
  if (data.badge) {
    const badgeOpacity = anim.badgeOpacity ?? 1;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, badgeOpacity));
    drawBadge(rc, data.badge, cx - 100, height * 0.28, scheme.badgeBg, scheme.badgeText);
    ctx.restore();
  }

  // Title — large, bold, centered, dark text
  const titleOpacity = anim.titleOpacity ?? 1;
  const titleOffsetY = anim.titleOffsetY ?? 0;
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, titleOpacity));

  const revealProgress = anim.revealProgress ?? 1;
  drawTextRevealed(rc, data.title, cx, height * 0.38 + titleOffsetY, {
    font: fontString('heading', 'lg'),
    color: colors.text.primary,
    align: 'center',
    maxWidth: layout.maxTextWidth,
  }, revealProgress);
  ctx.restore();

  // Colored underline under title
  const underlineWidth = (anim.underlineProgress ?? 1) * 200;
  if (underlineWidth > 0) {
    ctx.fillStyle = scheme.accent;
    drawRoundedRect(ctx, cx - underlineWidth / 2, height * 0.38 + titleOffsetY + 85, underlineWidth, 6, 3, scheme.accent);
  }

  // Subtitle
  if (data.subtitle) {
    const subOpacity = anim.subOpacity ?? titleOpacity;
    const subOffsetY = anim.subOffsetY ?? 0;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, subOpacity));
    drawText(rc, data.subtitle, cx, height * 0.55 + subOffsetY, {
      font: fontString('body', 'md'),
      color: colors.text.secondary,
      align: 'center',
      maxWidth: layout.maxTextWidth - 200,
    });
    ctx.restore();
  }
}

// ── Bullet List Layout (Zusammenfassung) ─────────────────────────────────────

export interface BulletListData {
  title: string;
  items: Array<{ icon: string; text: string }>;
  footer?: string;
  /** Override badge label (default: '📋 Summary') */
  badge?: string;
}

export function renderBulletListLayout(
  rc: RenderContext,
  data: BulletListData,
  anim: AnimatedProperties,
  visibleItems: number
): void {
  drawBackground(rc);
  const { ctx, width, scheme } = rc;

  drawSceneTypeBadge(rc, data.badge ?? '📋 Summary');

  // Title
  drawText(rc, data.title, layout.margin.x, layout.margin.y + 50, {
    font: fontString('heading', 'md'),
    color: colors.text.primary,
  });

  // Colored underline
  const underlineWidth = (anim.underlineProgress ?? 1) * 300;
  ctx.fillStyle = scheme.accent;
  drawRoundedRect(ctx, layout.margin.x, layout.margin.y + 115, underlineWidth, 4, 2, scheme.accent);

  // Bullet items — full-width cards with colored left border
  const startY = layout.margin.y + 150;
  const availableHeight = rc.height - startY - layout.margin.y - 100; // leave room for footer
  const itemCount = data.items.length;
  const itemHeight = Math.min(95, Math.floor(availableHeight / Math.max(itemCount, 1)));

  for (let i = 0; i < Math.min(visibleItems, data.items.length); i++) {
    const item = data.items[i];
    const itemY = startY + i * itemHeight;
    const itemOpacity = anim[`item${i}Opacity`] ?? 1;
    const itemOffsetX = anim[`item${i}OffsetX`] ?? 0;

    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, itemOpacity));

    // Card with accent left border
    drawCard(rc, layout.margin.x + itemOffsetX, itemY, layout.contentWidth, itemHeight - 14, {
      accentSide: i === visibleItems - 1 ? 'left' : 'none',
      accentColor: scheme.accent,
    });

    // Number circle
    drawNumberCircle(rc, layout.margin.x + itemOffsetX + 48, itemY + (itemHeight - 14) / 2, 20, i + 1, {
      bgColor: scheme.accentLight,
      textColor: scheme.accent,
      fontSize: 'sm',
    });

    // Icon
    ctx.font = '32px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(item.icon, layout.margin.x + 82 + itemOffsetX, itemY + 22);

    // Text — clamp to card height
    drawTextClamped(rc, item.text, layout.margin.x + 124 + itemOffsetX, itemY + 24, {
      font: fontString('body', 'sm'),
      color: colors.text.primary,
      maxWidth: layout.contentWidth - 180,
    }, itemHeight - 38);

    ctx.restore();
  }

  // Footer callout
  if (data.footer && visibleItems >= data.items.length) {
    const footerY = startY + data.items.length * itemHeight + 16;
    const footerOpacity = anim.footerOpacity ?? 0;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, footerOpacity));
    drawCalloutBox(rc, '💡', data.footer, layout.margin.x, footerY, layout.contentWidth, {
      bgColor: scheme.accentBg,
      borderColor: scheme.cardBorder,
    });
    ctx.restore();
  }
}

// ── Quiz Layout ──────────────────────────────────────────────────────────────

export interface QuizLayoutData {
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  /** Override badge label (default: '❓ Quiz') */
  badge?: string;
}

export function renderQuizLayout(
  rc: RenderContext,
  data: QuizLayoutData,
  anim: AnimatedProperties,
  phase: 'question' | 'countdown' | 'reveal' | 'explanation'
): void {
  drawBackground(rc);
  const { ctx, width, height, scheme } = rc;

  drawSceneTypeBadge(rc, data.badge ?? '❓ Quiz');

  // Question — large, readable
  const questionOpacity = anim.questionOpacity ?? 1;
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, questionOpacity));
  drawText(rc, data.question, layout.margin.x, layout.margin.y + 50, {
    font: fontString('heading', 'sm'),
    color: colors.text.primary,
    maxWidth: layout.contentWidth,
  });
  ctx.restore();

  // Options — stacked full-width cards (not 2×2 grid)
  const optStartY = 260;
  const cardH = 90;
  const cardGap = 16;
  const labels = ['A', 'B', 'C', 'D'];
  const labelColors = [colors.accent.blue, colors.accent.purple, colors.accent.orange, colors.accent.teal];

  for (let i = 0; i < Math.min(4, data.options.length); i++) {
    const cy = optStartY + i * (cardH + cardGap);
    const cardOpacity = anim[`card${i}Opacity`] ?? 1;
    const cardScale = anim[`card${i}Scale`] ?? 1;

    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, cardOpacity));

    // Determine card styling based on phase
    let bgFill: string = colors.bg.card;
    let borderCol: string = colors.bg.muted;
    let textCol: string = colors.text.primary;
    let accentSide: 'left' | 'none' = 'left';

    if (phase === 'reveal' || phase === 'explanation') {
      if (i === data.correctIndex) {
        bgFill = colors.accent.greenLight;
        borderCol = colors.accent.green;
      } else {
        bgFill = '#F8FAFC';
        borderCol = '#E2E8F0';
        textCol = colors.text.muted;
      }
    }

    const sw = layout.contentWidth * cardScale;
    const sx = layout.margin.x + (layout.contentWidth - sw) / 2;

    drawCard(rc, sx, cy, sw, cardH, {
      fill: bgFill,
      borderColor: borderCol,
      accentSide,
      accentColor: phase === 'reveal' && i === data.correctIndex ? colors.accent.green : labelColors[i],
    });

    // Letter badge
    drawNumberCircle(rc, sx + 50, cy + cardH / 2, 24, labels[i], {
      bgColor: phase === 'reveal' && i === data.correctIndex ? colors.accent.green : labelColors[i],
      textColor: colors.text.inverse,
      fontSize: 'sm',
    });

    // Option text — clamp to card height
    drawTextClamped(rc, data.options[i], sx + 90, cy + (cardH - 30) / 2, {
      font: fontString('body', 'sm'),
      color: textCol,
      maxWidth: sw - 130,
    }, cardH - 30);

    // Checkmark for correct answer
    if ((phase === 'reveal' || phase === 'explanation') && i === data.correctIndex) {
      ctx.font = '36px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText('✅', sx + sw - 30, cy + cardH / 2 - 18);
    }

    ctx.restore();
  }

  // Countdown — large centered number
  if (phase === 'countdown') {
    const countdownValue = Math.ceil(anim.counterValue ?? 3);
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.font = fontString('heading', 'lg');
    ctx.fillStyle = scheme.accent;
    ctx.textAlign = 'center';
    ctx.fillText(String(countdownValue), width / 2, height - 180);
    ctx.restore();
  }

  // Explanation callout
  if (phase === 'explanation') {
    const explOpacity = anim.explOpacity ?? 1;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, explOpacity));
    drawCalloutBox(rc, '✅', data.explanation, layout.margin.x, height - 170, layout.contentWidth, {
      bgColor: colors.accent.greenBg,
      borderColor: colors.accent.green,
    });
    ctx.restore();
  }
}

// ── Step-by-Step Layout ──────────────────────────────────────────────────────

export interface StepLayoutData {
  title: string;
  steps: Array<{ number: number; title: string; content: string }>;
  /** Override badge label (default: '📝 Steps') */
  badge?: string;
}

export function renderStepLayout(
  rc: RenderContext,
  data: StepLayoutData,
  anim: AnimatedProperties,
  activeStep: number,
  completedSteps: number
): void {
  drawBackground(rc);
  const { ctx, width, height, scheme } = rc;

  drawSceneTypeBadge(rc, data.badge ?? '📝 Steps');

  // Title
  drawText(rc, data.title, layout.margin.x + 10, layout.margin.y + 50, {
    font: fontString('heading', 'md'),
    color: colors.text.primary,
  });

  // Step cards — vertically stacked, focused view (show nearby steps only)
  const stepStartY = layout.margin.y + 130;
  const maxSteps = Math.min(data.steps.length, 6);
  const availableH = height - stepStartY - layout.margin.y - 50;

  // Show at most 4 steps at a time to give each enough space
  const visibleWindow = 4;
  // Decide which slice is visible: center around active step
  let firstVisible = Math.max(0, activeStep - 1);
  if (firstVisible + visibleWindow > maxSteps) firstVisible = Math.max(0, maxSteps - visibleWindow);
  const lastVisible = Math.min(firstVisible + visibleWindow, maxSteps);
  const visibleCount = lastVisible - firstVisible;
  const stepSpacing = visibleCount > 0 ? Math.min(180, availableH / visibleCount) : 130;

  for (let vi = 0; vi < visibleCount; vi++) {
    const i = firstVisible + vi;
    const sy = stepStartY + vi * stepSpacing;
    const isActive = i === activeStep;
    const isCompleted = i < completedSteps;
    const isFuture = !isActive && !isCompleted;

    // Step number circle
    const circleX = layout.margin.x + 36;
    const circleY = sy + 30;
    const circleR = 24;

    drawNumberCircle(rc, circleX, circleY, circleR, data.steps[i].number, {
      bgColor: isCompleted ? colors.accent.green : isActive ? scheme.accent : colors.bg.muted,
      textColor: isCompleted || isActive ? colors.text.inverse : colors.text.muted,
      borderColor: isActive ? scheme.accent + '60' : undefined,
      completed: isCompleted,
      fontSize: 'sm',
    });

    // Connecting line to next step
    if (vi < visibleCount - 1) {
      ctx.save();
      ctx.strokeStyle = isCompleted ? colors.accent.green : colors.bg.muted;
      ctx.lineWidth = 2;
      ctx.setLineDash(isFuture ? [6, 4] : []);
      ctx.beginPath();
      ctx.moveTo(circleX, circleY + circleR + 4);
      ctx.lineTo(circleX, sy + stepSpacing - 4);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // Content card for active/completed steps
    const contentX = layout.margin.x + 80;
    const contentW = layout.contentWidth - 90;
    const contentH = stepSpacing - 20;

    ctx.save();
    ctx.globalAlpha = isFuture ? 0.4 : 1;

    if (isActive) {
      // Active step gets a highlighted card
      drawCard(rc, contentX, sy + 4, contentW, contentH, {
        fill: scheme.accentBg,
        borderColor: scheme.cardBorder,
        accentSide: 'left',
        accentColor: scheme.accent,
      });
    }

    // Step title
    drawText(rc, data.steps[i].title, contentX + 20, sy + 12, {
      font: fontString('bold', 'xs'),
      color: isActive ? scheme.accent : isCompleted ? colors.accent.green : colors.text.muted,
      maxWidth: contentW - 40,
    });

    // Step content (only for active/completed) — use remaining card height
    if (isActive || isCompleted) {
      drawTextClamped(rc, data.steps[i].content, contentX + 20, sy + 44, {
        font: fontString('body', 'xs'),
        color: colors.text.secondary,
        maxWidth: contentW - 40,
      }, contentH - 50);
    }

    ctx.restore();
  }

  // Bottom progress bar with label
  const progressY = height - layout.margin.y - 30;
  const progressFill = data.steps.length > 0 ? completedSteps / data.steps.length : 0;
  const progressPct = Math.round(progressFill * 100);

  ctx.save();
  ctx.font = fontString('label', 'sm');
  ctx.fillStyle = colors.text.muted;
  ctx.textAlign = 'right';
  ctx.fillText(`${progressPct}%`, layout.margin.x + layout.contentWidth, progressY - 8);
  ctx.restore();

  drawProgressBar(rc, layout.margin.x, progressY, layout.contentWidth - 60, 12, progressFill);
}

// ── Formula Layout ───────────────────────────────────────────────────────────

export interface FormulaLayoutData {
  title: string;
  formula: string;
  explanation: string;
  steps?: string[];
  /** Override badge label (default: '📐 Formula') */
  badge?: string;
}

export function renderFormulaLayout(
  rc: RenderContext,
  data: FormulaLayoutData,
  anim: AnimatedProperties,
  highlightedPart?: string
): void {
  drawBackground(rc);
  const { ctx, width, height, scheme } = rc;

  drawSceneTypeBadge(rc, data.badge ?? '📐 Formula');

  // Title
  drawText(rc, data.title, layout.margin.x, layout.margin.y + 50, {
    font: fontString('heading', 'md'),
    color: colors.text.primary,
  });

  // ── FORMULA CARD — the centerpiece ──
  const formulaOpacity = anim.formulaOpacity ?? 1;
  const formulaScale = anim.formulaScale ?? 1;
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, formulaOpacity));

  const formulaCardW = Math.min(layout.contentWidth, 1400);
  const formulaCardH = 180;
  const formulaX = (width - formulaCardW * formulaScale) / 2;
  const formulaY = 220;

  // White card with colored top accent
  drawCard(rc, formulaX, formulaY, formulaCardW * formulaScale, formulaCardH * formulaScale, {
    fill: colors.bg.card,
    borderColor: scheme.cardBorder,
    accentSide: 'top',
    accentColor: scheme.accent,
    radius: 20,
  });

  // Formula text — BIG, bold, colored, centered
  ctx.font = fontString('code', 'lg');
  ctx.fillStyle = scheme.accent;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(data.formula, width / 2, formulaY + (formulaCardH * formulaScale) / 2);
  ctx.textBaseline = 'top';
  ctx.restore();

  // ── EXPLANATION — below formula ──
  const explOpacity = anim.explOpacity ?? 1;
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, explOpacity));

  // Render explanation as a callout with info icon
  drawCalloutBox(rc, '📖', data.explanation, layout.margin.x + 40, formulaY + formulaCardH + 40, layout.contentWidth - 80, {
    bgColor: scheme.accentBg,
    borderColor: scheme.cardBorder,
  });
  ctx.restore();

  // ── DERIVATION STEPS — progressive reveal ──
  if (data.steps && data.steps.length > 0) {
    const stepsStartY = formulaY + formulaCardH + 170;
    const availableStepH = height - stepsStartY - layout.margin.y;
    const stepCount = data.steps.length;
    // Each step gets a card with enough room for wrapped text
    const stepH = Math.min(90, Math.floor(availableStepH / Math.max(stepCount, 1)));
    const cardW = layout.contentWidth - 120;

    for (let i = 0; i < stepCount; i++) {
      const stepOpacity = anim[`step${i}Opacity`] ?? 0;
      if (stepOpacity <= 0) continue;

      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, stepOpacity));

      const sy = stepsStartY + i * stepH;

      // Step accent bar
      drawCard(rc, layout.margin.x + 40, sy, cardW, stepH - 8, {
        fill: scheme.accentBg,
        borderColor: scheme.cardBorder,
        accentSide: 'left',
        accentColor: scheme.accent,
      });

      // Step text — use drawText for proper word wrapping
      drawText(rc, data.steps[i], layout.margin.x + 60, sy + 10, {
        font: fontString('body', 'xs'),
        color: colors.text.primary,
        maxWidth: cardW - 50,
      });

      ctx.restore();
    }
  }
}

// ── Quote Layout ─────────────────────────────────────────────────────────────

export interface QuoteLayoutData {
  quote: string;
  author: string;
  context?: string;
  /** Override badge label (default: '💬 Quote') */
  badge?: string;
}

export function renderQuoteLayout(
  rc: RenderContext,
  data: QuoteLayoutData,
  anim: AnimatedProperties
): void {
  drawBackground(rc);
  const { ctx, width, height, scheme } = rc;

  drawSceneTypeBadge(rc, data.badge ?? '💬 Quote');

  // Large opening quotation mark — colored
  const quoteMarkOpacity = anim.quoteMarkOpacity ?? 1;
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, quoteMarkOpacity)) * 0.2;
  ctx.font = '300px serif';
  ctx.fillStyle = scheme.accent;
  ctx.textAlign = 'left';
  ctx.fillText('„', layout.margin.x - 20, height * 0.18 + 260);
  ctx.restore();

  // Quote card — white card centered
  const cardW = layout.contentWidth - 100;
  const cardX = (width - cardW) / 2;
  const cardY = height * 0.25;
  const cardH = height * 0.35;

  drawCard(rc, cardX, cardY, cardW, cardH, {
    fill: colors.bg.card,
    borderColor: scheme.cardBorder,
    accentSide: 'left',
    accentColor: scheme.accent,
    radius: 20,
  });

  // Quote text (word-by-word reveal) — large italic-style
  const quoteProgress = anim.revealProgress ?? 1;
  drawTextRevealed(rc, data.quote, cardX + 50, cardY + 40, {
    font: fontString('heading', 'sm'),
    color: colors.text.primary,
    maxWidth: cardW - 100,
    lineHeight: 1.6,
  }, quoteProgress);

  // Author line
  const authorOpacity = anim.authorOpacity ?? 0;
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, authorOpacity));

  const authorY = cardY + cardH + 40;

  // Colored line
  ctx.fillStyle = scheme.accent;
  drawRoundedRect(ctx, cardX + 50, authorY, 60, 4, 2, scheme.accent);

  // Author name
  drawText(rc, `— ${data.author}`, cardX + 50, authorY + 16, {
    font: fontString('bold', 'md'),
    color: scheme.accent,
  });

  // Context
  if (data.context) {
    drawText(rc, data.context, cardX + 50, authorY + 56, {
      font: fontString('body', 'xs'),
      color: colors.text.muted,
    });
  }
  ctx.restore();
}

// ── Infographic Layout ───────────────────────────────────────────────────────

export interface InfografikLayoutData {
  title: string;
  imagePath?: string;
  keywords: Array<{ text: string; x: number; y: number; w: number; h: number }>;
}

/**
 * @deprecated This layout is no longer used — the InfografikAgent renders inline
 * with pre-loaded images. Kept for backward compatibility.
 */
export async function renderInfografikLayout(
  rc: RenderContext,
  data: InfografikLayoutData,
  anim: AnimatedProperties,
  revealedKeywords: Set<string>
): Promise<void> {
  drawBackground(rc);
  const { ctx, width, height, scheme } = rc;

  drawSceneTypeBadge(rc, '📊 Infographic');

  // Title
  drawText(rc, data.title, layout.margin.x, layout.margin.y + 50, {
    font: fontString('heading', 'md'),
    color: colors.text.primary,
  });

  // Image area
  const imgX = layout.margin.x;
  const imgY = layout.margin.y + 130;
  const imgW = layout.contentWidth;
  const imgH = height - imgY - layout.margin.y - 20;

  if (data.imagePath) {
    await drawImage(rc, data.imagePath, imgX, imgY, imgW, imgH, { radius: 16, shadow: true });

    // Keyword overlays
    for (const kw of data.keywords) {
      if (!revealedKeywords.has(kw.text)) {
        ctx.save();
        const overlayOpacity = anim[`overlay_${kw.text}_opacity`] ?? 1;
        ctx.globalAlpha = Math.max(0, Math.min(1, overlayOpacity));
        const ox = imgX + (kw.x / 1920) * imgW;
        const oy = imgY + (kw.y / 1080) * imgH;
        const ow = (kw.w / 1920) * imgW + 10;
        const oh = (kw.h / 1080) * imgH + 6;
        drawRoundedRect(ctx, ox - 5, oy - 3, ow, oh, 6, scheme.accentLight);
        ctx.restore();
      }
    }
  } else {
    // ── Fallback: render keywords as stat cards instead of empty placeholder ──
    const cols = Math.min(3, data.keywords.length || 3);
    const fallbackKeywords = data.keywords.length > 0 ? data.keywords : [
      { text: 'Key Point 1', x: 0, y: 0, w: 0, h: 0 },
      { text: 'Key Point 2', x: 0, y: 0, w: 0, h: 0 },
      { text: 'Key Point 3', x: 0, y: 0, w: 0, h: 0 },
    ];
    const cardGap = 24;
    const cardW = (imgW - (cols - 1) * cardGap) / cols;
    const cardH = 200;
    const startY = imgY + (imgH - cardH) / 2;

    const kwColors = [colors.accent.blue, colors.accent.green, colors.accent.orange, colors.accent.purple, colors.accent.teal];

    for (let i = 0; i < Math.min(cols, fallbackKeywords.length); i++) {
      const cx = imgX + i * (cardW + cardGap);
      const accent = kwColors[i % kwColors.length];

      drawCard(rc, cx, startY, cardW, cardH, {
        fill: colors.bg.card,
        borderColor: colors.bg.muted,
        accentSide: 'top',
        accentColor: accent,
        radius: 16,
      });

      // Keyword text centered
      drawText(rc, fallbackKeywords[i].text, cx + cardW / 2, startY + cardH / 2 - 20, {
        font: fontString('bold', 'md'),
        color: accent,
        align: 'center',
        maxWidth: cardW - 40,
      });
    }
  }
}

// ── Funfact Layout ───────────────────────────────────────────────────────────

export interface FunfactLayoutData {
  header: string;
  fact: string;
  emoji: string;
  /** Override badge label (default: '🤓 Fun Fact') */
  badge?: string;
}

export function renderFunfactLayout(
  rc: RenderContext,
  data: FunfactLayoutData,
  anim: AnimatedProperties
): void {
  drawBackground(rc);
  const { ctx, width, height, scheme } = rc;

  drawSceneTypeBadge(rc, data.badge ?? '🤓 Fun Fact');

  // Emoji in colored circle
  const emojiScale = anim.emojiScale ?? 1;
  const emojiOpacity = anim.emojiOpacity ?? 1;
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, emojiOpacity));

  // Circle background
  const circleR = 70 * emojiScale;
  const circleX = width / 2;
  const circleY = height * 0.24;
  ctx.beginPath();
  ctx.arc(circleX, circleY, circleR, 0, Math.PI * 2);
  ctx.fillStyle = scheme.accentLight;
  ctx.fill();

  // Emoji
  const emojiSize = Math.floor(70 * emojiScale);
  ctx.font = `${emojiSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(data.emoji, circleX, circleY);
  ctx.textBaseline = 'top';
  ctx.restore();

  // Header
  const headerOpacity = anim.headerOpacity ?? 1;
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, headerOpacity));
  drawText(rc, data.header, width / 2, height * 0.38, {
    font: fontString('heading', 'sm'),
    color: scheme.accent,
    align: 'center',
  });
  ctx.restore();

  // Fact card — centered, large
  const factOpacity = anim.factOpacity ?? 0;
  const factScale = anim.factScale ?? 0.95;
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, factOpacity));

  const cardW = (layout.contentWidth - 120) * factScale;
  const cardX = (width - cardW) / 2;
  const cardY = height * 0.48;
  const cardH = 220;

  drawCard(rc, cardX, cardY, cardW, cardH, {
    fill: colors.bg.card,
    borderColor: scheme.cardBorder,
    accentSide: 'top',
    accentColor: scheme.accent,
    radius: 24,
  });

  drawTextClamped(rc, data.fact, width / 2, cardY + 50, {
    font: fontString('body', 'md'),
    color: colors.text.primary,
    align: 'center',
    maxWidth: cardW - 80,
    lineHeight: 1.6,
  }, cardH - 80);
  ctx.restore();
}
