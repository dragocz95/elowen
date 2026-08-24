import { describe, it, expect, vi } from 'vitest';
import { ChannelSessionService } from '../../src/brain/channels.js';
import { channelSessionId } from '../../src/brain/sessionId.js';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { openDb, type Db } from '../../src/store/db.js';

/** A room belongs to whoever OPENED it, and these run against a real store rather than a mocked channel
 *  service, because the interesting half of that rule is what actually lands in `brain_sessions.user_id`.
 *
 *  The orchestrator decides the owner it passes in (platforms.ts: the row's current owner, else the
 *  verified sender, else the operator). What it cannot see is the idle rollover, which happens INSIDE
 *  send: it renames the row to the archived id, so the owner the orchestrator read a moment earlier is
 *  stale and the writer is opening a genuinely new conversation. */

const agedTs = (agoMs: number): string => new Date(Date.now() - agoMs).toISOString().replace('T', ' ').slice(0, 19);
const THIRTY_ONE_MIN = 31 * 60 * 1000;

function fakeBrain(sessionId: string, ownerUserId: number, direct = false) {
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
    sessionId, ownerUserId, direct,
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
  // Mirrors the real factory: the row is created ONLY when missing, so a respawn never re-points an
  // existing conversation. That is the property the whole rule rests on.
  const spawn = vi.fn(async (o: { sessionId: string; ownerUserId: number; direct?: boolean }) => {
    if (!store.getSession(o.sessionId)) store.createSession({ id: o.sessionId, userId: o.ownerUserId, model: 'kimi' });
    return fakeBrain(o.sessionId, o.ownerUserId, o.direct === true);
  });
  const svc = new ChannelSessionService({
    registry, store, users: { get: () => ({ username: 'someone' }) }, spawn, titler: { run: vi.fn() },
  } as never);
  const channelId = 'msteams-19:room';
  const sessionId = channelSessionId(channelId);
  const policy = { allowedProjectIds: 'all' as const, allowedPaths: () => [] };

  /** One turn as the orchestrator would issue it: it sends the row's current owner when there is a row,
   *  and the verified writer when there is not (platforms.ts `rowOwner ?? linkedUserId ?? owner`). */
  const turn = async (writerUserId: number, text: string, operator = 1) => {
    const rowOwner = store.getSession(sessionId)?.user_id;
    await svc.send({ channelId, ownerUserId: rowOwner ?? writerUserId ?? operator, writerUserId, policy }, text);
  };

  const ageLastMessage = (ms: number) => {
    const rows = store.getMessages(sessionId);
    db.prepare('UPDATE brain_messages SET created_at = ? WHERE id = ?').run(agedTs(ms), rows[rows.length - 1]!.id);
  };

  return { db, store, registry, spawn, svc, channelId, sessionId, turn, ageLastMessage };
}

describe('a shared room is owned by whoever opened it', () => {
  it('records the first writer as the owner of a brand-new room', async () => {
    const t = setup();
    await t.turn(2, 'Michal opens the room');
    expect(t.store.getSession(t.sessionId)?.user_id).toBe(2);
  });

  it('does not change hands when somebody else writes into the same conversation', async () => {
    const t = setup();
    await t.turn(2, 'Michal opens the room');
    await t.turn(5, 'Ondrej replies in the same conversation');

    expect(t.store.getSession(t.sessionId)?.user_id).toBe(2);
    // Spawned once for the whole conversation: the owner sent back matched the row, so the live channel
    // was reused. Sending the operator here instead would have rebuilt it on this turn and every later one.
    expect(t.spawn).toHaveBeenCalledOnce();
  });

  // The case Filip named: writing into a quiet channel opens a NEW session (the idle rollover exists to
  // stop paying for a cold prompt cache), and that new session belongs to the person who woke it.
  it('hands the next session to whoever writes after the channel has gone idle', async () => {
    const t = setup();
    await t.turn(2, 'Michal opens the room');
    t.ageLastMessage(THIRTY_ONE_MIN);

    await t.turn(5, 'Ondrej writes an hour later');

    expect(t.store.getSession(t.sessionId)?.user_id).toBe(5);
    // …and the conversation Michal had is preserved under the archived id, still his.
    const archived = t.store.listSessions(2).filter((s) => s.id.startsWith(`brain-ch-${t.channelId}-arch-`));
    expect(archived).toHaveLength(1);
    expect(archived[0]!.user_id).toBe(2);
  });

  it('keeps the operator when the writer has no linked account to name', async () => {
    const t = setup();
    // An unlinked sender: the orchestrator resolves no account, so nothing better than the operator exists.
    await t.svc.send({
      channelId: t.channelId, ownerUserId: 1, policy: { allowedProjectIds: 'all' as const, allowedPaths: () => [] },
    }, 'a stranger writes');
    expect(t.store.getSession(t.sessionId)?.user_id).toBe(1);
  });
});
