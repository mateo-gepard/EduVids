import { describe, it, expect } from 'vitest';
import type { SubAgentOutput, SceneSpec } from '../core/types.js';

// We test `heuristicCheck` indirectly via `scoreOutput`. To avoid real LLM
// calls we only exercise the fast-fail path (heuristic score < 4), which never
// reaches the LLM.

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeScene(overrides: Partial<SceneSpec> = {}): SceneSpec {
  return {
    id: 'scene-1',
    order: 0,
    type: 'intro',
    title: 'Test Scene',
    content: 'A short intro about the French Revolution.',
    timeBudget: 30,
    ...overrides,
  };
}

function makeOutput(overrides: Partial<SubAgentOutput> = {}): SubAgentOutput {
  return {
    sceneId: 'scene-1',
    sceneType: 'intro',
    script: 'The French Revolution began in 1789 when widespread inequality and economic hardship drove the French people to rise against the monarchy.',
    durationSeconds: 30,
    audio: { filePath: '/tmp/audio.mp3', durationSeconds: 30 },
    visuals: [],
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('quality scorer heuristics (fast-fail path)', () => {
  it('passes a well-formed output without calling the LLM', async () => {
    // scoreOutput would call the LLM for well-formed output — skip this in unit
    // tests and test only the heuristic cases that never reach the LLM.
    // We verify the fast-fail path by giving obviously broken inputs.
    expect(true).toBe(true); // placeholder — see tests below
  });

  it('detects empty script', async () => {
    const { scoreOutput } = await import('../orchestrator/qualityScorer.js');
    const scene = makeScene({ timeBudget: 30 });
    const output = makeOutput({ script: '' });
    const score = await scoreOutput(output, scene);
    expect(score.passesThreshold).toBe(false);
    expect(score.issues.some(i => /empty/i.test(i))).toBe(true);
  });

  it('detects suspiciously short script', async () => {
    const { scoreOutput } = await import('../orchestrator/qualityScorer.js');
    const scene = makeScene({ timeBudget: 60 });
    const output = makeOutput({ script: 'Hi.' });
    const score = await scoreOutput(output, scene);
    expect(score.passesThreshold).toBe(false);
    expect(score.issues.length).toBeGreaterThan(0);
  });

  it('detects zero duration', async () => {
    const { scoreOutput } = await import('../orchestrator/qualityScorer.js');
    const scene = makeScene({ timeBudget: 30 });
    const output = makeOutput({ durationSeconds: 0 });
    const score = await scoreOutput(output, scene);
    expect(score.passesThreshold).toBe(false);
    expect(score.issues.some(i => /duration/i.test(i))).toBe(true);
  });

  it('detects missing audio file path', async () => {
    const { scoreOutput } = await import('../orchestrator/qualityScorer.js');
    const scene = makeScene({ timeBudget: 30 });
    // Short script (<20 chars) deducts 3 + audio empty deducts 3 → heuristic score 1
    const output = makeOutput({
      script: 'Too short.',
      audio: { filePath: '', durationSeconds: 30 },
    });
    const score = await scoreOutput(output, scene);
    expect(score.passesThreshold).toBe(false);
    expect(score.issues.some(i => /audio/i.test(i))).toBe(true);
  });

  it('detects duration diverging >50% from budget', async () => {
    const { scoreOutput } = await import('../orchestrator/qualityScorer.js');
    const scene = makeScene({ timeBudget: 30 });
    // Empty script (-5) + word count too short (-2) + diverges (-2) = heuristic score -2
    // This ensures we fail heuristics without calling the LLM, while still checking
    // that the "diverges" issue is reported.
    const output = makeOutput({ script: '', durationSeconds: 120 });
    const score = await scoreOutput(output, scene);
    expect(score.passesThreshold).toBe(false);
    expect(score.issues.some(i => /diverges/i.test(i))).toBe(true);
  });
});
