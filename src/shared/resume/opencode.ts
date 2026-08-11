import type { ResumeProvider } from './types.js';

/** opencode resumes a session in the interactive TUI with the top-level `-s <sessionId>` flag
 *  (verified on opencode 1.15: `-s, --session <id>` continues that session and composes with
 *  `--model` and `--prompt`). It sits alongside `--model`, before `--prompt`, hence 'flag'. */
export const opencodeResume: ResumeProvider = {
  program: 'opencode',
  resumeArgs: (sessionId) => ({ args: ['-s', sessionId], placement: 'flag' }),
};
