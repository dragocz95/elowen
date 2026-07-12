import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
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
  options: { cwd: string; timeout: number; maxBuffer: number; killGraceMs: number },
  callback: (error: (Error & { code?: number | string; killed?: boolean }) | null, stdout: string, stderr: string) => void,
) => { kill(signal?: NodeJS.Signals): boolean; terminate?(reason: 'abort' | 'timeout' | 'overflow'): void } | unknown;

export interface LocalShellLimits {
  timeoutMs?: number;
  maxBufferBytes?: number;
  killGraceMs?: number;
}

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

interface ProcessIdentity { pid: number; startTime: string }

/** Read the identities currently belonging to one Linux process group. `startTime` is the kernel's
 * immutable birth tick, so escalation never sends SIGKILL to a PID recycled after the owned command
 * exited. Other POSIX platforms fall back to their process-group primitive below. */
function linuxProcessGroup(pgid: number): ProcessIdentity[] | null {
  if (process.platform !== 'linux') return null;
  const members: ProcessIdentity[] = [];
  let names: string[];
  try { names = readdirSync('/proc'); } catch { return null; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const commEnd = stat.lastIndexOf(')');
      if (commEnd < 0) continue;
      // Fields after comm start at field 3 (state): pgrp is index 2, starttime is index 19.
      const fields = stat.slice(commEnd + 2).trim().split(/\s+/);
      if (Number(fields[2]) !== pgid || !fields[19]) continue;
      members.push({ pid: Number(name), startTime: fields[19] });
    } catch { /* process exited while /proc was being scanned */ }
  }
  return members;
}

function sameLinuxProcess(identity: ProcessIdentity, pgid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${identity.pid}/stat`, 'utf8');
    const commEnd = stat.lastIndexOf(')');
    if (commEnd < 0) return false;
    const fields = stat.slice(commEnd + 2).trim().split(/\s+/);
    return Number(fields[2]) === pgid && fields[19] === identity.startTime;
  } catch {
    return false;
  }
}

/** Sole owner of TERM→KILL for one spawned shell group. Timeout, output overflow and application abort
 * all converge here. Escalation deliberately survives the leader's `close`: grandchildren can close the
 * inherited pipes and outlive that event. Linux kills only birth-identity-matched members, avoiding a
 * recycled-PID/group kill; other platforms use the strongest native fallback available. */
class OwnedProcessGroup {
  private requested = false;
  private identities: ProcessIdentity[] | null = null;

  constructor(private readonly child: ChildProcess, private readonly graceMs: number) {}

  terminate(_reason: 'abort' | 'timeout' | 'overflow'): void {
    if (this.requested) return;
    this.requested = true;
    const pgid = this.child.pid;
    if (pgid && process.platform !== 'win32') this.identities = linuxProcessGroup(pgid);
    terminateProcessTree(this.child, 'SIGTERM');
    // Include descendants that became observable at the TERM boundary without ever discarding the
    // pre-signal identities. A trapped command may react synchronously by closing its stdio/leader.
    if (pgid && this.identities) {
      const known = new Map(this.identities.map((identity) => [identity.pid, identity]));
      for (const identity of linuxProcessGroup(pgid) ?? []) known.set(identity.pid, identity);
      this.identities = [...known.values()];
    }
    setTimeout(() => this.force(), this.graceMs);
  }

  private force(): void {
    const pgid = this.child.pid;
    if (pgid && this.identities) {
      for (const identity of this.identities) {
        if (!sameLinuxProcess(identity, pgid)) continue;
        try { process.kill(identity.pid, 'SIGKILL'); } catch { /* already gone */ }
      }
      return;
    }
    // `/proc` is unavailable (macOS/Windows): retain the previous native group/child behavior. On POSIX
    // the grace is intentionally short, limiting the unavoidable process-group reuse window.
    terminateProcessTree(this.child, 'SIGKILL');
  }
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
  const processGroup = new OwnedProcessGroup(child, options.killGraceMs);
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
      processGroup.terminate('overflow');
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
    processGroup.terminate('timeout');
  }, options.timeout);
  return {
    pid: child.pid,
    kill: (signal?: NodeJS.Signals) => child.kill(signal),
    terminate: (reason: 'abort' | 'timeout' | 'overflow') => processGroup.terminate(reason),
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
    let child: { kill(signal?: NodeJS.Signals): boolean; terminate?(reason: 'abort' | 'timeout' | 'overflow'): void } | null = null;
    const onAbort = (): void => {
      if (!child) return;
      if (child.terminate) child.terminate('abort');
      else child.kill('SIGTERM');
    };
    const returned = execFn(command, { cwd, timeout: timeoutMs, maxBuffer: maxBufferBytes, killGraceMs }, (error, stdout, stderr) => {
      signal?.removeEventListener('abort', onAbort);
      const parts = [stdout, stderr].filter((s) => s.length > 0);
      let output = parts.join(stdout.length > 0 && !stdout.endsWith('\n') ? '\n' : '').replace(/\n+$/, '');
      const truncated = output.length > LOCAL_SHELL_MAX_CHARS;
      if (truncated) output = `${output.slice(0, LOCAL_SHELL_MAX_CHARS)}\n… output truncated at ${LOCAL_SHELL_MAX_CHARS} chars`;
      if (error?.killed) output = output ? `${output}\n[timed out after ${timeoutMs / 1000}s]` : `[timed out after ${timeoutMs / 1000}s]`;
      const exitCode = error ? (typeof error.code === 'number' ? error.code : null) : 0;
      resolve({ command, output, exitCode, truncated });
    });
    if (returned && typeof returned === 'object' && 'kill' in returned && typeof returned.kill === 'function') {
      child = returned as { kill(signal?: NodeJS.Signals): boolean; terminate?(reason: 'abort' | 'timeout' | 'overflow'): void };
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
