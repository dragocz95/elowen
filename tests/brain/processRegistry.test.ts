import { describe, it, expect, vi } from 'vitest';
import { ProcessRegistry, type ProcessHandle } from '../../src/brain/processRegistry.js';

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

  it('isolates list, output, and kill operations by originating brain session', () => {
    const reg = new ProcessRegistry();
    const parent = fakeHandle('parent'); parent.handle.sessionId = 'brain-parent';
    const child = fakeHandle('child'); child.handle.sessionId = 'brain-child';
    reg.register(parent.handle); reg.register(child.handle);

    expect(reg.listForSession('brain-parent').map((p) => p.id)).toEqual(['parent']);
    expect(reg.listForSession('brain-child').map((p) => p.id)).toEqual(['child']);
    expect(reg.outputForSession('brain-parent', 'child')).toBeNull();
    expect(reg.killForSession('brain-parent', 'child')).toBe(false);
    expect(child.state.killed).toBe(false);
    expect(reg.killForSession('brain-child', 'child')).toBe(true);
    expect(child.state.killed).toBe(true);
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

  it('kill() invokes the handle kill, drops it, and returns false for unknown ids', () => {
    const reg = new ProcessRegistry();
    const a = fakeHandle('1');
    reg.register(a.handle);
    expect(reg.kill('1')).toBe(true);
    expect(a.state.killed).toBe(true);
    expect(reg.list()).toHaveLength(0);
    expect(reg.kill('1')).toBe(false); // already gone
  });

  it('remove() drops without killing; runningCount counts live ones', () => {
    const reg = new ProcessRegistry();
    const a = fakeHandle('1');
    const b = fakeHandle('2');
    reg.register(a.handle); reg.register(b.handle);
    b.state.running = false;
    expect(reg.runningCount()).toBe(1);
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

  it('does NOT fire the exit listener for a killed (removed) process', () => {
    const reg = new ProcessRegistry();
    let fired = 0;
    reg.setExitListener(() => { fired++; });
    const a = fakeHandle('1');
    reg.register(a.handle);
    reg.kill('1');          // killed → dropped from the registry
    reg.markExited('1');    // its subsequent close finds nothing → no wake
    expect(fired).toBe(0);
  });

  it('fires the change listener on register/kill/remove', () => {
    const reg = new ProcessRegistry();
    let ticks = 0;
    reg.setChangeListener(() => { ticks++; });
    const a = fakeHandle('1');
    reg.register(a.handle);   // 1
    reg.kill('1');            // 2
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
      reg.kill('1');
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
