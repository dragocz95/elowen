import { describe, it, expect, onTestFinished, vi } from 'vitest';
import { ProcessRegistry, processHandleOwnedByAccount, type ProcessHandle, type ProcessInfo } from '../../src/brain/processRegistry.js';

/** Build a fake handle whose running/exit/output are driven by a small mutable state object, so tests can
 *  flip a process to "exited" or capture kill() without spawning anything real. */
function fakeHandle(id: string, command = `sleep ${id}`, startedAt = `2026-01-01T00:00:0${id}Z`) {
  const state = { running: true, exit: null as number | null, output: `out-${id}`, killed: false };
  const handle: ProcessHandle = {
    id, command, cwd: '/w', startedAt,
    running: () => state.running,
    exitCode: () => state.exit,
    readAll: () => state.output,
    kill: () => { state.killed = true; state.running = false; state.exit = -1; },
  };
  return { handle, state };
}

describe('ProcessRegistry', () => {
  it('lists registered processes, running first then newest first', () => {
    const reg = new ProcessRegistry();
    const a = fakeHandle('1', 'a', '2026-01-01T00:00:01Z');
    const b = fakeHandle('2', 'b', '2026-01-01T00:00:03Z');
    const c = fakeHandle('3', 'c', '2026-01-01T00:00:02Z');
    reg.register(a.handle); reg.register(b.handle); reg.register(c.handle);
    b.state.running = false; // b exited → sinks below the running ones
    expect(reg.list().map((p) => p.id)).toEqual(['3', '1', '2']);
    expect(reg.list().find((p) => p.id === '2')!.running).toBe(false);
  });

  it('reads a process output buffer, null for unknown', () => {
    const reg = new ProcessRegistry();
    const a = fakeHandle('1');
    reg.register(a.handle);
    expect(reg.output('1')).toBe('out-1');
    expect(reg.output('nope')).toBeNull();
  });

  it('isolates list, output, and kill operations by originating brain session', async () => {
    const reg = new ProcessRegistry();
    const parent = fakeHandle('parent'); parent.handle.sessionId = 'brain-parent';
    const child = fakeHandle('child'); child.handle.sessionId = 'brain-child';
    reg.register(parent.handle); reg.register(child.handle);

    expect(reg.listForSession('brain-parent').map((p) => p.id)).toEqual(['parent']);
    expect(reg.listForSession('brain-child').map((p) => p.id)).toEqual(['child']);
    expect(reg.outputForSession('brain-parent', 'child')).toBeNull();
    await expect(reg.killForSession('brain-parent', 'child')).resolves.toBe(false);
    expect(child.state.killed).toBe(false);
    await expect(reg.killForSession('brain-child', 'child')).resolves.toBe(true);
    expect(child.state.killed).toBe(true);
  });

  it('isolates two contribution accounts inside the same shared-room session', async () => {
    const reg = new ProcessRegistry();
    const amy = fakeHandle('amy');
    amy.handle.sessionId = 'brain-ch-room';
    amy.handle.accountUserId = 2;
    amy.handle.workspaceId = 'ws-amy';
    amy.handle.homeGeneration = 4;
    const bob = fakeHandle('bob');
    bob.handle.sessionId = 'brain-ch-room';
    bob.handle.accountUserId = 3;
    reg.register(amy.handle);
    reg.register(bob.handle);

    expect(reg.listForSessionAccount('brain-ch-room', 2).map((p) => p.id)).toEqual(['amy']);
    expect(reg.listForSessionAccount('brain-ch-room', 3).map((p) => p.id)).toEqual(['bob']);
    expect(reg.outputForSessionAccount('brain-ch-room', 2, 'bob')).toBeNull();
    await expect(reg.killForSessionAccount('brain-ch-room', 2, 'bob')).resolves.toBe(false);
    expect(bob.state.killed).toBe(false);
    expect(reg.listForSessionAccount('brain-ch-room', 2)[0]).toMatchObject({ workspaceId: 'ws-amy', homeGeneration: 4 });
  });

  it('carries the originating session in the snapshot (null when it has none) — the UI origin badge', () => {
    const reg = new ProcessRegistry();
    const child = fakeHandle('child'); child.handle.sessionId = 'brain-ch-subagent-sub-dlg-7';
    const loose = fakeHandle('loose'); // registered without a session
    reg.register(child.handle); reg.register(loose.handle);
    expect(reg.list().map((p) => [p.id, p.sessionId])).toEqual(expect.arrayContaining([
      ['child', 'brain-ch-subagent-sub-dlg-7'],
      ['loose', null],
    ]));
  });

  it('listWhere filters on the HANDLE (fields the snapshot does not carry, e.g. userId)', () => {
    const reg = new ProcessRegistry();
    const mine = fakeHandle('mine'); mine.handle.userId = 1;
    const theirs = fakeHandle('theirs'); theirs.handle.userId = 2;
    reg.register(mine.handle); reg.register(theirs.handle);
    expect(reg.listWhere((h) => h.userId === 1).map((p) => p.id)).toEqual(['mine']);
  });

  it('kill() invokes the handle kill, drops it, and returns false for unknown ids', async () => {
    const reg = new ProcessRegistry();
    const a = fakeHandle('1');
    reg.register(a.handle);
    await expect(reg.kill('1')).resolves.toBe(true);
    expect(a.state.killed).toBe(true);
    expect(reg.list()).toHaveLength(0);
    await expect(reg.kill('1')).resolves.toBe(false); // already gone
  });

  it('remove() drops without killing', () => {
    const reg = new ProcessRegistry();
    const a = fakeHandle('1');
    const b = fakeHandle('2');
    reg.register(a.handle); reg.register(b.handle);
    b.state.running = false;
    expect(reg.remove('1')).toBe(true);
    expect(a.state.killed).toBe(false); // remove ≠ kill
    expect(reg.list().map((p) => p.id)).toEqual(['2']);
  });

  it('markExited fires the exit listener once with the process info + userId + sessionId', () => {
    const reg = new ProcessRegistry();
    const events: Array<{ id: string; running: boolean; userId: number | null; sessionId: string | null }> = [];
    reg.setExitListener((info, userId, sessionId) => events.push({ id: info.id, running: info.running, userId, sessionId }));
    const a = fakeHandle('1');
    a.handle.userId = 42;
    a.handle.sessionId = 'brain-42';
    reg.register(a.handle);
    a.state.running = false; a.state.exit = 0; // process finished on its own
    reg.markExited('1');
    reg.markExited('1'); // second call is a no-op (fires once)
    expect(events).toEqual([{ id: '1', running: false, userId: 42, sessionId: 'brain-42' }]);
  });

  it('does NOT fire the exit listener for a killed (removed) process', async () => {
    const reg = new ProcessRegistry();
    let fired = 0;
    reg.setExitListener(() => { fired++; });
    const a = fakeHandle('1');
    reg.register(a.handle);
    await reg.kill('1');    // killed → dropped from the registry
    reg.markExited('1');    // its subsequent close finds nothing → no wake
    expect(fired).toBe(0);
  });

  // Process ids are short and time-based, so two spawns can collide. The registry must never drop a LIVE
  // handle silently — that child would keep running with nothing able to list, read or kill it.
  describe('id collision', () => {
    it('kills the process it evicts and releases everyone waiting on it', async () => {
      const reg = new ProcessRegistry();
      const first = fakeHandle('dup', 'first'); first.handle.sessionId = 's';
      reg.register(first.handle);
      const waiter = reg.waitForExit('dup', 60_000);

      const second = fakeHandle('dup', 'second'); second.handle.sessionId = 's';
      reg.register(second.handle);

      expect(first.state.killed).toBe(true);
      expect(second.state.killed).toBe(false);
      expect(reg.list().map((p) => p.command)).toEqual(['second']);
      await expect(waiter).resolves.toBe('exited');
    });

    it('settles the evicted handle\'s own session, whose job count just dropped', async () => {
      const reg = new ProcessRegistry();
      const old = fakeHandle('dup'); old.handle.sessionId = 'a'; old.handle.completionMode = 'job';
      reg.register(old.handle);
      const idle = reg.waitForSessionJobsIdle('a', 60_000);
      const fresh = fakeHandle('dup'); fresh.handle.sessionId = 'b'; fresh.handle.completionMode = 'job';
      reg.register(fresh.handle);
      await expect(idle).resolves.toBe('idle');
    });

    it('refreshes both account scopes when a colliding id changes owner inside one room', () => {
      const reg = new ProcessRegistry();
      const scopes: Array<[string | null, number | null]> = [];
      reg.setChangeListener((sessionId, accountUserId) => scopes.push([sessionId, accountUserId]));
      const first = fakeHandle('dup'); first.handle.sessionId = 'room'; first.handle.accountUserId = 2;
      reg.register(first.handle);
      scopes.length = 0;
      const second = fakeHandle('dup'); second.handle.sessionId = 'room'; second.handle.accountUserId = 3;
      reg.register(second.handle);
      expect(scopes).toEqual([['room', 2], ['room', 3]]);
    });

    it('treats re-registering the SAME handle (foreground detach) as an update, not a collision', () => {
      const reg = new ProcessRegistry();
      const fg = fakeHandle('1'); fg.handle.sessionId = 's'; fg.handle.completionMode = 'foreground';
      reg.register(fg.handle);
      fg.handle.completionMode = 'job';
      reg.register(fg.handle);
      expect(fg.state.killed).toBe(false);
      expect(fg.state.running).toBe(true);
      expect(reg.runningJobCountForSession('s')).toBe(1);
    });
  });

  it('fires the change listener on register/kill/remove', async () => {
    const reg = new ProcessRegistry();
    let ticks = 0;
    reg.setChangeListener(() => { ticks++; });
    const a = fakeHandle('1');
    reg.register(a.handle);   // 1
    await reg.kill('1');      // 2
    reg.register(fakeHandle('2').handle); // 3
    reg.remove('2');          // 4
    expect(ticks).toBe(4);
  });

  describe('waitForSessionJobsIdle', () => {
    /** Register a still-running job bound to a session. */
    const runningJob = (reg: ProcessRegistry, id: string, sessionId: string) => {
      const j = fakeHandle(id);
      j.handle.sessionId = sessionId;
      j.handle.completionMode = 'job';
      reg.register(j.handle);
      return j;
    };

    it('times out a jobs-idle wait and never double-settles on a later exit', async () => {
      vi.useFakeTimers();
      try {
        const reg = new ProcessRegistry();
        const j = runningJob(reg, '1', 's');
        let settlements = 0;
        const p = reg.waitForSessionJobsIdle('s', 5).then((o) => { settlements++; return o; });
        await vi.advanceTimersByTimeAsync(5);
        expect(await p).toBe('timeout');
        // The timed-out waiter is already gone; a later real exit must NOT re-settle it.
        j.state.running = false; j.state.exit = 0;
        reg.markExited('1');
        await vi.advanceTimersByTimeAsync(10);
        expect(settlements).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('resolves idle when the last running job exits before the timeout', async () => {
      const reg = new ProcessRegistry();
      const j = runningJob(reg, '1', 's');
      const p = reg.waitForSessionJobsIdle('s', 5_000);
      j.state.running = false; j.state.exit = 0;
      reg.markExited('1'); // last job idle → settles the waiter, clearing its (unref'd) timer
      await expect(p).resolves.toBe('idle');
    });

    it('without a timeout resolves immediately when already idle, else on the next exit', async () => {
      const reg = new ProcessRegistry();
      await expect(reg.waitForSessionJobsIdle('s')).resolves.toBe('idle'); // no running jobs → immediate
      const j = runningJob(reg, '1', 's');
      const p = reg.waitForSessionJobsIdle('s');
      j.state.running = false;
      reg.markExited('1');
      await expect(p).resolves.toBe('idle');
    });

    // Regression: a foreground Bash command (the transient mode Ctrl+B can detach) must NOT count as a job.
    // If it did, a delegate's collect loop — which blocks on this exact count — would deadlock against the
    // command it is itself running.
    it('excludes a foreground command from the job count, so an idle wait resolves at once', async () => {
      const reg = new ProcessRegistry();
      const fg = fakeHandle('fg'); fg.handle.sessionId = 's'; fg.handle.completionMode = 'foreground';
      reg.register(fg.handle);
      expect(reg.runningJobCountForSession('s')).toBe(0);
      await expect(reg.waitForSessionJobsIdle('s')).resolves.toBe('idle');
    });

    it('counts a mode-less handle as a job, and a foreground handle flipped to job', () => {
      const reg = new ProcessRegistry();
      const loose = fakeHandle('loose'); loose.handle.sessionId = 's'; // no completionMode
      reg.register(loose.handle);
      expect(reg.runningJobCountForSession('s')).toBe(1);
      const fg = fakeHandle('fg'); fg.handle.sessionId = 's'; fg.handle.completionMode = 'foreground';
      reg.register(fg.handle);
      expect(reg.runningJobCountForSession('s')).toBe(1); // foreground still excluded
      fg.handle.completionMode = 'job'; reg.register(fg.handle); // detach flips it to a real job
      expect(reg.runningJobCountForSession('s')).toBe(2);
    });
  });

  // Backs ProcessOutput(block:true): the agent parks until ONE process finishes instead of polling.
  describe('waitForExit', () => {
    it('resolves exited on the process exit', async () => {
      const reg = new ProcessRegistry();
      const j = fakeHandle('1');
      reg.register(j.handle);
      const p = reg.waitForExit('1', 5_000);
      j.state.running = false; j.state.exit = 0;
      reg.markExited('1');
      await expect(p).resolves.toBe('exited');
    });

    it('resolves immediately for an unknown id or an already-finished process — never parks on a corpse', async () => {
      const reg = new ProcessRegistry();
      await expect(reg.waitForExit('nope', 5_000)).resolves.toBe('exited');
      const j = fakeHandle('1');
      j.state.running = false; j.state.exit = 0;
      reg.register(j.handle);
      await expect(reg.waitForExit('1', 5_000)).resolves.toBe('exited');
    });

    it('a kill or a registry removal releases the waiter — no more output is ever coming', async () => {
      const reg = new ProcessRegistry();
      reg.register(fakeHandle('1').handle);
      const killed = reg.waitForExit('1', 60_000);
      await reg.kill('1');
      await expect(killed).resolves.toBe('exited');

      reg.register(fakeHandle('2').handle);
      const dropped = reg.waitForExit('2', 60_000);
      reg.remove('2');
      await expect(dropped).resolves.toBe('exited');
    });

    it('times out and never double-settles on a later exit', async () => {
      vi.useFakeTimers();
      try {
        const reg = new ProcessRegistry();
        const j = fakeHandle('1');
        reg.register(j.handle);
        const p = reg.waitForExit('1', 1_000);
        vi.advanceTimersByTime(1_000);
        await expect(p).resolves.toBe('timeout');
        // The process is still alive and later exits; the settled waiter must not resolve a second time.
        j.state.running = false; j.state.exit = 0;
        expect(() => reg.markExited('1')).not.toThrow();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe('ProcessRegistry — teardown sweeps', () => {
  it('killWhere stops running processes, drops exited ones, and reports unconfirmed kills', async () => {
    const reg = new ProcessRegistry();
    const a = fakeHandle('a'); const b = fakeHandle('b'); const dead = fakeHandle('dead');
    reg.register(a.handle); reg.register(b.handle); reg.register(dead.handle);
    dead.state.running = false;
    // `killed` counts CONFIRMED kills; the exited handle is dropped as cleanup, not counted as killed.
    await expect(reg.killWhere((handle) => handle.id !== 'b')).resolves.toEqual({ killed: 1, failed: [] });
    expect(a.state.killed).toBe(true);
    expect(b.state.killed).toBe(false);
    expect(reg.get('b')).toBeDefined();
    expect(reg.get('a')).toBeUndefined();
    expect(reg.get('dead')).toBeUndefined();
  });

  it('a kill whose handle refuses is RETAINED and reported, never folded into success', async () => {
    const reg = new ProcessRegistry();
    const stubborn = fakeHandle('stubborn');
    stubborn.handle.kill = () => Promise.reject(new Error('guest cancellation failed'));
    reg.register(stubborn.handle);
    await expect(reg.kill('stubborn')).rejects.toThrow('guest cancellation failed');
    // The handle stays: still listed, still stoppable — the next sweep can retry it.
    expect(reg.get('stubborn')).toBeDefined();
    expect(reg.list().map((p) => p.id)).toContain('stubborn');
    await expect(reg.killWhere(() => true)).resolves.toEqual({ killed: 0, failed: ['stubborn'] });
    expect(reg.get('stubborn')).toBeDefined();
    // And a later kill that lands settles it for real.
    stubborn.handle.kill = () => { stubborn.state.killed = true; return Promise.resolve(); };
    await expect(reg.kill('stubborn')).resolves.toBe(true);
    expect(reg.get('stubborn')).toBeUndefined();
  });

  it('never lets the per-run kill token reach the OUTWARD snapshot', async () => {
    // The token is a secret: the terminal plugin redacts it out of command output so that an `env` run
    // cannot publish it. Every shape produced by toInfo is serialized straight into GET /brain/processes
    // and into the `process` event pushed to client streams, so the token must not be on it. Its one
    // consumer (the post-mortem sweep) reads the HANDLE, which never leaves this process.
    const reg = new ProcessRegistry();
    const tokened = fakeHandle('tokened');
    tokened.handle.sessionId = 'brain-1';
    tokened.handle.killToken = 'per-run-secret-token';
    const exited: ProcessInfo[] = [];
    reg.setExitListener((info) => { exited.push(info); });
    reg.register(tokened.handle);

    const outward: ProcessInfo[] = [
      ...reg.list(),
      ...reg.listForSession('brain-1'),
      ...reg.listWhere(() => true),
    ];
    tokened.state.running = false; tokened.state.exit = 0;
    reg.markExited('tokened');
    outward.push(...exited);

    expect(outward).toHaveLength(4);
    for (const snapshot of outward) {
      expect(Object.keys(snapshot)).not.toContain('killToken');
      expect(JSON.stringify(snapshot)).not.toContain('per-run-secret-token');
    }
    // …while the handle still carries it, which is what killTokens() reads.
    expect(reg.get('tokened')?.killToken).toBe('per-run-secret-token');
  });

  it('bounds a local kill that never confirms instead of holding the teardown forever', async () => {
    // The plugin's kill chains guest cancellation with no timeout of its own. Unbounded, one stuck guest
    // blocks killSession → the conversation teardown sweep → the DELETE route, holding the session lock.
    vi.useFakeTimers();
    // Restored even if this test times out — a leaked fake clock would break the next test instead of
    // just failing this one.
    onTestFinished(() => { vi.useRealTimers(); });
    const reg = new ProcessRegistry();
    const wedged = fakeHandle('wedged');
    wedged.handle.kill = () => new Promise<void>(() => { /* a guest cancellation that never returns */ });
    reg.register(wedged.handle);

    const settled = expect(reg.kill('wedged')).rejects.toThrow('did not confirm its stop in time');
    await vi.advanceTimersByTimeAsync(2_000); // the same bound the runner-side process RPC uses
    await settled;
    // Reported like any other unconfirmed kill: the handle is RETAINED, listed and retryable.
    expect(reg.get('wedged')).toBeDefined();
    expect(reg.list().map((p) => p.id)).toContain('wedged');
  });

  it('killTokens() lists the running handles’ tokens so a post-mortem sweep can reach them', async () => {
    const reg = new ProcessRegistry();
    const tokened = fakeHandle('tokened'); const bare = fakeHandle('bare'); const dead = fakeHandle('dead');
    tokened.handle.killToken = 'tok-1';
    bare.handle.killToken = null;
    dead.handle.killToken = 'tok-dead';
    reg.register(tokened.handle); reg.register(bare.handle); reg.register(dead.handle);
    dead.state.running = false;
    expect(reg.killTokens()).toEqual(['tok-1']);
    await reg.kill('tokened');
    expect(reg.killTokens()).toEqual([]);
  });

  it('the account predicate reaches a delegated child through its session row', () => {
    const childHandle = fakeHandle('child').handle;
    childHandle.sessionId = 'brain-ch-subagent-sub-dlg-1'; // delegated turn: no explicit account
    const explicit = fakeHandle('explicit').handle;
    explicit.accountUserId = 7;
    const foreignChild = fakeHandle('foreign').handle;
    foreignChild.sessionId = 'brain-ch-subagent-sub-dlg-2';
    const owners = (sessionId: string) => (sessionId === 'brain-ch-subagent-sub-dlg-1' ? 1
      : sessionId === 'brain-ch-subagent-sub-dlg-2' ? 2 : undefined);

    expect(processHandleOwnedByAccount(childHandle, 1, owners)).toBe(true);
    expect(processHandleOwnedByAccount(childHandle, 2, owners)).toBe(false);
    expect(processHandleOwnedByAccount(explicit, 7, owners)).toBe(true);
    // An explicit account is authoritative: the session row must not widen it.
    expect(processHandleOwnedByAccount(explicit, 1, owners)).toBe(false);
    expect(processHandleOwnedByAccount(foreignChild, 1, owners)).toBe(false);
    // A sessionless handle resolves no owner and stays unreachable.
    const loose = fakeHandle('loose').handle;
    expect(processHandleOwnedByAccount(loose, 1, owners)).toBe(false);
  });

  it('stops a REAL detached process tree through the sweep (test-owned child)', async () => {
    if (process.platform === 'win32') return; // `sleep` and detached groups are POSIX shapes
    const { spawn } = await import('node:child_process');
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    const reg = new ProcessRegistry();
    const alive = () => {
      try { process.kill(-child.pid!, 0); return true; } catch { return false; }
    };
    expect(alive()).toBe(true);
    const handle: ProcessHandle = {
      id: 'real-1', command: 'sleep 30', cwd: process.cwd(), startedAt: new Date().toISOString(),
      accountUserId: null, sessionId: 'brain-ch-subagent-sub-dlg-real',
      running: alive,
      exitCode: () => child.exitCode,
      readAll: () => '',
      kill: () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ } },
    };
    reg.register(handle);
    await expect(reg.killWhere((h) => h.sessionId === 'brain-ch-subagent-sub-dlg-real')).resolves.toEqual({ killed: 1, failed: [] });
    // The process GROUP is really gone, not just the registry row.
    for (let i = 0; i < 50 && alive(); i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(alive()).toBe(false);
    child.kill('SIGKILL');
  });
});
