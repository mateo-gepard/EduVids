import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

export const config = {
  // ── Server ─────────────────────────────────────────────────────────────
  port: parseInt(process.env.PORT || '3001', 10),
  /** CORS allowed origin for the frontend (use * when client is served from same origin) */
  allowedOrigin: process.env.ALLOWED_ORIGIN || (process.env.NODE_ENV === 'production' ? '*' : 'http://localhost:5173'),
  /** Max simultaneous video pipelines (each is CPU+memory heavy) */
  maxConcurrentPipelines: parseInt(process.env.MAX_CONCURRENT_PIPELINES || '2', 10),

  // ── LLM ────────────────────────────────────────────────────────────────
  llmProvider: (process.env.LLM_PROVIDER || 'openai') as 'openai' | 'gemini',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
  whisperModel: process.env.WHISPER_MODEL || 'whisper-1',

  // ── ElevenLabs ─────────────────────────────────────────────────────────
  elevenlabsApiKey: process.env.ELEVENLABS_API_KEY || '',
  elevenlabsVoiceId: process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM',

  // ── Image Search ───────────────────────────────────────────────────────
  // Priority: Pexels → Pixabay → Bing → Wikimedia Commons (no key needed)
  pexelsApiKey: process.env.PEXELS_API_KEY || '',
  pixabayApiKey: process.env.PIXABAY_API_KEY || '',
  bingSearchKey: process.env.BING_SEARCH_KEY || '',

  // ── Google APIs ────────────────────────────────────────────────────────
  googleVisionKey: process.env.GOOGLE_CLOUD_VISION_KEY || '',

  // ── Paths ──────────────────────────────────────────────────────────────
  outputDir: path.resolve(root, process.env.OUTPUT_DIR || './output'),
  tmpDir: path.resolve(root, process.env.TMP_DIR || './tmp'),

  // ── Feature Flags ──────────────────────────────────────────────────────
  mockMode: process.env.MOCK_MODE === 'true',

  // ── Authentication ─────────────────────────────────────────────────────────────
  /** Optional API key for authenticating requests. When set, all requests must include X-API-Key header. */
  apiKey: process.env.API_KEY || '',
} as const;

export type Config = typeof config;

/**
 * Validate required configuration at startup.
 * Throws with a descriptive error if critical env vars are missing.
 * Prints warnings for optional-but-recommended keys.
 */
export function validateConfig(): void {
  if (config.mockMode) return; // Skip in mock mode — no real API calls

  const errors: string[] = [];

  if (!config.openaiApiKey && config.llmProvider === 'openai') {
    errors.push('OPENAI_API_KEY is required when LLM_PROVIDER=openai (the default)');
  }
  if (!config.geminiApiKey && config.llmProvider === 'gemini') {
    errors.push('GEMINI_API_KEY is required when LLM_PROVIDER=gemini');
  }

  if (errors.length > 0) {
    throw new Error(
      `[config] Startup failed — missing required environment variables:\n` +
      errors.map(e => `  ✗ ${e}`).join('\n') +
      `\n\nCreate a .env file. See .env.example for all available variables.`
    );
  }

  const warnings: string[] = [];
  if (!config.elevenlabsApiKey) {
    warnings.push('ELEVENLABS_API_KEY not set — TTS will fall back to OpenAI TTS (requires OPENAI_API_KEY)');
  }
  if (!config.pexelsApiKey && !config.pixabayApiKey) {
    warnings.push('PEXELS_API_KEY / PIXABAY_API_KEY not set — images will use Wikimedia Commons (free, no key needed). Set PEXELS_API_KEY for higher quality.');
  }
  if (config.allowedOrigin === 'http://localhost:5173') {
    warnings.push('ALLOWED_ORIGIN is still the default localhost:5173 — set it to your Vercel domain for production');
  }
  if (warnings.length > 0) {
    console.warn('[config] Warnings:\n' + warnings.map(w => `  ⚠  ${w}`).join('\n'));
  }
}
