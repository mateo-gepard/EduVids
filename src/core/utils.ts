// ═══════════════════════════════════════════════════════════════════════════
// EduVid AI — Shared Utilities
// Consolidated utility functions previously duplicated across modules
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'fs/promises';
import ffmpegLib from 'fluent-ffmpeg';
import { createLogger } from './logger.js';
import { getFfmpegPath, getFfprobePath } from './ffmpegPath.js';

ffmpegLib.setFfmpegPath(getFfmpegPath());
ffmpegLib.setFfprobePath(getFfprobePath());

const log = createLogger({ module: 'utils' });

// ── Timing ───────────────────────────────────────────────────────────────────

/**
 * Sleep for a given number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wrap a promise with a timeout. Rejects if the promise doesn't settle
 * within `timeoutMs` milliseconds.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string = 'Operation'
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

// ── File Helpers ─────────────────────────────────────────────────────────────

/**
 * Check if a file exists and has non-zero size.
 */
export async function verifyFileExists(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(filePath);
    return stats.size > 0;
  } catch {
    return false;
  }
}

/**
 * Filter a list of file paths to only those that actually exist on disk.
 */
export async function filterExistingFiles(paths: string[]): Promise<string[]> {
  const results = await Promise.all(
    paths.map(async (p) => ({ path: p, exists: await verifyFileExists(p) }))
  );
  const missing = results.filter((r) => !r.exists);
  if (missing.length > 0) {
    log.warn(
      { missing: missing.map((r) => r.path) },
      'Some files are missing and will be skipped'
    );
  }
  return results.filter((r) => r.exists).map((r) => r.path);
}

// ── Audio Duration ───────────────────────────────────────────────────────────

/**
 * Get actual audio duration using FFprobe.
 * Returns null if probing fails.
 * Optionally falls back to bitrate estimation if `fallbackSizeBytes` is provided.
 */
export async function probeAudioDuration(
  filePath: string,
  fallbackSizeBytes?: number
): Promise<number | null> {
  try {
    const duration = await new Promise<number>((resolve, reject) => {
      ffmpegLib.ffprobe(filePath, (err, metadata) => {
        if (err) return reject(err);
        const dur = metadata?.format?.duration;
        if (typeof dur === 'number' && dur > 0 && isFinite(dur)) {
          resolve(dur);
        } else {
          reject(new Error('FFprobe returned no valid duration'));
        }
      });
    });
    return duration;
  } catch (err) {
    if (fallbackSizeBytes !== undefined) {
      log.warn(
        { filePath, error: (err as Error).message },
        'FFprobe failed, falling back to bitrate estimation'
      );
      const estimated = (fallbackSizeBytes * 8) / (128 * 1000);
      return Math.max(1, estimated);
    }
    return null;
  }
}
