# EduVid AI 🎓

EduVid AI is an advanced, automated educational video generator. It transforms simple text prompts and concepts into professional, fully-rendered explainer videos. Built on a sophisticated multi-agent AI architecture, EduVid handles everything from scriptwriting and storyboarding to visual rendering, voiceover generation, and final video composition.

## 🌟 Key Features

- **Multi-Pass AI Orchestration:** Employs a robust `Plan-Critique-Revise` loop to ensure high-quality educational content and logical flow before rendering begins.
- **Specialized Scene Sub-Agents:** Utilizes distinct, intelligent agents for different pedagogical formats:
## 🏗 Architecture & Pipeline

EduVid AI orchestrates video creation through a modular, multi-pass pipeline. The core engine is structured into separate discrete phases to ensure resilience and high quality:

1. **Input Parsing & Planning (`Orchestrator`)**:
   - The user's text prompt is processed by an LLM to extract key themes and concepts.
   - The `storyboard-planner` uses a **Plan-Critique-Revise** loop to construct a timeline (`RenderTimeline`). This timeline is segmented into individual scenes, each assigned a specific duration, style, and optimized pedagogical agent (e.g., `formel` for math, `quiz` for engagement).

2. **Agent Execution (The Sub-Agents)**:
   - Each scene is delegated to a specialized `BaseAgent` subclass.
   - These agents execute autonomously to perform:
     1. **Script Generation**: Writing a localized narration script tailored to their scene type.
     2. **TTS Synthesis**: Converting the script to high-quality speech via ElevenLabs (with OpenAI TTS fallback).
     3. **Visual Curation**: Agents like `KenBurnsAgent` search Pixabay for contextual background images.
     4. **Timeline Mapping**: Combining the generated script and TTS duration, the `narrationSegmenter` creates an `AnimationTimeline` syncing words to specific visual beats.

3. **Frame Rendering (`renderer.ts`)**:
   - The visual output is generated frame-by-frame using the `canvas` package.
   - Using the mapped `AnimationTimeline`, the renderer executes smooth easing functions (e.g., cubic-bezier) at exactly 30fps. Text, shapes, formulas, and images are drawn procedurally per frame to produce high-quality motion graphics that natively synchronize with the audio track without expensive AfterEffects processing.

4. **Encoding & Assembly (`ffmpeg.ts`)**:
   - **Scene Encoding**: `fluent-ffmpeg` compiles the raw PNG frames of each scene into segmented MP4 clips.
   - **Resilience and Normalization**: Before concatenation, every clip is aggressively normalized to a strict canonical format (`libx264`, `yuv420p`, `1920x1080`, `30fps`). This prevents FFmpeg from crashing during `concat` operations due to codec or resolution mismatches.
   - **Error Isolation**: If an individual agent crashes (e.g., API timeout), the Base Agent intercepts the failure and generates a *canonical black clip + silent audio track*. This ensures the overall video assembly never fails due to a single dropped scene.

## 🤖 Specialized Scene Sub-Agents

EduVid leverages bespoke agents to handle complex visual layouts. Each agent inherits from `BaseAgent` but overrides the render logic:

- **`IntroOutroAgent`**: Specialized in creating high-impact title sequences. It uses bold, contrasting typography and animating geometric shapes to hook the viewer or summarize key takeaways.
- **`StepByStepAgent`**: Parses procedural knowledge into lists. It controls timing to reveal list items sequentially, keeping the viewer focused on the current step as the voiceover reads it.
- **`FormelAgent`**: Optimized for STEM content. It parses mathematical or physics formulas and renders them using specialized formatting (like a built-in LaTeX-to-Canvas approach) for clear visual hierarchy.
- **`ZitatAgent`**: Designed for historical or impactful quotes. It applies stylized quotation marks, centers dynamic text, and uses slow scaling (easing) to emphasize the magnitude of the quote.
- **`InfografikAgent`**: Constructs visual diagrams or contextual layouts to explain abstract concepts, linking them directly to narration beats.
- **`QuizAgent`**: Creates an interactive pause. It presents a question, waits precisely for a "thinking" beat, and then applies a "reveal" animation to show the correct answer, engaging the viewer actively.
- **`KenBurnsAgent`**: The cinematic agent. It fetches high-resolution imagery and applies the "Ken Burns" effect—slow, algorithmic panning and zooming via FFmpeg filters (`zoompan`)—combined with subtitle overlays to add visual flair to long stretches of narration.

## 🚀 Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) (v18+)
- [FFmpeg](https://ffmpeg.org/) (Must be installed and available in your system `PATH`)
- OpenAI API Key (required — powers LLM + TTS fallback)
- ElevenLabs API Key (recommended — high-quality voices)
- Pixabay API Key (free — for real images: https://pixabay.com/api/docs/)

### Installation

1. Clone the repository and install dependencies:
   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in your API keys:
   ```bash
   cp .env.example .env
   ```

### Local Development
```bash
npm run dev
```
This starts both the Express backend (port 3001) and Vite frontend (port 5173).

### Production Deployment (Vercel + Railway)

The app is deployed as a **split architecture**:
- **Vercel** serves the Vite SPA frontend
- **Railway** runs the Express/FFmpeg/Canvas backend via Docker

**Railway environment variables:**
```
OPENAI_API_KEY=sk-...
ELEVENLABS_API_KEY=...
PIXABAY_API_KEY=...
ALLOWED_ORIGIN=https://your-app.vercel.app
```

**Vercel environment variable:**
```
VITE_API_URL=https://your-app.up.railway.app/api
```

Both platforms auto-deploy from GitHub pushes. Railway detects the Dockerfile automatically.

## 🛠 Tech Stack
- **Backend/Core Orchestration:** Node.js, TypeScript, Express
- **Video Processing:** `fluent-ffmpeg`, raw native FFmpeg process control, `canvas`
- **AI/NLP:** OpenAI API (GPT-4o)
- **Voice Synthesis:** ElevenLabs → OpenAI TTS fallback
- **Image Search:** Pixabay API (free, 100 req/min)
- **Frontend UI:** Vite, Vanilla JS
- **Deployment:** Vercel (frontend) + Railway (backend Docker)
