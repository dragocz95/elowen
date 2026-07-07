import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** `/editor` — compose the prompt in the user's own editor. The TUI caller suspends the terminal
 *  (tui.stop()) around this round-trip and re-inits afterwards; this module only owns the temp-file
 *  dance and the $VISUAL/$EDITOR resolution, so it stays unit-testable with a mocked spawn. */

/** The editor command as argv: $VISUAL, else $EDITOR, else vi. Split on whitespace so commands with
 *  arguments ("code --wait") work. */
export function editorCommand(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.VISUAL?.trim() || env.EDITOR?.trim() || 'vi').split(/\s+/);
}

export interface ExternalEditOpts {
  /** The current draft seeded into the temp file. */
  text: string;
  env?: NodeJS.ProcessEnv;
  /** Injected for tests; defaults to node's spawn (stdio inherited — the editor owns the TTY). */
  spawnFn?: typeof spawn;
}

/** Round-trip the draft through the external editor. Resolves to the edited content (a saved empty
 *  file → ''), or null when the editor exited non-zero or failed to launch — keep the original draft
 *  then. The temp file always gets cleaned up. */
export async function editTextExternally(o: ExternalEditOpts): Promise<string | null> {
  const [cmd = 'vi', ...args] = editorCommand(o.env);
  const dir = mkdtempSync(join(tmpdir(), 'orca-editor-'));
  const file = join(dir, 'draft.md');
  try {
    writeFileSync(file, o.text, 'utf-8');
    const spawnFn = o.spawnFn ?? spawn;
    // Async spawn, not spawnSync: a synchronous child keeps libuv's console read active on some
    // platforms after the TUI paused stdin, racing vi for the input buffer (same fix as pi's).
    const code = await new Promise<number | null>((resolve) => {
      const child = spawnFn(cmd, [...args, file], { stdio: 'inherit' });
      child.on('error', () => resolve(null));
      child.on('close', (exitCode) => resolve(exitCode));
    });
    if (code !== 0) return null;
    return readFileSync(file, 'utf-8').replace(/\n$/, '');
  } catch {
    return null;
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp cleanup is best-effort */ }
  }
}
