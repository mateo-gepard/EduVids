// ═══════════════════════════════════════════════════════════════════════════
// EduVid AI — Video Validator
// FFprobe-based validation of output video files
// ═══════════════════════════════════════════════════════════════════════════

import ffmpegLib from 'fluent-ffmpeg';
import fs from 'fs/promises';
import { createLogger } from '../core/logger.js';
import { config } from '../core/config.js';

// Re-export probeAudioDuration from core/utils so existing importers still work
export { probeAudioDuration } from '../core/utils.js';

const log = createLogger({ module: 'video-validator' });

export interface VideoValidation {
  valid: boolean;
  issues: string[];
  metadata?: {
    duration: number;
    videoCodec: string;
    audioCodec: string;
    width: number;
    height: number;
    fileSize: number;
  };
}

/**
 * Validate a video file using FFprobe.
 * Checks for valid video/audio streams, reasonable duration, and non-zero file size.
 */
export async function validateVideoFile(filePath: string): Promise<VideoValidation> {
  const issues: string[] = [];

  if (config.mockMode) {
    return { valid: true, issues: [] };
  }

  // Check file exists and has size
  try {
    const stats = await fs.stat(filePath);
    if (stats.size === 0) {
      return { valid: false, issues: ['File is 0 bytes'] };
    }
    if (stats.size < 1024) {
      issues.push(`File suspiciously small: ${stats.size} bytes`);
    }
  } catch {
    return { valid: false, issues: [`File not found: ${filePath}`] };
  }

  // FFprobe the file
  try {
    const metadata = await new Promise<any>((resolve, reject) => {
      ffmpegLib.ffprobe(filePath, (err, data) => {
        if (err) return reject(err);
        resolve(data);
      });
    });

    const videoStream = metadata.streams?.find((s: any) => s.codec_type === 'video');
    const audioStream = metadata.streams?.find((s: any) => s.codec_type === 'audio');
    const duration = metadata.format?.duration;
    const fileSize = metadata.format?.size;

    // Check video stream
    if (!videoStream) {
      issues.push('No video stream found');
    } else {
      if (!videoStream.width || !videoStream.height) {
        issues.push('Video stream has no resolution');
      }
      if (videoStream.width < 640 || videoStream.height < 360) {
        issues.push(`Video resolution too low: ${videoStream.width}x${videoStream.height}`);
      }
      if (videoStream.nb_frames && parseInt(videoStream.nb_frames) < 10) {
        issues.push(`Video has very few frames: ${videoStream.nb_frames}`);
      }
    }

    // Check audio stream
    if (!audioStream) {
      issues.push('No audio stream found');
    }

    // Check duration
    if (!duration || duration <= 0) {
      issues.push('Video has zero or negative duration');
    } else if (duration < 1) {
      issues.push(`Video is very short: ${duration}s`);
    }

    const valid = !issues.some(i =>
      i.includes('No video stream') ||
      i.includes('0 bytes') ||
      i.includes('not found') ||
      i.includes('zero or negative duration')
    );

    const result: VideoValidation = {
      valid,
      issues,
      metadata: {
        duration: duration || 0,
        videoCodec: videoStream?.codec_name || 'unknown',
        audioCodec: audioStream?.codec_name || 'unknown',
        width: videoStream?.width || 0,
        height: videoStream?.height || 0,
        fileSize: parseInt(fileSize) || 0,
      },
    };

    if (valid) {
      log.info({ filePath, duration, issues: issues.length }, 'Video validation passed');
    } else {
      log.warn({ filePath, issues }, 'Video validation failed');
    }

    return result;
  } catch (err) {
    log.error({ filePath, error: (err as Error).message }, 'FFprobe validation failed');
    return {
      valid: false,
      issues: [`FFprobe error: ${(err as Error).message}`],
    };
  }
}
