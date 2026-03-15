import type { BaseAgent } from './base.js';
import type { SceneType } from '../core/types.js';
import { IntroOutroAgent } from './intro-outro.js';
import { InfografikAgent } from './infografik.js';
import { KenBurnsAgent } from './ken-burns.js';
import { FormelAgent } from './formel.js';
import { ZitatAgent } from './zitat.js';
import { StepByStepAgent } from './step-by-step.js';
import { QuizAgent } from './quiz.js';
import { FunfactAgent } from './funfact.js';
import { ZusammenfassungAgent } from './zusammenfassung.js';
import { DiagramAgent } from './diagram.js';

/**
 * Registry of all available sub-agents, keyed by scene type.
 */
const agents: Record<SceneType, BaseAgent> = {
  'intro': new IntroOutroAgent(),
  'outro': new IntroOutroAgent(),
  'infografik': new InfografikAgent(),
  'ken-burns': new KenBurnsAgent(),
  'formel': new FormelAgent(),
  'zitat': new ZitatAgent(),
  'step-by-step': new StepByStepAgent(),
  'quiz': new QuizAgent(),
  'funfact': new FunfactAgent(),
  'zusammenfassung': new ZusammenfassungAgent(),
  'diagram': new DiagramAgent(),
};

/**
 * Get a sub-agent by scene type.
 * @throws if the scene type is unknown
 */
export function getAgent(sceneType: SceneType): BaseAgent {
  const agent = agents[sceneType];
  if (!agent) {
    throw new Error(`Unknown scene type: ${sceneType}. Available: ${Object.keys(agents).join(', ')}`);
  }
  return agent;
}

/** List all registered scene types */
export function getAvailableSceneTypes(): SceneType[] {
  return Object.keys(agents) as SceneType[];
}
