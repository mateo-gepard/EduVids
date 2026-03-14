// ─── Core Types for EduVid AI ───────────────────────────────────────────────

/** Difficulty levels for content generation */
export type Difficulty = 'overview' | 'standard' | 'deep';

/** Supported scene types — one per sub-agent */
export type SceneType =
  | 'intro'
  | 'outro'
  | 'infografik'
  | 'ken-burns'
  | 'formel'
  | 'zitat'
  | 'step-by-step'
  | 'quiz'
  | 'funfact'
  | 'zusammenfassung';

/** User-configurable video parameters */
export interface VideoParams {
  /** Target duration in seconds */
  duration: number;
  /** Target duration in minutes (convenience) */
  durationMinutes: number;
  /** Content difficulty / depth */
  difficulty: Difficulty;
  /** Output language (ISO 639-1) */
  language: string;
  /** ElevenLabs voice ID override */
  voiceId?: string;
}

/** Raw user input before parsing */
export interface ProjectInput {
  /** Plain text content or topic description */
  text?: string;
  /** Path to uploaded PDF file */
  pdfPath?: string;
  /** Path to uploaded image (handwritten notes) */
  imagePath?: string;
  /** User-tunable parameters */
  params: VideoParams;
}

/** Parsed content block from input */
export interface ContentBlock {
  type: 'heading' | 'paragraph' | 'formula' | 'list' | 'quote' | 'image-ref';
  content: string;
  level?: number; // for headings
  items?: string[]; // for lists
}

/** One scene in the storyboard */
export interface SceneSpec {
  id: string;
  type: SceneType;
  title: string;
  /** Narrative content / talking points for this scene */
  content: string;
  /** Time budget in seconds */
  timeBudget: number;
  /** Scene-specific metadata */
  metadata?: Record<string, unknown>;
  /** Visual hints for the rendering engine */
  visualHints?: string;
  /** Order index */
  order: number;
}

/** Complete storyboard — ordered list of scenes */
export interface Storyboard {
  projectId: string;
  totalDuration: number;
  scenes: SceneSpec[];
  /** Narrative arc description from planner */
  narrativeArc?: string;
}

/** Input passed from orchestrator to a sub-agent */
export interface SubAgentInput {
  sceneSpec: SceneSpec;
  projectId: string;
  workDir: string;
  language: string;
  voiceId?: string;
  difficulty: Difficulty;
}

/** Audio result from TTS */
export interface AudioResult {
  filePath: string;
  durationSeconds: number;
}

/** Word with timestamp from STT */
export interface TimestampedWord {
  word: string;
  start: number;
  end: number;
}

/** Image search result */
export interface ImageResult {
  url: string;
  title: string;
  thumbnailUrl: string;
  width: number;
  height: number;
  localPath?: string;
}

/** OCR detection on an image */
export interface OcrResult {
  fullText: string;
  words: Array<{
    text: string;
    boundingBox: { x: number; y: number; width: number; height: number };
    confidence: number;
  }>;
}

/** A visual frame/clip produced by a sub-agent */
export interface VisualClip {
  type: 'image' | 'video' | 'canvas-render';
  filePath: string;
  durationSeconds: number;
  /** Timestamps for keyword reveal animations (infografik) */
  revealTimestamps?: Array<{ keyword: string; time: number }>;
}

/** Output from a sub-agent */
export interface SubAgentOutput {
  sceneId: string;
  sceneType: SceneType;
  audio: AudioResult;
  visuals: VisualClip[];
  /** Narration script used */
  script: string;
  /** Actual duration achieved */
  durationSeconds: number;
  /** Narration segments (if segmentation was used) */
  segments?: NarrationSegment[];
}

/** A timed narration segment with an associated visual cue.
 *  Each segment represents one "visual beat" — a moment where the screen changes. */
export interface NarrationSegment {
  /** The exact text from the narration script for this segment */
  text: string;
  /** Estimated start time in seconds */
  estimatedStart: number;
  /** Estimated end time in seconds */
  estimatedEnd: number;
  /** Visual cue directive — tells the renderer what to do (e.g., "reveal_step:2") */
  visualCue: string;
  /** Zero-based index of this segment */
  index: number;
}

/** Final render timeline entry */
export interface TimelineEntry {
  order: number;
  sceneId: string;
  audioPath: string;
  visualPaths: string[];
  startTime: number;
  endTime: number;
  transition?: 'crossfade' | 'fade-black' | 'cut';
}

/** Complete render timeline */
export interface RenderTimeline {
  projectId: string;
  entries: TimelineEntry[];
  totalDuration: number;
  outputPath: string;
}

/** Project status */
export type ProjectStatus =
  | 'input-received'
  | 'parsing'
  | 'planning'
  | 'storyboard-ready'
  | 'rendering'
  | 'compositing'
  | 'done'
  | 'error';

/** Full project state */
export interface Project {
  id: string;
  status: ProjectStatus;
  input: ProjectInput;
  contentBlocks?: ContentBlock[];
  storyboard?: Storyboard;
  agentOutputs?: SubAgentOutput[];
  timeline?: RenderTimeline;
  outputPath?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/** Progress event for SSE */
export interface ProgressEvent {
  projectId: string;
  status: ProjectStatus;
  message: string;
  /** 0-100 */
  progress: number;
  currentScene?: string;
}
