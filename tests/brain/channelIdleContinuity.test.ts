import { describe, it, expect, vi } from 'vitest';
import { ChannelSessionService } from '../../src/brain/channels.js';
import { channelSessionId } from '../../src/brain/sessionId.js';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { openDb, type Db } from '../../src/store/db.js';

/** SQLite-shaped UTC timestamp `ms` before now (matches brain_messages.created_at). */
const agedTs = (agoMs: number): string => new Date(Date.now() - agoMs).toISOString().replace('T', ' ').slice(0, 19);

/** A minimal fake LiveBrain — only the fields ChannelSessionService.send touches. `prompt` appends a
 *  settled assistant message so the reply-extraction + thinking-only guard have something to read.
 *  `assessColdCompaction` is the seam the turn-start cold-context passes consult, so a test can prove
 *  which mechanism handled a stale context. */
function fakeBrain(sessionId = 'brain-ch-discord-c1', ownerUserId = 1, direct = false) {
  const messages: { role?: string; content?: unknown }[] = [];
  const session = {
    isStreaming: false,
    isCompacting: false,
    getContextUsage: () => ({ tokens: 50, contextWindow: 8000, percent: 1 }),
    messages,
    prompt: vi.fn(async () => { messages.push({ role: 'assistant', content: 'ok' }); }),
    dispose: vi.fn(() => {}),
    getAllTools: () => [] as { name: string }[],
    getActiveToolNames: () => [] as string[],
    setActiveToolsByName: () => {},
  };
  return {
    session, sessionId, ownerUserId, direct,
    model: 'kimi',
    thinkingLevel: undefined as string | undefined,
    providerId: 'moonshot',
    pluginToolNames: new Set<string>(),
    turnSender: undefined as number | undefined,
    interactedAt: undefined as number | undefined,
    listeners: new Set<(e: unknown) => void>(),
    turnContext: () => ({ beforeUser: '', afterUser: '' }),
    // Reached only once the shared cold predicate has opened: a warm conversation never gets here.
    assessColdCompaction: vi.fn(() => ({ eligible: false, reason: 'not-worthwhile' as const })),
  };
}

type Brain = ReturnType<typeof fakeBrain>;

function setup() {
  const db: Db = openDb(':memory:');
  const store = new BrainStore(db);
  const registry = new LiveSessionRegistry<Brain>();
  const titler = { run: vi.fn() };
  const spawn = vi.fn(async (o: { sessionId: string; ownerUserId: number; direct?: boolean; seedMessages?: { id: string; role: string; content: unknown }[] }) => {
    // Mirror the real factory: create the row only when it is missing (a respawn keeps the durable
    // conversation), atomically seed imported history, then expose the live brain.
    if (!store.getSession(o.sessionId)) store.createSession({ id: o.sessionId, userId: o.ownerUserId, model: 'kimi' });
    if (o.seedMessages?.length) store.seedMessages(o.sessionId, o.seedMessages);
    return fakeBrain(o.sessionId, o.ownerUserId, o.direct === true);
  });
  const svc = new ChannelSessionService({ registry, store, users: { get: () => ({ username: "owner" }) }, spawn, titler } as never);
  const channelId = 'discord-c1';
  const sessionId = channelSessionId(channelId);
  const baseOpts = {
    channelId,
    ownerUserId: 1,
    policy: { allowedProjectIds: 'all' as const, allowedPaths: () => [] },
  };
  /** Seed a live brain + a persisted session with one user message aged `msgAgeMs` in the past. */
  const seed = (msgAgeMs: number, live: Brain) => {
    store.createSession({ id: sessionId, userId: 1, model: 'kimi' });
    store.appendMessage({ id: 'm1', sessionId, parentId: null, role: 'user', content: { role: 'user', content: 'old' } });
    db.prepare('UPDATE brain_messages SET created_at = ? WHERE id = ?').run(agedTs(msgAgeMs), 'm1');
    registry.channelTouch(channelId, live);
  };
  return { db, store, registry, titler, spawn, svc, channelId, sessionId, baseOpts, seed };
}

const TWO_HOURS = 2 * 60 * 60 * 1000;
const ONE_MIN = 60 * 1000;

/** Idle no longer moves a platform conversation anywhere. A room, a 1:1 DM, a cron job channel and a
 *  sub-agent channel all keep ONE session for their whole life; the cost of returning to a stale context
 *  is paid at turn start by cold-start compaction and cold tool-result clearing instead.
 *
 *  RED BEFORE THE CHANGE: `send` consulted `rolloverDue` under the lock and, past a 30-minute cutoff,
 *  disposed the live session and re-keyed the transcript to `brain-ch-<channel>-arch-*` before spawning a
 *  fresh empty one under the canonical id. Both cases below therefore came back on a new, empty session —
 *  which is what broke a scheduled wake-up bound to a DM: it archived the transcript from under itself. */
describe('ChannelSessionService.send — a long-idle channel continues its own session', () => {
  it('a scheduled wake-up into a 1:1 DM idle for 2 h runs in the SAME channel session', async () => {
    const t = setup();
    const live = fakeBrain(t.sessionId, 1, true); // already classified as a 1:1 DM, so nothing rebuilds it
    t.seed(TWO_HOURS, live);
    t.store.setTitle(t.sessionId, 'Morning digest');

    await t.svc.send({ ...t.baseOpts, direct: true, scheduled: true }, 'scheduled wake-up');

    // The live session is reused: nothing was disposed, nothing respawned, nothing archived.
    expect(live.session.dispose).not.toHaveBeenCalled();
    expect(t.spawn).not.toHaveBeenCalled();
    expect(t.store.listSessions(1).some((s) => s.id.startsWith(`brain-ch-${t.channelId}-arch-`))).toBe(false);
    // The wake-up landed in the conversation it was bound to, after the history it was meant to continue.
    const contents = t.store.getMessages(t.sessionId).map((m) => JSON.parse(m.content).content);
    expect(contents).toEqual(['old', 'scheduled wake-up']);
    expect(t.store.getSession(t.sessionId)?.title).toBe('Morning digest');
  });

  it('a room message after 2 h idle continues the session and the cold turn-start passes are what fire', async () => {
    const t = setup();
    const live = fakeBrain();
    t.seed(TWO_HOURS, live);
    t.store.setTitle(t.sessionId, 'Room chat');
    // Both turn-start passes read the fork-child watermark through the store; a warm turn reaches neither.
    const forkWatermark = vi.spyOn(t.store, 'lastForkChildMessageAt');
    const history = vi.fn(async () => 'past chatter');

    await t.svc.send({ ...t.baseOpts, history }, 'hello again');

    expect(live.session.dispose).not.toHaveBeenCalled();
    expect(t.spawn).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled(); // the transcript is still here → no history backfill
    expect(t.titler.run).not.toHaveBeenCalled(); // not a brand-new conversation
    expect(t.store.getMessages(t.sessionId).some((m) => JSON.parse(m.content).content === 'old')).toBe(true);
    // Cold tool-result clearing ran, then cold-start compaction got as far as assessing the context —
    // both gates opened, which is the whole replacement for the removed rollover.
    expect(forkWatermark).toHaveBeenCalledWith(t.sessionId);
    expect(live.assessColdCompaction).toHaveBeenCalled();
  });

  it('leaves a warm channel alone — neither cold pass is reached one minute after the last message', async () => {
    const t = setup();
    const live = fakeBrain();
    t.seed(ONE_MIN, live);

    await t.svc.send({ ...t.baseOpts }, 'hello');

    expect(live.session.dispose).not.toHaveBeenCalled();
    expect(t.spawn).not.toHaveBeenCalled();
    expect(live.assessColdCompaction).not.toHaveBeenCalled();
    expect(t.store.getMessages(t.sessionId).map((m) => JSON.parse(m.content).content)).toContain('old');
  });

  it('a streaming turn is never cut short by a stale transcript', async () => {
    const t = setup();
    const live = fakeBrain();
    live.session.isStreaming = true;
    live.turnSender = 999; // a different sender than this (identity-less) turn → past the pre-lock steer path
    t.seed(TWO_HOURS, live);

    await t.svc.send({ ...t.baseOpts }, 'hello');

    expect(live.session.dispose).not.toHaveBeenCalled();
    expect(t.spawn).not.toHaveBeenCalled();
    expect(live.assessColdCompaction).not.toHaveBeenCalled(); // a streaming session is not rewritten either
    expect(t.store.getMessages(t.sessionId).some((m) => JSON.parse(m.content).content === 'old')).toBe(true);
  });

  it('seeds role-preserving JSON history before the live user message', async () => {
    const t = setup();
    const history = vi.fn(async () => [
      { id: 'p1', role: 'user' as const, author: { id: 'u1', name: 'Amy' }, text: 'Earlier question' },
      { id: 'p2', role: 'assistant' as const, author: { id: 'bot', name: 'Elowen' }, text: 'Earlier answer' },
    ]);

    await t.svc.send({ ...t.baseOpts, history, historyPlatform: 'discord' }, 'Current question');

    const rows = t.store.getMessages(t.sessionId);
    expect(rows.map((row) => row.role)).toEqual(['user', 'assistant', 'user']);
    const first = JSON.parse(JSON.parse(rows[0].content).content);
    const second = JSON.parse(JSON.parse(rows[1].content).content[0].text);
    expect(first).toMatchObject({ source: 'platform_history', platform: 'discord', messageId: 'p1', author: { name: 'Amy' }, text: 'Earlier question' });
    expect(second).toMatchObject({ source: 'platform_history', platform: 'discord', messageId: 'p2', author: { name: 'Elowen' }, text: 'Earlier answer' });
    expect(JSON.parse(rows[2].content).content).toBe('Current question');
  });
});

/** A live PI session bakes its tool definitions in when it is assembled, so a caller that changed what the
 *  session may run has to be able to force a rebuild. It keeps the conversation: the transcript stays under
 *  the same id and rehydrates. Today's only user is a promoted sub-agent scope. */
describe('ChannelSessionService.send — rebuildSession', () => {
  it('drops and respawns the live session while keeping the transcript under the same id', async () => {
    const t = setup();
    const live = fakeBrain();
    t.seed(ONE_MIN, live);

    await t.svc.send({ ...t.baseOpts, rebuildSession: true }, 'now with more tools');

    expect(live.session.dispose).toHaveBeenCalledOnce();
    expect(t.spawn).toHaveBeenCalledOnce();
    // The earlier message is still in THIS session and nothing was archived.
    expect(t.store.getMessages(t.sessionId).some((m) => JSON.parse(m.content).content === 'old')).toBe(true);
    expect(t.store.listSessions(1).some((s) => s.id.startsWith(`brain-ch-${t.channelId}-arch-`))).toBe(false);
  });

  it('rebuilds when effective direct classification changes and keeps the transcript', async () => {
    const t = setup();
    const live = fakeBrain(t.sessionId, 1, false);
    t.seed(ONE_MIN, live);

    await t.svc.send({ ...t.baseOpts, direct: true }, 'this is now a verified DM');

    expect(live.session.dispose).toHaveBeenCalledOnce();
    expect(t.spawn).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: 1, direct: true }));
    expect(t.store.getSession(t.sessionId)?.direct).toBe(1);
    expect(t.store.getMessages(t.sessionId).some((m) => JSON.parse(m.content).content === 'old')).toBe(true);
  });

  it('reuses the live session when the spawn-time owner and classification are unchanged', async () => {
    const t = setup();
    const live = fakeBrain();
    t.seed(ONE_MIN, live);

    await t.svc.send({ ...t.baseOpts }, 'same tools as before');

    expect(live.session.dispose).not.toHaveBeenCalled();
    expect(t.spawn).not.toHaveBeenCalled();
  });
});
