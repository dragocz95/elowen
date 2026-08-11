import type { ResumeProvider } from './types.js';

/** Kilo Code resumes a prior session in its interactive TUI with `--session <sessionId>`
 *  (verified on kilo 7.x: `-s, --session <sessionId>` restores a session by id; composes with
 *  `--model` and `--prompt`). It sits alongside `--model`, hence 'flag'. */
export const kiloResume: ResumeProvider = {
  program: 'kilo',
  resumeArgs: (sessionId) => ({ args: ['--session', sessionId], placement: 'flag' }),
};
