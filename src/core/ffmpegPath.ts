import { execSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
let resolvedFfmpeg: string | null = null;
let resolvedFfprobe: string | null = null;

function findOnPath(name: string): string | null {
  try {
    const cmd = process.platform === 'win32' ? `where ${name}` : `which ${name}`;
    const result = execSync(cmd, { encoding: 'utf-8', timeout: 5000 }).trim();
    return result ? result.split('\n')[0].trim() : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the FFmpeg binary path.
 * Priority: system PATH → @ffmpeg-installer/ffmpeg npm package.
 */
export function getFfmpegPath(): string {
  if (resolvedFfmpeg) return resolvedFfmpeg;

  resolvedFfmpeg = findOnPath('ffmpeg');
  if (resolvedFfmpeg) return resolvedFfmpeg;

  try {
    const installer = require('@ffmpeg-installer/ffmpeg');
    if (installer?.path) {
      resolvedFfmpeg = installer.path as string;
      return resolvedFfmpeg;
    }
  } catch { /* package not installed */ }

  resolvedFfmpeg = 'ffmpeg';
  return resolvedFfmpeg;
}

/**
 * Resolve the FFprobe binary path.
 * Priority: system PATH → @ffprobe-installer/ffprobe npm package.
 */
export function getFfprobePath(): string {
  if (resolvedFfprobe) return resolvedFfprobe;

  resolvedFfprobe = findOnPath('ffprobe');
  if (resolvedFfprobe) return resolvedFfprobe;

  try {
    const installer = require('@ffprobe-installer/ffprobe');
    if (installer?.path) {
      resolvedFfprobe = installer.path as string;
      return resolvedFfprobe;
    }
  } catch { /* package not installed */ }

  resolvedFfprobe = 'ffprobe';
  return resolvedFfprobe;
}
