import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ChatApplicationLifetime } from '../../../src/cli/chat/applicationLifetime.js';
import { createShutdownCoordinator, installExitGuards } from '../../../src/cli/chat/terminalLifecycle.js';
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

  it.skipIf(process.platform === 'win32')('enforces the timeout when the process group ignores SIGTERM', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elowen-shell-timeout-'));
    const pidFile = join(dir, 'shell.pid');
    const lifecycle = new AbortController();
    let groupPid = 0;
    try {
      const pending = runLocalShell(
        `printf '%s' "$$" > "${pidFile}"; trap '' TERM; while :; do sleep 1; done`,
        process.cwd(), undefined, lifecycle.signal,
        { timeoutMs: 40, killGraceMs: 40 },
      );
      const deadline = Date.now() + 1_000;
      while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      groupPid = Number(readFileSync(pidFile, 'utf8'));

      const result = await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('timeout did not escalate')), 1_000)),
      ]);
      expect(result.exitCode).toBeNull();
      expect(result.output).toContain('timed out');
      expect(() => process.kill(groupPid, 0)).toThrow();
    } finally {
      lifecycle.abort();
      if (groupPid > 0) {
        try { process.kill(-groupPid, 'SIGKILL'); } catch { /* already gone */ }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('enforces the output limit when the process group ignores SIGTERM', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elowen-shell-overflow-'));
    const pidFile = join(dir, 'shell.pid');
    const lifecycle = new AbortController();
    let groupPid = 0;
    try {
      const pending = runLocalShell(
        `printf '%s' "$$" > "${pidFile}"; trap '' TERM; printf '%02048d' 0; while :; do sleep 1; done`,
        process.cwd(), undefined, lifecycle.signal,
        { timeoutMs: 5_000, killGraceMs: 40, maxBufferBytes: 64 },
      );
      const deadline = Date.now() + 1_000;
      while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      groupPid = Number(readFileSync(pidFile, 'utf8'));

      const result = await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('overflow did not escalate')), 1_000)),
      ]);
      expect(result.exitCode).toBeNull();
      expect(() => process.kill(groupPid, 0)).toThrow();
    } finally {
      lifecycle.abort();
      if (groupPid > 0) {
        try { process.kill(-groupPid, 'SIGKILL'); } catch { /* already gone */ }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('keeps escalation alive after the shell leader closes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elowen-shell-orphan-'));
    const pidFile = join(dir, 'pids');
    const lifecycle = new AbortController();
    let groupPid = 0;
    let grandchildPid = 0;
    try {
      const pending = runLocalShell(
        `(trap '' TERM; exec >/dev/null 2>&1; while :; do sleep 1; done) & child=$!; printf '%s %s' "$$" "$child" > "${pidFile}"; wait "$child"`,
        process.cwd(), undefined, lifecycle.signal,
        { killGraceMs: 40 },
      );
      const deadline = Date.now() + 1_000;
      while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      [groupPid, grandchildPid] = readFileSync(pidFile, 'utf8').trim().split(/\s+/).map(Number);

      lifecycle.abort();
      await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('aborted shell did not settle')), 1_000)),
      ]);
      const goneBy = Date.now() + 1_000;
      while (Date.now() < goneBy) {
        try { process.kill(grandchildPid, 0); } catch { break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(() => process.kill(grandchildPid, 0)).toThrow();
    } finally {
      lifecycle.abort();
      if (groupPid > 0) {
        try { process.kill(-groupPid, 'SIGKILL'); } catch { /* already gone */ }
      }
      if (grandchildPid > 0) {
        try { process.kill(grandchildPid, 'SIGKILL'); } catch { /* already gone */ }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'linux')('keeps application shutdown pending until a TERM-ignoring grandchild is gone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elowen-shell-shutdown-'));
    const pidFile = join(dir, 'pids');
    const lifetime = new ChatApplicationLifetime<'metadata'>();
    let groupPid = 0;
    let grandchildPid = 0;
    try {
      lifetime.runApplication(
        (signal) => runLocalShell(
          `(trap '' TERM; exec >/dev/null 2>&1; while :; do sleep 1; done) & child=$!; printf '%s %s' "$$" "$child" > "${pidFile}"; wait "$child"`,
          process.cwd(), undefined, signal, { killGraceMs: 40 },
        ),
        () => {},
      );
      const deadline = Date.now() + 1_000;
      while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(existsSync(pidFile)).toBe(true);
      [groupPid, grandchildPid] = readFileSync(pidFile, 'utf8').trim().split(/\s+/).map(Number);

      // This is the production signal boundary: installExitGuards calls process.exit immediately after
      // this promise settles. No extra wait after stop() may be required for a detached force timer.
      const shutdown = createShutdownCoordinator({
        teardown: () => lifetime.stop(),
        stopBoundSession: async () => {},
      });
      const killSpy = vi.spyOn(process, 'kill');
      let dispose: (() => void) | null = null;
      try {
        dispose = installExitGuards({ shutdown, teardownNow: shutdown.teardownNow, exit: () => {} });
        const fatal = process.listeners('uncaughtExceptionMonitor').at(-1) as (error: Error) => void;
        fatal(new Error('fatal render failure'));
        // The monitor cannot await anything: resnapshot + force must have completed before it returns.
        expect(killSpy.mock.calls.some(([pid, signal]) => pid === grandchildPid && signal === 'SIGKILL')).toBe(true);
        await shutdown();
      } finally {
        dispose?.();
        killSpy.mockRestore();
      }

      expect(() => process.kill(grandchildPid, 0)).toThrow();
    } finally {
      if (groupPid > 0) {
        try { process.kill(-groupPid, 'SIGKILL'); } catch { /* already gone */ }
      }
      if (grandchildPid > 0) {
        try { process.kill(grandchildPid, 'SIGKILL'); } catch { /* already gone */ }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'linux')('captures and kills a process forked by the TERM trap during grace', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elowen-shell-late-fork-'));
    const groupFile = join(dir, 'group.pid');
    const lateFile = join(dir, 'late.pid');
    const lifetime = new ChatApplicationLifetime<'metadata'>();
    let groupPid = 0;
    let latePid = 0;
    try {
      lifetime.runApplication(
        (signal) => runLocalShell(
          `printf '%s' "$$" > "${groupFile}"; trap '(trap "" TERM HUP; exec >/dev/null 2>&1; while :; do sleep 1; done) & printf "%s" "$!" > "${lateFile}"' TERM; while :; do sleep 1; done`,
          process.cwd(), undefined, signal, { timeoutMs: 20, killGraceMs: 280 },
        ),
        () => {},
      );
      // Timeout owns the polite TERM grace. Wait until its trap has really forked the late child, then
      // simulate fatal/application teardown; abort must resnapshot and force synchronously.
      const startedBy = Date.now() + 1_000;
      while (!existsSync(lateFile) && Date.now() < startedBy) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(existsSync(groupFile)).toBe(true);
      expect(existsSync(lateFile)).toBe(true);
      groupPid = Number(readFileSync(groupFile, 'utf8'));
      latePid = Number(readFileSync(lateFile, 'utf8'));

      const shutdown = createShutdownCoordinator({
        teardown: () => lifetime.stop(),
        stopBoundSession: async () => {},
      });
      const killSpy = vi.spyOn(process, 'kill');
      let dispose: (() => void) | null = null;
      try {
        dispose = installExitGuards({ shutdown, teardownNow: shutdown.teardownNow, exit: () => {} });
        const fatal = process.listeners('uncaughtExceptionMonitor').at(-1) as (error: Error) => void;
        fatal(new Error('fatal during TERM grace'));
        expect(killSpy.mock.calls.some(([pid, signal]) => pid === latePid && signal === 'SIGKILL')).toBe(true);
        await shutdown();
      } finally {
        dispose?.();
        killSpy.mockRestore();
      }

      expect(latePid).toBeGreaterThan(0);
      expect(() => process.kill(latePid, 0)).toThrow();
    } finally {
      if (groupPid > 0) {
        try { process.kill(-groupPid, 'SIGKILL'); } catch { /* already gone */ }
      }
      if (latePid > 0) {
        try { process.kill(latePid, 'SIGKILL'); } catch { /* already gone */ }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'linux')('escalates immediately when application abort arrives during timeout grace', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elowen-shell-timeout-abort-'));
    const groupFile = join(dir, 'group.pid');
    const termFile = join(dir, 'term.seen');
    const lifetime = new ChatApplicationLifetime<'metadata'>();
    let groupPid = 0;
    try {
      lifetime.runApplication(
        (signal) => runLocalShell(
          `printf '%s' "$$" > "${groupFile}"; trap 'printf x > "${termFile}"; trap "" TERM' TERM; while :; do sleep 1; done`,
          process.cwd(), undefined, signal, { timeoutMs: 20, killGraceMs: 280 },
        ),
        () => {},
      );
      const timedOutBy = Date.now() + 1_000;
      while (!existsSync(termFile) && Date.now() < timedOutBy) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(existsSync(termFile)).toBe(true);
      groupPid = Number(readFileSync(groupFile, 'utf8'));

      const abortedAt = Date.now();
      await lifetime.stop();

      expect(Date.now() - abortedAt).toBeLessThan(150);
      expect(() => process.kill(groupPid, 0)).toThrow();
    } finally {
      if (groupPid > 0) {
        try { process.kill(-groupPid, 'SIGKILL'); } catch { /* already gone */ }
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
