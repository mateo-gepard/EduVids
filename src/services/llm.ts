import OpenAI from 'openai';
import { z, type ZodSchema } from 'zod';
import { config } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { sleep } from '../core/utils.js';
import { Semaphore } from '../core/semaphore.js';

const log = createLogger({ module: 'llm' });

// Limit concurrent LLM calls to prevent 429 rate-limit errors
const llmSemaphore = new Semaphore(5);

// ── OpenAI Client ────────────────────────────────────────────────────────────

let openaiClient: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: config.openaiApiKey });
  }
  return openaiClient;
}

let geminiClient: OpenAI | null = null;

function getGemini(): OpenAI {
  if (!geminiClient) {
    geminiClient = new OpenAI({
      apiKey: config.geminiApiKey,
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    });
  }
  return geminiClient;
}

// ── Retry Configuration ──────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);



function isRetryableError(error: unknown): boolean {
  if (error instanceof OpenAI.APIError) {
    return RETRYABLE_STATUS_CODES.has(error.status);
  }
  // Network errors
  if (error instanceof TypeError && (error as any).cause?.code === 'ECONNRESET') {
    return true;
  }
  return false;
}

// ── Provider-agnostic interface ──────────────────────────────────────────────

export interface LLMOptions {
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  /** When true, request JSON mode from the provider (OpenAI only) */
  jsonMode?: boolean;
}

/**
 * Generate free-form text from an LLM with automatic retry on transient failures.
 */
export async function generateText(
  prompt: string,
  options: LLMOptions = {}
): Promise<string> {
  if (config.mockMode) {
    log.info('Mock mode: returning placeholder text');
    return `[MOCK LLM RESPONSE for prompt: ${prompt.slice(0, 80)}...]`;
  }

  // No hardcoded maxTokens default — let the model decide unless caller specifies
  const { temperature = 0.7, maxTokens, systemPrompt, jsonMode } = options;

  await llmSemaphore.acquire();
  try {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const result = await callLLM(prompt, temperature, maxTokens, systemPrompt, jsonMode);
        return result;
      } catch (error) {
        const isRetryable = isRetryableError(error);
        const isLastAttempt = attempt === MAX_RETRIES - 1;

        if (!isRetryable || isLastAttempt) {
          log.error(
            { attempt: attempt + 1, retryable: isRetryable, error: (error as Error).message },
            'LLM call failed (non-retryable or last attempt)'
          );
          throw error;
        }

        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        log.warn(
          { attempt: attempt + 1, delay, error: (error as Error).message },
          'LLM call failed (retrying)'
        );
        await sleep(delay);
      }
    }
  } finally {
    llmSemaphore.release();
  }

  throw new Error('LLM call exhausted all retries');
}

/**
 * Internal: call the configured LLM provider.
 */
async function callLLM(
  prompt: string,
  temperature: number,
  maxTokens: number | undefined,
  systemPrompt: string | undefined,
  jsonMode: boolean | undefined
): Promise<string> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  const baseParams: Record<string, unknown> = {
    messages,
    temperature,
  };
  // Only set max_tokens when explicitly provided — otherwise let the model decide
  if (maxTokens !== undefined) {
    baseParams.max_tokens = maxTokens;
  }

  if (config.llmProvider === 'openai') {
    const response = await getOpenAI().chat.completions.create({
      model: config.openaiModel,
      ...baseParams,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    } as any);

    return response.choices[0]?.message?.content || '';
  }

  if (config.llmProvider === 'gemini') {
    const response = await getGemini().chat.completions.create({
      model: config.geminiModel,
      ...baseParams,
    } as any);

    return response.choices[0]?.message?.content || '';
  }

  throw new Error(`Unsupported LLM provider: ${config.llmProvider}`);
}

// ── Robust JSON Extraction ───────────────────────────────────────────────────

/**
 * Multi-strategy JSON extraction. Tries in order:
 * 1. Direct JSON.parse (cleanest case)
 * 2. Strip markdown code fences
 * 3. Extract first JSON object/array from the text
 * 4. Strip control characters and retry
 */
function extractJSON<T>(raw: string): T {
  const strategies: Array<{ name: string; extract: () => string }> = [
    {
      name: 'direct',
      extract: () => raw.trim(),
    },
    {
      name: 'strip-fences',
      extract: () =>
        raw
          .replace(/^```(?:json)?\s*/im, '')
          .replace(/\s*```\s*$/im, '')
          .trim(),
    },
    {
      name: 'extract-object',
      extract: () => {
        // Find the first { ... } or [ ... ] block (greedy)
        const objMatch = raw.match(/(\{[\s\S]*\})/);
        if (objMatch) return objMatch[1];
        const arrMatch = raw.match(/(\[[\s\S]*\])/);
        if (arrMatch) return arrMatch[1];
        throw new Error('No JSON object or array found');
      },
    },
    {
      name: 'strip-control-chars',
      extract: () => {
        const objMatch = raw.match(/(\{[\s\S]*\})/);
        const text = objMatch ? objMatch[1] : raw;
        // Remove control characters except whitespace
        return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').trim();
      },
    },
  ];

  const errors: string[] = [];

  for (const strategy of strategies) {
    try {
      const extracted = strategy.extract();
      const parsed = JSON.parse(extracted) as T;
      if (strategy.name !== 'direct') {
        log.info({ strategy: strategy.name }, 'JSON extracted using fallback strategy');
      }
      return parsed;
    } catch (err) {
      errors.push(`${strategy.name}: ${(err as Error).message}`);
    }
  }

  log.error({ raw: raw.slice(0, 500), errors }, 'All JSON extraction strategies failed');
  throw new Error(
    `LLM returned unparseable JSON. Tried ${strategies.length} strategies.\n` +
    `Errors: ${errors.join('; ')}\n` +
    `Raw (first 300 chars): ${raw.slice(0, 300)}`
  );
}

// ── JSON Generation with Validation ──────────────────────────────────────────

/**
 * Generate a JSON response from an LLM, parsed with robust extraction.
 * Optionally validates against a Zod schema.
 */
export async function generateJSON<T>(
  prompt: string,
  options: LLMOptions = {},
  schema?: ZodSchema<T>
): Promise<T> {
  const systemPrompt = [
    options.systemPrompt || '',
    'You MUST respond with valid JSON only. No markdown, no code fences, no explanation.',
  ]
    .filter(Boolean)
    .join('\n');

  const raw = await generateText(prompt, {
    ...options,
    systemPrompt,
    jsonMode: config.llmProvider === 'openai', // Use native JSON mode for OpenAI
  });

  // Robust multi-strategy extraction
  const parsed = extractJSON<T>(raw);

  // Optional Zod validation
  if (schema) {
    const result = schema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`);
      log.error(
        { errors: issues },
        'LLM JSON failed schema validation'
      );
      throw new Error(
        `LLM response failed Zod schema validation:\n` +
        issues.map(i => `  • ${i}`).join('\n')
      );
    }
  }

  return parsed;
}

// ── Prompt Injection Sanitization ────────────────────────────────────────────

/**
 * Sanitize user-supplied text before embedding it in LLM prompts.
 * Strips common prompt injection patterns that attempt to override system instructions.
 */
export function sanitizeUserInput(input: string): string {
  return input
    // Remove explicit instruction-override attempts
    .replace(/ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|context|rules?)/gi, '[removed]')
    .replace(/you\s+are\s+now\s+(a|an)\b/gi, '[removed]')
    .replace(/\bnew\s+(instructions?|prompt|task|role)\b/gi, '[removed]')
    // Strip special tokens used by various LLM platforms
    .replace(/\[INST\]|\[\/INST\]|<\|endoftext\|>|<\|im_start\|>|<\|im_end\|>|<\|system\|>/g, '')
    // Strip role prefixes that could confuse the message structure
    .replace(/^(system|assistant|user)\s*:/gim, '[removed]:')
    // Cap length to prevent token-flooding / cost attacks (50k chars ≈ ~12k tokens)
    .slice(0, 50_000)
    .trim();
}
