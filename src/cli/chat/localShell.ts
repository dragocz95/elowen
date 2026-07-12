import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { ElowenTurn } from '../../brain/transcript.js';
import type { ToolOutputView } from '../../brain/messageView.js';

/** `!cmd` local shell escape for the chat TUI (opencode-style): the command runs on THIS machine
 *  (the CLI's cwd), renders as a console block in the transcript, and its output is buffered as
 *  context for the NEXT prompt sent to the brain. Nothing here talks to the daemon. */

export const LOCAL_SHELL_TIMEOUT_MS = 30_000;
export const LOCAL_SHELL_MAX_CHARS = 20_000;
/** How many `!` results ride along with the next prompt before the oldest drops. */
export const MAX_SHELL_CONTEXT_RESULTS = 5;
/** Transcript preview length; the full (capped) output stays click-to-expandable. */
const PREVIEW_LINES = 20;

/** Extract the command from a `!`-prefixed message (`!ls -la`, `! git status`). Returns null for a
 *  regular chat message or a bare `!`. */
export function parseBangCommand(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('!')) return null;
  const command = trimmed.slice(1).trim();
  return command || null;
}

export interface LocalShellResult {
  command: string;
  /** stdout + stderr, trailing newlines stripped, capped at {@link LOCAL_SHELL_MAX_CHARS}. */
  output: string;
  /** null when the command couldn't run or was killed (timeout). */
  exitCode: number | null;
  truncated: boolean;
}

type ExecFn = (
  command: string,
  options: { cwd: string; timeout: number; maxBuffer: number },
  callback: (error: (Error & { code?: number | string; killed?: boolean }) | null, stdout: string, stderr: string) => void,
) => { kill(signal?: NodeJS.Signals): boolean } | unknown;

function terminateProcessTree(child: Pick<ChildProcess, 'pid' | 'kill'>, signal: NodeJS.Signals = 'SIGTERM'): boolean {
  // A shell escape commonly launches grandchildren (`sh -c 'sleep …'`). Killing only the shell leaves
  // those descendants holding stdout/stderr pipes, so the exec callback — and therefore CLI teardown —
  // remains stuck. A detached POSIX child becomes a process-group leader; a negative pid terminates the
  // complete command tree. Windows has no equivalent negative-pid contract, so use ChildProcess.kill().
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
    }
  }
  try { return child.kill(signal); } catch { return false; }
}

/** `exec` does not pass its undocumented `detached` option through to the underlying spawn. Own the
 * shell process explicitly so every local command has a real POSIX process group and bounded buffers. */
const spawnLocalShell: ExecFn = (command, options, callback) => {
  const child = spawn(command, {
    cwd: options.cwd,
    shell: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let bufferedBytes = 0;
  let overflow = false;
  let timedOut = false;
  let settled = false;
  const finish = (error: (Error & { code?: number | string; killed?: boolean }) | null): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    callback(error, stdout, stderr);
  };
  const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
    if (overflow) return;
    bufferedBytes += chunk.length;
    if (bufferedBytes > options.maxBuffer) {
      overflow = true;
      terminateProcessTree(child);
      return;
    }
    if (target === 'stdout') stdout += chunk.toString('utf8');
    else stderr += chunk.toString('utf8');
  };
  child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk));
  child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));
  child.once('error', (error) => finish(error));
  child.once('close', (code, closeSignal) => {
    if (overflow) {
      finish(Object.assign(new Error(`stdout/stderr exceeded ${options.maxBuffer} bytes`), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }));
      return;
    }
    if (timedOut || closeSignal) {
      finish(Object.assign(new Error(timedOut ? 'local shell timed out' : `local shell killed by ${closeSignal}`), { killed: true }));
      return;
    }
    finish(code === 0 ? null : Object.assign(new Error(`local shell exited ${code}`), { code: code ?? undefined }));
  });
  const timer = setTimeout(() => {
    timedOut = true;
    terminateProcessTree(child);
  }, options.timeout);
  return child;
};

/** Run a `!` command locally: /bin/sh semantics via a process-group-owned spawn, 30s timeout, stdout+stderr
 *  captured and capped. Never rejects — failures land in the result (exit code / timeout note). */
export function runLocalShell(
  command: string,
  cwd: string,
  execFn: ExecFn = spawnLocalShell,
  signal?: AbortSignal,
): Promise<LocalShellResult> {
  return new Promise((resolve) => {
    let child: { kill(signal?: NodeJS.Signals): boolean } | null = null;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = (): void => {
      if (!child) return;
      terminateProcessTree(child);
      // Commands can trap/ignore SIGTERM. Escalate the same owned group without holding the event loop
      // open; the normal close callback clears this before a pid could be reused.
      forceKillTimer = setTimeout(() => { if (child) terminateProcessTree(child, 'SIGKILL'); }, 250);
      forceKillTimer.unref?.();
    };
    const returned = execFn(command, { cwd, timeout: LOCAL_SHELL_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      signal?.removeEventListener('abort', onAbort);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      forceKillTimer = null;
      const parts = [stdout, stderr].filter((s) => s.length > 0);
      let output = parts.join(stdout.length > 0 && !stdout.endsWith('\n') ? '\n' : '').replace(/\n+$/, '');
      const truncated = output.length > LOCAL_SHELL_MAX_CHARS;
      if (truncated) output = `${output.slice(0, LOCAL_SHELL_MAX_CHARS)}\n… output truncated at ${LOCAL_SHELL_MAX_CHARS} chars`;
      if (error?.killed) output = output ? `${output}\n[timed out after ${LOCAL_SHELL_TIMEOUT_MS / 1000}s]` : `[timed out after ${LOCAL_SHELL_TIMEOUT_MS / 1000}s]`;
      const exitCode = error ? (typeof error.code === 'number' ? error.code : null) : 0;
      resolve({ command, output, exitCode, truncated });
    });
    if (returned && typeof returned === 'object' && 'kill' in returned && typeof returned.kill === 'function') {
      child = returned as { kill(signal?: NodeJS.Signals): boolean };
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/** Shape a local result as a settled assistant turn holding one console block, so the transcript's
 *  existing tool-output rendering (framed block, click-to-expand) applies unchanged. */
export function localShellTurn(result: LocalShellResult): ElowenTurn {
  const full = result.output || '(no output)';
  const lines = full.split('\n');
  const output: ToolOutputView = {
    title: 'local shell',
    kind: 'console',
    text: lines.slice(0, PREVIEW_LINES).join('\n'),
    fullText: lines.length > PREVIEW_LINES ? full : undefined,
    command: result.command,
    status: result.exitCode === 0 ? undefined : result.exitCode == null ? 'failed' : `exit ${result.exitCode}`,
    tone: result.exitCode === 0 ? 'normal' : 'danger',
  };
  return {
    role: 'elowen',
    streaming: false,
    segments: [{ kind: 'tools', items: [{ name: 'bash', detail: result.command, command: result.command, output }] }],
  };
}

/** Prepend the buffered `!` results to an outgoing message as one fenced context block. */
export function composeWithShellContext(message: string, results: LocalShellResult[]): string {
  if (results.length === 0) return message;
  const blocks = results.map((r) => {
    const exit = r.exitCode !== 0 ? `\n[exit ${r.exitCode ?? '?'}]` : '';
    return `$ ${r.command}\n${r.output || '(no output)'}${exit}`;
  });
  return `Local shell context:\n\`\`\`\n${blocks.join('\n\n')}\n\`\`\`\n\n${message}`;
}

/** The pending-inclusion buffer: `!` results collect here and ride along with the NEXT prompt, then
 *  the buffer clears. Session-local, capped at {@link MAX_SHELL_CONTEXT_RESULTS}. */
export class LocalShellBuffer {
  private results: LocalShellResult[] = [];

  get pending(): boolean { return this.results.length > 0; }

  add(result: LocalShellResult): void {
    this.results.push(result);
    if (this.results.length > MAX_SHELL_CONTEXT_RESULTS) this.results.shift();
  }

  /** Compose the outgoing message with any pending context and clear the buffer. */
  take(message: string): string {
    const out = composeWithShellContext(message, this.results);
    this.results = [];
    return out;
  }
}
