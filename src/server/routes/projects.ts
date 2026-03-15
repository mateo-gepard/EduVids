import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { upload } from '../middleware/upload.js';
import { orchestrate, type ProgressCallback } from '../../orchestrator/orchestrator.js';
import { createLogger } from '../../core/logger.js';
import { config } from '../../core/config.js';
import { sanitizeUserInput } from '../../services/llm.js';
import { z } from 'zod';
import type { Project, ProjectInput, ProgressEvent } from '../../core/types.js';
import { Semaphore } from '../../core/semaphore.js';
import { projectStore } from '../projectStore.js';

const log = createLogger({ module: 'routes/projects' });
const router = Router();

// ── SSE listeners (in-memory only — not persisted) ───────────────────────
const progressListeners = new Map<string, Set<(event: ProgressEvent) => void>>();

const pipelineSemaphore = new Semaphore(config.maxConcurrentPipelines);

// ── Zod schema for project creation input ────────────────────────────────────
const createProjectSchema = z.object({
  text: z.string().max(100_000).optional(),
  duration: z.coerce.number().int().min(30).max(1800).default(300),
  difficulty: z.enum(['overview', 'standard', 'deep']).default('standard'),
  language: z.enum(['de', 'en', 'fr', 'es']).default('de'),
  voiceId: z.string().optional(),
});

// ── Helper: broadcast a progress event to all SSE listeners ──────────────
function broadcast(projectId: string, event: ProgressEvent): void {
  const listeners = progressListeners.get(projectId);
  if (listeners) {
    for (const listener of listeners) {
      listener(event);
    }
  }
}

// ── POST /api/projects — Create & start a new project ────────────────────
router.post('/', upload.single('file'), async (req, res) => {
  try {
    const parsed = createProjectSchema.safeParse(req.body);
    if (!parsed.success) {
      const issues = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`);
      res.status(400).json({ error: 'Invalid input', details: issues });
      return;
    }

    const { text, duration, difficulty, language, voiceId } = parsed.data;
    const file = req.file;

    // Sanitize free-text input to prevent prompt injection
    const safeText = text ? sanitizeUserInput(String(text)) : undefined;

    const input: ProjectInput = {
      text: safeText,
      pdfPath: file && file.mimetype === 'application/pdf' ? file.path : undefined,
      imagePath: file && file.mimetype.startsWith('image/') ? file.path : undefined,
      params: {
        duration,
        durationMinutes: Math.round(duration / 60),
        difficulty,
        language,
        voiceId: voiceId || undefined,
      },
    };

    if (!input.text && !input.pdfPath && !input.imagePath) {
      res.status(400).json({ error: 'Provide text or upload a file.' });
      return;
    }

    // Text length validation — prevent abuse via massive payloads
    if (input.text && input.text.length > 100_000) {
      res.status(400).json({ error: 'Text input too long. Maximum 100,000 characters.' });
      return;
    }

    // Generate the project ID HERE, before starting the pipeline.
    // This eliminates the race between the orchestrator generating its own UUID
    // and the route needing to return a stable ID to the client.
    const projectId = uuid();
    const now = new Date().toISOString();

    // Store initial state immediately so GET /api/projects/:id works right away.
    const initialProject: Project = {
      id: projectId,
      status: 'input-received',
      input,
      createdAt: now,
      updatedAt: now,
    };
    projectStore.set(projectId, initialProject);

    // Launch the pipeline in the background (non-blocking response).
    (async () => {
      await pipelineSemaphore.acquire();
      try {
        const onProgress: ProgressCallback = (event) => {
          // Keep the stored project status in sync with pipeline progress.
          const p = projectStore.get(projectId);
          if (p) {
            p.status = event.status;
            p.updatedAt = new Date().toISOString();
          }
          broadcast(projectId, event);
        };

        const completed = await orchestrate(input, onProgress, projectId);
        // Overwrite with final project state (includes outputPath, agentOutputs, etc.)
        projectStore.set(projectId, completed);
        log.info({ projectId }, 'Project pipeline completed');
      } catch (err) {
        const errMsg = (err as Error).message;
        log.error({ projectId, error: errMsg }, 'Project pipeline failed');
        // Always update the stored project with the error — client can poll and see it.
        const p = projectStore.get(projectId);
        if (p) {
          p.status = 'error';
          p.error = errMsg;
          p.updatedAt = new Date().toISOString();
        }
        broadcast(projectId, { projectId, status: 'error', message: errMsg, progress: -1 });
      } finally {
        pipelineSemaphore.release();
      }
    })();

    // Return 202 Accepted immediately — client polls /api/projects/:id or streams /progress.
    res.status(202).json({ projectId, status: 'input-received' });
  } catch (error) {
    log.error({ error: (error as Error).message }, 'Failed to create project');
    res.status(500).json({ error: (error as Error).message });
  }
});

// ── GET /api/projects — List all projects ───────────────────────────────────
router.get('/', (_req, res) => {
  const list = Array.from(projectStore.values()).map(p => ({
    id: p.id,
    status: p.status,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    error: p.error,
    outputReady: !!p.outputPath,
  }));
  // Most recently created first
  list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json(list);
});

// ── GET /api/projects/:id — Get project status ───────────────────────────────
router.get('/:id', (req, res) => {
  const project = projectStore.get(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  // Sanitize response: strip internal filesystem paths
  const { outputPath, ...safeProject } = project as any;
  res.json({
    ...safeProject,
    outputReady: !!outputPath,
  });
});

// ── GET /api/projects/:id/storyboard — Get storyboard ────────────────────────
router.get('/:id/storyboard', (req, res) => {
  const project = projectStore.get(req.params.id);
  if (!project?.storyboard) {
    res.status(404).json({ error: 'Storyboard not ready' });
    return;
  }
  res.json(project.storyboard);
});

// ── Zod schema for storyboard validation ─────────────────────────────────────
const storyboardSceneSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  content: z.string(),
  timeBudget: z.number().positive(),
}).passthrough();

const storyboardSchema = z.object({
  scenes: z.array(storyboardSceneSchema).min(1),
}).passthrough();

// ── PUT /api/projects/:id/storyboard — Update storyboard ─────────────────────
router.put('/:id/storyboard', (req, res) => {
  const project = projectStore.get(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }

  const result = storyboardSchema.safeParse(req.body);
  if (!result.success) {
    const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`);
    res.status(400).json({ error: 'Invalid storyboard', details: issues });
    return;
  }

  project.storyboard = result.data as any;
  project.updatedAt = new Date().toISOString();
  projectStore.set(project.id, project);
  res.json(project.storyboard);
});

// ── GET /api/projects/:id/progress — SSE progress stream ─────────────────────
router.get('/:id/progress', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const projectId = req.params.id;

  const listener = (event: ProgressEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (event.status === 'done' || event.status === 'error') {
      res.end();
    }
  };

  if (!progressListeners.has(projectId)) {
    progressListeners.set(projectId, new Set());
  }
  progressListeners.get(projectId)!.add(listener);

  req.on('close', () => {
    progressListeners.get(projectId)?.delete(listener);
  });
});

// ── GET /api/projects/:id/download — Download final video ────────────────────
router.get('/:id/download', (req, res) => {
  const project = projectStore.get(req.params.id);
  if (!project?.outputPath) {
    res.status(404).json({ error: 'Video not ready' });
    return;
  }
  // Use sendFile with range-request support instead of res.download() which
  // buffers the entire file into memory before sending.
  res.setHeader('Content-Disposition', `attachment; filename="eduvid_${project.id}.mp4"`);
  res.setHeader('Content-Type', 'video/mp4');
  res.sendFile(project.outputPath, { headers: { 'Accept-Ranges': 'bytes' } }, (err) => {
    if (err && !res.headersSent) {
      res.status(500).json({ error: 'Failed to send video file' });
    }
  });
});

export { router as projectRoutes };
