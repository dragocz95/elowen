import { defineConfig } from 'vitest/config';

// The suite runs 657 files in a fork pool sized to the machine's CPU count, and a good many of them do
// real work: buildApp and buildBrainCore construct the whole daemon core including the plugin registry,
// several store tests spawn a child process, and the container/sandbox tests drive real subprocess
// lifecycles. In isolation those cost 0.3-2 s each. Under a saturated host they cost well past vitest's
// default 5 s testTimeout and fail — falsely, because nothing in them asserts on time.
//
// Measured: two full runs on a loaded 16-core host failed 4 files and then 14, barely overlapping, and
// all 16 failures were "Test timed out in 5000ms" rather than an assertion. Each passed in isolation.
// The default is an incidental limit here, not a chosen budget, so it is raised to a value that still
// catches a genuine hang quickly while leaving contention room above the slowest real test (~2 s).
const TIMEOUT_MS = 30_000;

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup/pluginPromptOverlay.ts'],
    testTimeout: TIMEOUT_MS,
    // Hooks build the same daemon cores the bodies do, so they need the same room.
    hookTimeout: TIMEOUT_MS,
  },
});
