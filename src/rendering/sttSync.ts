// ═══════════════════════════════════════════════════════════════════════════
// EduVid AI — STT-based Audio-Video Sync
// Replaces LLM-estimated timestamps with real word-level timestamps
// from Whisper STT. Pipeline: LLM script+keywords → TTS → STT → exact cues.
// ═══════════════════════════════════════════════════════════════════════════

import { transcribeWithTimestamps, findKeywordTimestamps } from '../services/stt.js';
import { createLogger } from '../core/logger.js';
import type { NarrationSegment, TimestampedWord } from '../core/types.js';

const log = createLogger({ module: 'stt-sync' });

/**
 * A cue keyword definition: the visual cue name and the trigger phrase
 * that, when spoken in the audio, activates that cue.
 */
export interface CueKeyword {
  /** Visual cue name, e.g. "reveal_step:0", "bullet:1" */
  visualCue: string;
  /** The trigger phrase the narrator says, e.g. "first step", "Calvin Cycle" */
  triggerPhrase: string;
}

/**
 * Result of STT-based sync: NarrationSegments with real timestamps.
 */
export interface SttSyncResult {
  /** Segments with real STT-derived timestamps */
  segments: NarrationSegment[];
  /** Raw word-level timestamps from Whisper */
  words: TimestampedWord[];
  /** Whether STT succeeded (false = fell back to proportional) */
  usedStt: boolean;
}

/**
 * Core sync pipeline:
 * 1. Transcribe TTS audio with Whisper to get word-level timestamps
 * 2. Match cue trigger phrases to word timestamps
 * 3. Build NarrationSegments with real start/end times
 *
 * Falls back to proportional word-count estimation if STT fails.
 */
export async function buildSttSyncedSegments(
  audioPath: string,
  script: string,
  totalDuration: number,
  cueKeywords: CueKeyword[],
): Promise<SttSyncResult> {
  try {
    log.info({ audioPath, cueCount: cueKeywords.length }, 'Starting STT sync pipeline');

    // Step 1: Transcribe audio with word-level timestamps
    const { words } = await transcribeWithTimestamps(audioPath);

    if (words.length === 0) {
      log.warn('STT returned no words — falling back to proportional timing');
      return {
        segments: buildProportionalSegments(script, totalDuration, cueKeywords),
        words: [],
        usedStt: false,
      };
    }

    log.info({ wordCount: words.length }, 'STT transcription complete');

    // Step 2: Find timestamps for each cue trigger phrase
    const triggerPhrases = cueKeywords.map(ck => ck.triggerPhrase);
    const keywordTimestamps = findKeywordTimestamps(words, triggerPhrases);

    // Build a map: triggerPhrase → timestamp
    const phraseToTime = new Map<string, number>();
    for (const kt of keywordTimestamps) {
      phraseToTime.set(kt.keyword.toLowerCase(), kt.time);
    }

    // Step 3: Assign real timestamps to cues, falling back to proportional for unmatched
    const cueTimestamps = assignCueTimestamps(cueKeywords, phraseToTime, totalDuration);

    // Step 4: Build segments from assigned timestamps
    const segments = buildSegmentsFromCueTimestamps(script, cueTimestamps, totalDuration, words);

    const matchedCount = cueKeywords.filter(
      ck => phraseToTime.has(ck.triggerPhrase.toLowerCase())
    ).length;
    log.info(
      { total: cueKeywords.length, matched: matchedCount, segments: segments.length },
      'STT sync complete'
    );

    return { segments, words, usedStt: true };
  } catch (err) {
    log.warn({ error: (err as Error).message }, 'STT sync failed — falling back to proportional timing');
    return {
      segments: buildProportionalSegments(script, totalDuration, cueKeywords),
      words: [],
      usedStt: false,
    };
  }
}

/**
 * Assign real timestamps to cues. For each cue, uses the STT-matched time
 * if available, otherwise interpolates proportionally between known timestamps.
 */
function assignCueTimestamps(
  cueKeywords: CueKeyword[],
  phraseToTime: Map<string, number>,
  totalDuration: number,
): Array<{ visualCue: string; startTime: number }> {
  const result: Array<{ visualCue: string; startTime: number; matched: boolean }> = [];

  for (const ck of cueKeywords) {
    const matchedTime = phraseToTime.get(ck.triggerPhrase.toLowerCase());
    result.push({
      visualCue: ck.visualCue,
      startTime: matchedTime ?? -1,
      matched: matchedTime !== undefined,
    });
  }

  // Fill in unmatched cues by interpolating between known anchors
  // First pass: collect anchor points (matched cues + start/end)
  const anchors: Array<{ index: number; time: number }> = [
    { index: -1, time: 0 },
  ];
  for (let i = 0; i < result.length; i++) {
    if (result[i].matched) {
      anchors.push({ index: i, time: result[i].startTime });
    }
  }
  anchors.push({ index: result.length, time: totalDuration });

  // Second pass: linearly interpolate between anchors for unmatched cues
  for (let a = 0; a < anchors.length - 1; a++) {
    const fromIdx = anchors[a].index;
    const toIdx = anchors[a + 1].index;
    const fromTime = anchors[a].time;
    const toTime = anchors[a + 1].time;
    const gapCount = toIdx - fromIdx;

    if (gapCount <= 1) continue;

    for (let i = fromIdx + 1; i < toIdx; i++) {
      if (!result[i].matched) {
        const fraction = (i - fromIdx) / gapCount;
        result[i].startTime = fromTime + fraction * (toTime - fromTime);
      }
    }
  }

  // Ensure monotonically increasing, within bounds, and minimum 1.0s apart
  const MIN_SEGMENT_GAP = 1.0;
  for (let i = 0; i < result.length; i++) {
    if (result[i].startTime < 0) {
      result[i].startTime = (i / result.length) * totalDuration;
    }
    if (i > 0 && result[i].startTime <= result[i - 1].startTime + MIN_SEGMENT_GAP) {
      result[i].startTime = result[i - 1].startTime + MIN_SEGMENT_GAP;
    }
  }

  return result.map(r => ({ visualCue: r.visualCue, startTime: Math.min(r.startTime, totalDuration - 0.1) }));
}

/**
 * Build NarrationSegments from cue timestamps.
 * Each segment runs from its cue's startTime to the next cue's startTime.
 * Text is assigned proportionally from the script.
 */
function buildSegmentsFromCueTimestamps(
  script: string,
  cueTimestamps: Array<{ visualCue: string; startTime: number }>,
  totalDuration: number,
  words: TimestampedWord[],
): NarrationSegment[] {
  if (cueTimestamps.length === 0) return [];

  const segments: NarrationSegment[] = [];
  const scriptWords = script.split(/\s+/);
  const wordsPerSegment = Math.max(1, Math.floor(scriptWords.length / cueTimestamps.length));

  for (let i = 0; i < cueTimestamps.length; i++) {
    const startTime = cueTimestamps[i].startTime;
    const endTime = i < cueTimestamps.length - 1
      ? cueTimestamps[i + 1].startTime
      : totalDuration;

    // Assign script text proportionally to this segment
    const wordStart = i * wordsPerSegment;
    const wordEnd = i === cueTimestamps.length - 1
      ? scriptWords.length
      : (i + 1) * wordsPerSegment;
    const text = scriptWords.slice(wordStart, wordEnd).join(' ');

    segments.push({
      text,
      estimatedStart: startTime,
      estimatedEnd: endTime,
      visualCue: cueTimestamps[i].visualCue,
      index: i,
    });
  }

  return segments;
}

/**
 * Fallback: build proportional segments from word count when STT is unavailable.
 * This was the original behavior — kept as fallback only.
 */
function buildProportionalSegments(
  script: string,
  totalDuration: number,
  cueKeywords: CueKeyword[],
): NarrationSegment[] {
  const wordCount = script.split(/\s+/).length;
  const wordsPerSegment = Math.max(1, Math.floor(wordCount / Math.max(1, cueKeywords.length)));
  const scriptWords = script.split(/\s+/);
  const segments: NarrationSegment[] = [];

  let timeAccum = 0;

  for (let i = 0; i < cueKeywords.length; i++) {
    const wordStart = i * wordsPerSegment;
    const wordEnd = i === cueKeywords.length - 1
      ? scriptWords.length
      : (i + 1) * wordsPerSegment;
    const segmentWords = wordEnd - wordStart;
    const segmentDuration = (segmentWords / wordCount) * totalDuration;

    segments.push({
      text: scriptWords.slice(wordStart, wordEnd).join(' '),
      estimatedStart: timeAccum,
      estimatedEnd: timeAccum + segmentDuration,
      visualCue: cueKeywords[i].visualCue,
      index: i,
    });

    timeAccum += segmentDuration;
  }

  return segments;
}
