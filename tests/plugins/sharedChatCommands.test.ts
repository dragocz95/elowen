import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs plugin module, no types
import { applyPickerChoice, botControlCommandsFrom, controlCommandsFrom, localCommandsFrom, runControlCommand, runPickerCommand } from '../../packages/plugin-shared/chatCommands.mjs';
import { commandsWithPlugins } from '../../src/brain/slashCommands.js';

const MSG = {
  newConversation: 'NEW',
  controlForbidden: 'FORBIDDEN',
  pickContext: 'PICK_CONTEXT',
  contextPlaceholder: 'CONTEXT_PLACEHOLDER',
  contextBound: (title: string) => `BOUND ${title}`,
  noContextSessions: 'NO_CONTEXT_SESSIONS',
  contextError: (m: string) => `CONTEXT_ERROR ${m}`,
  pickProject: 'PICK_PROJECT',
  projectPlaceholder: 'PROJECT_PLACEHOLDER',
  projectSwitched: (slug: string) => `PROJECT_SWITCHED ${slug}`,
  projectNotFound: (arg: string) => `PROJECT_NOT_FOUND ${arg}`,
  projectError: (m: string) => `PROJECT_ERROR ${m}`,
  projectUnavailable: 'PROJECT_UNAVAILABLE',
  noProjects: 'NO_PROJECTS',
  projectAccountRequired: 'PROJECT_ACCOUNT_REQUIRED',
  fastUsage: 'USAGE',
  fastUnavailable: 'FAST_NA',
  fastAccountRequired: 'FAST_ACCOUNT',
  fastSet: (on: boolean) => (on ? 'FAST_ON' : 'FAST_OFF'),
  fastSetUnsupported: (on: boolean) => (on ? 'FAST_ON_UNSUPPORTED' : 'FAST_OFF'),
  fastStatus: (on: boolean, supported: boolean) => `FAST_STATUS_${on ? 'ON' : 'OFF'}_${supported ? 'SUPPORTED' : 'UNSUPPORTED'}`,
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
  const showings: { d: unknown; page: number }[] = [];
  return {
    replies, state, showings,
    b: {
      msg: MSG, reply: (t: string) => { replies.push(t); }, isAdmin: () => over.admin !== false,
      state, stateId: 'X', ctl: over.ctl, ref: 'ref', arg: over.arg,
      senderPlatformId: (over.senderPlatformId as string) ?? 'sender-1',
      activeModel: async () => over.active ?? null,
      showPicker: async (d: unknown, page = 0) => { showings.push({ d, page }); },
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
  it('routes the session-control commands, pickers included', () => {
    expect([...controlCommandsFrom(PLATFORM_CATALOG)].sort())
      .toEqual(['compact', 'context', 'fast', 'new', 'project', 'restart', 'stats', 'stop']);
  });

  /** The complement, and the half that used to be answered by a hardcoded switch in every adapter: /help
   *  plus the surface-local pickers. Together with the control set it must partition the projection
   *  exactly — a name in neither set is a published command nobody runs, a name in both is a command two
   *  code paths claim. */
  it('claims the surface-run remainder, and the two sets partition the projection', () => {
    expect([...localCommandsFrom(PLATFORM_CATALOG)].sort())
      .toEqual(['help', 'model', 'reasoning']);

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
    expect(controlCommandsFrom([]).size).toBe(0);
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

  /** The published `session-control` pickers ARE in the control set — that is what moved them out of the
   *  per-surface switches: a `session-control` picker is the daemon's operation, and the shared core owns
   *  the gate, listing, empty/unlinked states and the call behind it. What stays per-surface is only the
   *  DRAWING (`b.showPicker`) and the choice round-trip (`applyPickerChoice`). A picker the core has no
   *  case for still behaves like any other control command an older core cannot run: `runControlCommand`
   *  and `runPickerCommand` both return false and the adapter falls through. */
  it('routes every published picker through the control set', () => {
    const set = controlCommandsFrom(PLATFORM_CATALOG);
    expect(set.has('context')).toBe(true);
    expect(set.has('project')).toBe(true);
    expect(set.has('deploy')).toBe(false);
    // …while a surface-local picker never enters it: the daemon owns nothing behind /model.
    expect(controlCommandsFrom(PLATFORM_CATALOG.filter((c) => c.name === 'model')).size).toBe(0);
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
      .toEqual(['compact', 'context', 'display', 'fast', 'help', 'model', 'new', 'project', 'reasoning', 'restart', 'stats', 'stop']);
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

  it('keeps administrative controls gated without treating Fast as a permission', async () => {
    for (const [cmd, expected] of [['stop', 'FORBIDDEN'], ['restart', 'RESTART_FORBIDDEN']] as const) {
      const { b, replies } = binding({ admin: false, ctl: {} });
      await runControlCommand(cmd, b);
      expect(replies).toEqual([expected]);
    }

    let sender = '';
    const fast = binding({
      admin: false,
      arg: 'on',
      active: { fastAvailable: true },
      ctl: { setAccountFast: (_ref: string, senderPlatformId: string) => { sender = senderPlatformId; return { fast: true, fastAvailable: true }; } },
    });
    await runControlCommand('fast', fast.b);
    expect(sender).toBe('sender-1');
    expect(fast.replies).toEqual(['FAST_ON']);
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

  it('/fast keeps the account preference enabled when the selected route is unsupported', async () => {
    let setFastArg: boolean | undefined;
    const on = binding({
      arg: 'on', active: { fastAvailable: false },
      ctl: { setAccountFast: (_ref: string, _sender: string, wanted?: boolean) => { setFastArg = wanted; return { fast: true, fastAvailable: false }; } },
    });
    await runControlCommand('fast', on.b);
    expect(setFastArg).toBe(true);
    expect(on.replies).toEqual(['FAST_ON_UNSUPPORTED']);
    expect(on.state._store.X.fast).toBeUndefined();
  });

  it('/fast toggle, explicit forms and status use the linked account value, not conversation state', async () => {
    let stored = false;
    const ctl = {
      fastStatus: () => ({ fast: stored, fastAvailable: true }),
      setAccountFast: (_ref: string, _sender: string, wanted?: boolean) => {
        stored = wanted ?? !stored;
        return { fast: stored, fastAvailable: true };
      },
    };
    const toggle = binding({ active: { fastAvailable: true }, ctl });
    await runControlCommand('fast', toggle.b);
    expect(toggle.replies).toEqual(['FAST_ON']);

    const off = binding({ arg: 'off', active: { fastAvailable: true }, ctl });
    await runControlCommand('fast', off.b);
    expect(off.replies).toEqual(['FAST_OFF']);

    const status = binding({ arg: 'status', active: { fastAvailable: true }, ctl });
    await runControlCommand('fast', status.b);
    expect(status.replies).toEqual(['FAST_STATUS_OFF_SUPPORTED']);
  });

  it('/fast fails closed for an unlinked sender', async () => {
    const unlinked = binding({
      arg: 'on', active: { fastAvailable: true },
      ctl: { setAccountFast: () => null },
    });
    await runControlCommand('fast', unlinked.b);
    expect(unlinked.replies).toEqual(['FAST_ACCOUNT']);
  });
});

/** The published `session-control` pickers (`/context`, `/project`) run through the shared picker core:
 *  the gate, the listing, the empty/unlinked states and the bind/switch call live here, and the adapter
 *  only draws the descriptor and hands the choice back. The descriptor is the contract between the two
 *  halves — `items` carry a transport value, a label and an optional secondary hint, and nothing else. */
describe('shared picker core', () => {
  const contextCtl = () => ({
    listContext: () => ({ items: [{ id: 'brain-7-1', title: 'Refactor', model: 'gpt-5' }], total: 1, hasMore: false }),
    bindContext: async () => ({ title: 'Refactor' }),
  });
  const projectCtl = () => ({
    listProjects: () => [{ id: 7, slug: 'kolin', path: '/srv/private/kolin' }, { id: 12, slug: 'elowen' }],
    switchProject: async () => ({ workDir: '/srv/private/kolin', slug: 'kolin' }),
  });

  it('/context offers the caller’s own conversations as a normalized descriptor', async () => {
    const { b, showings, replies } = binding({ ctl: contextCtl() });
    expect(await runPickerCommand('context', b)).toBe(true);
    expect(showings).toEqual([{
      d: {
        picker: 'context', title: 'PICK_CONTEXT', placeholder: 'CONTEXT_PLACEHOLDER',
        items: [{ value: 'brain-7-1', label: 'Refactor', hint: 'gpt-5' }],
      },
      page: 0,
    }]);
    expect(replies).toEqual([]); // nothing terminal was said; the chooser was rendered instead
  });

  it('/context is operator-gated, like /model', async () => {
    const { b, showings, replies } = binding({ admin: false, ctl: contextCtl() });
    expect(await runPickerCommand('context', b)).toBe(true);
    expect(showings).toEqual([]);
    expect(replies).toEqual(['FORBIDDEN']);
  });

  it('/context answers an empty or unresolvable listing as "nothing to bind"', async () => {
    const empty = binding({ ctl: { listContext: () => ({ items: [], total: 0, hasMore: false }) } });
    expect(await runPickerCommand('context', empty.b)).toBe(true);
    expect(empty.replies).toEqual(['NO_CONTEXT_SESSIONS']);
    expect(empty.showings).toEqual([]);

    const unlinked = binding({ ctl: { listContext: () => null } });
    expect(await runPickerCommand('context', unlinked.b)).toBe(true);
    expect(unlinked.replies).toEqual(['NO_CONTEXT_SESSIONS']);
  });

  it('/project offers the caller’s projects and never carries a host path', async () => {
    const { b, showings, replies } = binding({ ctl: projectCtl() });
    expect(await runPickerCommand('project', b)).toBe(true);
    expect(showings[0].d).toEqual({
      picker: 'project', title: 'PICK_PROJECT', placeholder: 'PROJECT_PLACEHOLDER',
      items: [{ value: '7', label: 'kolin' }, { value: '12', label: 'elowen' }],
    });
    expect(JSON.stringify(showings)).not.toContain('/srv');
    expect(replies).toEqual([]);
  });

  it('/project has no operator gate: every linked sender may open it', async () => {
    const { b, showings, replies } = binding({ admin: false, ctl: projectCtl() });
    expect(await runPickerCommand('project', b)).toBe(true);
    expect(showings).toHaveLength(1);
    expect(replies).toEqual([]);
  });

  it('/project distinguishes an unlinked sender from an empty list', async () => {
    const unlinked = binding({ ctl: { listProjects: () => null } });
    expect(await runPickerCommand('project', unlinked.b)).toBe(true);
    expect(unlinked.replies).toEqual(['PROJECT_ACCOUNT_REQUIRED']);

    const none = binding({ ctl: { listProjects: () => [] } });
    expect(await runPickerCommand('project', none.b)).toBe(true);
    expect(none.replies).toEqual(['NO_PROJECTS']);
  });

  it('/project is unhandled when the host predates the optional methods', async () => {
    const missing = binding({ ctl: {} });
    expect(await runPickerCommand('project', missing.b)).toBe(true);
    expect(missing.replies).toEqual(['PROJECT_UNAVAILABLE']);
  });

  it('/project <slug|id> skips the chooser: exact slug first, then the decimal id', async () => {
    let switched: number | undefined;
    const ctl = {
      listProjects: () => [{ id: 7, slug: 'kolin', path: '/srv/k' }],
      switchProject: async (_ref: unknown, _sender: string, id: number) => { switched = id; return { workDir: '/x', slug: 'kolin' }; },
    };
    const bySlug = binding({ arg: 'kolin', ctl });
    expect(await runPickerCommand('project', bySlug.b)).toBe(true);
    expect(switched).toBe(7);
    expect(bySlug.replies).toEqual(['PROJECT_SWITCHED kolin']);
    expect(bySlug.showings).toEqual([]);

    switched = undefined;
    const byId = binding({ arg: '42', ctl });
    expect(await runPickerCommand('project', byId.b)).toBe(true);
    expect(switched).toBe(42);

    // An all-digit slug is still a slug first — the decimal reading is the fallback, not the rule.
    switched = undefined;
    const digits = binding({ arg: '42', ctl: {
      listProjects: () => [{ id: 7, slug: '42', path: '/srv/d' }],
      switchProject: async (_ref: unknown, _s: string, id: number) => { switched = id; return { workDir: '/x', slug: '42' }; },
    } });
    expect(await runPickerCommand('project', digits.b)).toBe(true);
    expect(switched).toBe(7);
  });

  it('/project reports an unknown slug or id without touching the host', async () => {
    let switched = 0;
    const { b, replies } = binding({ arg: 'nope', ctl: {
      listProjects: () => [{ id: 7, slug: 'kolin', path: '/srv/k' }],
      switchProject: async () => { switched += 1; return { workDir: '/x', slug: 'kolin' }; },
    } });
    expect(await runPickerCommand('project', b)).toBe(true);
    expect(replies).toEqual(['PROJECT_NOT_FOUND nope']);
    expect(switched).toBe(0);
  });

  it('/context choice binds through the host as the person who chose', async () => {
    const { b, replies } = binding({ senderPlatformId: 'clicker-9', ctl: {
      bindContext: async (_ref: unknown, sender: string, _session: string) => { expect(sender).toBe('clicker-9'); return { title: 'Refactor' }; },
    } });
    expect(await applyPickerChoice('context', 'brain-7-1', b)).toBe(true);
    expect(replies).toEqual(['BOUND Refactor']);
  });

  it('/context choice re-checks the operator gate on submit', async () => {
    let called = false;
    const { b, replies } = binding({ admin: false, ctl: { bindContext: async () => { called = true; return { title: 'x' }; } } });
    expect(await applyPickerChoice('context', 'brain-7-1', b)).toBe(true);
    expect(replies).toEqual(['FORBIDDEN']);
    expect(called).toBe(false);
  });

  it('/context choice surfaces a bind guard rejection', async () => {
    const { b, replies } = binding({ ctl: { bindContext: async () => { throw new Error('unknown session'); } } });
    expect(await applyPickerChoice('context', 'brain-7-1', b)).toBe(true);
    expect(replies).toEqual(['CONTEXT_ERROR unknown session']);
  });

  it('/project choice switches by decimal id and reports the slug', async () => {
    let called: { sender: string; id: number } | undefined;
    const { b, replies } = binding({ senderPlatformId: 'clicker-9', ctl: {
      listProjects: () => [{ id: 7, slug: 'kolin', path: '/srv/k' }],
      switchProject: async (_ref: unknown, sender: string, id: number) => { called = { sender, id }; return { workDir: '/x', slug: 'kolin' }; },
    } });
    expect(await applyPickerChoice('project', '7', b)).toBe(true);
    expect(called).toEqual({ sender: 'clicker-9', id: 7 });
    expect(replies).toEqual(['PROJECT_SWITCHED kolin']);
  });

  it('/project choice reports a switch failure through the shared error text', async () => {
    const { b, replies } = binding({ ctl: {
      listProjects: () => [{ id: 7, slug: 'kolin', path: '/srv/k' }],
      switchProject: async () => { throw new Error('project is not readable or not allowed'); },
    } });
    expect(await applyPickerChoice('project', '7', b)).toBe(true);
    expect(replies).toEqual(['PROJECT_ERROR project is not readable or not allowed']);
  });

  it('is unhandled for a picker it does not own, without touching the binding', async () => {
    const { b, replies, showings } = binding({ ctl: {} });
    // `/model` is a surface-local picker: the daemon owns nothing behind it, so the picker core must
    // return false the same way runControlCommand does for a name outside its switch.
    expect(await runPickerCommand('model', b)).toBe(false);
    expect(await applyPickerChoice('model', 'p::m', b)).toBe(false);
    expect(replies).toEqual([]);
    expect(showings).toEqual([]);
  });
});
