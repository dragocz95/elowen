import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ChannelSessionService } from '../../src/brain/channels.js';
import { channelSessionId } from '../../src/brain/sessionId.js';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { openDb, type Db } from '../../src/store/db.js';

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

  return { store, registry, spawn, svc, sessionId, turn, ageLastMessage, settingsIdOf };
}

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

/** The per-user settings that a live session is BUILT from, and which therefore have exactly one legal
 *  reader. `model`/`modelProvider` are deliberately absent: the owner surface runs a richer selection
 *  ladder over them (an explicit pick, the stored model, a project preference, then the account default)
 *  and hands the WINNER to the spawner as `selection`, which is not a second copy of this decision. */
const COMPOSITION_SETTINGS = ['advisorStyle', 'autoCompactAt', 'autoCompactAtByModel', 'compactModel', 'compactModelProvider'];

describe('the session-settings contract', () => {
  it('nothing that spawns a live session resolves those settings for itself', () => {
    // Derived: whatever calls the spawner is in scope, whether it exists today or not.
    const callers = modules().filter(({ path, code }) => path !== SPAWNER && /\bspawn\s*\(\s*\{/.test(code));
    // A rename that stopped matching would leave an empty set quietly passing.
    expect(callers.map((m) => m.path).sort(), 'the spawn call sites this contract covers')
      .toEqual(['brain/channels.ts', 'brain/service/lifecycle.ts']);
    const offenders = callers.flatMap(({ path, code }) => COMPOSITION_SETTINGS
      .filter((key) => new RegExp(`\\b${key}\\b`).test(code))
      .map((key) => `${path} reads ${key}`));
    expect(offenders, 'a spawn caller must NAME the settings account (settingsUserId) and let the spawner read it').toEqual([]);
  });

  it('every spawn caller decides the settings account explicitly or omits it', () => {
    // Omitting the argument is the single-sender surface saying "the owner"; passing a value is the room
    // saying "the writer". What must not exist is a third shape that resolves a setting on the side.
    const channels = modules().find((m) => m.path === 'brain/channels.ts')!.code;
    expect(/settingsUserId:\s*opts\.writerUserId\s*\?\?\s*ownerUserId/.test(channels)).toBe(true);
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
  });
});
