import type { ResumeProvider } from './types.js';

/** claude-code resumes a prior conversation in the interactive TUI with `--resume <sessionId>`
 *  (verified on claude 2.x: `--resume [value]` resumes the given session directly, no picker). The
 *  flag sits alongside `--model`, so the new prompt still arrives as the positional argument. */
export const claudeResume: ResumeProvider = {
  program: 'claude-code',
  resumeArgs: (sessionId) => ({ args: ['--resume', sessionId], placement: 'flag' }),
};
