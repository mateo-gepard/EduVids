// ═══════════════════════════════════════════════════════════════════════════
// EduVid AI — Chain-of-Thought Reasoning Engine
// Structured reasoning, self-critique, and plan-with-backtracking
// ═══════════════════════════════════════════════════════════════════════════

import { generateJSON, generateText } from '../services/llm.js';
import { createLogger } from './logger.js';

const log = createLogger({ module: 'reasoning' });

// ── Types ────────────────────────────────────────────────────────────────────

export interface ThoughtStep {
  observation: string;
  reasoning: string;
  conclusion: string;
  confidence: number; // 0-1
}

export interface CritiqueResult {
  score: number;        // 1-10
  strengths: string[];
  weaknesses: string[];
  suggestions: string[];
  shouldRevise: boolean;
}

export interface ReasoningTrace {
  steps: ThoughtStep[];
  finalConclusion: string;
  totalConfidence: number;
}

// ── Chain-of-Thought Reasoning ───────────────────────────────────────────────

/**
 * Multi-step reasoning with explicit thought chains.
 * Forces the LLM to show its work before concluding.
 */
export async function thinkStep(
  context: string,
  question: string,
  constraints: string[] = []
): Promise<ReasoningTrace> {
  const constraintText = constraints.length > 0
    ? `\nConstraints to satisfy:\n${constraints.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
    : '';

  const prompt = `You are reasoning step-by-step to answer a question.

Context:
${context}

Question:
${question}
${constraintText}

Think through this carefully in multiple steps. For each step:
1. State what you observe (observation)
2. Reason about it (reasoning)
3. Draw a conclusion (conclusion)
4. Rate your confidence 0-1 (confidence)

After all steps, provide a final conclusion.

Respond as JSON:
{
  "steps": [
    { "observation": "...", "reasoning": "...", "conclusion": "...", "confidence": 0.9 }
  ],
  "finalConclusion": "...",
  "totalConfidence": 0.85
}`;

  const result = await generateJSON<ReasoningTrace>(prompt, {
    systemPrompt: 'You are a meticulous reasoning agent. Think deeply before concluding. Be honest about uncertainty.',
    temperature: 0.3,
  });

  log.info(
    { steps: result.steps.length, confidence: result.totalConfidence },
    'Reasoning trace completed'
  );

  return result;
}

// ── Self-Critique ────────────────────────────────────────────────────────────

/**
 * Have the LLM critique its own output. Returns a structured score with
 * strengths, weaknesses, and revision suggestions.
 */
export async function reflectAndCritique(
  artifact: string,
  artifactType: string,
  criteria: string[]
): Promise<CritiqueResult> {
  const criteriaText = criteria.map((c, i) => `${i + 1}. ${c}`).join('\n');

  const prompt = `You are a rigorous quality reviewer. Critically evaluate this ${artifactType}:

--- BEGIN ARTIFACT ---
${artifact.slice(0, 6000)}
--- END ARTIFACT ---

Evaluation criteria:
${criteriaText}

Be brutally honest. Score 1-10 (7+ is good, below 7 needs revision).

Respond as JSON:
{
  "score": 8,
  "strengths": ["..."],
  "weaknesses": ["..."],
  "suggestions": ["..."],
  "shouldRevise": false
}`;

  const result = await generateJSON<CritiqueResult>(prompt, {
    systemPrompt: 'You are a critical reviewer. Be specific and actionable in feedback.',
    temperature: 0.2,
  });

  log.info(
    { artifactType, score: result.score, shouldRevise: result.shouldRevise },
    'Self-critique completed'
  );

  return result;
}

// ── Plan with Backtracking ───────────────────────────────────────────────────

/**
 * Plan → critique → revise loop. Keeps refining until score ≥ threshold
 * or maxIterations reached.
 */
export async function planWithBacktracking<T>(
  generatePlan: () => Promise<T>,
  serializePlan: (plan: T) => string,
  criteria: string[],
  revise: (plan: T, critique: CritiqueResult) => Promise<T>,
  options: { maxIterations?: number; scoreThreshold?: number } = {}
): Promise<{ plan: T; iterations: number; finalScore: number }> {
  const { maxIterations = 3, scoreThreshold = 7 } = options;

  let plan = await generatePlan();
  let iterations = 1;
  let finalScore = 0;

  for (let i = 0; i < maxIterations; i++) {
    const serialized = serializePlan(plan);
    const critique = await reflectAndCritique(serialized, 'plan', criteria);
    finalScore = critique.score;

    log.info(
      { iteration: i + 1, score: critique.score, shouldRevise: critique.shouldRevise },
      'Plan evaluation'
    );

    if (critique.score >= scoreThreshold || !critique.shouldRevise) {
      break;
    }

    // Revise based on critique
    log.info({ suggestions: critique.suggestions.length }, 'Revising plan');
    plan = await revise(plan, critique);
    iterations++;
  }

  return { plan, iterations, finalScore };
}

// ── Content Analysis ─────────────────────────────────────────────────────────

export interface ContentAnalysis {
  themes: string[];
  keyConcepts: string[];
  complexity: 'beginner' | 'intermediate' | 'advanced';
  pedagogicalGoals: string[];
  suggestedVisualStyles: string[];
  estimatedDepth: number; // 1-10
  prerequisites: string[];
  targetAudience: string;
}

/**
 * Deep analysis of educational content via CoT reasoning.
 * Extracts themes, concepts, pedagogical goals, and visual style suggestions.
 */
export async function analyzeContent(
  content: string,
  targetDifficulty: string,
  language: string
): Promise<ContentAnalysis> {
  const prompt = `Analyze this educational content deeply. Think carefully about:
- What are the main themes and how do they connect?
- What key concepts must a student understand?
- How complex is this material?
- What are the pedagogical goals?
- What visual styles would best communicate this?

Content:
${content.slice(0, 4000)}

Target difficulty: ${targetDifficulty}
Language: ${language}

Respond as JSON:
{
  "themes": ["theme1", "theme2"],
  "keyConcepts": ["concept1", "concept2"],
  "complexity": "intermediate",
  "pedagogicalGoals": ["goal1", "goal2"],
  "suggestedVisualStyles": ["infographic", "timeline", "diagram"],
  "estimatedDepth": 6,
  "prerequisites": ["prereq1"],
  "targetAudience": "..."
}`;

  return generateJSON<ContentAnalysis>(prompt, {
    systemPrompt: 'You are an expert educational content analyst and curriculum designer.',
    temperature: 0.3,
  });
}
