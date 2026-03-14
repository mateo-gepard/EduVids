// ═══════════════════════════════════════════════════════════════════════════
// EduVid AI — Temp File Cleanup
// Utilities for cleaning up project work directories and stale temp files
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../core/logger.js';
import { config } from '../core/config.js';

const log = createLogger({ module: 'cleanup' });

/**
 * Remove a project's temporary work directory after pipeline completion.
 * Silently ignores missing directories.
 */
export async function cleanupProjectDir(workDir: string): Promise<void> {
  try {
    await fs.rm(workDir, { recursive: true, force: true });
    log.info({ workDir }, 'Project work directory cleaned up');
  } catch (err) {
    log.warn({ workDir, error: (err as Error).message }, 'Failed to clean up project directory');
  }
}

/**
 * Sweep stale temporary files older than `maxAgeMs` from the tmp directory.
 * Useful as a periodic background task to prevent disk exhaustion.
 *
 * @param maxAgeMs - Maximum age in milliseconds (default: 24 hours)
 */
export async function sweepStaleTmpFiles(maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<number> {
  const tmpDir = config.tmpDir;
  let removedCount = 0;

  try {
    const entries = await fs.readdir(tmpDir, { withFileTypes: true });
    const now = Date.now();

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const dirPath = path.join(tmpDir, entry.name);
      try {
        const stats = await fs.stat(dirPath);
        const ageMs = now - stats.mtimeMs;

        if (ageMs > maxAgeMs) {
          await fs.rm(dirPath, { recursive: true, force: true });
          removedCount++;
          log.info({ dir: entry.name, ageHours: Math.round(ageMs / 3600000) }, 'Removed stale temp directory');
        }
      } catch (err) {
        log.warn({ dir: entry.name, error: (err as Error).message }, 'Could not check/remove stale directory');
      }
    }

    if (removedCount > 0) {
      log.info({ removedCount }, 'Stale temp file sweep complete');
    }
  } catch (err) {
    // tmpDir might not exist yet — that's fine
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn({ error: (err as Error).message }, 'Stale temp file sweep failed');
    }
  }

  return removedCount;
}
