import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs plugin module, no types
import { botControlCommandsFrom, controlCommandsFrom, localCommandsFrom, runControlCommand } from '../../packages/plugin-shared/chatCommands.mjs';
import { commandsWithPlugins } from '../../src/brain/slashCommands.js';

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

/** The REAL projection `GET /brain/commands?surface=discord` returns for an operator, built from the
 *  catalog rather than transcribed from it — plus a plugin prompt macro, which only ever reaches a live
 *  surface. Transcribing it meant a second copy that stayed green while the catalog moved underneath it,
 *  and the whole point of the derivations below is that the projection is their only input.
 *
 *  The EXPECTATIONS stay written out by hand. A test whose expected value is derived from the same source
 *  as its input asserts nothing about the function in between; these name the commands that must route one
 *  way or the other, so a catalog edit that changes where one goes has to be acknowledged here. */
const PLATFORM_CATALOG = commandsWithPlugins(
  'discord', true, [{ name: 'deploy', description: 'Ship it', prompt: 'Deploy $1' }], new Set(),
);

describe('control set derived from the published catalog', () => {
  it('routes the session-control non-pickers and nothing else', () => {
    expect([...controlCommandsFrom(PLATFORM_CATALOG)].sort())
      .toEqual(['compact', 'fast', 'new', 'restart', 'stats', 'stop']);
  });

  /** The complement, and the half that used to be answered by a hardcoded switch in every adapter: the
   *  pickers each surface draws itself plus `/help`. Together with the control set it must partition the
   *  projection exactly — a name in neither set is a published command nobody runs, a name in both is a
   *  command two code paths claim. */
  it('claims the surface-run remainder, and the two sets partition the projection', () => {
    expect([...localCommandsFrom(PLATFORM_CATALOG)].sort())
      .toEqual(['context', 'help', 'model', 'reasoning']);

    const control = controlCommandsFrom(PLATFORM_CATALOG);
    const local = localCommandsFrom(PLATFORM_CATALOG);
    expect([...control].filter((n) => local.has(n))).toEqual([]);
    // `deploy` is the one published entry neither claims: a prompt macro is a turn, not a command.
    const dispatched = [...control, ...local].sort();
    expect(PLATFORM_CATALOG.map((c) => c.name).filter((n) => n !== 'deploy').sort()).toEqual(dispatched);
  });

  /** Fail closed, and for the local half this is new behaviour. An empty projection is what a core too old
   *  to publish one, or a failed fetch, looks like — and an adapter that answered its own pickers anyway
   *  was running commands the daemon had never published. `adapterOwned` goes with it: those names are
   *  never in the projection, so nothing in it could gate them by name, and a live catalog is the
   *  adapter's only evidence it is talking to a daemon at all. */
  it('claims nothing at all from an empty projection, adapter-owned names included', () => {
    expect(localCommandsFrom([]).size).toBe(0);
    expect(localCommandsFrom([], ['voice', 'display']).size).toBe(0);
    expect(botControlCommandsFrom([], ['voice', 'display']).size).toBe(0);
    for (const bad of [undefined, null, 'nonsense', 42, {}]) {
      expect(localCommandsFrom(bad as never, ['voice']).size, String(bad)).toBe(0);
    }
  });

  it('adds the adapter-owned names once the projection is live', () => {
    const local = localCommandsFrom(PLATFORM_CATALOG, ['voice', 'display']);
    expect(local.has('voice')).toBe(true);
    expect(local.has('display')).toBe(true);
    expect(local.has('deploy')).toBe(false);
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
   *  turn the conversation actually had.
   *
   *  Derived as the union of the two sets above rather than by filtering `execution` a third time. Written
   *  out here all the same: the union is the implementation's own claim, and this is where "everything the
   *  bot runs is kept out of the transcript" is stated independently of it. */
  it('treats every daemon- and surface-executed command, plus the adapter own, as bot control', () => {
    expect([...botControlCommandsFrom(PLATFORM_CATALOG, ['display'])].sort())
      .toEqual(['compact', 'context', 'display', 'fast', 'help', 'model', 'new', 'reasoning', 'restart', 'stats', 'stop']);
    expect(botControlCommandsFrom(PLATFORM_CATALOG, ['display']).has('deploy')).toBe(false);
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

  it('/stats renders the session line or reports none', async () => {
    const withS = binding({ ctl: { status: () => ({ model: 'gpt', usage: { percent: 50, tokens: 12 } }) } });
    await runControlCommand('stats', withS.b);
    expect(withS.replies).toEqual(['STATUS gpt 50 12']);

    const noCtl = binding({ ctl: undefined });
    await runControlCommand('stats', noCtl.b);
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
