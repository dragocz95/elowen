import { describe, it, expect, vi } from 'vitest';
import { ChannelSessionService } from '../../src/brain/channels.js';
import { channelSessionId } from '../../src/brain/sessionId.js';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { openDb, type Db } from '../../src/store/db.js';

/** SQLite-shaped UTC timestamp `ms` before now (matches brain_messages.created_at). */
const agedTs = (agoMs: number): string => new Date(Date.now() - agoMs).toISOString().replace('T', ' ').slice(0, 19);

/** A minimal fake LiveBrain — only the fields ChannelSessionService.send touches. `prompt` appends a
 *  settled assistant message so the reply-extraction + thinking-only guard have something to read. */
function fakeBrain(sessionId = 'brain-ch-discord-c1') {
  const messages: { role?: string; content?: unknown }[] = [];
  const session = {
    isStreaming: false,
    getContextUsage: () => ({ tokens: 50, contextWindow: 8000, percent: 1 }),
    messages,
    prompt: vi.fn(async () => { messages.push({ role: 'assistant', content: 'ok' }); }),
    dispose: vi.fn(() => {}),
    getAllTools: () => [] as { name: string }[],
    getActiveToolNames: () => [] as string[],
    setActiveToolsByName: () => {},
  };
  return {
    session, sessionId,
    model: 'kimi',
    thinkingLevel: undefined as string | undefined,
    providerId: 'moonshot',
    pluginToolNames: new Set<string>(),
    turnSender: undefined as number | undefined,
    interactedAt: undefined as number | undefined,
    listeners: new Set<(e: unknown) => void>(),
    turnContext: () => '',
  };
}

type Brain = ReturnType<typeof fakeBrain>;

function setup() {
  const db: Db = openDb(':memory:');
  const store = new BrainStore(db);
  const registry = new LiveSessionRegistry<Brain>();
  const titler = { run: vi.fn() };
  const spawn = vi.fn(async (o: { sessionId: string; ownerUserId: number }) => {
    // Mirror the real spawn: a channel session's row exists before the first turn persists into it.
    store.createSession({ id: o.sessionId, userId: o.ownerUserId, model: 'kimi' });
    return fakeBrain();
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

const THIRTY_ONE_MIN = 31 * 60 * 1000;
const ONE_MIN = 60 * 1000;

describe('ChannelSessionService.send — idle rollover (cache-cost fix)', () => {
  it('resets the session in place when the last message is older than the threshold', async () => {
    const t = setup();
    const stale = fakeBrain();
    t.seed(THIRTY_ONE_MIN, stale);
    const history = vi.fn(async () => 'past chatter');

    await t.svc.send({ ...t.baseOpts, history }, 'hello');

    expect(stale.session.dispose).toHaveBeenCalledOnce(); // old live PI session dropped (channelDispose)
    expect(t.spawn).toHaveBeenCalledOnce(); // fell through to a fresh spawn under the SAME id
    expect(history).toHaveBeenCalledOnce(); // reset → getMessages()==0 → channel-history backfill re-fired
    expect(t.titler.run).toHaveBeenCalledOnce(); // brand-new conversation → titler re-runs
    const msgs = t.store.getMessages(t.sessionId);
    // The stale 'old' message is gone; the fresh turn's user message carries the backfilled history.
    expect(msgs).toHaveLength(1);
    expect(JSON.parse(msgs[0].content).content).toContain('past chatter');
    expect(JSON.parse(msgs[0].content).content).not.toContain('old');
  });

  it('PRESERVES the old transcript+title under an archived session (browsable), never deletes it', async () => {
    const t = setup();
    const stale = fakeBrain();
    t.seed(THIRTY_ONE_MIN, stale);
    t.store.setTitle(t.sessionId, 'Old chat'); // a titled conversation must survive the rollover

    await t.svc.send({ ...t.baseOpts }, 'hello');

    // The deterministic channel id now hosts the FRESH session (its only message is this turn's).
    expect(t.store.getMessages(t.sessionId).some((m) => JSON.parse(m.content).content === 'old')).toBe(false);
    // The old conversation is archived under a fresh `brain-ch-<channel>-arch-*` id — still owned by the
    // owner, so it stays browsable in the admin sessions view — carrying its 'old' message AND its title.
    const archived = t.store.listSessions(1).filter((s) => s.id !== t.sessionId && s.id.startsWith(`brain-ch-${t.channelId}-arch-`));
    expect(archived).toHaveLength(1);
    expect(archived[0].title).toBe('Old chat');
    const archivedMsgs = t.store.getMessages(archived[0].id);
    expect(archivedMsgs.some((m) => JSON.parse(m.content).content === 'old')).toBe(true);
  });

  it('a recent interaction on the live session vetoes the rollover even when the last message is stale', async () => {
    const t = setup();
    const live = fakeBrain();
    live.interactedAt = Date.now(); // a deliberate touch (compact/model switch) moments ago
    t.seed(THIRTY_ONE_MIN, live); // last stored message is 31 min old — stale on its own

    await t.svc.send({ ...t.baseOpts }, 'hello');

    expect(live.session.dispose).not.toHaveBeenCalled(); // interactedAt shielded it — no rollover
    expect(t.spawn).not.toHaveBeenCalled();
    expect(t.store.getMessages(t.sessionId).some((m) => JSON.parse(m.content).content === 'old')).toBe(true);
    // No archive was minted.
    expect(t.store.listSessions(1).some((s) => s.id.startsWith(`brain-ch-${t.channelId}-arch-`))).toBe(false);
  });

  it('idleRolloverMs=Infinity disables rollover — a long-idle session keeps its context', async () => {
    const t = setup();
    const live = fakeBrain();
    t.seed(10 * THIRTY_ONE_MIN, live); // hours idle — would roll over under any finite cutoff

    await t.svc.send({ ...t.baseOpts, idleRolloverMs: Infinity }, 'tick');

    expect(live.session.dispose).not.toHaveBeenCalled();
    expect(t.spawn).not.toHaveBeenCalled();
    expect(t.store.getMessages(t.sessionId).some((m) => JSON.parse(m.content).content === 'old')).toBe(true);
  });

  it('does NOT reset while the last message is within the threshold — the live session is reused', async () => {
    const t = setup();
    const live = fakeBrain();
    t.seed(ONE_MIN, live);
    const history = vi.fn(async () => 'past chatter');

    await t.svc.send({ ...t.baseOpts, history }, 'hello');

    expect(live.session.dispose).not.toHaveBeenCalled();
    expect(t.spawn).not.toHaveBeenCalled(); // existing live session reused
    expect(history).not.toHaveBeenCalled(); // getMessages()>0 → no backfill
    // The original message survives (deleteSession never ran); the new turn is appended after it.
    const contents = t.store.getMessages(t.sessionId).map((m) => JSON.parse(m.content).content);
    expect(contents).toContain('old');
  });

  it('honors a shorter per-surface idleRolloverMs (cron): resets at 6 min under a 5-min cutoff', async () => {
    const t = setup();
    const stale = fakeBrain();
    t.seed(6 * 60 * 1000, stale);

    await t.svc.send({ ...t.baseOpts, idleRolloverMs: 5 * 60 * 1000 }, 'tick');

    expect(stale.session.dispose).toHaveBeenCalledOnce();
    expect(t.spawn).toHaveBeenCalledOnce();
    // The same 6-min age would NOT roll over under the default 30-min cutoff (regression guard).
    const t2 = setup();
    const live = fakeBrain();
    t2.seed(6 * 60 * 1000, live);
    await t2.svc.send({ ...t2.baseOpts }, 'tick');
    expect(live.session.dispose).not.toHaveBeenCalled();
    expect(t2.spawn).not.toHaveBeenCalled();
  });

  it('never resets a session whose turn is still streaming, even past the threshold', async () => {
    const t = setup();
    const live = fakeBrain();
    live.session.isStreaming = true;
    live.turnSender = 999; // a different sender than this (identity-less) turn → past the pre-lock steer path
    t.seed(THIRTY_ONE_MIN, live);

    await t.svc.send({ ...t.baseOpts }, 'hello');

    expect(live.session.dispose).not.toHaveBeenCalled();
    expect(t.spawn).not.toHaveBeenCalled();
    // deleteSession never ran → the stale message is still there.
    expect(t.store.getMessages(t.sessionId).some((m) => JSON.parse(m.content).content === 'old')).toBe(true);
  });

  it('never rolls over a parent while its background child is still running', async () => {
    const t = setup();
    const live = fakeBrain(t.sessionId);
    t.seed(THIRTY_ONE_MIN, live);
    t.registry.setChildRunning(t.sessionId, 'brain-ch-subagent-running', true);

    await t.svc.send({ ...t.baseOpts }, 'hello');

    expect(live.session.dispose).not.toHaveBeenCalled();
    expect(t.spawn).not.toHaveBeenCalled();
    expect(t.store.getMessages(t.sessionId).some((m) => JSON.parse(m.content).content === 'old')).toBe(true);
  });

  it('a fresh (empty) session never rolls over — nothing stale to cut', async () => {
    const t = setup();
    const live = fakeBrain();
    // Session row exists but has NO messages (lastMessageAt undefined).
    t.store.createSession({ id: t.sessionId, userId: 1, model: 'kimi' });
    t.registry.channelTouch(t.channelId, live);

    await t.svc.send({ ...t.baseOpts }, 'hello');

    expect(live.session.dispose).not.toHaveBeenCalled();
    expect(t.spawn).not.toHaveBeenCalled();
  });
});
