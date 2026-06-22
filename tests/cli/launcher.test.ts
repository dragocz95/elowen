import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState, writeState, clearState, isAlive, status, stop, start, type RunState } from '../../src/cli/launcher.js';
import type { spawn as nodeSpawn } from 'node:child_process';

let home: string;
let env: NodeJS.ProcessEnv;
const sample: RunState = { daemon: { pid: 111, port: 4400 }, web: { pid: 222, port: 4500 }, version: '1.1.1', startedAt: '2026-06-22T00:00:00Z' };

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'orca-launch-')); env = { HOME: home } as NodeJS.ProcessEnv; });
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('cli/launcher state', () => {
  it('round-trips run state through the run file', () => {
    writeState(env, sample);
    expect(readState(env)).toEqual(sample);
  });
  it('returns null when the run file is missing', () => {
    expect(readState(env)).toBeNull();
  });
  it('returns null (not throw) when the run file is corrupt', () => {
    mkdirSync(join(home, '.config', 'orca'), { recursive: true });
    writeFileSync(join(home, '.config', 'orca', 'run.json'), '{ not json', 'utf8');
    expect(readState(env)).toBeNull();
  });
  it('clearState removes the run file and tolerates a missing one', () => {
    writeState(env, sample);
    clearState(env);
    expect(readState(env)).toBeNull();
    expect(() => clearState(env)).not.toThrow();
  });
});

describe('cli/launcher.isAlive', () => {
  it('is true for the current process and false for a surely-dead pid', () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(2147483646)).toBe(false);
  });
});

describe('cli/launcher.status', () => {
  it('reports not-running when there is no run file', async () => {
    const s = await status(env, async () => new Response('', { status: 200 }));
    expect(s.daemon.running).toBe(false);
    expect(s.web.running).toBe(false);
  });
  it('reports running + healthy when pid is alive and the port answers', async () => {
    writeState(env, { ...sample, daemon: { pid: process.pid, port: 4400 }, web: { pid: process.pid, port: 4500 } });
    const s = await status(env, async () => new Response('ok', { status: 200 }));
    expect(s.daemon).toMatchObject({ running: true, pid: process.pid, healthy: true });
    expect(s.web).toMatchObject({ running: true, healthy: true });
  });
  it('running but unhealthy when the pid is alive but the port is silent', async () => {
    writeState(env, { ...sample, daemon: { pid: process.pid, port: 4400 }, web: { pid: process.pid, port: 4500 } });
    const s = await status(env, async () => { throw new Error('ECONNREFUSED'); });
    expect(s.daemon).toMatchObject({ running: true, healthy: false });
  });
});

describe('cli/launcher.stop', () => {
  it('signals each tracked pid and clears the run file', async () => {
    writeState(env, sample);
    const killed: number[] = [];
    await stop(env, (pid) => { killed.push(pid); });
    expect(killed.sort()).toEqual([111, 222]);
    expect(readState(env)).toBeNull();
  });
  it('is a no-op when nothing is running', async () => {
    const killed: number[] = [];
    await stop(env, (pid) => killed.push(pid));
    expect(killed).toEqual([]);
  });
});

describe('cli/launcher.start', () => {
  const fakeSpawn = (() => ({ pid: 4321, unref() { /* detached */ } })) as unknown as typeof nodeSpawn;

  it('records run state and resolves when the daemon answers /health', async () => {
    const fetchFn = (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch;
    const s = await start(env, { version: '9.9.9', spawn: fakeSpawn, fetch: fetchFn, pollMs: 1, attempts: 3 });
    expect(s.daemon.pid).toBe(4321);
    expect(readState(env)).toEqual(s);
  });

  it('throws when the daemon never becomes healthy, but still records pids for cleanup', async () => {
    const fetchFn = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    await expect(start(env, { version: '9.9.9', spawn: fakeSpawn, fetch: fetchFn, pollMs: 1, attempts: 2 }))
      .rejects.toThrow(/did not become healthy/);
    expect(readState(env)?.daemon.pid).toBe(4321);
  });
});
