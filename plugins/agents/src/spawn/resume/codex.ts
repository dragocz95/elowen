import type { ResumeProvider } from './types.js';

/** codex resumes a prior session via the `resume` subcommand: `codex resume <sessionId> …`
 *  (verified on codex 0.140: `resume [SESSION_ID] [PROMPT]` accepts `--model` and
 *  `--dangerously-bypass-approvals-and-sandbox` as options, and the new prompt as its positional).
 *  Because `resume` is a subcommand, it must come first — before any flags — hence 'subcommand'. */
export const codexResume: ResumeProvider = {
  program: 'codex',
  resumeArgs: (sessionId) => ({ args: ['resume', sessionId], placement: 'subcommand' }),
};
