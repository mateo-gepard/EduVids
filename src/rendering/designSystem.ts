// ═══════════════════════════════════════════════════════════════════════════
// EduVid AI — Design System v2
// Clean, bright, educational theme — readable & professional
// ═══════════════════════════════════════════════════════════════════════════

export const CANVAS_WIDTH = 1920;
export const CANVAS_HEIGHT = 1080;
export const FPS = 30;

// ── Color Palettes ───────────────────────────────────────────────────────────

export const colors = {
  // Backgrounds — bright & clean
  bg: {
    primary: '#FFFFFF',
    secondary: '#F8FAFC',
    tertiary: '#F1F5F9',
    card: '#FFFFFF',
    cardHover: '#F8FAFC',
    overlay: 'rgba(255, 255, 255, 0.92)',
    overlayLight: 'rgba(255, 255, 255, 0.7)',
    darkCard: '#1E293B',     // For inverted accent cards
    muted: '#E2E8F0',
  },
  // Text — dark, readable, high contrast
  text: {
    primary: '#1E293B',
    secondary: '#475569',
    muted: '#94A3B8',
    inverse: '#FFFFFF',
    accent: '#2563EB',
  },
  // Bold, saturated accent palette
  accent: {
    blue: '#2563EB',
    blueLight: '#DBEAFE',
    blueBg: 'rgba(37, 99, 235, 0.08)',
    green: '#16A34A',
    greenLight: '#DCFCE7',
    greenBg: 'rgba(22, 163, 74, 0.08)',
    orange: '#EA580C',
    orangeLight: '#FFEDD5',
    orangeBg: 'rgba(234, 88, 12, 0.08)',
    purple: '#7C3AED',
    purpleLight: '#EDE9FE',
    purpleBg: 'rgba(124, 58, 237, 0.08)',
    red: '#DC2626',
    redLight: '#FEE2E2',
    redBg: 'rgba(220, 38, 38, 0.08)',
    amber: '#D97706',
    amberLight: '#FEF3C7',
    amberBg: 'rgba(217, 119, 6, 0.08)',
    teal: '#0D9488',
    tealLight: '#CCFBF1',
    tealBg: 'rgba(13, 148, 136, 0.08)',
  },
} as const;

// ── Scene-specific color schemes ─────────────────────────────────────────────

export type SceneColorScheme = {
  accent: string;
  accentLight: string;
  accentBg: string;
  bgGradientStart: string;
  bgGradientEnd: string;
  cardBorder: string;
  badgeBg: string;
  badgeText: string;
  /** Dark gradient start for ken-burns/cinematic scenes */
  gradientStart: string;
  /** Dark gradient end for ken-burns/cinematic scenes */
  gradientEnd: string;
  /** Glow color for accent highlights */
  accentGlow: string;
};

export const sceneColors: Record<string, SceneColorScheme> = {
  'intro':           { accent: '#2563EB', accentLight: '#DBEAFE', accentBg: 'rgba(37,99,235,0.06)',   bgGradientStart: '#FFFFFF', bgGradientEnd: '#EFF6FF', cardBorder: '#BFDBFE', badgeBg: '#DBEAFE', badgeText: '#1D4ED8', gradientStart: '#0F172A', gradientEnd: '#1E3A5F', accentGlow: 'rgba(37,99,235,0.35)' },
  'outro':           { accent: '#16A34A', accentLight: '#DCFCE7', accentBg: 'rgba(22,163,74,0.06)',   bgGradientStart: '#FFFFFF', bgGradientEnd: '#F0FDF4', cardBorder: '#BBF7D0', badgeBg: '#DCFCE7', badgeText: '#15803D', gradientStart: '#0F172A', gradientEnd: '#14352A', accentGlow: 'rgba(22,163,74,0.35)' },
  'infografik':      { accent: '#0D9488', accentLight: '#CCFBF1', accentBg: 'rgba(13,148,136,0.06)',  bgGradientStart: '#FFFFFF', bgGradientEnd: '#F0FDFA', cardBorder: '#99F6E4', badgeBg: '#CCFBF1', badgeText: '#0F766E', gradientStart: '#0F172A', gradientEnd: '#0D2D2A', accentGlow: 'rgba(13,148,136,0.35)' },
  'ken-burns':       { accent: '#EA580C', accentLight: '#FFEDD5', accentBg: 'rgba(234,88,12,0.06)',   bgGradientStart: '#FFFFFF', bgGradientEnd: '#FFF7ED', cardBorder: '#FED7AA', badgeBg: '#FFEDD5', badgeText: '#C2410C', gradientStart: '#1A0F0A', gradientEnd: '#2D1A0F', accentGlow: 'rgba(234,88,12,0.35)' },
  'formel':          { accent: '#2563EB', accentLight: '#DBEAFE', accentBg: 'rgba(37,99,235,0.06)',   bgGradientStart: '#FFFFFF', bgGradientEnd: '#EFF6FF', cardBorder: '#BFDBFE', badgeBg: '#DBEAFE', badgeText: '#1D4ED8', gradientStart: '#0F172A', gradientEnd: '#1E3A5F', accentGlow: 'rgba(37,99,235,0.35)' },
  'zitat':           { accent: '#7C3AED', accentLight: '#EDE9FE', accentBg: 'rgba(124,58,237,0.06)', bgGradientStart: '#FFFFFF', bgGradientEnd: '#FAF5FF', cardBorder: '#DDD6FE', badgeBg: '#EDE9FE', badgeText: '#6D28D9', gradientStart: '#1A0F2E', gradientEnd: '#2D1A4E', accentGlow: 'rgba(124,58,237,0.35)' },
  'step-by-step':    { accent: '#16A34A', accentLight: '#DCFCE7', accentBg: 'rgba(22,163,74,0.06)',   bgGradientStart: '#FFFFFF', bgGradientEnd: '#F0FDF4', cardBorder: '#BBF7D0', badgeBg: '#DCFCE7', badgeText: '#15803D', gradientStart: '#0F172A', gradientEnd: '#14352A', accentGlow: 'rgba(22,163,74,0.35)' },
  'quiz':            { accent: '#D97706', accentLight: '#FEF3C7', accentBg: 'rgba(217,119,6,0.06)',   bgGradientStart: '#FFFFFF', bgGradientEnd: '#FFFBEB', cardBorder: '#FDE68A', badgeBg: '#FEF3C7', badgeText: '#B45309', gradientStart: '#1A150A', gradientEnd: '#2D250F', accentGlow: 'rgba(217,119,6,0.35)' },
  'funfact':         { accent: '#EA580C', accentLight: '#FFEDD5', accentBg: 'rgba(234,88,12,0.06)',   bgGradientStart: '#FFFFFF', bgGradientEnd: '#FFF7ED', cardBorder: '#FED7AA', badgeBg: '#FFEDD5', badgeText: '#C2410C', gradientStart: '#1A0F0A', gradientEnd: '#2D1A0F', accentGlow: 'rgba(234,88,12,0.35)' },
  'zusammenfassung': { accent: '#7C3AED', accentLight: '#EDE9FE', accentBg: 'rgba(124,58,237,0.06)', bgGradientStart: '#FFFFFF', bgGradientEnd: '#FAF5FF', cardBorder: '#DDD6FE', badgeBg: '#EDE9FE', badgeText: '#6D28D9', gradientStart: '#1A0F2E', gradientEnd: '#2D1A4E', accentGlow: 'rgba(124,58,237,0.35)' },
};

// ── Typography ───────────────────────────────────────────────────────────────

export const fonts = {
  heading: {
    family: 'Arial, Helvetica, sans-serif',
    weight: '800',
    sizes: { xl: 88, lg: 68, md: 54, sm: 44, xs: 36 },
  },
  body: {
    family: 'Arial, Helvetica, sans-serif',
    weight: '400',
    sizes: { lg: 38, md: 34, sm: 30, xs: 26 },
  },
  bold: {
    family: 'Arial, Helvetica, sans-serif',
    weight: '700',
    sizes: { lg: 38, md: 34, sm: 30, xs: 26 },
  },
  code: {
    family: 'Courier New, Courier, monospace',
    weight: '700',
    sizes: { xl: 72, lg: 56, md: 42, sm: 32, xs: 24 },
  },
  label: {
    family: 'Arial, Helvetica, sans-serif',
    weight: '600',
    sizes: { lg: 26, md: 22, sm: 18, xs: 14 },
  },
} as const;

/** Build a CSS font string for canvas */
export function fontString(
  category: keyof typeof fonts,
  size: keyof (typeof fonts)[keyof typeof fonts]['sizes']
): string {
  const f = fonts[category];
  return `${f.weight} ${f.sizes[size]}px ${f.family}`;
}

// ── Layout ───────────────────────────────────────────────────────────────────

export const layout = {
  margin: { x: 100, y: 80 },
  gutter: 32,
  contentWidth: CANVAS_WIDTH - 200,   // 1920 - 2*100
  contentHeight: CANVAS_HEIGHT - 160,  // 1080 - 2*80
  center: { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2 },
  cornerRadius: 16,
  cardPadding: 40,
  lineHeight: 1.5,
  maxTextWidth: 1500,
} as const;

// ── Shadows & Effects ────────────────────────────────────────────────────────

export const effects = {
  cardShadow: {
    color: 'rgba(0, 0, 0, 0.08)',
    blur: 24,
    offsetX: 0,
    offsetY: 4,
  },
  glowShadow: (color: string, blur: number = 20) => ({
    color,
    blur,
    offsetX: 0,
    offsetY: 0,
  }),
  textShadow: {
    color: 'rgba(0, 0, 0, 0.06)',
    blur: 2,
    offsetX: 0,
    offsetY: 1,
  },
} as const;
