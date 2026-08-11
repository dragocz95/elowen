import type { ResumeProvider } from './types.js';

/** oh-my-pi resumes a prior session in its interactive TUI with `--resume <id>` (verified on omp
 *  16.2: `-r, --resume=<value>` resumes a session by id prefix/path; composes with `--model` and the
 *  positional prompt). It sits alongside `--model`, before the positional prompt, hence 'flag'. */
export const ompResume: ResumeProvider = {
  program: 'omp',
  resumeArgs: (sessionId) => ({ args: ['--resume', sessionId], placement: 'flag' }),
};
