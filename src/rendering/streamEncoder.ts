// ═══════════════════════════════════════════════════════════════════════════
// EduVid AI — Streaming Frame Encoder
// Pipes raw BGRA pixel data directly into FFmpeg stdin — zero compression.
//
// Previous approach: canvas.toBuffer('image/png') → pipe PNG to FFmpeg
//   - PNG compression was the #1 bottleneck (~100-200ms per frame)
//
// Current approach: canvas.toBuffer('raw') → pipe raw BGRA pixels
//   - Zero compression overhead — just memcpy the pixel buffer
//   - ~8 MB per frame at 1920×1080, but throughput is not the bottleneck
// ═══════════════════════════════════════════════════════════════════════════

import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { CANVAS_WIDTH, CANVAS_HEIGHT, FPS } from './designSystem.js';
import { createRenderContext, type FrameRenderFn } from './renderer.js';
import type { AnimatedProperties } from './animations.js';
import { createLogger } from '../core/logger.js';
import { getFfmpegPath } from '../core/ffmpegPath.js';

const log = createLogger({ module: 'stream-encoder' });

const ENCODE_TIMEOUT_BASE_MS = 300_000; // 5 minutes base
const ENCODE_TIMEOUT_PER_FRAME_MS = 1_000; // +1s per frame for large scenes

export interface StreamEncodeOptions {
  fadeInDuration?: number;
  fadeOutDuration?: number;
}

/**
 * Render all frames for a scene and simultaneously encode them to MP4 via FFmpeg stdin.
 *
 * Uses `image2pipe` input: each frame is a self-contained PNG image written to FFmpeg's
 * stdin. FFmpeg concatenates them with the provided audio into an H.264/AAC MP4.
 *
 * Backpressure-aware: waits for FFmpeg's stdin buffer to drain before writing the
 * next frame, so memory stays bounded even for long scenes.
 */
export async function renderAndEncodeStream(
  sceneType: string,
  durationSeconds: number,
  outputPath: string,
  renderFn: FrameRenderFn,
  animationGetter: ((time: number) => AnimatedProperties) | undefined,
  audioPath: string,
  options: StreamEncodeOptions = {}
): Promise<void> {
  // Guard against degenerate durations
  if (!durationSeconds || !isFinite(durationSeconds) || durationSeconds <= 0) {
    durationSeconds = 5;
  }
  if (durationSeconds > 300) durationSeconds = 300;

  const totalFrames = Math.max(1, Math.ceil(durationSeconds * FPS));
  const rc = createRenderContext(sceneType);
  rc.totalFrames = totalFrames;

  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  // Build video filter for fade transitions
  const filters: string[] = [];
  if (options.fadeInDuration && options.fadeInDuration > 0) {
    filters.push(`fade=t=in:st=0:d=${options.fadeInDuration}`);
  }
  if (options.fadeOutDuration && options.fadeOutDuration > 0) {
    const fadeOutStart = Math.max(0, durationSeconds - options.fadeOutDuration);
    filters.push(`fade=t=out:st=${fadeOutStart.toFixed(3)}:d=${options.fadeOutDuration}`);
  }

  const args: string[] = [
    '-y',
    // Video input: raw BGRA pixels piped to stdin (no PNG compression overhead)
    '-f', 'rawvideo',
    '-pix_fmt', 'bgra',
    '-s', `${CANVAS_WIDTH}x${CANVAS_HEIGHT}`,
    '-r', String(FPS),
    '-i', 'pipe:0',
    // Audio input
    '-i', audioPath,
    // Video encoding — ultrafast for speed, CRF 23 for good-enough quality
    ...(filters.length > 0 ? ['-vf', filters.join(',')] : []),
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'animation',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-r', String(FPS),
    // Audio encoding
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
    outputPath,
  ];

  log.info({ sceneType, totalFrames, durationSeconds, outputPath }, 'Stream-encoding scene');

  const ffmpeg = spawn(getFfmpegPath(), args);
  const stderrChunks: string[] = [];
  ffmpeg.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk.toString()));

  // Set up the timeout — scale with frame count so large scenes don't time out
  const timeoutMs = Math.max(ENCODE_TIMEOUT_BASE_MS, totalFrames * ENCODE_TIMEOUT_PER_FRAME_MS);
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`Stream encoding timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
  });

  const encodePromise = (async () => {
    const logInterval = Math.max(1, Math.floor(totalFrames / 5));

    try {
      for (let i = 0; i < totalFrames; i++) {
        rc.frame = i;
        rc.time = i / FPS;

        const anim = animationGetter ? animationGetter(rc.time) : {};

        // Reset canvas state cleanly before each frame
        rc.ctx.save();
        rc.ctx.clearRect(0, 0, rc.width, rc.height);
        rc.ctx.globalAlpha = 1;
        rc.ctx.shadowColor = 'transparent';
        rc.ctx.shadowBlur = 0;
        rc.ctx.shadowOffsetX = 0;
        rc.ctx.shadowOffsetY = 0;
        rc.ctx.textBaseline = 'top';

        try {
          renderFn(rc, anim);
        } catch (err) {
          // Draw a simple error frame instead of crashing the entire encode
          rc.ctx.fillStyle = '#1a1a2e';
          rc.ctx.fillRect(0, 0, rc.width, rc.height);
          rc.ctx.font = 'bold 32px Arial';
          rc.ctx.fillStyle = '#ff6b6b';
          rc.ctx.textBaseline = 'top';
          rc.ctx.fillText(
            `Render error at frame ${i}: ${(err as Error).message.slice(0, 120)}`,
            80, 80
          );
        }

        rc.ctx.restore();

        // Get the current frame as raw BGRA pixels (no compression)
        const rawBuffer = rc.canvas.toBuffer('raw');

        // Write to FFmpeg stdin, respecting backpressure
        const canContinue = ffmpeg.stdin.write(rawBuffer);
        if (!canContinue) {
          await new Promise<void>((resolve, reject) => {
            ffmpeg.stdin.once('drain', resolve);
            ffmpeg.stdin.once('error', reject);
          });
        }

        if (i > 0 && i % logInterval === 0) {
          log.info(
            { sceneType, progress: `${Math.round((i / totalFrames) * 100)}%`, frame: i, total: totalFrames },
            'Encode progress'
          );
        }
      }
    } finally {
      // Always close stdin so FFmpeg knows we're done writing frames
      ffmpeg.stdin.end();
    }

    // Wait for FFmpeg process to finish
    const exitCode = await new Promise<number>((resolve) => {
      ffmpeg.on('close', code => resolve(code ?? 1));
      ffmpeg.on('error', err => {
        log.error({ error: err.message }, 'FFmpeg spawn error');
        resolve(1);
      });
    });

    if (exitCode !== 0) {
      const lastOutput = stderrChunks.slice(-5).join('').trim();
      throw new Error(
        `FFmpeg exited with code ${exitCode} for scene "${sceneType}". ` +
        `Last output: ${lastOutput}`
      );
    }

    log.info({ sceneType, outputPath }, 'Stream encode complete');
  })();

  try {
    await Promise.race([encodePromise, timeoutPromise]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    // Ensure FFmpeg is killed if it's still running (prevents zombie processes)
    if (!ffmpeg.killed) {
      ffmpeg.stdin.destroy();
      ffmpeg.kill('SIGKILL');
    }
  }
}
