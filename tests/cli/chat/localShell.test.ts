import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  composeWithShellContext,
  LOCAL_SHELL_MAX_CHARS,
  LOCAL_SHELL_TIMEOUT_MS,
  LocalShellBuffer,
  localShellTurn,
  MAX_SHELL_CONTEXT_RESULTS,
  parseBangCommand,
  runLocalShell,
} from '../../../src/cli/chat/localShell.js';

describe('parseBangCommand', () => {
  it('extracts the command with or without a space after !', () => {
    expect(parseBangCommand('!ls -la')).toBe('ls -la');
    expect(parseBangCommand('! git status')).toBe('git status');
    expect(parseBangCommand('  !  npm test  ')).toBe('npm test');
  });

  it('returns null for regular messages and a bare !', () => {
    expect(parseBangCommand('hello')).toBeNull();
    expect(parseBangCommand('what does ! mean')).toBeNull();
    expect(parseBangCommand('!')).toBeNull();
    expect(parseBangCommand('  !  ')).toBeNull();
    expect(parseBangCommand('/help')).toBeNull();
  });
});

describe('runLocalShell', () => {
  it('captures stdout, stderr and the exit code', async () => {
    const ok = await runLocalShell('echo out && echo err 1>&2', process.cwd());
    expect(ok.output).toBe('out\nerr');
    expect(ok.exitCode).toBe(0);
    expect(ok.truncated).toBe(false);
    const fail = await runLocalShell('echo boom 1>&2; exit 3', process.cwd());
    expect(fail.output).toBe('boom');
    expect(fail.exitCode).toBe(3);
  });

  it('runs in the given cwd with a 30s timeout configured', async () => {
    let seen: { cwd: string; timeout: number } | null = null;
    const execFn: Parameters<typeof runLocalShell>[2] = (_cmd, options, cb) => {
      seen = { cwd: options.cwd, timeout: options.timeout };
      cb(null, 'hi\n', '');
      return undefined;
    };
    const r = await runLocalShell('pwd', '/some/dir', execFn);
    expect(r.output).toBe('hi');
    expect(seen).toEqual({ cwd: '/some/dir', timeout: LOCAL_SHELL_TIMEOUT_MS });
  });

  it('caps combined output at 20k chars and flags the truncation', async () => {
    const execFn: Parameters<typeof runLocalShell>[2] = (_cmd, _options, cb) => {
      cb(null, 'a'.repeat(LOCAL_SHELL_MAX_CHARS + 5000), '');
      return undefined;
    };
    const r = await runLocalShell('yes', process.cwd(), execFn);
    expect(r.truncated).toBe(true);
    expect(r.output).toContain(`… output truncated at ${LOCAL_SHELL_MAX_CHARS} chars`);
    expect(r.output.length).toBeLessThan(LOCAL_SHELL_MAX_CHARS + 100);
  });

  it('marks a timeout kill in the output with a null exit code', async () => {
    const execFn: Parameters<typeof runLocalShell>[2] = (_cmd, _options, cb) => {
      cb(Object.assign(new Error('killed'), { killed: true }), 'partial\n', '');
      return undefined;
    };
    const r = await runLocalShell('sleep 99', process.cwd(), execFn);
    expect(r.exitCode).toBeNull();
    expect(r.output).toBe('partial\n[timed out after 30s]');
  });

  it('kills an outstanding local command when the application signal aborts', async () => {
    let finish!: Parameters<Parameters<typeof runLocalShell>[2]>[2];
    const kill = vi.fn(() => true);
    const execFn: Parameters<typeof runLocalShell>[2] = (_cmd, _options, callback) => {
      finish = callback;
      return { kill };
    };
    const lifecycle = new AbortController();

    const pending = runLocalShell('sleep 30', process.cwd(), execFn, lifecycle.signal);
    lifecycle.abort();
    finish(Object.assign(new Error('aborted'), { killed: true }), '', '');

    expect(kill).toHaveBeenCalledOnce();
    await expect(pending).resolves.toMatchObject({ command: 'sleep 30', exitCode: null });
  });

  it.skipIf(process.platform === 'win32')('terminates the real POSIX process group, including a sleeping grandchild', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elowen-shell-group-'));
    const pidFile = join(dir, 'sleep.pid');
    const lifecycle = new AbortController();
    let childPid = 0;
    try {
      const pending = runLocalShell(`sleep 30 & child=$!; printf '%s' "$child" > "${pidFile}"; wait "$child"`, process.cwd(), undefined, lifecycle.signal);
      const deadline = Date.now() + 1_000;
      while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(existsSync(pidFile)).toBe(true);
      childPid = Number(readFileSync(pidFile, 'utf8'));
      expect(childPid).toBeGreaterThan(0);

      const abortedAt = Date.now();
      lifecycle.abort();
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const result = await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('local shell did not stop within 1s')), 1_000);
        }),
      ]).finally(() => { if (timeout) clearTimeout(timeout); });
      expect(Date.now() - abortedAt).toBeLessThan(1_000);
      expect(result.exitCode).toBeNull();
      expect(() => process.kill(childPid, 0)).toThrow();
    } finally {
      if (childPid > 0) {
        try { process.kill(childPid, 'SIGKILL'); } catch { /* already gone */ }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('localShellTurn (transcript console block)', () => {
  it('shapes the result as a settled tool turn with a console output block', () => {
    const turn = localShellTurn({ command: 'git status', output: 'clean', exitCode: 0, truncated: false });
    expect(turn.role).toBe('elowen');
    expect(turn.streaming).toBe(false);
    const seg = turn.segments[0];
    if (seg?.kind !== 'tools') throw new Error('expected a tools segment');
    const item = seg.items[0]!;
    expect(item.command).toBe('git status');
    expect(item.output).toMatchObject({ kind: 'console', title: 'local shell', text: 'clean', command: 'git status', tone: 'normal' });
    expect(item.output!.fullText).toBeUndefined();
    expect(item.output!.status).toBeUndefined();
  });

  it('previews long output and keeps the full text expandable; failures get a danger status', () => {
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const turn = localShellTurn({ command: 'ls', output: long, exitCode: 2, truncated: false });
    const seg = turn.segments[0];
    if (seg?.kind !== 'tools') throw new Error('expected a tools segment');
    const out = seg.items[0]!.output!;
    expect(out.text.split('\n')).toHaveLength(20);
    expect(out.fullText).toBe(long);
    expect(out.status).toBe('exit 2');
    expect(out.tone).toBe('danger');
  });

  it('shows (no output) for a silent command', () => {
    const turn = localShellTurn({ command: 'true', output: '', exitCode: 0, truncated: false });
    const seg = turn.segments[0];
    if (seg?.kind !== 'tools') throw new Error('expected a tools segment');
    expect(seg.items[0]!.output!.text).toBe('(no output)');
  });
});

describe('shell context composition for the next prompt', () => {
  it('prepends buffered results as one fenced block and clears the buffer', () => {
    const buf = new LocalShellBuffer();
    expect(buf.pending).toBe(false);
    buf.add({ command: 'git status', output: 'clean', exitCode: 0, truncated: false });
    buf.add({ command: 'npm test', output: '1 failing', exitCode: 1, truncated: false });
    expect(buf.pending).toBe(true);
    const msg = buf.take('why does the test fail?');
    expect(msg).toBe('Local shell context:\n```\n$ git status\nclean\n\n$ npm test\n1 failing\n[exit 1]\n```\n\nwhy does the test fail?');
    expect(buf.pending).toBe(false);
    expect(buf.take('next message')).toBe('next message'); // cleared after send
  });

  it('passes messages through untouched with nothing pending', () => {
    expect(composeWithShellContext('hello', [])).toBe('hello');
  });

  it('keeps only the newest results beyond the buffer cap', () => {
    const buf = new LocalShellBuffer();
    for (let i = 0; i < MAX_SHELL_CONTEXT_RESULTS + 2; i++) {
      buf.add({ command: `cmd ${i}`, output: 'x', exitCode: 0, truncated: false });
    }
    const msg = buf.take('m');
    expect(msg).not.toContain('$ cmd 0');
    expect(msg).not.toContain('$ cmd 1');
    expect(msg).toContain('$ cmd 2');
    expect(msg).toContain(`$ cmd ${MAX_SHELL_CONTEXT_RESULTS + 1}`);
  });
});
