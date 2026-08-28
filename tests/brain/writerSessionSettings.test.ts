import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ChannelSessionService } from '../../src/brain/channels.js';
import { channelSessionId } from '../../src/brain/sessionId.js';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { openDb, type Db } from '../../src/store/db.js';
import type { DelegatedExecutionScope } from '../../src/brain/delegatedScope.js';

/** A room is owned by whoever OPENED it, and that ownership is bookkeeping: it grants nothing. The
 *  session's personal settings — chat model, compaction model, thresholds, advisor style — must therefore
 *  be composed from the VERIFIED WRITER of the turn that spawns, not from the opener, or one colleague's
 *  preferences decide which model (whose bill, whose capabilities) answers everybody else in the room.
 *
 *  These run against a real BrainStore because the interesting half is what the ROW says: the idle
 *  rollover happens inside send() and re-opens the room under the current writer, so the id the session
 *  is composed from has to be resolved there, after the rollover, rather than by the caller. */

const agedTs = (agoMs: number): string => new Date(Date.now() - agoMs).toISOString().replace('T', ' ').slice(0, 19);
const THIRTY_ONE_MIN = 31 * 60 * 1000;

function fakeBrain(sessionId: string, ownerUserId: number, settingsUserId: number) {
  const messages: { role?: string; content?: unknown }[] = [];
  return {
    session: {
      isStreaming: false,
      getContextUsage: () => ({ tokens: 50, contextWindow: 8000, percent: 1 }),
      messages,
      prompt: vi.fn(async () => { messages.push({ role: 'assistant', content: 'ok' }); }),
      // Touched by the teardown resetChannels runs before it disposes anything (abortTree).
      clearQueue: vi.fn(() => {}),
      abort: vi.fn(() => {}),
      dispose: vi.fn(() => {}),
      getAllTools: () => [] as { name: string }[],
      getActiveToolNames: () => [] as string[],
      setActiveToolsByName: () => {},
    },
    sessionId, ownerUserId, settingsUserId, direct: false,
    model: 'kimi', thinkingLevel: undefined as string | undefined, providerId: 'moonshot',
    pluginToolNames: new Set<string>(),
    turnSender: undefined as number | undefined,
    interactedAt: undefined as number | undefined,
    listeners: new Set<(e: unknown) => void>(),
    turnContext: () => ({ beforeUser: '', afterUser: '' }),
  };
}
type Brain = ReturnType<typeof fakeBrain>;

function setup() {
  const db: Db = openDb(':memory:');
  const store = new BrainStore(db);
  const registry = new LiveSessionRegistry<Brain>();
  const spawn = vi.fn(async (o: { sessionId: string; ownerUserId: number; settingsUserId?: number }) => {
    if (!store.getSession(o.sessionId)) store.createSession({ id: o.sessionId, userId: o.ownerUserId, model: 'kimi' });
    return fakeBrain(o.sessionId, o.ownerUserId, o.settingsUserId ?? o.ownerUserId);
  });
  const svc = new ChannelSessionService({
    registry, store, users: { get: () => ({ username: 'someone' }) }, spawn, titler: { run: vi.fn() },
  } as never);
  const channelId = 'discord-room';
  const sessionId = channelSessionId(channelId);
  const policy = { allowedProjectIds: 'all' as const, allowedPaths: () => [] };

  /** One turn as the orchestrator issues it: the row's current owner when there is a row, the verified
   *  writer when there is not (platforms.ts `rowOwner ?? linkedUserId ?? operator`). */
  const turn = async (writerUserId: number | undefined, text: string, operator = 1) => {
    const rowOwner = store.getSession(sessionId)?.user_id;
    await svc.send({ channelId, ownerUserId: rowOwner ?? writerUserId ?? operator, ...(writerUserId === undefined ? {} : { writerUserId }), policy }, text);
  };

  const ageLastMessage = (ms: number) => {
    const rows = store.getMessages(sessionId);
    db.prepare('UPDATE brain_messages SET created_at = ? WHERE id = ?').run(agedTs(ms), rows[rows.length - 1]!.id);
  };

  const settingsIdOf = (call: number): number | undefined =>
    (spawn.mock.calls[call]![0] as { settingsUserId?: number }).settingsUserId;

  return { store, registry, spawn, svc, sessionId, channelId, policy, turn, ageLastMessage, settingsIdOf };
}

/** An admin delegation, as `delegatedExecution` demands it: the scope, the sub-agent identity and the
 *  caller's policy must agree, and the child carries NO writer of its own — a delegated send that named
 *  one is refused outright. */
const SCOPE: DelegatedExecutionScope = { admin: true, projectIds: [], owner: true, permissionBoundary: null };

describe('a room composes its session from the writer, not from whoever opened it', () => {
  it('names the verified writer even when somebody else owns the room', async () => {
    const t = setup();

    await t.turn(2, 'Michal opens the room');
    // Sabina writes into a room Michal owns. Her turn spawned nothing new, so force the respawn the way
    // production does (a model switch, an eviction, a restart) and check what the fresh session is built from.
    t.registry.channelDispose('discord-room');
    await t.turn(3, 'Sabina asks something');

    expect(t.store.getSession(t.sessionId)?.user_id).toBe(2); // ownership is untouched by this change
    expect(t.settingsIdOf(1)).toBe(3);
    expect(t.registry.channelGet('discord-room')?.settingsUserId).toBe(3);
  });

  it('falls back to the room owner for an unlinked sender', async () => {
    const t = setup();

    await t.turn(2, 'Michal opens the room');
    t.registry.channelDispose('discord-room');
    await t.turn(undefined, 'a guest with no linked account writes');

    // Nobody to read settings from, so the owner's stand — the same fallback a cron turn takes.
    expect(t.settingsIdOf(1)).toBe(2);
  });

  it('follows the writer that an idle rollover just made the new owner', async () => {
    const t = setup();

    await t.turn(2, 'Michal opens the room');
    t.ageLastMessage(THIRTY_ONE_MIN);
    await t.turn(3, 'Sabina writes half an hour later');

    // The rollover archives Michal's conversation and Sabina opens a fresh one: both the row and the
    // composition must move to her, and the stale owner the orchestrator passed in must not win.
    expect(t.store.getSession(t.sessionId)?.user_id).toBe(3);
    expect(t.settingsIdOf(1)).toBe(3);
  });

  it('gives a delegated child the settings its PARENT composed from, not the room opener’s', async () => {
    const t = setup();

    await t.turn(2, 'Michal opens the room');
    t.registry.channelDispose('discord-room');
    await t.turn(3, 'Sabina asks something'); // room owned by 2, composed for 3

    // The child of Sabina's turn. A delegated send may not name a writer (its sender is the sub-agent
    // identity, not a person), so without inheriting it would fall back to the opener and run the child
    // on Michal's default model, compaction model and thresholds while its parent ran on Sabina's.
    await t.svc.send({
      channelId: 'subagent-sub-1',
      ownerUserId: 2,
      parentSessionId: t.sessionId,
      policy: t.policy,
      delegatedAccess: SCOPE,
      trusted: SCOPE.admin,
      identity: { platform: 'subagent', userId: 'subagent', admin: true, owner: true },
    } as never, 'go and look');

    expect(t.settingsIdOf(2)).toBe(3);
    expect(t.registry.channelGet('subagent-sub-1')?.settingsUserId).toBe(3);
    expect(t.spawn.mock.calls[2]![0]).not.toHaveProperty('fast'); // child reads account 3 live on every request
  });

  it('keeps the captured settings account after the parent live session is evicted', async () => {
    const t = setup();

    await t.turn(2, 'Michal opens the room');
    t.registry.channelDispose('discord-room');
    await t.turn(3, 'Sabina asks something'); // room owned by 2, composed for 3
    t.registry.channelDispose('discord-room'); // runner/restart can no longer consult parentLive

    await t.svc.send({
      channelId: 'subagent-sub-durable',
      ownerUserId: 2,
      parentSessionId: t.sessionId,
      policy: t.policy,
      delegatedAccess: { ...SCOPE, settingsUserId: 3, contributionUserId: 3 },
      trusted: SCOPE.admin,
      identity: { platform: 'subagent', userId: 'subagent', admin: true, owner: true },
    } as never, 'resume after eviction');

    expect(t.settingsIdOf(2)).toBe(3);
    expect(t.registry.channelGet('subagent-sub-durable')?.settingsUserId).toBe(3);
  });

  it('resets the rooms that RENDER an account’s instructions, not the ones it opened', async () => {
    const t = setup();

    await t.turn(2, 'Michal opens the room');
    t.registry.channelDispose('discord-room');
    await t.turn(3, 'Sabina asks something'); // owned by 2, composed for 3

    // Michal saving his instructions must not respawn a room whose prompt is built from Sabina's.
    await t.svc.resetChannels('user instructions changed', (settingsUserId) => settingsUserId === 2);
    expect(t.registry.channelGet(t.channelId)).toBeDefined();

    // Sabina saving hers must, or the room keeps rendering the instructions she just replaced.
    await t.svc.resetChannels('user instructions changed', (settingsUserId) => settingsUserId === 3);
    expect(t.registry.channelGet(t.channelId)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------
// Mechanical contract: exactly one place decides whose settings compose a session.
//
// Derived from the source rather than hand-listed, so a spawn caller added next year is in the check by
// construction. Before this change three of them resolved the auto-compact threshold for themselves and
// the room resolved it for the wrong account entirely.
// ---------------------------------------------------------------------------------------------------

const SRC = new URL('../../src/', import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

/** Comments discuss these settings constantly (and should). Only real CODE counts. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const modules = (): { path: string; code: string }[] => sourceFiles(SRC)
  .map((path) => ({ path: path.slice(SRC.length), code: stripComments(readFileSync(path, 'utf-8')) }));

/** The module that OWNS the decision: it is the one that turns `settingsUserId` into a composed session. */
const SPAWNER = 'brain/service/spawner.ts';
/** The module that DECLARES SpawnOpts. The type IS the contract, so naming it there is not a call site. */
const SPAWN_OPTS = 'brain/session/liveBrain.ts';

/** The per-user settings a live session is BUILT from, and which therefore have exactly one legal reader.
 *  `personalityBody` / `activeUserInstructions` are in here for the same reason as the advisor style they
 *  land beside in the system prompt: they are a statement of how ONE account wants to be answered, and a
 *  stronger one. Leaving them out is what let a room render the writer's style next to the opener's
 *  private standing instructions. */
const COMPOSITION_SETTINGS = [
  'advisorStyle', 'autoCompactAt', 'autoCompactAtByModel', 'compactModel', 'compactModelProvider',
  'personalityBody', 'activeUserInstructions',
];

/** The model-selection ladder, which is NOT a second copy of the decision above: the owner surface runs it
 *  (an explicit pick, the stored model, a project preference, then the account default — and the vision
 *  hop's own model) and hands the WINNER to the spawner as `selection`.
 *
 *  It is legal for exactly one kind of caller: one that composes for the session OWNER and therefore omits
 *  `settingsUserId`. A caller that NAMES a settings account and still runs the ladder would resolve a model
 *  under one id and every other preference under another — which is how the vision model, absent from this
 *  contract entirely, would have followed a room's opener into a session composed for its writer.
 *  Each pair is represented by the half whose name cannot collide with the word "model" everywhere else. */
const SELECTION_SETTINGS = ['modelProvider', 'visionModel', 'visionModelProvider'];

/** Everything that spawns a live session. DERIVED from the type system rather than from call syntax:
 *  reaching the spawner means holding its injected dep, and that dep is declared `(opts: SpawnOpts)` from
 *  liveBrain.js. A textual `spawn({` misses a caller that assembles its options into a variable first —
 *  and a caller-list equality assertion alone only notices after somebody updates the list. The literal
 *  shape stays in the union as a second net. */
const spawnCallers = (): { path: string; code: string }[] => modules().filter(({ path, code }) =>
  path !== SPAWNER && path !== SPAWN_OPTS
  && ((/\bSpawnOpts\b/.test(code) && /liveBrain\.js/.test(code)) || /\bspawn\s*\(\s*\{/.test(code)));

describe('the session-settings contract', () => {
  it('nothing that spawns a live session resolves those settings for itself', () => {
    const callers = spawnCallers();
    // A rename that stopped matching would leave an empty set quietly passing.
    expect(callers.map((m) => m.path).sort(), 'the spawn call sites this contract covers')
      .toEqual(['brain/channels.ts', 'brain/service/lifecycle.ts']);
    const offenders = callers.flatMap(({ path, code }) => COMPOSITION_SETTINGS
      .filter((key) => new RegExp(`\\b${key}\\b`).test(code))
      .map((key) => `${path} reads ${key}`));
    expect(offenders, 'a spawn caller must NAME the settings account (settingsUserId) and let the spawner read it').toEqual([]);
  });

  it('only a caller composing for the owner may run the model-selection ladder', () => {
    const offenders = spawnCallers()
      .filter(({ code }) => /\bsettingsUserId\b/.test(code))
      .flatMap(({ path, code }) => SELECTION_SETTINGS
        .filter((key) => new RegExp(`\\b${key}\\b`).test(code))
        .map((key) => `${path} names a settings account and still reads ${key}`));
    expect(offenders, 'resolve the model under the same id as every other preference, or omit the argument').toEqual([]);
  });

  it('every spawn caller decides the settings account explicitly or omits it', () => {
    // Omitting the argument is the single-sender surface saying "the owner"; passing a value is the room
    // saying "the writer" (and a delegated child saying "whoever composed my parent"). What must not exist
    // is a third shape that resolves a setting on the side.
    const channels = modules().find((m) => m.path === 'brain/channels.ts')!.code;
    expect(/settingsUserId:\s*opts\.writerUserId\s*\?\?[^;]*\bownerUserId\b/.test(channels)).toBe(true);
    const lifecycle = modules().find((m) => m.path === 'brain/service/lifecycle.ts')!.code;
    expect(/\bsettingsUserId\b/.test(lifecycle), 'owner chat has one sender — it omits the argument').toBe(false);
  });

  it('a setting re-applied to an already live session matches on what composed it', () => {
    // The seam the room-ownership rollover hid in: keying an in-place re-apply on the session's OWNER
    // puts the opener's personal threshold back onto a room composed for somebody else.
    const service = modules().find((m) => m.path === 'brain/brainService.ts')!.code;
    const body = service.slice(service.indexOf('applyAutoCompactSettings('));
    expect(/live\.settingsUserId\s*!==\s*userId/.test(body)).toBe(true);
    expect(/getSession\(.*\)\?\.user_id\s*!==\s*userId/.test(body.slice(0, body.indexOf('\n  }'))))
      .toBe(false);
    // Same rule for the OTHER live re-apply: a user-instructions change respawns the rooms that render
    // those instructions, which is not the same set as the rooms that account opened.
    const channels = modules().find((m) => m.path === 'brain/channels.ts')!.code;
    const reset = channels.slice(channels.indexOf('async resetChannels('));
    expect(/settingsFilter\(ch\.settingsUserId\)/.test(reset)).toBe(true);
    expect(/getSession\(ch\.sessionId\)\?\.user_id/.test(reset.slice(0, reset.indexOf('\n  }')))).toBe(false);
  });
});
