// ═══════════════════════════════════════════════════════════════════════════
// EduVid AI — Quality Scorer v2
// Heuristic pre-checks + LLM-based multi-dimensional evaluation
// ═══════════════════════════════════════════════════════════════════════════

import { generateJSON } from '../services/llm.js';
import { createLogger } from '../core/logger.js';
import type { SubAgentOutput, SceneSpec } from '../core/types.js';

const log = createLogger({ module: 'quality-scorer' });

export interface QualityScore {
  scriptClarity: number;       // 1-10
  scriptAccuracy: number;      // 1-10
  engagement: number;          // 1-10
  pedagogicalValue: number;    // 1-10
  pacing: number;              // 1-10
  aggregate: number;           // weighted average
  issues: string[];
  passesThreshold: boolean;
}

const QUALITY_THRESHOLD = 6.5;

const DIMENSION_WEIGHTS = {
  scriptClarity: 0.2,
  scriptAccuracy: 0.25,
  engagement: 0.2,
  pedagogicalValue: 0.25,
  pacing: 0.1,
};

// ── Heuristic Pre-Checks ─────────────────────────────────────────────────────

interface HeuristicResult {
  passes: boolean;
  issues: string[];
  score: number; // 0-10 rough heuristic score
}

/**
 * Fast local checks before calling the expensive LLM scorer.
 * Catches obviously broken outputs without spending tokens.
 */
function heuristicCheck(output: SubAgentOutput, sceneSpec: SceneSpec): HeuristicResult {
  const issues: string[] = [];
  let score = 7; // start at "good" and deduct

  // 1. Script sanity
  if (!output.script || output.script.trim().length === 0) {
    issues.push('Script is empty');
    score -= 5;
  } else if (output.script.trim().length < 20) {
    issues.push('Script is suspiciously short (< 20 chars)');
    score -= 3;
  }

  // 2. Script word count vs time budget
  const words = output.script.split(/\s+/).length;
  const expectedWords = (sceneSpec.timeBudget / 60) * 140; // ~140 wpm
  if (words < expectedWords * 0.3) {
    issues.push(`Script too short: ${words} words for ${sceneSpec.timeBudget}s (expected ~${Math.round(expectedWords)})`);
    score -= 2;
  }
  if (words > expectedWords * 3) {
    issues.push(`Script too long: ${words} words for ${sceneSpec.timeBudget}s (expected ~${Math.round(expectedWords)})`);
    score -= 1;
  }

  // 3. Duration sanity
  if (!output.durationSeconds || output.durationSeconds <= 0) {
    issues.push('Duration is zero or negative');
    score -= 5;
  } else {
    const durationDiff = Math.abs(output.durationSeconds - sceneSpec.timeBudget) / sceneSpec.timeBudget;
    if (durationDiff > 0.5) {
      issues.push(`Duration ${output.durationSeconds}s diverges >50% from budget ${sceneSpec.timeBudget}s`);
      score -= 2;
    }
  }

  // 4. Audio file reference
  if (!output.audio?.filePath) {
    issues.push('No audio file path');
    score -= 3;
  }

  score = Math.max(0, Math.min(10, score));
  return { passes: score >= 4, issues, score };
}

// ── LLM-Based Quality Scoring ────────────────────────────────────────────────

/**
 * Score a sub-agent's output across multiple quality dimensions.
 * First runs heuristic checks — only calls LLM if heuristics pass.
 */
export async function scoreOutput(
  output: SubAgentOutput,
  sceneSpec: SceneSpec
): Promise<QualityScore> {
  // Run fast heuristic checks first
  const heuristic = heuristicCheck(output, sceneSpec);

  if (!heuristic.passes) {
    log.info(
      { sceneType: output.sceneType, heuristicScore: heuristic.score, issues: heuristic.issues },
      'Output failed heuristic pre-check — skipping LLM scoring'
    );
    return {
      scriptClarity: heuristic.score,
      scriptAccuracy: heuristic.score,
      engagement: heuristic.score,
      pedagogicalValue: heuristic.score,
      pacing: heuristic.score,
      aggregate: heuristic.score,
      issues: heuristic.issues,
      passesThreshold: false,
    };
  }

  // LLM-based deep scoring (only for outputs that pass heuristics)
  try {
    const prompt = `You are evaluating the quality of a scene in an educational video.

Scene type: ${output.sceneType}
Scene title: ${sceneSpec.title}
Expected content: ${sceneSpec.content.slice(0, 400)}
Time budget: ${sceneSpec.timeBudget}s
Actual duration: ${output.durationSeconds}s

Generated narration script:
"${output.script.slice(0, 1000)}"

Evaluate on these dimensions (score 1-10 each):

1. **Script Clarity** — Is the narration clear, well-structured, and easy to follow?
2. **Script Accuracy** — Does the script accurately cover the expected content?
3. **Engagement** — Is the script engaging? Does it hold attention?
4. **Pedagogical Value** — Does it effectively teach? Good explanations, examples?
5. **Pacing** — Is the content well-paced for the time budget?

Also list any specific issues found.

Respond as JSON:
{
  "scriptClarity": 8,
  "scriptAccuracy": 7,
  "engagement": 6,
  "pedagogicalValue": 8,
  "pacing": 7,
  "issues": ["issue1", "issue2"]
}`;

    const raw = await generateJSON<Omit<QualityScore, 'aggregate' | 'passesThreshold'>>(prompt, {
      systemPrompt: 'You are a strict but fair educational content reviewer. Be specific about issues.',
      temperature: 0.2,
    });

    // Compute weighted aggregate
    const aggregate =
      (raw.scriptClarity || 5) * DIMENSION_WEIGHTS.scriptClarity +
      (raw.scriptAccuracy || 5) * DIMENSION_WEIGHTS.scriptAccuracy +
      (raw.engagement || 5) * DIMENSION_WEIGHTS.engagement +
      (raw.pedagogicalValue || 5) * DIMENSION_WEIGHTS.pedagogicalValue +
      (raw.pacing || 5) * DIMENSION_WEIGHTS.pacing;

    const score: QualityScore = {
      scriptClarity: raw.scriptClarity || 5,
      scriptAccuracy: raw.scriptAccuracy || 5,
      engagement: raw.engagement || 5,
      pedagogicalValue: raw.pedagogicalValue || 5,
      pacing: raw.pacing || 5,
      aggregate: Math.round(aggregate * 100) / 100,
      issues: raw.issues || [],
      passesThreshold: aggregate >= QUALITY_THRESHOLD,
    };

    log.info(
      {
        sceneType: output.sceneType,
        aggregate: score.aggregate,
        passes: score.passesThreshold,
        issues: score.issues.length,
      },
      'Quality score computed'
    );

    return score;
  } catch (error) {
    // If LLM scoring fails, use heuristic score as fallback
    log.warn(
      { error: (error as Error).message },
      'LLM quality scoring failed — using heuristic score as fallback'
    );
    return {
      scriptClarity: heuristic.score,
      scriptAccuracy: heuristic.score,
      engagement: heuristic.score,
      pedagogicalValue: heuristic.score,
      pacing: heuristic.score,
      aggregate: heuristic.score,
      issues: [...heuristic.issues, `LLM scoring failed: ${(error as Error).message}`],
      passesThreshold: heuristic.score >= QUALITY_THRESHOLD,
    };
  }
}

/**
 * Score coherence across all scenes (transitions, tone consistency, coverage).
 */
export async function scoreCoherence(
  scripts: Array<{ type: string; title: string; script: string }>
): Promise<{
  score: number;
  issues: string[];
  suggestions: string[];
}> {
  const sceneSummaries = scripts
    .map((s, i) => `Scene ${i + 1} (${s.type}: ${s.title}): "${s.script.slice(0, 150)}..."`)
    .join('\n\n');

  const prompt = `Review these video scenes for coherence and flow:

${sceneSummaries}

Evaluate:
1. Are transitions between scenes smooth?
2. Is the tone consistent throughout?
3. Are there any redundancies or gaps in coverage?
4. Does the overall flow make pedagogical sense?

Score 1-10 and list specific issues and suggestions.

Respond as JSON:
{
  "score": 7,
  "issues": ["..."],
  "suggestions": ["..."]
}`;

  return generateJSON(prompt, {
    systemPrompt: 'You are a video editor reviewing an educational video script for coherence.',
    temperature: 0.2,
  });
}
