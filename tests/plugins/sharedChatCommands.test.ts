import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs plugin module, no types
import { CONTROL_COMMANDS, runControlCommand } from '../../plugins/_shared/chatCommands.mjs';

const MSG = {
  newConversation: 'NEW',
  controlForbidden: 'FORBIDDEN',
  fastUsage: 'USAGE',
  fastUnavailable: 'FAST_NA',
  fastSet: (on: boolean) => (on ? 'FAST_ON' : 'FAST_OFF'),
  noSession: 'NO_SESSION',
  nothingRunning: 'NOTHING_RUNNING',
  stopped: 'STOPPED',
  status: (m: string, p: number, t: number) => `STATUS ${m} ${p} ${t}`,
  compacted: (p: number) => `COMPACTED ${p}`,
  nothingToCompact: 'NOTHING_TO_COMPACT',
  compactFailed: 'COMPACT_FAILED',
  restarting: 'RESTARTING',
  restartForbidden: 'RESTART_FORBIDDEN',
  restartUnavailable: 'RESTART_NA',
};

/** A minimal StateStore stand-in (the real one is _shared/stateStore.mjs). */
function fakeState(init: Record<string, unknown> = {}) {
  const store: Record<string, Record<string, unknown>> = { X: { ...init } };
  return { get: (id: string) => store[id] ?? (store[id] = {}), patch: (id: string, p: Record<string, unknown>) => { store[id] = { ...(store[id] ?? {}), ...p }; }, _store: store };
}

function binding(over: Record<string, unknown> = {}) {
  const replies: string[] = [];
  const state = fakeState((over.stateInit as Record<string, unknown>) ?? {});
  return {
    replies, state,
    b: {
      msg: MSG, reply: (t: string) => { replies.push(t); }, isAdmin: () => over.admin !== false,
      state, stateId: 'X', ctl: over.ctl, ref: 'ref', arg: over.arg,
      activeModel: async () => over.active ?? null, fastEnabled: over.fastEnabled,
      ...(over.binding as object ?? {}),
    },
  };
}

describe('shared control-command core', () => {
  it('CONTROL_COMMANDS owns exactly the six control commands', () => {
    expect([...CONTROL_COMMANDS].sort()).toEqual(['compact', 'fast', 'new', 'restart', 'status', 'stop']);
  });

  it('/new bumps the generation counter and confirms', async () => {
    const { b, state, replies } = binding({ stateInit: { gen: 4 } });
    expect(await runControlCommand('new', b)).toBe(true);
    expect(state._store.X.gen).toBe(5);
    expect(replies).toEqual(['NEW']);
  });

  it('/stop reports nothing running, then aborts a live turn', async () => {
    let aborted = false;
    const idle = binding({ ctl: { status: () => ({ streaming: false }), abort: () => { aborted = true; } } });
    await runControlCommand('stop', idle.b);
    expect(idle.replies).toEqual(['NOTHING_RUNNING']);
    expect(aborted).toBe(false);

    const live = binding({ ctl: { status: () => ({ streaming: true }), abort: () => { aborted = true; } } });
    await runControlCommand('stop', live.b);
    expect(aborted).toBe(true);
    expect(live.replies).toEqual(['STOPPED']);
  });

  it('/status renders the session line or reports none', async () => {
    const withS = binding({ ctl: { status: () => ({ model: 'gpt', usage: { percent: 50, tokens: 12 } }) } });
    await runControlCommand('status', withS.b);
    expect(withS.replies).toEqual(['STATUS gpt 50 12']);

    const noCtl = binding({ ctl: undefined });
    await runControlCommand('status', noCtl.b);
    expect(noCtl.replies).toEqual(['NO_SESSION']);
  });

  it('/compact maps the three outcomes and swallows failures', async () => {
    const ok = binding({ ctl: { compact: async () => ({ compacted: true, usage: { percent: 33 } }) } });
    await runControlCommand('compact', ok.b);
    expect(ok.replies).toEqual(['COMPACTED 33']);

    const noop = binding({ ctl: { compact: async () => ({ compacted: false, usage: { percent: 0 } }) } });
    await runControlCommand('compact', noop.b);
    expect(noop.replies).toEqual(['NOTHING_TO_COMPACT']);

    const fail = binding({ ctl: { compact: async () => { throw new Error('boom'); } } });
    await runControlCommand('compact', fail.b);
    expect(fail.replies).toEqual(['COMPACT_FAILED']);
  });

  it('/restart runs and reports, or reports unavailable', async () => {
    const ok = binding({ ctl: { restart: async () => {} } });
    await runControlCommand('restart', ok.b);
    expect(ok.replies).toEqual(['RESTARTING']);

    const noCtl = binding({ ctl: undefined });
    await runControlCommand('restart', noCtl.b);
    expect(noCtl.replies).toEqual(['RESTART_NA']);
  });

  it('gates control commands behind the admin check', async () => {
    for (const [cmd, expected] of [['stop', 'FORBIDDEN'], ['restart', 'RESTART_FORBIDDEN'], ['fast', 'FORBIDDEN']] as const) {
      const { b, replies } = binding({ admin: false, ctl: {}, fastEnabled: true });
      await runControlCommand(cmd, b);
      expect(replies).toEqual([expected]);
    }
  });

  it('/fast is unhandled when the surface has not published it', async () => {
    const { b, replies } = binding({ fastEnabled: false });
    expect(await runControlCommand('fast', b)).toBe(false);
    expect(replies).toEqual([]);
  });

  it('/fast rejects an unrecognized argument on every surface (the unified validation)', async () => {
    const { b, replies } = binding({ arg: 'xyz', fastEnabled: true });
    expect(await runControlCommand('fast', b)).toBe(true);
    expect(replies).toEqual(['USAGE']);
  });

  it('/fast on a non-OAuth model refuses to turn on but still switches off a stale flag', async () => {
    const on = binding({ arg: 'on', fastEnabled: true, active: { fastAvailable: false } });
    await runControlCommand('fast', on.b);
    expect(on.replies).toEqual(['FAST_NA']);

    const off = binding({ arg: 'off', fastEnabled: true, active: { fastAvailable: false }, stateInit: { fast: true } });
    await runControlCommand('fast', off.b);
    expect(off.replies).toEqual(['FAST_OFF']);
    expect(off.state._store.X.fast).toBe(false);
  });

  it('/fast applies to the live session only when it matches the selected model', async () => {
    let setFastArg: boolean | null = null;
    const active = { fastAvailable: true, provider: 'openai', model: 'gpt-5' };
    const b = binding({
      arg: 'on', fastEnabled: true, active,
      ctl: { status: () => ({ provider: 'openai', model: 'gpt-5' }), setFast: (_r: string, w: boolean) => { setFastArg = w; return { fastAvailable: true }; } },
    });
    await runControlCommand('fast', b.b);
    expect(setFastArg).toBe(true);
    expect(b.state._store.X.fast).toBe(true);
    expect(b.replies).toEqual(['FAST_ON']);
  });
});
