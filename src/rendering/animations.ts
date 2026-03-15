// ═══════════════════════════════════════════════════════════════════════════
// EduVid AI — Animation Engine v2
// Frame-by-frame interpolation with value sanitization and safety guards
// ═══════════════════════════════════════════════════════════════════════════

import { FPS } from './designSystem.js';

// ── Easing Functions ─────────────────────────────────────────────────────────

export type EasingFn = (t: number) => number;

export const easing = {
  linear: (t: number) => t,

  easeInQuad: (t: number) => t * t,
  easeOutQuad: (t: number) => 1 - (1 - t) * (1 - t),
  easeInOutQuad: (t: number) => t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2,

  easeInCubic: (t: number) => t ** 3,
  easeOutCubic: (t: number) => 1 - (1 - t) ** 3,
  easeInOutCubic: (t: number) => t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2,

  easeOutBack: (t: number) => {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
  },

  easeOutElastic: (t: number) => {
    if (t === 0 || t === 1) return t;
    return 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI / 3)) + 1;
  },

  easeOutBounce: (t: number) => {
    const n1 = 7.5625, d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  },

  spring: (t: number) => {
    return 1 - Math.cos(t * 4.5 * Math.PI) * Math.exp(-t * 6);
  },
} as const;

// ── Value Sanitization ───────────────────────────────────────────────────────

/**
 * Sanitize an animation value — replace NaN/Infinity with a safe default,
 * and clamp to a reasonable range to prevent canvas rendering issues.
 */
function sanitizeValue(value: number, fallback: number = 0): number {
  if (!isFinite(value) || isNaN(value)) return fallback;
  return value;
}

// ── Interpolation ────────────────────────────────────────────────────────────

/** Linearly interpolate between two values */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Interpolate colors (hex) */
export function lerpColor(hex1: string, hex2: string, t: number): string {
  const r1 = parseInt(hex1.slice(1, 3), 16), g1 = parseInt(hex1.slice(3, 5), 16), b1 = parseInt(hex1.slice(5, 7), 16);
  const r2 = parseInt(hex2.slice(1, 3), 16), g2 = parseInt(hex2.slice(3, 5), 16), b2 = parseInt(hex2.slice(5, 7), 16);
  const r = Math.round(lerp(r1, r2, t)), g = Math.round(lerp(g1, g2, t)), b = Math.round(lerp(b1, b2, t));
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

// ── Animation Timeline ───────────────────────────────────────────────────────

export interface AnimationKeyframe {
  /** Start time in seconds */
  startTime: number;
  /** Duration in seconds */
  duration: number;
  /** Easing function */
  easing: EasingFn;
  /** Properties to animate: key → [from, to] */
  properties: Record<string, [number, number]>;
}

export interface AnimatedProperties {
  [key: string]: number;
}

export class AnimationTimeline {
  private keyframes: AnimationKeyframe[] = [];

  /**
   * Add a keyframe to the timeline.
   * Validates the keyframe to prevent malformed data from corrupting animation state.
   */
  add(keyframe: AnimationKeyframe): this {
    // Validate keyframe
    if (!isFinite(keyframe.startTime) || keyframe.startTime < 0) {
      keyframe.startTime = 0;
    }
    // Guard against zero/negative/NaN duration — causes divide-by-zero
    if (!isFinite(keyframe.duration) || keyframe.duration <= 0) {
      keyframe.duration = 0.001; // Effectively instant but won't divide by zero
    }
    // Validate properties
    if (keyframe.properties && typeof keyframe.properties === 'object') {
      for (const [key, range] of Object.entries(keyframe.properties)) {
        if (!Array.isArray(range) || range.length !== 2) {
          delete keyframe.properties[key];
          continue;
        }
        // Sanitize from/to values
        if (!isFinite(range[0])) range[0] = 0;
        if (!isFinite(range[1])) range[1] = 0;
      }
    }

    this.keyframes.push(keyframe);
    return this;
  }

  /** Add a delayed animation */
  addDelayed(delay: number, keyframe: Omit<AnimationKeyframe, 'startTime'>): this {
    return this.add({ ...keyframe, startTime: delay });
  }

  /**
   * Get interpolated property values at a given time (seconds).
   * All values are sanitized to prevent NaN/Infinity from reaching canvas operations.
   */
  getValues(time: number): AnimatedProperties {
    const result: AnimatedProperties = {};

    // Sanitize input time
    if (!isFinite(time) || time < 0) time = 0;

    for (const kf of this.keyframes) {
      const elapsed = time - kf.startTime;
      if (elapsed < 0) {
        // Before animation starts — use "from" values
        for (const [key, [from]] of Object.entries(kf.properties)) {
          if (!(key in result)) result[key] = sanitizeValue(from, 0);
        }
        continue;
      }

      // Guard against zero duration (already prevented in add(), but double-check)
      const rawProgress = kf.duration > 0 ? elapsed / kf.duration : 1;
      const progress = Math.min(rawProgress, 1);

      // Apply easing with safety — catch any easing function that throws
      let easedProgress: number;
      try {
        easedProgress = kf.easing(progress);
      } catch {
        easedProgress = progress; // Linear fallback
      }

      // Clamp easing output to prevent extreme overshoot
      // easeOutBack peaks at ~1.04, easeOutElastic peaks at ~1.09
      // We allow wider range to preserve artistic intent, but prevent corruption
      easedProgress = Math.max(-2, Math.min(3, easedProgress));

      for (const [key, [from, to]] of Object.entries(kf.properties)) {
        const rawValue = lerp(from, to, easedProgress);
        result[key] = sanitizeValue(rawValue, from);
      }
    }

    return result;
  }
}

// ── Pre-built Animation Presets ──────────────────────────────────────────────

export const presets = {
  /** Fade in from 0 to 1 */
  fadeIn: (startTime: number, duration: number = 0.4): AnimationKeyframe => ({
    startTime, duration,
    easing: easing.easeOutCubic,
    properties: { opacity: [0, 1] },
  }),

  /** Fade out from 1 to 0 */
  fadeOut: (startTime: number, duration: number = 0.3): AnimationKeyframe => ({
    startTime, duration,
    easing: easing.easeInQuad,
    properties: { opacity: [1, 0] },
  }),

  /** Slide in from below */
  slideUp: (startTime: number, distance: number = 60, duration: number = 0.5): AnimationKeyframe => ({
    startTime, duration,
    easing: easing.easeOutCubic,
    properties: { opacity: [0, 1], offsetY: [distance, 0] },
  }),

  /** Slide in from left */
  slideRight: (startTime: number, distance: number = 80, duration: number = 0.5): AnimationKeyframe => ({
    startTime, duration,
    easing: easing.easeOutCubic,
    properties: { opacity: [0, 1], offsetX: [-distance, 0] },
  }),

  /** Scale in from small */
  scaleIn: (startTime: number, duration: number = 0.4): AnimationKeyframe => ({
    startTime, duration,
    easing: easing.easeOutBack,
    properties: { opacity: [0, 1], scale: [0.5, 1] },
  }),

  /** Scale in with elastic bounce */
  popIn: (startTime: number, duration: number = 0.6): AnimationKeyframe => ({
    startTime, duration,
    easing: easing.easeOutElastic,
    properties: { scale: [0, 1], opacity: [0, 1] },
  }),

  /** Typewriter reveal: progress from 0 to 1 */
  typewriter: (startTime: number, duration: number): AnimationKeyframe => ({
    startTime, duration,
    easing: easing.linear,
    properties: { revealProgress: [0, 1] },
  }),

  /** Progress bar fill */
  fillBar: (startTime: number, duration: number, fromPct: number = 0, toPct: number = 1): AnimationKeyframe => ({
    startTime, duration,
    easing: easing.easeInOutCubic,
    properties: { fillProgress: [fromPct, toPct] },
  }),

  /** Counting number animation */
  countUp: (startTime: number, duration: number, from: number, to: number): AnimationKeyframe => ({
    startTime, duration,
    easing: easing.easeOutCubic,
    properties: { counterValue: [from, to] },
  }),

  /** Pulsing glow */
  pulseGlow: (startTime: number, duration: number = 2): AnimationKeyframe => ({
    startTime, duration,
    easing: (t) => Math.sin(t * Math.PI),
    properties: { glowIntensity: [0.3, 1] },
  }),
} as const;

// ── Utility: compute frame count ─────────────────────────────────────────────

export function secondsToFrames(seconds: number): number {
  return Math.ceil(seconds * FPS);
}

export function frameToTime(frame: number): number {
  return frame / FPS;
}

/** Stagger a list of items with a delay between each */
export function staggerDelays(count: number, startTime: number, staggerGap: number): number[] {
  return Array.from({ length: count }, (_, i) => startTime + i * staggerGap);
}

// ══════════════════════════════════════════════════════════════════════════════
// SEGMENT-DRIVEN ANIMATION BUILDER
// Generates keyframes from NarrationSegment[] visual cues
// ══════════════════════════════════════════════════════════════════════════════

import type { NarrationSegment } from '../core/types.js';

/** Animation pattern for a visual cue */
interface CueAnimation {
  properties: Record<string, [number, number]>;
  easing: EasingFn;
  /** Duration override — if not set, uses segment duration */
  duration?: number;
  /** Offset from segment start */
  offset?: number;
}

/** Map of visual cue patterns to their animation definitions */
const CUE_ANIMATIONS: Record<string, CueAnimation> = {
  // ─── Generic ───
  'narrate': { properties: {}, easing: easing.linear },
  'fade_out': { properties: { opacity: [1, 0] }, easing: easing.easeInQuad, duration: 0.4, offset: -0.4 },

  // ─── Intro ───
  'title_appear': { properties: { opacity: [0, 1], offsetY: [40, 0] }, easing: easing.easeOutCubic, duration: 0.6 },
  'subtitle_reveal': { properties: { subOpacity: [0, 1], subOffsetY: [30, 0] }, easing: easing.easeOutCubic, duration: 0.5 },
  'badge_show': { properties: { badgeOpacity: [0, 1] }, easing: easing.easeOutCubic, duration: 0.4 },

  // ─── Formula ───
  'show_title': { properties: { opacity: [0, 1] }, easing: easing.easeOutCubic, duration: 0.5 },
  'show_formula': { properties: { formulaOpacity: [0, 1], formulaScale: [0.8, 1] }, easing: easing.easeOutBack, duration: 0.6 },
  'explain_meaning': { properties: { explOpacity: [0, 1] }, easing: easing.easeOutCubic, duration: 0.5 },

  // ─── Fun Fact ───
  'tease_fact': { properties: { emojiScale: [0, 1], emojiOpacity: [0, 1] }, easing: easing.easeOutElastic, duration: 0.8 },
  'show_header': { properties: { headerOpacity: [0, 1] }, easing: easing.easeOutCubic, duration: 0.4 },
  'reveal_fact': { properties: { factOpacity: [0, 1], factScale: [0.85, 1] }, easing: easing.easeOutBack, duration: 0.6 },

  // ─── Quote ───
  'introduce': { properties: { quoteMarkOpacity: [0, 1], quoteMarkScale: [0, 1] }, easing: easing.easeOutBack, duration: 0.8 },
  'quote_reveal': { properties: { revealProgress: [0, 1] }, easing: easing.linear },  // uses full segment duration
  'show_author': { properties: { authorOpacity: [0, 1] }, easing: easing.easeOutCubic, duration: 0.6 },

  // ─── Quiz ───
  'read_question': { properties: { questionOpacity: [0, 1] }, easing: easing.easeOutCubic, duration: 0.5 },

  // ─── Ken Burns ───
  'establish_scene': { properties: { opacity: [0, 1] }, easing: easing.easeOutCubic, duration: 0.8 },

  // ─── Summary titles ───
  'summary_title': { properties: { opacity: [0, 1], underlineProgress: [0, 1] }, easing: easing.easeOutCubic, duration: 0.6 },
  'closing_message': { properties: { footerOpacity: [0, 1] }, easing: easing.easeOutCubic, duration: 0.6 },
  'closing': { properties: { footerOpacity: [0, 1] }, easing: easing.easeOutCubic, duration: 0.6 },
};

/**
 * Build an AnimationTimeline from narration segments.
 * Maps each segment's visualCue to keyframe animations.
 */
export function buildSegmentTimeline(
  segments: NarrationSegment[],
  totalDuration: number
): AnimationTimeline {
  const timeline = new AnimationTimeline();

  // Initial fade-in
  timeline.add(presets.fadeIn(0, 0.5));

  for (const segment of segments) {
    const cue = segment.visualCue;
    const segStart = segment.estimatedStart;
    const segDuration = segment.estimatedEnd - segment.estimatedStart;

    // Check for exact match in static cue map
    const anim = CUE_ANIMATIONS[cue];
    if (anim && Object.keys(anim.properties).length > 0) {
      const offset = anim.offset ?? 0;
      timeline.add({
        startTime: Math.max(0, segStart + offset),
        duration: anim.duration ?? Math.max(0.3, segDuration * 0.8),
        easing: anim.easing,
        properties: { ...anim.properties },
      });
      continue;
    }

    // ─── Dynamic indexed cues (bullet:N, reveal_step:N, etc.) ───
    const indexedMatch = cue.match(/^(bullet|reveal_step|complete_step|reveal_point|derivation_step|caption|show_options):(\d+)$/);
    if (indexedMatch) {
      const [, cueType, idxStr] = indexedMatch;
      const idx = parseInt(idxStr);

      switch (cueType) {
        case 'bullet':
        case 'reveal_point':
          timeline.add({
            startTime: segStart,
            duration: 0.5,
            easing: easing.easeOutCubic,
            properties: {
              [`item${idx}Opacity`]: [0, 1],
              [`item${idx}OffsetX`]: [-40, 0],
              [`point${idx}Opacity`]: [0.3, 1],
            },
          });
          break;

        case 'reveal_step':
          // Active step highlight pulse (continuous during segment)
          timeline.add({
            startTime: segStart,
            duration: segDuration,
            easing: (t) => Math.sin(t * Math.PI),
            properties: { [`step${idx}Pulse`]: [0, 1] },
          });
          break;

        case 'complete_step':
          timeline.add({
            startTime: segStart,
            duration: 0.4,
            easing: easing.easeOutCubic,
            properties: { [`step${idx}Complete`]: [0, 1] },
          });
          break;

        case 'derivation_step':
          timeline.add({
            startTime: segStart,
            duration: 0.5,
            easing: easing.easeOutCubic,
            properties: { [`step${idx}Opacity`]: [0, 1] },
          });
          break;

        case 'caption':
          timeline.add({
            startTime: segStart,
            duration: 0.5,
            easing: easing.easeOutCubic,
            properties: { [`cap${idx}Opacity`]: [0, 1], [`cap${idx}OffsetY`]: [20, 0] },
          });
          // Auto-fade after segment
          timeline.add({
            startTime: segment.estimatedEnd,
            duration: 0.4,
            easing: easing.easeInQuad,
            properties: { [`cap${idx}Opacity`]: [1, 0] },
          });
          break;

        case 'show_options':
          // Stagger all quiz option cards
          for (let i = 0; i < 4; i++) {
            timeline.add({
              startTime: segStart + i * 0.2,
              duration: 0.5,
              easing: easing.easeOutBack,
              properties: { [`card${i}Scale`]: [0.6, 1], [`card${i}Opacity`]: [0, 1] },
            });
          }
          break;
      }
      continue;
    }

    // ─── Special cues ───
    if (cue === 'countdown') {
      timeline.add({
        startTime: segStart,
        duration: Math.min(3, segDuration),
        easing: easing.linear,
        properties: { counterValue: [3, 0] },
      });
    } else if (cue === 'reveal_answer') {
      timeline.add({
        startTime: segStart,
        duration: 0.5,
        easing: easing.easeOutCubic,
        properties: { revealFlash: [0, 1] },
      });
    } else if (cue === 'explain') {
      timeline.add({
        startTime: segStart,
        duration: 0.6,
        easing: easing.easeOutCubic,
        properties: { explOpacity: [0, 1] },
      });
    } else if (cue === 'show_image') {
      timeline.add({
        startTime: segStart,
        duration: 0.5,
        easing: easing.easeOutCubic,
        properties: { imageOpacity: [0, 1] },
      });
    }
  }

  // Fade-out at end
  timeline.add(presets.fadeOut(Math.max(0, totalDuration - 0.5), 0.4));

  return timeline;
}

