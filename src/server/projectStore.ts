/**
 * File-backed project store.
 *
 * Keeps an in-memory Map for fast reads. Persists every mutation to
 * `data/projects.json` so projects survive server restarts.
 *
 * On startup, any project that was mid-flight (not done/error) is marked as
 * error — pipelines cannot resume across restarts.
 */
import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../core/logger.js';
import type { Project } from '../core/types.js';

const log = createLogger({ module: 'project-store' });

const DATA_DIR = path.join(process.cwd(), 'data');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');

// Statuses that mean the pipeline is still running
const IN_FLIGHT_STATUSES = new Set([
  'input-received',
  'parsing',
  'planning',
  'rendering',
  'assembling',
]);

class ProjectStore {
  private readonly cache = new Map<string, Project>();
  private initialized = false;

  // ── Serialized flush (prevents race conditions) ──
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushPromise: Promise<void> | null = null;
  private flushQueued = false;
  private static readonly FLUSH_DEBOUNCE_MS = 100;

  /** Load projects from disk. Call once at server startup. */
  async init(): Promise<void> {
    if (this.initialized) return;

    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      const raw = await fs.readFile(PROJECTS_FILE, 'utf-8');
      const data = JSON.parse(raw) as Project[];
      const now = new Date().toISOString();

      for (const project of data) {
        // Mark interrupted in-flight projects as errored — they can't be resumed
        if (IN_FLIGHT_STATUSES.has(project.status)) {
          project.status = 'error';
          project.error = 'Server restarted while project was in progress';
          project.updatedAt = now;
        }
        this.cache.set(project.id, project);
      }

      log.info({ count: this.cache.size }, 'Projects loaded from disk');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        log.warn({ error: (err as Error).message }, 'Could not load projects file — starting fresh');
      }
    }

    this.initialized = true;
  }

  get(id: string): Project | undefined {
    return this.cache.get(id);
  }

  set(id: string, project: Project): void {
    this.cache.set(id, project);
    this.scheduleDebouncedFlush();
  }

  has(id: string): boolean {
    return this.cache.has(id);
  }

  values(): IterableIterator<Project> {
    return this.cache.values();
  }

  /**
   * Debounce flush requests — coalesces rapid set() calls (e.g. progress updates).
   * If a flush is already in progress, queues another one after it completes.
   */
  private scheduleDebouncedFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.enqueueFlush();
    }, ProjectStore.FLUSH_DEBOUNCE_MS);
  }

  /**
   * Serialize flush operations so two writes never interleave.
   */
  private enqueueFlush(): void {
    if (this.flushPromise) {
      // A flush is in progress — mark that another is needed
      this.flushQueued = true;
      return;
    }

    this.flushPromise = this.doFlush()
      .catch(err => log.error({ error: (err as Error).message }, 'Failed to persist project to disk'))
      .finally(() => {
        this.flushPromise = null;
        if (this.flushQueued) {
          this.flushQueued = false;
          this.enqueueFlush();
        }
      });
  }

  private async doFlush(): Promise<void> {
    const data = Array.from(this.cache.values());
    await fs.mkdir(DATA_DIR, { recursive: true });
    // Write to a temp file then rename for atomic replacement
    const tmp = `${PROJECTS_FILE}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
    await fs.rename(tmp, PROJECTS_FILE);
  }
}

export const projectStore = new ProjectStore();
