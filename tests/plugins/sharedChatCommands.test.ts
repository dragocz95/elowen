import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs plugin module, no types
import { botControlCommandsFrom, controlCommandsFrom, runControlCommand } from '../../packages/plugin-shared/chatCommands.mjs';

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

/** A minimal StateStore stand-in (the real one is elowen-plugin-shared/stateStore). */
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
      activeModel: async () => over.active ?? null,
      ...(over.binding as object ?? {}),
    },
  };
}

/** The projection `GET /brain/commands?surface=discord` really returns (recorded 25 Aug) — identical on
 *  all four chat platforms — plus a plugin prompt macro, which only ever reaches a real surface. This is
 *  the ONLY input the derivations below get: there is no name list left on either side. */
const PLATFORM_CATALOG = [
  { name: 'new', kind: 'action', execution: 'session-control' },
  { name: 'stop', kind: 'action', execution: 'session-control' },
  { name: 'status', kind: 'info', execution: 'session-control' },
  { name: 'compact', kind: 'action', execution: 'session-control' },
  { name: 'model', kind: 'picker', execution: 'surface-local' },
  { name: 'context', kind: 'picker', execution: 'session-control' },
  { name: 'fast', kind: 'action', execution: 'session-control' },
  { name: 'reasoning', kind: 'picker', execution: 'surface-local' },
  { name: 'restart', kind: 'action', execution: 'session-control' },
  { name: 'help', kind: 'info', execution: 'surface-local' },
  { name: 'deploy', kind: 'prompt', execution: 'plugin-prompt' },
];

describe('control set derived from the published catalog', () => {
  it('routes the session-control non-pickers and nothing else', () => {
    expect([...controlCommandsFrom(PLATFORM_CATALOG)].sort())
      .toEqual(['compact', 'fast', 'new', 'restart', 'status', 'stop']);
  });

  /** `/context` is `session-control` too, but its chooser is drawn per surface and its listing/binding go
   *  through dedicated PlatformControlApi methods — routing it here would hand the core a command whose
   *  UI it cannot draw. `/model` is the mirror case on the other axis (a picker the daemon never runs). */
  it('never routes a picker, whichever side owns the execution', () => {
    const set = controlCommandsFrom(PLATFORM_CATALOG);
    expect(set.has('context')).toBe(false);
    expect(set.has('model')).toBe(false);
    expect(set.has('deploy')).toBe(false);
  });

  /** The catalog arrives from the daemon over HTTP, so a surface running against a core that predates
   *  `execution` (or a malformed entry) must yield an EMPTY control set — every `/command` then falls
   *  through as unknown, which is the harmless direction. Claiming a command it cannot place is not. */
  it('claims nothing from a catalog that does not state execution', () => {
    expect(controlCommandsFrom([{ name: 'new', kind: 'action' }, { name: 'stop' }]).size).toBe(0);
    for (const bad of [undefined, null, 'nonsense', 42, {}]) {
      expect(controlCommandsFrom(bad as never).size, String(bad)).toBe(0);
    }
  });

  /** The transcript question: what was said TO the bot rather than in the room. `adapter-state` commands
   *  are deliberately absent from the projection (each adapter registers its own), so the adapter that
   *  implements one passes its names in — and a plugin prompt macro must stay OUT, because that one is a
   *  turn the conversation actually had. */
  it('treats every daemon- and surface-executed command, plus the adapter own, as bot control', () => {
    expect([...botControlCommandsFrom(PLATFORM_CATALOG, ['display'])].sort())
      .toEqual(['compact', 'context', 'display', 'fast', 'help', 'model', 'new', 'reasoning', 'restart', 'status', 'stop']);
    expect(botControlCommandsFrom(PLATFORM_CATALOG, ['display']).has('deploy')).toBe(false);
    expect([...botControlCommandsFrom([], ['display'])]).toEqual(['display']);
  });
});

describe('shared control-command core', () => {
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
      const { b, replies } = binding({ admin: false, ctl: {} });
      await runControlCommand(cmd, b);
      expect(replies).toEqual([expected]);
    }
  });

  /** A surface that has not published `/fast` never reaches this core at all — the derived control set
   *  simply does not contain the name, so the adapter's own unknown-command path takes it. That replaced
   *  a `fastEnabled` flag the caller had to remember to pass: publication was being answered twice, once
   *  by the catalog and once by hand. */
  it('leaves an unpublished /fast to the derived set, not to a flag', async () => {
    const withoutFast = PLATFORM_CATALOG.filter((c) => c.name !== 'fast');
    expect(controlCommandsFrom(withoutFast).has('fast')).toBe(false);
    expect(controlCommandsFrom(PLATFORM_CATALOG).has('fast')).toBe(true);
  });

  it('is unhandled for a name it does not own, without touching the binding', async () => {
    // `clear` is `session-control` on the CLI and the web dock. If it ever reached a platform's derived
    // set, this is the branch that keeps the adapter harmless instead of swallowing the command.
    const { b, replies } = binding({ ctl: {} });
    expect(await runControlCommand('clear', b)).toBe(false);
    expect(replies).toEqual([]);
  });

  it('/fast rejects an unrecognized argument on every surface (the unified validation)', async () => {
    const { b, replies } = binding({ arg: 'xyz' });
    expect(await runControlCommand('fast', b)).toBe(true);
    expect(replies).toEqual(['USAGE']);
  });

  it('/fast on a non-OAuth model refuses to turn on but still switches off a stale flag', async () => {
    const on = binding({ arg: 'on', active: { fastAvailable: false } });
    await runControlCommand('fast', on.b);
    expect(on.replies).toEqual(['FAST_NA']);

    const off = binding({ arg: 'off', active: { fastAvailable: false }, stateInit: { fast: true } });
    await runControlCommand('fast', off.b);
    expect(off.replies).toEqual(['FAST_OFF']);
    expect(off.state._store.X.fast).toBe(false);
  });

  it('/fast applies to the live session only when it matches the selected model', async () => {
    let setFastArg: boolean | null = null;
    const active = { fastAvailable: true, provider: 'openai', model: 'gpt-5' };
    const b = binding({
      arg: 'on', active,
      ctl: { status: () => ({ provider: 'openai', model: 'gpt-5' }), setFast: (_r: string, w: boolean) => { setFastArg = w; return { fastAvailable: true }; } },
    });
    await runControlCommand('fast', b.b);
    expect(setFastArg).toBe(true);
    expect(b.state._store.X.fast).toBe(true);
    expect(b.replies).toEqual(['FAST_ON']);
  });
});
