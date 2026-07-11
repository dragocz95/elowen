import { describe, expect, it, vi } from 'vitest';
import { ALT_SCREEN_OFF, ALT_SCREEN_ON, DISABLE_MOUSE, ENABLE_MOUSE } from '../../../src/cli/chat/terminalProtocol.js';
import { TerminalLifecycle } from '../../../src/cli/chat/terminalLifecycle.js';

function harness() {
  const calls: string[] = [];
  const scheduler = {
    pause: vi.fn(() => calls.push('scheduler:pause')),
    resume: vi.fn(() => calls.push('scheduler:resume')),
    stop: vi.fn(() => calls.push('scheduler:stop')),
  };
  const lifecycle = new TerminalLifecycle({
    term: { write: (value: string) => calls.push(`write:${JSON.stringify(value)}`) },
    tui: {
      start: () => calls.push('tui:start'),
      stop: () => calls.push('tui:stop'),
    },
    scheduler,
    forceRender: (reason) => calls.push(`force:${reason}`),
    beforeStop: () => calls.push('beforeStop'),
    dispose: () => calls.push('dispose'),
  });
  return { calls, lifecycle, scheduler };
}

describe('TerminalLifecycle', () => {
  it('starts once in alternate screen with mouse enabled and a forced first paint', () => {
    const { calls, lifecycle } = harness();
    lifecycle.start();
    lifecycle.start();
    expect(lifecycle.state).toBe('active');
    expect(calls).toEqual([
      `write:${JSON.stringify(ALT_SCREEN_ON)}`,
      'scheduler:resume',
      'tui:start',
      `write:${JSON.stringify(ENABLE_MOUSE)}`,
      'force:lifecycle:start',
    ]);
  });

  it('suspends before an external editor without writing pi-tui cleanup into the primary buffer', () => {
    const { calls, lifecycle } = harness();
    lifecycle.start();
    calls.length = 0;
    lifecycle.suspend();
    lifecycle.suspend();
    expect(lifecycle.state).toBe('suspended');
    expect(calls).toEqual([
      'scheduler:pause',
      `write:${JSON.stringify(DISABLE_MOUSE)}`,
      'tui:stop',
      `write:${JSON.stringify(ALT_SCREEN_OFF)}`,
    ]);
  });

  it('resumes with a clean alternate screen and resets the stale diff through one forced repaint', () => {
    const { calls, lifecycle } = harness();
    lifecycle.start();
    lifecycle.suspend();
    calls.length = 0;
    lifecycle.resume();
    lifecycle.resume();
    expect(lifecycle.state).toBe('active');
    expect(calls).toEqual([
      `write:${JSON.stringify(ALT_SCREEN_ON)}`,
      'scheduler:resume',
      'tui:start',
      `write:${JSON.stringify(ENABLE_MOUSE)}`,
      'force:lifecycle:resume',
    ]);
  });

  it('stops active resources exactly once and always leaves alternate screen last', () => {
    const { calls, lifecycle, scheduler } = harness();
    lifecycle.start();
    calls.length = 0;
    lifecycle.stop();
    lifecycle.stop();
    expect(lifecycle.state).toBe('stopped');
    expect(calls).toEqual([
      'scheduler:pause',
      `write:${JSON.stringify(DISABLE_MOUSE)}`,
      'beforeStop',
      'tui:stop',
      `write:${JSON.stringify(ALT_SCREEN_OFF)}`,
      'scheduler:stop',
      'dispose',
    ]);
    expect(scheduler.stop).toHaveBeenCalledOnce();
  });

  it('can stop safely while suspended without a second tui.stop or screen switch', () => {
    const { calls, lifecycle } = harness();
    lifecycle.start();
    lifecycle.suspend();
    calls.length = 0;
    lifecycle.stop();
    expect(calls).toEqual(['beforeStop', 'scheduler:stop', 'dispose']);
  });

  it('restores the primary screen when startup fails after entering the alternate buffer', () => {
    const calls: string[] = [];
    const lifecycle = new TerminalLifecycle({
      term: { write: (value: string) => calls.push(`write:${JSON.stringify(value)}`) },
      tui: {
        start: () => { calls.push('tui:start'); throw new Error('raw mode unavailable'); },
        stop: () => calls.push('tui:stop'),
      },
      scheduler: {
        pause: () => calls.push('scheduler:pause'),
        resume: () => calls.push('scheduler:resume'),
        stop: () => calls.push('scheduler:stop'),
      },
      forceRender: () => {},
      beforeStop: () => calls.push('beforeStop'),
    });

    expect(() => lifecycle.start()).toThrow('raw mode unavailable');
    expect(lifecycle.state).toBe('stopped');
    expect(calls.lastIndexOf(`write:${JSON.stringify(ALT_SCREEN_OFF)}`))
      .toBeGreaterThan(calls.lastIndexOf(`write:${JSON.stringify(ALT_SCREEN_ON)}`));
  });

  it('continues teardown and leaves the screen even when one cleanup hook throws', () => {
    const calls: string[] = [];
    const lifecycle = new TerminalLifecycle({
      term: { write: (value: string) => calls.push(`write:${JSON.stringify(value)}`) },
      tui: {
        start: () => calls.push('tui:start'),
        stop: () => { calls.push('tui:stop'); throw new Error('stop failed'); },
      },
      scheduler: {
        pause: () => calls.push('scheduler:pause'),
        resume: () => calls.push('scheduler:resume'),
        stop: () => calls.push('scheduler:stop'),
      },
      forceRender: () => {},
      beforeStop: () => { calls.push('beforeStop'); throw new Error('overlay failed'); },
      dispose: () => calls.push('dispose'),
    });
    lifecycle.start();

    expect(() => lifecycle.stop()).not.toThrow();
    expect(lifecycle.state).toBe('stopped');
    expect(calls).toContain(`write:${JSON.stringify(ALT_SCREEN_OFF)}`);
    expect(calls).toContain('scheduler:stop');
    expect(calls).toContain('dispose');
  });
});
