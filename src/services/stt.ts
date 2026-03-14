import fs from 'fs/promises';
import OpenAI from 'openai';
import { config } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import type { TimestampedWord } from '../core/types.js';

const log = createLogger({ module: 'stt' });

// ── Singleton OpenAI Client ──────────────────────────────────────────────────
let openaiClient: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: config.openaiApiKey });
  }
  return openaiClient;
}

/**
 * Transcribe audio with word-level timestamps using OpenAI Whisper API.
 */
export async function transcribeWithTimestamps(
  audioPath: string
): Promise<{ text: string; words: TimestampedWord[] }> {
  if (config.mockMode) {
    log.info('Mock mode: returning placeholder transcription');
    return {
      text: 'Dies ist ein Platzhalter-Text für die Transkription.',
      words: [
        { word: 'Dies', start: 0, end: 0.3 },
        { word: 'ist', start: 0.3, end: 0.5 },
        { word: 'ein', start: 0.5, end: 0.7 },
        { word: 'Platzhalter-Text', start: 0.7, end: 1.2 },
        { word: 'für', start: 1.2, end: 1.4 },
        { word: 'die', start: 1.4, end: 1.5 },
        { word: 'Transkription', start: 1.5, end: 2.2 },
      ],
    };
  }

  const audioFile = await fs.readFile(audioPath);
  const file = new File([audioFile], 'audio.mp3', { type: 'audio/mpeg' });

  log.info({ audioPath }, 'Transcribing audio with word timestamps');

  const response = await getOpenAI().audio.transcriptions.create({
    model: config.whisperModel,
    file,
    response_format: 'verbose_json',
    timestamp_granularities: ['word'],
  });

  const words: TimestampedWord[] = (response as any).words?.map(
    (w: any) => ({
      word: w.word,
      start: w.start,
      end: w.end,
    })
  ) || [];

  log.info({ wordCount: words.length }, 'Transcription complete');

  return { text: response.text, words };
}

/**
 * Find timestamps for specific keywords in the transcribed words.
 */
export function findKeywordTimestamps(
  words: TimestampedWord[],
  keywords: string[]
): Array<{ keyword: string; time: number }> {
  const results: Array<{ keyword: string; time: number }> = [];
  const normalizedWords = words.map((w) => ({
    ...w,
    normalized: w.word.toLowerCase().replace(/[.,!?;:]/g, ''),
  }));

  for (const keyword of keywords) {
    const keywordLower = keyword.toLowerCase();
    const keywordParts = keywordLower.split(/\s+/);

    for (let i = 0; i <= normalizedWords.length - keywordParts.length; i++) {
      const match = keywordParts.every(
        (part, j) => normalizedWords[i + j].normalized.includes(part)
      );
      if (match) {
        results.push({ keyword, time: normalizedWords[i].start });
        break; // first occurrence only
      }
    }
  }

  return results;
}
