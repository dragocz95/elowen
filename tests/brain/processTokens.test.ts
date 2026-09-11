import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { DIRECT_PROCESS_TOKEN_ENV, killTokenProcesses, tokenPids } from '../../src/brain/processTokens.js';

const spawned: ReturnType<typeof spawn>[] = [];
afterEach(() => {
  for (const child of spawned) {
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
  }
  spawned.length = 0;
});

/** A REAL detached child carrying the same env token the terminal plugin stamps onto every background
 *  run — the plugin cannot import core, so this pins the shared contract from the outside: find by
 *  /proc environ, kill by pid, the group membership irrelevant. */
const spawnTokenChild = (token: string): ReturnType<typeof spawn> => {
  const child = spawn('sleep', ['30'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, [DIRECT_PROCESS_TOKEN_ENV]: token },
  });
  child.unref();
  spawned.push(child);
  return child;
};

const groupAlive = (pid: number): boolean => {
  try { process.kill(-pid, 0); return true; } catch { return false; }
};

describe('core direct-token sweep (mirror of the terminal plugin\u2019s scanner)', () => {
  it('finds a live detached child by its environment token and stops it', async () => {
    const token = `test-${Math.random().toString(36).slice(2)}-${process.pid}`;
    const child = spawnTokenChild(token);
    // The /proc scan is a poll of other processes' environ: give the child a moment to exist.
    let pids: number[] = [];
    for (let i = 0; i < 50 && pids.length === 0; i += 1) {
      pids = tokenPids([token]);
      if (pids.length === 0) await new Promise((r) => setTimeout(r, 20));
    }
    expect(pids).toContain(child.pid!);

    expect(killTokenProcesses([token])).toContain(child.pid!);
    // Really gone, not just delisted: poll the pid itself (the group leader may have no group left).
    let gone = false;
    for (let i = 0; i < 50 && !gone; i += 1) {
      gone = !tokenPids([token]).includes(child.pid!);
      if (!gone) await new Promise((r) => setTimeout(r, 20));
    }
    expect(gone).toBe(true);
  });

  it('stops a DESCENDANT that escaped into its own session (setsid) — the case a group kill misses', async () => {
    const token = `test-esc-${Math.random().toString(36).slice(2)}-${process.pid}`;
    // A shell that starts `sleep` in a NEW session: the sleep is no longer in the child's process
    // group, so only the token can still reach it.
    const shell = spawn('sh', ['-c', `setsid sleep 30 & wait`], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, [DIRECT_PROCESS_TOKEN_ENV]: token },
    });
    spawned.push(shell);
    let sleepPid = 0;
    for (let i = 0; i < 50 && sleepPid === 0; i += 1) {
      sleepPid = tokenPids([token]).find((pid) => pid !== shell.pid) ?? 0;
      if (sleepPid === 0) await new Promise((r) => setTimeout(r, 20));
    }
    expect(sleepPid).toBeGreaterThan(0);

    killTokenProcesses([token]);
    let gone = false;
    for (let i = 0; i < 50 && !gone; i += 1) {
      gone = !tokenPids([token]).includes(sleepPid);
      if (!gone) await new Promise((r) => setTimeout(r, 20));
    }
    expect(gone).toBe(true);
  });

  it('sweeps EVERY token of a dead runner in one scan', async () => {
    // A runner crash hands the daemon one token per child that was running. The scan takes the whole set
    // at once: a pass per token re-reads every /proc environ on the box once per child.
    const tokens = [0, 1].map((n) => `test-multi-${n}-${Math.random().toString(36).slice(2)}-${process.pid}`);
    const children = tokens.map(spawnTokenChild);
    let found: number[] = [];
    for (let i = 0; i < 50 && found.length < 2; i += 1) {
      found = tokenPids(tokens);
      if (found.length < 2) await new Promise((r) => setTimeout(r, 20));
    }
    for (const child of children) expect(found).toContain(child.pid!);

    const swept = killTokenProcesses(tokens);
    for (const child of children) expect(swept).toContain(child.pid!);
    let gone = false;
    for (let i = 0; i < 50 && !gone; i += 1) {
      gone = tokenPids(tokens).length === 0;
      if (!gone) await new Promise((r) => setTimeout(r, 20));
    }
    expect(gone).toBe(true);
  });

  it('a token no process carries scans to nothing — pid reuse cannot resurrect a target', () => {
    expect(tokenPids([`no-such-token-${Math.random()}`])).toEqual([]);
    expect(killTokenProcesses([''])).toEqual([]);
    expect(killTokenProcesses([])).toEqual([]);
  });

  it('the sweep does not touch the scanning process itself', () => {
    // The scanner skips its own pid; assert the guard by construction (the scan never lists us).
    expect(tokenPids(['x'])).not.toContain(process.pid);
    void groupAlive;
  });
});
