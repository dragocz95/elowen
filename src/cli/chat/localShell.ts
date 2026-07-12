import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ElowenTurn } from '../../brain/transcript.js';
import type { ToolOutputView } from '../../brain/messageView.js';
import { BoundedProcessGroupTermination } from './processTermination.js';
import type { LinuxProcessOwner } from './processTermination.js';

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

type TerminationReason = 'abort' | 'timeout' | 'overflow';

interface LocalShellProcessHandle {
  kill(signal?: NodeJS.Signals): boolean;
  terminate?(reason: TerminationReason): void | Promise<void>;
  waitForTermination?(): Promise<void> | null;
}

type ExecFn = (
  command: string,
  options: { cwd: string; timeout: number; maxBuffer: number; killGraceMs: number },
  callback: (error: (Error & { code?: number | string; killed?: boolean }) | null, stdout: string, stderr: string) => void,
) => LocalShellProcessHandle | unknown;

export interface LocalShellLimits {
  timeoutMs?: number;
  maxBufferBytes?: number;
  killGraceMs?: number;
}

const LOCAL_SHELL_OWNER_ENV = 'ELOWEN_LOCAL_SHELL_OWNER';

/** `exec` does not pass its undocumented `detached` option through to the underlying spawn. Own the
 * shell process explicitly so every local command has a real POSIX process group and bounded buffers. */
const spawnLocalShell: ExecFn = (command, options, callback) => {
  const owner: LinuxProcessOwner = { name: LOCAL_SHELL_OWNER_ENV, value: randomUUID() };
  const child = spawn(command, {
    cwd: options.cwd,
    shell: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, [owner.name]: owner.value },
  });
  let stdout = '';
  let stderr = '';
  let bufferedBytes = 0;
  let overflow = false;
  let timedOut = false;
  let settled = false;
  const processGroup = new BoundedProcessGroupTermination(child, options.killGraceMs, owner);
  const finish = (error: (Error & { code?: number | string; killed?: boolean }) | null): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    callback(error, stdout, stderr);
  };
  const terminate = (reason: TerminationReason): Promise<void> => {
    const settlement = processGroup.terminate(reason);
    void settlement.then(() => {
      if (settled) return;
      // A process can be unkillable or a platform tree-kill can fail. Once the bounded transaction has
      // exhausted every safe kill attempt, detach every libuv handle so application shutdown cannot be
      // kept alive by a descendant that still owns the inherited pipes.
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      finish(Object.assign(new Error(`local shell ${reason}`), { killed: true }));
    });
    return settlement;
  };
  const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
    if (overflow) return;
    bufferedBytes += chunk.length;
    if (bufferedBytes > options.maxBuffer) {
      overflow = true;
      void terminate('overflow');
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
    void terminate('timeout');
  }, options.timeout);
  return {
    pid: child.pid,
    kill: (signal?: NodeJS.Signals) => child.kill(signal),
    terminate,
    waitForTermination: () => processGroup.waitForSettlement(),
  };
};

/** Run a `!` command locally: /bin/sh semantics via a process-group-owned spawn, 30s timeout, stdout+stderr
 *  captured and capped. Never rejects — failures land in the result (exit code / timeout note). */
export function runLocalShell(
  command: string,
  cwd: string,
  execFn: ExecFn = spawnLocalShell,
  signal?: AbortSignal,
  limits: LocalShellLimits = {},
): Promise<LocalShellResult> {
  const timeoutMs = Math.max(1, limits.timeoutMs ?? LOCAL_SHELL_TIMEOUT_MS);
  const maxBufferBytes = Math.max(1, limits.maxBufferBytes ?? 4 * 1024 * 1024);
  const killGraceMs = Math.max(0, limits.killGraceMs ?? 250);
  return new Promise((resolve) => {
    let child: LocalShellProcessHandle | null = null;
    let callbackReceived = false;
    const onAbort = (): void => {
      if (!child) return;
      if (child.terminate) {
        const terminating = child.terminate('abort');
        if (terminating) void terminating.catch(() => { /* settlement is best-effort and never rejects */ });
      }
      else child.kill('SIGTERM');
    };
    const returned = execFn(command, { cwd, timeout: timeoutMs, maxBuffer: maxBufferBytes, killGraceMs }, (error, stdout, stderr) => {
      if (callbackReceived) return;
      callbackReceived = true;
      const parts = [stdout, stderr].filter((s) => s.length > 0);
      let output = parts.join(stdout.length > 0 && !stdout.endsWith('\n') ? '\n' : '').replace(/\n+$/, '');
      const truncated = output.length > LOCAL_SHELL_MAX_CHARS;
      if (truncated) output = `${output.slice(0, LOCAL_SHELL_MAX_CHARS)}\n… output truncated at ${LOCAL_SHELL_MAX_CHARS} chars`;
      if (error?.killed) output = output ? `${output}\n[timed out after ${timeoutMs / 1000}s]` : `[timed out after ${timeoutMs / 1000}s]`;
      const exitCode = error ? (typeof error.code === 'number' ? error.code : null) : 0;
      const result = { command, output, exitCode, truncated };
      // Defer one microtask so a synchronous test adapter can return its process handle before we inspect
      // settlement. In production this waits the complete TERM→KILL group transaction, not merely leader
      // close, and keeps the abort listener installed so an application stop can shorten existing grace.
      queueMicrotask(() => {
        const settlement = child?.waitForTermination?.();
        void Promise.resolve(settlement).catch(() => {}).then(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve(result);
        });
      });
    });
    if (returned && typeof returned === 'object' && 'kill' in returned && typeof returned.kill === 'function') {
      child = returned as LocalShellProcessHandle;
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
