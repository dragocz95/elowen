import { describe, it, expect } from 'vitest';
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
});
