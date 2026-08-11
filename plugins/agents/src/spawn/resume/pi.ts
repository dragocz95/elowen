import type { ResumeProvider } from './types.js';

/** Pi resumes a prior session in its interactive TUI with `--session <path|id>` (verified on pi
 *  0.80: `--session <path|id>` uses a specific session file or partial UUID; composes with `--model`
 *  and the positional prompt). It sits alongside `--model`, before the positional prompt, hence
 *  'flag'. */
export const piResume: ResumeProvider = {
  program: 'pi',
  resumeArgs: (sessionId) => ({ args: ['--session', sessionId], placement: 'flag' }),
};
