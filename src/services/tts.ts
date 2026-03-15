import fs from 'fs/promises';
import path from 'path';
import OpenAI from 'openai';
import { config } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { probeAudioDuration } from '../core/utils.js';
import type { AudioResult } from '../core/types.js';
import * as googleTTS from 'google-tts-api';

const log = createLogger({ module: 'tts' });

export interface TTSOptions {
  voiceId?: string;
  language?: string;
}

// probeAudioDuration is provided by core/utils.ts

// ── ElevenLabs TTS ────────────────────────────────────────────────────────────

/**
 * Generate speech via ElevenLabs API (high-quality, requires API key).
 * This is the primary TTS provider when ELEVENLABS_API_KEY is set.
 */
async function textToSpeechElevenLabs(
  text: string,
  outputDir: string,
  filename: string,
  voiceId: string
): Promise<AudioResult> {
  const outPath = path.join(outputDir, `${filename}.mp3`);

  log.info({ textLength: text.length, voiceId }, 'Generating ElevenLabs TTS audio');

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: 'POST',
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': config.elevenlabsApiKey,
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`ElevenLabs TTS error ${response.status}: ${errorBody}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(outPath, buffer);

  const stats = await fs.stat(outPath);
  const durationSeconds = await probeAudioDuration(outPath, stats.size) ?? 5;
  const safeDuration = durationSeconds > 0 && isFinite(durationSeconds) ? durationSeconds : 5;

  log.info({ outPath, durationSeconds: safeDuration }, 'ElevenLabs TTS audio generated');
  return { filePath: outPath, durationSeconds: safeDuration };
}

// ── OpenAI TTS fallback ───────────────────────────────────────────────────────

/**
 * Generate speech via OpenAI TTS API (good quality, uses existing API key).
 * This is the secondary TTS provider when ElevenLabs is unavailable.
 */
async function textToSpeechOpenAI(
  text: string,
  outputDir: string,
  filename: string,
  language: string
): Promise<AudioResult> {
  const outPath = path.join(outputDir, `${filename}.mp3`);

  log.info({ textLength: text.length }, 'Generating OpenAI TTS audio');

  const openai = new OpenAI({ apiKey: config.openaiApiKey });
  const voice = language === 'de' ? 'nova' : 'alloy';
  const response = await openai.audio.speech.create({
    model: 'tts-1',
    voice,
    input: text,
    speed: 0.92,
  });

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(outPath, buffer);

  const stats = await fs.stat(outPath);
  const durationSeconds = await probeAudioDuration(outPath, stats.size) ?? 5;
  const safeDuration = durationSeconds > 0 && isFinite(durationSeconds) ? durationSeconds : 5;

  log.info({ outPath, durationSeconds: safeDuration }, 'OpenAI TTS audio generated');
  return { filePath: outPath, durationSeconds: safeDuration };
}

// ── Google TTS fallback ───────────────────────────────────────────────────────

/**
 * Fallback TTS via the unofficial Google Translate TTS endpoint.
 * WARNING: This violates Google's Terms of Service for commercial use.
 * Use only for development/testing. Set ELEVENLABS_API_KEY for production.
 */
async function textToSpeechGoogleFallback(
  text: string,
  outputDir: string,
  filename: string,
  language: string
): Promise<AudioResult> {
  const outPath = path.join(outputDir, `${filename}.mp3`);

  log.warn(
    { textLength: text.length },
    'Using unofficial Google TTS fallback — set ELEVENLABS_API_KEY for production'
  );

  const urls = googleTTS.getAllAudioUrls(text, {
    lang: language,
    slow: false,
    host: 'https://translate.google.com',
    splitPunct: '.,?',
  });

  const buffers: Buffer[] = [];
  for (const { url } of urls) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch Google TTS audio chunk: ${response.statusText}`);
    }
    buffers.push(Buffer.from(await response.arrayBuffer()));
  }

  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(outPath, Buffer.concat(buffers));

  const stats = await fs.stat(outPath);
  const durationSeconds = await probeAudioDuration(outPath, stats.size) ?? 5;
  const safeDuration = durationSeconds > 0 && isFinite(durationSeconds) ? durationSeconds : 5;

  log.info({ outPath, durationSeconds: safeDuration }, 'Google TTS audio generated');
  return { filePath: outPath, durationSeconds: safeDuration };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Convert text to speech.
 * Provider priority:
 *   1. ElevenLabs (if ELEVENLABS_API_KEY is set) — high quality, commercial OK
 *   2. OpenAI TTS (if OPENAI_API_KEY is set) — good quality, reliable
 *   3. Google TTS unofficial (last resort for local dev only)
 */
export async function textToSpeech(
  text: string,
  outputDir: string,
  filename: string,
  options: TTSOptions = {}
): Promise<AudioResult> {
  if (config.mockMode) {
    log.info('Mock mode: creating placeholder audio file');
    const outPath = path.join(outputDir, `${filename}.mp3`);
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(outPath, Buffer.alloc(1024));
    return { filePath: outPath, durationSeconds: 10 };
  }

  const voiceId = options.voiceId || config.elevenlabsVoiceId;
  const language = options.language || 'de';

  // Use ElevenLabs when a key is available
  if (config.elevenlabsApiKey) {
    try {
      return await textToSpeechElevenLabs(text, outputDir, filename, voiceId);
    } catch (error) {
      log.error(
        { error: (error as Error).message },
        'ElevenLabs TTS failed — falling back to OpenAI TTS'
      );
    }
  }

  // OpenAI TTS fallback (reliable, uses existing API key)
  if (config.openaiApiKey) {
    try {
      return await textToSpeechOpenAI(text, outputDir, filename, language);
    } catch (error) {
      log.error(
        { error: (error as Error).message },
        'OpenAI TTS failed — falling back to Google TTS'
      );
    }
  }

  // Google TTS last resort
  try {
    return await textToSpeechGoogleFallback(text, outputDir, filename, language);
  } catch (error) {
    throw new Error(`All TTS providers failed. Last error: ${(error as Error).message}`);
  }
}


