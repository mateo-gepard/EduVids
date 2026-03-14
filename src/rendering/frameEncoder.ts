// ═══════════════════════════════════════════════════════════════════════════
// EduVid AI — Frame Encoder v2
// @deprecated — All rendering now uses streamEncoder.ts (direct pipe encoding).
// This module is retained for backward compatibility with external consumers.
// Converts PNG frame sequences to MP4 video with validation and verification
// ═══════════════════════════════════════════════════════════════════════════

import ffmpegLib from 'fluent-ffmpeg';
import fs from 'fs/promises';
import path from 'path';
import { FPS } from './designSystem.js';
import { config } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { withTimeout } from '../core/utils.js';
import { validateVideoFile, probeAudioDuration } from '../services/videoValidator.js';

const log = createLogger({ module: 'frame-encoder' });

const ENCODE_TIMEOUT_MS = 180_000; // 3 minutes

// ── Frame Sequence Validation ────────────────────────────────────────────────

interface FrameSequenceInfo {
  frameCount: number;
  firstFrame: number;
  lastFrame: number;
  gaps: Array<{ start: number; end: number }>;
  isContiguous: boolean;
}

/**
 * Validate that frame files form a contiguous sequence.
 */
async function validateFrameSequence(frameDir: string): Promise<FrameSequenceInfo> {
  const files = await fs.readdir(frameDir).catch(() => []);
  const frameFiles = files.filter(f => f.match(/^frame_\d{6}\.png$/));

  if (frameFiles.length === 0) {
    return { frameCount: 0, firstFrame: -1, lastFrame: -1, gaps: [], isContiguous: false };
  }

  // Extract frame numbers and sort
  const frameNumbers = frameFiles
    .map(f => parseInt(f.match(/frame_(\d{6})/)?.[1] || '-1'))
    .filter(n => n >= 0)
    .sort((a, b) => a - b);

  const firstFrame = frameNumbers[0];
  const lastFrame = frameNumbers[frameNumbers.length - 1];

  // Check for gaps
  const gaps: Array<{ start: number; end: number }> = [];
  for (let i = 1; i < frameNumbers.length; i++) {
    if (frameNumbers[i] !== frameNumbers[i - 1] + 1) {
      gaps.push({ start: frameNumbers[i - 1] + 1, end: frameNumbers[i] - 1 });
    }
  }

  if (gaps.length > 0) {
    log.warn(
      { frameDir, gaps, totalGapFrames: gaps.reduce((s, g) => s + (g.end - g.start + 1), 0) },
      'Frame sequence has gaps'
    );
  }

  return {
    frameCount: frameFiles.length,
    firstFrame,
    lastFrame,
    gaps,
    isContiguous: gaps.length === 0 && firstFrame === 0,
  };
}

// ── Encoding ─────────────────────────────────────────────────────────────────

/**
 * Encode a directory of PNG frames into an MP4 video.
 */
export async function encodeFramesToVideo(
  frameDir: string,
  outputPath: string,
  fps: number = FPS,
  audioPath?: string
): Promise<string> {
  if (config.mockMode) {
    log.info({ frameDir, outputPath }, 'Mock mode: skipping frame encoding');
    await fs.writeFile(outputPath, Buffer.alloc(2048));
    return outputPath;
  }

  // Validate frame sequence
  const seqInfo = await validateFrameSequence(frameDir);
  if (seqInfo.frameCount === 0) {
    throw new Error(`Frame directory is empty or missing: ${frameDir}`);
  }
  if (seqInfo.frameCount < 5) {
    log.warn({ frameDir, frameCount: seqInfo.frameCount }, 'Very few frames — video may be too short');
  }

  log.info(
    { frameDir, outputPath, fps, hasAudio: !!audioPath, frameCount: seqInfo.frameCount, contiguous: seqInfo.isContiguous },
    'Encoding frames to video'
  );
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const inputPattern = path.join(frameDir, 'frame_%06d.png');

  const promise = new Promise<string>((resolve, reject) => {
    const cmd = ffmpegLib()
      .input(inputPattern)
      .inputOptions(['-framerate', String(fps)]);

    if (audioPath) {
      cmd.input(audioPath);
    }

    cmd.outputOptions([
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '20',
      '-pix_fmt', 'yuv420p',
      '-r', String(fps),
      ...(audioPath ? ['-c:a', 'aac', '-b:a', '192k', '-shortest'] : []),
    ]);

    cmd
      .output(outputPath)
      .on('end', () => {
        log.info({ outputPath }, 'Frame encoding complete');
        resolve(outputPath);
      })
      .on('error', (err) => {
        log.error({ error: err.message }, 'Frame encoding failed');
        reject(new Error(`Frame encoding failed: ${err.message}`));
      })
      .on('progress', (progress) => {
        if (progress.percent && Math.round(progress.percent) % 25 === 0) {
          log.debug({ percent: progress.percent }, 'Encoding progress');
        }
      })
      .run();
  });

  const result = await withTimeout(promise, ENCODE_TIMEOUT_MS, 'Frame encoding');

  // Post-encode verification
  const validation = await validateVideoFile(result);
  if (!validation.valid) {
    log.error({ outputPath, issues: validation.issues }, 'Encoded video failed validation');
    throw new Error(`Encoded video is invalid: ${validation.issues.join('; ')}`);
  }

  return result;
}

/**
 * Encode frames + add audio + add transitions all in one pass.
 * Includes audio-video duration sync and post-encode verification.
 */
export async function encodeSceneVideo(
  frameDir: string,
  audioPath: string,
  outputPath: string,
  options: {
    fps?: number;
    fadeInDuration?: number;
    fadeOutDuration?: number;
  } = {}
): Promise<string> {
  const fps = options.fps ?? FPS;
  const fadeIn = options.fadeInDuration ?? 0.3;
  const fadeOut = options.fadeOutDuration ?? 0.3;

  if (config.mockMode) {
    log.info({ frameDir, outputPath }, 'Mock mode: skipping scene encoding');
    await fs.writeFile(outputPath, Buffer.alloc(2048));
    return outputPath;
  }

  // Validate frame sequence
  const seqInfo = await validateFrameSequence(frameDir);
  if (seqInfo.frameCount === 0) {
    throw new Error(`Frame directory is empty or missing: ${frameDir}`);
  }

  // Check audio-video duration sync
  const videoDuration = seqInfo.frameCount / fps;
  const audioDuration = await probeAudioDuration(audioPath);

  if (audioDuration) {
    const drift = Math.abs(videoDuration - audioDuration);
    if (drift > 2) {
      log.warn(
        { videoDuration, audioDuration, drift },
        'Significant audio-video duration mismatch — -shortest flag will handle it'
      );
    }
  }

  log.info(
    { frameDir, outputPath, fps, fadeIn, fadeOut, frameCount: seqInfo.frameCount, videoDuration, audioDuration },
    'Encoding scene video'
  );
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const inputPattern = path.join(frameDir, 'frame_%06d.png');
  const duration = videoDuration;

  // Build filter graph with fade transitions
  const filters: string[] = [];
  if (fadeIn > 0) {
    filters.push(`fade=t=in:st=0:d=${fadeIn}`);
  }
  if (fadeOut > 0) {
    filters.push(`fade=t=out:st=${Math.max(0, duration - fadeOut)}:d=${fadeOut}`);
  }

  const promise = new Promise<string>((resolve, reject) => {
    const cmd = ffmpegLib()
      .input(inputPattern)
      .inputOptions(['-framerate', String(fps)])
      .input(audioPath);

    const outputOpts = [
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '20',
      '-pix_fmt', 'yuv420p',
      '-r', String(fps),
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest',
    ];

    if (filters.length > 0) {
      outputOpts.push('-vf', filters.join(','));
    }

    cmd
      .outputOptions(outputOpts)
      .output(outputPath)
      .on('end', () => {
        log.info({ outputPath }, 'Scene encoding complete');
        resolve(outputPath);
      })
      .on('error', (err) => {
        log.error({ error: err.message }, 'Scene encoding failed');
        reject(new Error(`Scene encoding failed: ${err.message}`));
      })
      .run();
  });

  const result = await withTimeout(promise, ENCODE_TIMEOUT_MS, 'Scene encoding');

  // Post-encode verification
  const validation = await validateVideoFile(result);
  if (!validation.valid) {
    log.error({ outputPath, issues: validation.issues }, 'Scene video failed validation');
    // Don't throw — let the pipeline try to use it anyway, buildFinalVideo will handle gracefully
    log.warn('Proceeding with potentially invalid scene video');
  }

  return result;
}

/**
 * Clean up frame directory after encoding.
 */
export async function cleanupFrames(frameDir: string): Promise<void> {
  try {
    await fs.rm(frameDir, { recursive: true, force: true });
    log.info({ frameDir }, 'Cleaned up frames');
  } catch (err) {
    log.warn({ frameDir, error: (err as Error).message }, 'Failed to cleanup frames');
  }
}
