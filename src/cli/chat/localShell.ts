import { exec } from 'node:child_process';
import type { OrcaTurn } from '../../brain/transcript.js';
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
) => unknown;

/** Run a `!` command locally: /bin/sh semantics via child_process.exec, 30s timeout, stdout+stderr
 *  captured and capped. Never rejects — failures land in the result (exit code / timeout note). */
export function runLocalShell(command: string, cwd: string, execFn: ExecFn = exec as unknown as ExecFn): Promise<LocalShellResult> {
  return new Promise((resolve) => {
    execFn(command, { cwd, timeout: LOCAL_SHELL_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const parts = [stdout, stderr].filter((s) => s.length > 0);
      let output = parts.join(stdout.length > 0 && !stdout.endsWith('\n') ? '\n' : '').replace(/\n+$/, '');
      const truncated = output.length > LOCAL_SHELL_MAX_CHARS;
      if (truncated) output = `${output.slice(0, LOCAL_SHELL_MAX_CHARS)}\n… output truncated at ${LOCAL_SHELL_MAX_CHARS} chars`;
      if (error?.killed) output = output ? `${output}\n[timed out after ${LOCAL_SHELL_TIMEOUT_MS / 1000}s]` : `[timed out after ${LOCAL_SHELL_TIMEOUT_MS / 1000}s]`;
      const exitCode = error ? (typeof error.code === 'number' ? error.code : null) : 0;
      resolve({ command, output, exitCode, truncated });
    });
  });
}

/** Shape a local result as a settled assistant turn holding one console block, so the transcript's
 *  existing tool-output rendering (framed block, click-to-expand) applies unchanged. */
export function localShellTurn(result: LocalShellResult): OrcaTurn {
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
    role: 'orca',
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
