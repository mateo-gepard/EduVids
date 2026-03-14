import { orchestrate } from './src/orchestrator/orchestrator.js';

async function run() {
  console.log("Starting direct video generation test...");
  try {
    const project = await orchestrate({
      text: "Explain the concept of gravity very briefly.",
      params: {
        duration: 120,
        durationMinutes: 2,
        difficulty: "standard",
        language: "en"
      }
    }, (event) => {
      console.log(`[Progress ${event.progress}%] ${event.status}: ${event.message} ${event.currentScene || ''}`);
    });
    console.log(`\n🎉 Generation complete!\nOutput Video: ${project.outputPath}`);
  } catch (err) {
    console.error("❌ Generation failed:", err);
  }
}

run();
