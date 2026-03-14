import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import fs from 'fs';
import { config, validateConfig } from '../core/config.js';
import { logger } from '../core/logger.js';
import { checkFfmpeg } from '../services/ffmpeg.js';
import { projectRoutes } from './routes/projects.js';
import { projectStore } from './projectStore.js';
import { sweepStaleTmpFiles } from '../services/cleanup.js';

// Validate required config before accepting any traffic.
validateConfig();

const app = express();
const startedAt = Date.now();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: config.allowedOrigin }));
app.use(express.json({ limit: '10mb' }));

// ── API Key Authentication (optional) ────────────────────────────────────────
// When API_KEY is set in env, require all /api/ requests to include X-API-Key header.
if (config.apiKey) {
  app.use('/api', (req, res, next) => {
    // Allow health check without auth
    if (req.path === '/health') return next();

    const providedKey = req.headers['x-api-key'];
    if (providedKey !== config.apiKey) {
      res.status(401).json({ error: 'Invalid or missing API key. Set X-API-Key header.' });
      return;
    }
    next();
  });
  logger.info('API key authentication enabled');
}

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Video generation is expensive (LLM calls, TTS, rendering).
// Allow 5 new videos per IP per 10 minutes to prevent abuse.
const videoGenerationLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many video generation requests. Max 5 per 10 minutes per IP.' },
});

// ── Ensure directories ──────────────────────────────────────────────────────
fs.mkdirSync(config.tmpDir, { recursive: true });
fs.mkdirSync(config.outputDir, { recursive: true });

// ── Routes ───────────────────────────────────────────────────────────────────
// Apply rate limit only to POST (video creation), not to GET status/progress/download.
app.post('/api/projects', videoGenerationLimiter);
app.use('/api/projects', projectRoutes);

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', async (_req, res) => {
  const ffmpegOk = await checkFfmpeg();
  res.json({
    status: 'ok',
    uptime: Math.round((Date.now() - startedAt) / 1000),
    mockMode: config.mockMode,
    ffmpeg: ffmpegOk,
    llmProvider: config.llmProvider,
    maxConcurrentPipelines: config.maxConcurrentPipelines,
  });
});

// ── Start ────────────────────────────────────────────────────────────────────
(async () => {
  // Load persisted projects before accepting traffic so clients never see a
  // 404 for a project that existed before a restart.
  await projectStore.init();

  // Clean up stale temp files from previous runs (older than 24h)
  await sweepStaleTmpFiles().catch(() => {});

  const server = app.listen(config.port, () => {
    logger.info(
      { port: config.port, mockMode: config.mockMode, allowedOrigin: config.allowedOrigin },
      `🎬 EduVid AI server running on http://localhost:${config.port}`
    );

    if (config.mockMode) {
      logger.warn('⚠️  Running in MOCK MODE — no real API calls will be made');
    }
  });

  // ── Graceful Shutdown ──────────────────────────────────────────────────
  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Received shutdown signal — closing server');
    server.close(() => {
      logger.info('HTTP server closed — exiting');
      process.exit(0);
    });
    // Force exit after 10s if connections don't close
    setTimeout(() => {
      logger.warn('Forced exit after 10s grace period');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
})();

export default app;

