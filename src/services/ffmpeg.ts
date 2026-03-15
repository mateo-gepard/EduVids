import ffmpegLib from 'fluent-ffmpeg';
import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../core/logger.js';
import { config } from '../core/config.js';
import { withTimeout, verifyFileExists, filterExistingFiles } from '../core/utils.js';
import { validateVideoFile } from './videoValidator.js';
import type { RenderTimeline, TimelineEntry } from '../core/types.js';

const log = createLogger({ module: 'ffmpeg' });

// Default timeout for FFmpeg processes (2 minutes)
const FFMPEG_TIMEOUT_MS = 120_000;

// Canonical video format for all clips (ensures concat compatibility)
const CANONICAL_FORMAT = {
  codec: 'libx264',
  preset: 'medium',
  crf: '20',
  pixFmt: 'yuv420p',
  fps: '30',
  resolution: '1920x1080',
} as const;

// ── File Verification ────────────────────────────────────────────────────────
// verifyFileExists, filterExistingFiles, and withTimeout are in core/utils.ts

// ── Core FFmpeg Operations ───────────────────────────────────────────────────

/**
 * Check if FFmpeg is installed and accessible.
 */
export function checkFfmpeg(): Promise<boolean> {
  return new Promise((resolve) => {
    ffmpegLib.getAvailableFormats((err) => {
      if (err) {
        log.error('FFmpeg not found. Please install FFmpeg.');
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

/**
 * Normalize a video clip to the canonical format.
 * Ensures all clips have identical codec, resolution, fps, and pixel format
 * so they can be safely concatenated with -c copy.
 */
export function normalizeClip(inputPath: string, outputPath: string): Promise<string> {
  if (config.mockMode) {
    return fs.writeFile(outputPath, Buffer.alloc(1024)).then(() => outputPath);
  }

  const promise = new Promise<string>((resolve, reject) => {
    ffmpegLib()
      .input(inputPath)
      .outputOptions([
        '-c:v', CANONICAL_FORMAT.codec,
        '-preset', CANONICAL_FORMAT.preset,
        '-crf', CANONICAL_FORMAT.crf,
        '-pix_fmt', CANONICAL_FORMAT.pixFmt,
        '-r', CANONICAL_FORMAT.fps,
        '-vf', `scale=${CANONICAL_FORMAT.resolution}:force_original_aspect_ratio=decrease,pad=${CANONICAL_FORMAT.resolution}:(ow-iw)/2:(oh-ih)/2:black`,
        '-c:a', 'aac',
        '-b:a', '192k',
        '-ar', '44100',
        '-ac', '2',
      ])
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(new Error(`FFmpeg normalize error: ${err.message}`)))
      .run();
  });

  return withTimeout(promise, FFMPEG_TIMEOUT_MS, 'FFmpeg normalize');
}

/**
 * Create a video from a single image with a specific duration.
 */
export function createImageClip(
  imagePath: string,
  outputPath: string,
  durationSeconds: number
): Promise<string> {
  if (config.mockMode) {
    log.info('Mock mode: skipping image clip creation');
    return fs.writeFile(outputPath, Buffer.alloc(1024)).then(() => outputPath);
  }

  const promise = new Promise<string>((resolve, reject) => {
    verifyFileExists(imagePath).then((exists) => {
      if (!exists) {
        reject(new Error(`Image file not found: ${imagePath}`));
        return;
      }

      ffmpegLib()
        .input(imagePath)
        .loop(durationSeconds)
        .inputOptions(['-framerate', '1'])
        .outputOptions([
          '-c:v', CANONICAL_FORMAT.codec,
          '-t', String(durationSeconds),
          '-pix_fmt', CANONICAL_FORMAT.pixFmt,
          '-vf', `scale=${CANONICAL_FORMAT.resolution}:force_original_aspect_ratio=decrease,pad=${CANONICAL_FORMAT.resolution}:(ow-iw)/2:(oh-ih)/2:black`,
          '-r', CANONICAL_FORMAT.fps,
        ])
        .output(outputPath)
        .on('end', () => resolve(outputPath))
        .on('error', (err) => reject(new Error(`FFmpeg image clip error: ${err.message}`)))
        .run();
    }).catch(reject);
  });

  return withTimeout(promise, FFMPEG_TIMEOUT_MS, 'FFmpeg image clip');
}

/**
 * Overlay audio on a video clip. Fixed: no async executor anti-pattern.
 */
export async function overlayAudio(
  videoPath: string,
  audioPath: string,
  outputPath: string
): Promise<string> {
  if (config.mockMode) {
    log.info('Mock mode: skipping audio overlay');
    await fs.writeFile(outputPath, Buffer.alloc(1024));
    return outputPath;
  }

  // Verify both inputs exist BEFORE the promise executor
  const [videoExists, audioExists] = await Promise.all([
    verifyFileExists(videoPath),
    verifyFileExists(audioPath),
  ]);

  if (!videoExists) {
    throw new Error(`Video file not found for overlay: ${videoPath}`);
  }
  if (!audioExists) {
    throw new Error(`Audio file not found for overlay: ${audioPath}`);
  }

  const promise = new Promise<string>((resolve, reject) => {
    ffmpegLib()
      .input(videoPath)
      .input(audioPath)
      .outputOptions([
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-shortest',
      ])
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(new Error(`FFmpeg overlay error: ${err.message}`)))
      .run();
  });

  return withTimeout(promise, FFMPEG_TIMEOUT_MS, 'FFmpeg audio overlay');
}

/**
 * Concatenate multiple video clips in sequence.
 * Re-encodes all clips to canonical format before concat to prevent mismatched codec errors.
 */
export async function concatenateClips(
  clipPaths: string[],
  outputPath: string,
  transition: 'crossfade' | 'fade-black' | 'cut' = 'cut'
): Promise<string> {
  if (config.mockMode) {
    log.info('Mock mode: skipping concatenation');
    await fs.writeFile(outputPath, Buffer.alloc(2048));
    return outputPath;
  }

  // Filter to only clips that actually exist
  const validClips = await filterExistingFiles(clipPaths);

  if (validClips.length === 0) {
    throw new Error('No valid clips to concatenate (all files missing)');
  }

  if (validClips.length === 1) {
    await fs.copyFile(validClips[0], outputPath);
    return outputPath;
  }

  // Normalize all clips to canonical format before concat
  // This prevents "codec mismatch" and "resolution mismatch" errors
  const concatDir = path.dirname(outputPath);
  const normalizedClips: string[] = [];

  for (let i = 0; i < validClips.length; i++) {
    const normalizedPath = path.join(concatDir, `normalized_${i}_${Date.now()}.mp4`);
    try {
      await normalizeClip(validClips[i], normalizedPath);
      normalizedClips.push(normalizedPath);
    } catch (err) {
      log.warn({ clip: validClips[i], error: (err as Error).message }, 'Failed to normalize clip, trying raw');
      normalizedClips.push(validClips[i]); // Fall back to raw clip
    }
  }

  // Write concat file list
  const listPath = path.join(concatDir, `concat_${Date.now()}.txt`);
  const listContent = normalizedClips.map((p) => `file '${p}'`).join('\n');
  await fs.writeFile(listPath, listContent);

  const promise = new Promise<string>((resolve, reject) => {
    ffmpegLib()
      .input(listPath)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions(['-c', 'copy'])
      .output(outputPath)
      .on('end', async () => {
        // Cleanup temporary files
        await fs.unlink(listPath).catch(() => {});
        for (let i = 0; i < normalizedClips.length; i++) {
          // Only delete if it differs from the original (i.e. was actually normalized)
          if (normalizedClips[i] !== validClips[i]) {
            await fs.unlink(normalizedClips[i]).catch(() => {});
          }
        }
        resolve(outputPath);
      })
      .on('error', async (err) => {
        await fs.unlink(listPath).catch(() => {});
        reject(new Error(`FFmpeg concat error: ${err.message}`));
      })
      .run();
  });

  return withTimeout(promise, FFMPEG_TIMEOUT_MS, 'FFmpeg concatenation');
}

/**
 * Apply Ken Burns effect (slow zoom/pan) to an image.
 * Fixed: no async executor anti-pattern.
 */
export async function kenBurnsEffect(
  imagePath: string,
  outputPath: string,
  durationSeconds: number,
  direction: 'zoom-in' | 'zoom-out' | 'pan-left' | 'pan-right' = 'zoom-in'
): Promise<string> {
  if (config.mockMode) {
    log.info('Mock mode: skipping Ken Burns effect');
    await fs.writeFile(outputPath, Buffer.alloc(1024));
    return outputPath;
  }

  // Verify BEFORE entering promise executor
  const exists = await verifyFileExists(imagePath);
  if (!exists) {
    throw new Error(`Image file not found for Ken Burns: ${imagePath}`);
  }

  const totalFrames = durationSeconds * 30;
  let filter: string;

  switch (direction) {
    case 'zoom-in':
      filter = `scale=8000:-1,zoompan=z='min(zoom+0.001,1.5)':d=${totalFrames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=30`;
      break;
    case 'zoom-out':
      filter = `scale=8000:-1,zoompan=z='if(lte(zoom,1.0),1.5,max(1.001,zoom-0.001))':d=${totalFrames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=30`;
      break;
    case 'pan-left':
      filter = `scale=3840:-1,zoompan=z='1.1':d=${totalFrames}:x='iw-iw/zoom-(iw-iw/zoom)*on/${totalFrames}':y='0':s=1920x1080:fps=30`;
      break;
    case 'pan-right':
      filter = `scale=3840:-1,zoompan=z='1.1':d=${totalFrames}:x='(iw-iw/zoom)*on/${totalFrames}':y='0':s=1920x1080:fps=30`;
      break;
  }

  const promise = new Promise<string>((resolve, reject) => {
    ffmpegLib()
      .input(imagePath)
      .inputOptions(['-loop', '1'])
      .outputOptions([
        '-vf', filter,
        '-c:v', CANONICAL_FORMAT.codec,
        '-t', String(durationSeconds),
        '-pix_fmt', CANONICAL_FORMAT.pixFmt,
      ])
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(new Error(`FFmpeg Ken Burns error: ${err.message}`)))
      .run();
  });

  return withTimeout(promise, FFMPEG_TIMEOUT_MS, 'FFmpeg Ken Burns');
}

/**
 * Build the final video from a complete render timeline.
 * Validates all files before assembly, normalizes clips, and gracefully skips broken scenes.
 */
export async function buildFinalVideo(timeline: RenderTimeline): Promise<string> {
  log.info({ projectId: timeline.projectId, entries: timeline.entries.length }, 'Building final video');

  await fs.mkdir(path.dirname(timeline.outputPath), { recursive: true });

  // Build individual scene clips with audio
  const sceneClips: string[] = [];

  for (const entry of timeline.entries) {
    try {
      // Verify audio exists
      const audioExists = await verifyFileExists(entry.audioPath);
      if (!audioExists) {
        log.warn({ sceneId: entry.sceneId }, 'Audio file missing, skipping scene');
        continue;
      }

      const sceneDir = path.dirname(entry.audioPath);
      const clipPath = path.join(sceneDir, `scene_${entry.sceneId}_final.mp4`);

      if (entry.visualPaths.length > 0) {
        const validVisuals = await filterExistingFiles(entry.visualPaths);

        if (validVisuals.length > 0) {
          const visualClip = path.join(sceneDir, `scene_${entry.sceneId}_visual.mp4`);
          await concatenateClips(validVisuals, visualClip);
          await overlayAudio(visualClip, entry.audioPath, clipPath);
        } else {
          // All visuals missing — create black clip with audio
          const duration = entry.endTime - entry.startTime;
          const blackClip = path.join(sceneDir, `scene_${entry.sceneId}_black.mp4`);
          await createBlackClip(blackClip, Math.max(1, duration));
          await overlayAudio(blackClip, entry.audioPath, clipPath);
        }
      } else {
        // Audio-only scene (create black clip)
        const duration = entry.endTime - entry.startTime;
        const blackClip = path.join(sceneDir, `scene_${entry.sceneId}_black.mp4`);
        await createBlackClip(blackClip, Math.max(1, duration));
        await overlayAudio(blackClip, entry.audioPath, clipPath);
      }

      // Verify the output clip was created
      const clipExists = await verifyFileExists(clipPath);
      if (clipExists) {
        sceneClips.push(clipPath);
      } else {
        log.warn({ sceneId: entry.sceneId }, 'Scene clip was not created, skipping');
      }
    } catch (error) {
      log.error(
        { sceneId: entry.sceneId, error: (error as Error).message },
        'Failed to build scene clip, skipping scene'
      );
      // Continue with other scenes instead of crashing
    }
  }

  if (sceneClips.length === 0) {
    throw new Error('No scene clips were successfully built — cannot create final video');
  }

  log.info(
    { validClips: sceneClips.length, totalEntries: timeline.entries.length },
    'Scene clips ready, concatenating final video'
  );

  // Concatenate all scene clips (normalizeClip happens inside concatenateClips)
  await concatenateClips(sceneClips, timeline.outputPath);

  // Final output validation
  const validation = await validateVideoFile(timeline.outputPath);
  if (!validation.valid) {
    log.error({ outputPath: timeline.outputPath, issues: validation.issues }, 'Final video failed validation');
    // Don't throw — the video file exists, let the user try it
  } else {
    log.info(
      { outputPath: timeline.outputPath, metadata: validation.metadata },
      'Final video validated successfully'
    );
  }

  log.info({ outputPath: timeline.outputPath }, 'Final video built');
  return timeline.outputPath;
}

/**
 * Create a black video clip of specified duration.
 */
async function createBlackClip(outputPath: string, durationSeconds: number): Promise<string> {
  if (config.mockMode) {
    await fs.writeFile(outputPath, Buffer.alloc(1024));
    return outputPath;
  }

  return new Promise<string>((resolve, reject) => {
    ffmpegLib()
      .input(`color=black:s=${CANONICAL_FORMAT.resolution}:r=${CANONICAL_FORMAT.fps}`)
      .inputFormat('lavfi')
      .outputOptions([
        '-c:v', CANONICAL_FORMAT.codec,
        '-t', String(durationSeconds),
        '-pix_fmt', CANONICAL_FORMAT.pixFmt,
      ])
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(new Error(`FFmpeg black clip error: ${err.message}`)))
      .run();
  });
}

