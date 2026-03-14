import path from 'path';
import fs from 'fs/promises';
import { v4 as uuid } from 'uuid';
import { config } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import type { RenderTimeline, SubAgentOutput, Storyboard, TimelineEntry } from '../core/types.js';

const log = createLogger({ module: 'timeline-assembler' });

/**
 * Check if a file exists and has content.
 */
async function fileIsValid(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(filePath);
    return stats.size > 0;
  } catch {
    return false;
  }
}

/**
 * Assemble a RenderTimeline from sub-agent outputs, ordered by the storyboard.
 * Validates all file paths and gracefully skips broken scenes.
 */
export async function assembleTimeline(
  storyboard: Storyboard,
  outputs: SubAgentOutput[]
): Promise<RenderTimeline> {
  log.info(
    { scenes: storyboard.scenes.length, outputs: outputs.length },
    'Assembling render timeline'
  );

  // Map outputs by scene ID for quick lookup
  const outputMap = new Map<string, SubAgentOutput>();
  for (const output of outputs) {
    outputMap.set(output.sceneId, output);
  }

  const validEntries: TimelineEntry[] = [];
  let currentTime = 0;
  let skippedCount = 0;

  for (const scene of storyboard.scenes) {
    const output = outputMap.get(scene.id);
    if (!output) {
      log.warn({ sceneId: scene.id, sceneType: scene.type }, 'Missing output for scene, skipping');
      skippedCount++;
      continue;
    }

    // Validate duration
    if (!output.durationSeconds || output.durationSeconds <= 0 || !isFinite(output.durationSeconds)) {
      log.warn(
        { sceneId: scene.id, duration: output.durationSeconds },
        'Scene has invalid duration, skipping'
      );
      skippedCount++;
      continue;
    }

    // Validate audio file exists
    const audioValid = output.audio?.filePath
      ? await fileIsValid(output.audio.filePath)
      : false;

    if (!audioValid) {
      log.warn(
        { sceneId: scene.id, audioPath: output.audio?.filePath },
        'Audio file missing or empty, skipping scene'
      );
      skippedCount++;
      continue;
    }

    // Filter visual paths to only existing files
    const validVisualPaths: string[] = [];
    for (const visual of output.visuals) {
      if (visual.filePath && await fileIsValid(visual.filePath)) {
        validVisualPaths.push(visual.filePath);
      } else {
        log.warn(
          { sceneId: scene.id, visualPath: visual.filePath },
          'Visual file missing or empty, excluding from timeline'
        );
      }
    }

    const entry: TimelineEntry = {
      order: scene.order,
      sceneId: scene.id,
      audioPath: output.audio.filePath,
      visualPaths: validVisualPaths,
      startTime: currentTime,
      endTime: currentTime + output.durationSeconds,
      transition: determineTransition(scene.type),
    };

    validEntries.push(entry);
    currentTime += output.durationSeconds;
  }

  if (validEntries.length === 0) {
    throw new Error(
      `No valid scenes in timeline (${skippedCount} skipped). ` +
      'All scenes either had missing outputs, invalid durations, or missing files.'
    );
  }

  const outputPath = path.join(
    config.outputDir,
    storyboard.projectId,
    `${storyboard.projectId}_final.mp4`
  );

  const timeline: RenderTimeline = {
    projectId: storyboard.projectId,
    entries: validEntries.sort((a, b) => a.order - b.order),
    totalDuration: currentTime,
    outputPath,
  };

  log.info(
    {
      totalDuration: timeline.totalDuration,
      validEntries: validEntries.length,
      skippedScenes: skippedCount,
    },
    'Timeline assembled'
  );

  return timeline;
}

/**
 * Determine transition type based on scene type.
 */
function determineTransition(
  sceneType: string
): 'crossfade' | 'fade-black' | 'cut' {
  switch (sceneType) {
    case 'intro':
    case 'outro':
      return 'fade-black';
    case 'zusammenfassung':
      return 'crossfade';
    default:
      return 'cut';
  }
}
