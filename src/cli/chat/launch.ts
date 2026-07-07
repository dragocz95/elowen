import { resolveToken, NeedsLogin, login } from './token.js';
import { runChat } from './app.js';

/** Prompt for a line on the TTY. `mute` hides typed characters (for passwords) by swallowing the
 *  readline echo — the standard Node trick, since readline has no built-in masked input. The question
 *  itself is printed directly: readline renders it through the same `_writeToOutput` the mute swallows,
 *  so `rl.question(question)` under mute would show a blank line and the user would type blind. */
async function promptLine(question: string, mute = false): Promise<string> {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (mute) {
    const anyRl = rl as unknown as { _writeToOutput: (s: string) => void };
    anyRl._writeToOutput = (s: string) => { if (s.includes('\n')) process.stdout.write('\n'); };
    process.stdout.write(question);
    return new Promise((resolve) => rl.question('', (a) => { rl.close(); resolve(a); }));
  }
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

/** Interactive login → cache a full-scope token, returning it. Used by `orca login` and as the
 *  fallback when chat finds no token in the env or cache. */
export async function interactiveLogin(base: string, env: NodeJS.ProcessEnv): Promise<string> {
  const username = await promptLine('Username: ');
  const password = await promptLine('Password: ', true);
  return login(base, { username, password }, env);
}

/** Resolve a token (env → cache → interactive login) and open the interactive Orca chat TUI. The single
 *  entry point shared by the `orca chat` command and the launcher menu's "Talk to Orca" item. */
export async function launchChat(
  base: string, env: NodeJS.ProcessEnv,
  opts: { model?: string; session?: string; fresh?: boolean } = {},
): Promise<void> {
  let token: string;
  try { token = resolveToken(env); }
  catch (e) { if (e instanceof NeedsLogin) token = await interactiveLogin(base, env); else throw e; }
  await runChat({ base, token, model: opts.model, session: opts.session, fresh: opts.fresh });
}
