import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config, validateConfig } from '../core/config.js';
import { logger } from '../core/logger.js';
import { checkFfmpeg } from '../services/ffmpeg.js';
import { projectRoutes } from './routes/projects.js';
import { projectStore } from './projectStore.js';
import { sweepStaleTmpFiles } from '../services/cleanup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let configValid = false;

const app = express();
const startedAt = Date.now();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
// In production the client is served from the same origin — allow it automatically.
const allowedOrigins = config.allowedOrigin.split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (same-origin, curl, mobile apps)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    callback(null, false);
  },
}));
app.use(express.json({ limit: '10mb' }));

// ── API Key Authentication (optional) ────────────────────────────────────────
// When API_KEY is set in env, require all /api/ requests to include X-API-Key header.
if (config.apiKey) {
  app.use('/api', (req, res, next) => {
    // Exempt endpoints that can't send custom headers (SSE EventSource, <video> tag)
    if (req.path === '/health') return next();
    if (req.path.endsWith('/progress')) return next();
    if (req.path.endsWith('/download')) return next();

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

// ── Static files (production) ────────────────────────────────────────────────
// In production, serve the Vite-built client. In dev, Vite dev server handles it.
const clientDir = path.resolve(__dirname, '../../dist/client');
if (fs.existsSync(clientDir)) {
  app.use(express.static(clientDir));
  // SPA fallback: serve index.html for any non-API route
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(clientDir, 'index.html'));
  });
  logger.info({ clientDir }, 'Serving static client files');
}

// ── Health check (registered before validation so it always responds) ────────
app.get('/api/health', async (_req, res) => {
  const ffmpegOk = await checkFfmpeg();
  res.json({
    status: configValid ? 'ok' : 'degraded',
    uptime: Math.round((Date.now() - startedAt) / 1000),
    configValid,
    mockMode: config.mockMode,
    ffmpeg: ffmpegOk,
    llmProvider: config.llmProvider,
    maxConcurrentPipelines: config.maxConcurrentPipelines,
  });
});

// ── Start ────────────────────────────────────────────────────────────────────
(async () => {
  // Start listening FIRST so the health-check endpoint responds immediately.
  // Bind to 0.0.0.0 so Railway's proxy can reach the container.
  const server = app.listen(config.port, '0.0.0.0', () => {
    logger.info(
      { port: config.port, mockMode: config.mockMode, allowedOrigin: config.allowedOrigin },
      `🎬 EduVid AI server running on http://0.0.0.0:${config.port}`
    );
  });

  // Validate config after listen — non-fatal so health check keeps working.
  try {
    validateConfig();
    configValid = true;
  } catch (err: any) {
    logger.error({ err: err.message }, 'Config validation failed — video generation disabled until env vars are set');
  }

  if (config.mockMode) {
    logger.warn('⚠️  Running in MOCK MODE — no real API calls will be made');
  }

  // Load persisted projects
  await projectStore.init();

  // Clean up stale temp files from previous runs (older than 24h)
  await sweepStaleTmpFiles().catch(() => {});

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

