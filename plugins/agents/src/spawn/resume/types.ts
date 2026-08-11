import type { Program } from '../../lib/execs.js';

/** How a provider splices a resume into its launch command. Internal to this module — consumers go
 *  through `ResumeProvider.resumeArgs`. */
interface ResumePlan {
  /** The resume tokens to insert (e.g. `['--resume', '<id>']` or `['resume', '<id>']`). The leading
   *  tokens are literal flags/subcommand; the LAST token is the session id, which the command builder
   *  shell-escapes (so it may contain any characters). Keep the session id last. */
  args: string[];
  /** Where the tokens go relative to the program's own flags:
   *  - 'subcommand' — immediately after the binary, before any flags (codex `resume <id> --model …`);
   *  - 'flag' — after the binary/bypass flag, alongside `--model` (claude `-r <id>`, opencode `-s <id>`). */
  placement: 'subcommand' | 'flag';
}

/** A provider's resume strategy. One module per CLI, so adding a provider is a self-contained file
 *  (its session-id detection lives next to its usage parser in integrations/usage). */
export interface ResumeProvider {
  program: Program;
  /** Build the resume splice for a session id, or null when this provider can't resume a session. */
  resumeArgs(sessionId: string): ResumePlan | null;
}
