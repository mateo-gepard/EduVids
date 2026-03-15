import { orchestrate } from './src/orchestrator/orchestrator.js';

async function run() {
  const start = Date.now();
  console.log("Starting comprehensive video generation test...");
  console.log("Topic: Einstein's Theory of Relativity (all agents)");
  console.log("Target: 3 minutes, standard difficulty, English\n");

  try {
    const project = await orchestrate({
      text: `Einstein's Theory of Relativity — A Complete Explainer

Albert Einstein published his Special Theory of Relativity in 1905 while working as a patent clerk in Bern, Switzerland. It was a revolutionary moment in physics.

Key formula: E = mc², where E is energy, m is mass, and c is the speed of light (299,792,458 m/s). This equation shows that mass and energy are interchangeable.

The theory rests on two postulates:
1. The laws of physics are the same in all inertial reference frames
2. The speed of light in vacuum is constant for all observers

Step-by-step derivation of time dilation:
- Start with the light clock thought experiment
- A photon bounces between two mirrors
- For a moving observer, the photon travels a longer diagonal path
- Using the Pythagorean theorem: t' = t / sqrt(1 - v²/c²)
- This is the Lorentz factor γ (gamma)

Famous quote by Einstein: "Imagination is more important than knowledge. Knowledge is limited. Imagination encircles the world."

Another key quote: "The most incomprehensible thing about the universe is that it is comprehensible." — Albert Einstein, 1936

Historical context: Einstein fled Nazi Germany in 1933 and settled at Princeton's Institute for Advanced Study. His letter to President Roosevelt in 1939 warned about atomic weapons, eventually leading to the Manhattan Project.

Fun fact: GPS satellites must account for relativistic time dilation — without corrections, GPS would drift by about 10 km per day!

Another fun fact: If you traveled at 90% the speed of light, time would slow down for you by a factor of 2.3 compared to someone on Earth.

The relationship between Special and General Relativity:
- Special Relativity deals with constant velocity (inertial frames)
- General Relativity extends this to acceleration and gravity
- Gravity is not a force but a curvature of spacetime
- Massive objects warp the fabric of spacetime around them

Key concepts that can be visualized as a diagram:
- Spacetime curvature: mass bends spacetime like a bowling ball on a trampoline
- Light cones: the boundary of causally connected events
- Twin paradox: one twin travels at near-light speed, returns younger
- Gravitational lensing: light bends around massive objects

Experimental evidence:
- 1919 solar eclipse confirmed light bending around the Sun (Arthur Eddington)
- Gravitational waves detected by LIGO in 2015
- Mercury's orbital precession explained by General Relativity
- Pound-Rebka experiment (1959) confirmed gravitational redshift

Quiz material:
Q: What does the 'c' stand for in E=mc²?
A: The speed of light in vacuum (approximately 3 × 10⁸ m/s)

Q: What happens to time as you approach the speed of light?
A: Time slows down (time dilation)

Summary points:
- Relativity unified space and time into spacetime
- Mass and energy are equivalent (E=mc²)
- Gravity curves spacetime
- The theory has been confirmed by countless experiments
- Applications: GPS, nuclear energy, particle accelerators`,
      params: {
        duration: 180,
        durationMinutes: 3,
        difficulty: "standard",
        language: "en"
      }
    }, (event) => {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`[${elapsed}s] [${event.progress}%] ${event.status}: ${event.message} ${event.currentScene || ''}`);
    });

    const totalTime = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`\n🎉 Generation complete in ${totalTime}s!`);
    console.log(`Output Video: ${project.outputPath}`);
    console.log(`Duration: ${project.timeline?.entries?.reduce((sum: number, e: any) => sum + (e.endTime - e.startTime), 0)?.toFixed(1)}s`);
    console.log(`Scenes: ${project.timeline?.entries?.length}`);
  } catch (err) {
    const totalTime = ((Date.now() - start) / 1000).toFixed(1);
    console.error(`\n❌ Generation failed after ${totalTime}s:`, err);
  }
}

run();
