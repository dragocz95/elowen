import { describe, it, expect, vi } from 'vitest';
import { PlatformOrchestrator } from '../../src/brain/platforms.js';
import { ChannelSessionService } from '../../src/brain/channels.js';
import { IdentityResolver } from '../../src/brain/identity.js';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';
import { LiveEventReplay } from '../../src/brain/session/liveEventReplay.js';
import { CardRegistry } from '../../src/brain/cards.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { UsageOriginStore, billSettledTurn } from '../../src/store/usageOriginStore.js';
import { openDb } from '../../src/store/db.js';
import { channelSessionId } from '../../src/brain/sessionId.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { BrainEvent } from '../../src/brain/events.js';

/** Who a room turn's spend is billed to, driven through the REAL orchestrator, the REAL channel service,
 *  a real BrainStore and a real UsageOriginStore — only PI is faked.
 *
 *  Asserting `UsageOriginStore` on its own proves nothing about this: the defect was never in the store.
 *  It was that a whole class of room turns never reached it, and that a pin one turn left behind was
 *  charged to the wrong colleague — both invisible to a test that hand-calls `recordRequest`. */

const POLICY: Policy = { allowedProjectIds: 'all' as const, allowedPaths: () => [] };
const USAGE = { input: 900, output: 100, cacheRead: 0, cacheWrite: 0, total: 1000, cost: 0.5 };
const AT = Date.UTC(2026, 7, 24, 10, 0);

/** Discord id → the Elowen account it is linked to. Nobody else is linked. */
const LINKS: Record<string, { id: number; name: string; username: string; admin: boolean }> = {
  D2: { id: 2, name: 'Amy', username: 'amy', admin: false },
  D3: { id: 3, name: 'Ben', username: 'ben', admin: false },
};

/** A live PI session that answers, and settles its turn's usage the way persistence.ts does: at agent_end,
 *  DURING the turn. That timing is load-bearing — it is what consumes the pin. */
function fakeBrain(sessionId: string, settle: () => void) {
  const messages: { role?: string; content?: unknown }[] = [];
  const listeners = new Set<(e: BrainEvent) => void>();
  return {
    sessionId, ownerUserId: 1, model: 'kimi', thinkingLevel: undefined as string | undefined,
    providerId: 'moonshot', direct: false, requestProfile: { fast: false }, fastAvailable: false,
    thinkingLabels: {}, pluginToolNames: new Set<string>(),
    turnSender: undefined as number | undefined, interactedAt: undefined as number | undefined,
    turnWriterUserId: undefined as number | null | undefined,
    lastRequestCacheTtlMs: undefined as number | undefined,
    listeners, replay: new LiveEventReplay(listeners), turnContext: () => ({ beforeUser: '', afterUser: '' }),
    session: {
      isStreaming: false, isCompacting: false, messages,
      getContextUsage: () => ({ tokens: 50, contextWindow: 8000, percent: 1 }),
      promptTemplates: [] as { name: string }[],
      prompt: vi.fn(async (t: string) => { messages.push({ role: 'assistant', content: `re: ${t}` }); settle(); }),
      steer: vi.fn(async () => {}),
      dispose: vi.fn(() => {}),
      getAllTools: () => [] as { name: string }[],
      getActiveToolNames: () => [] as string[],
      setActiveToolsByName: () => {},
    },
  };
}
type Brain = ReturnType<typeof fakeBrain>;

/** The instance, wired as the daemon wires it (see brainCore's `onTurnSettled`). */
function instance(o: { admitsNewWork?: () => boolean; platform?: string } = {}) {
  const db = openDb(':memory:');
  const store = new BrainStore(db);
  const usage = new UsageOriginStore(db);
  const registry = new LiveSessionRegistry<Brain>();
  const channels = new ChannelSessionService({
    registry, store, cards: new CardRegistry(() => store), users: { get: () => ({ username: 'o' }) },
    ...(o.admitsNewWork ? { admitsNewWork: o.admitsNewWork } : {}),
    spawn: async (s: { sessionId: string; ownerUserId: number }) => {
      if (!store.getSession(s.sessionId)) store.createSession({ id: s.sessionId, userId: s.ownerUserId, model: 'kimi' });
      return fakeBrain(s.sessionId, () => billSettledTurn(
        usage, (id) => store.getSession(id)?.user_id, s.sessionId, USAGE, AT,
      ));
    },
  } as never);
  let handler!: (src: unknown, text: string) => Promise<unknown>;
  const adapter = {
    name: o.platform ?? 'discord',
    listen: (fn: never) => { handler = fn as never; },
    connect: async () => {}, control: () => {},
  };
  const orch = new PlatformOrchestrator({
    plugins: async () => ({ platforms: [adapter], platformPromptsFor: () => [] }) as never,
    platformOwner: () => 1,
    policyForUser: () => POLICY,
    identity: new IdentityResolver({
      platformOwner: () => 1,
      resolvePlatformUser: (_p: string, id: string) => LINKS[id] ?? null,
      users: { get: (id: number) => ({ username: `u${id}` }) },
    } as never),
    channels: channels as never,
    dispatch: { send: () => Promise.reject(new Error('this test must not delegate')) } as never,
    usageOrigins: usage,
  });
  return {
    store, usage,
    /** One inbound platform message, from `userId` (undefined ⇒ accountless instance automation). */
    say: async (userId: string | undefined, text: string, access: Record<string, unknown> = { admin: false, projectIds: [3] }) => {
      if (!handler) await orch.startAll();
      return handler({ platform: o.platform ?? 'discord', userId, channelId: 'c1', roleIds: [], access } as never, text);
    },
    sessionId: channelSessionId(`${o.platform ?? 'discord'}-c1`),
    /** The rollup as the admin view reads it: [account, address, turns]. */
    billed: () => usage.topOrigins({ group: 'pair' }).map((r) => [r.userId, r.origin, r.turns]),
  };
}

describe('a room turn is billed to the colleague who wrote it', () => {
  it('reaches the rollup through the real orchestrator, keyed on the WRITER not the room owner', async () => {
    const inst = instance();

    await inst.say('D2', 'hello');   // Amy opens the room, so the room is hers…
    await inst.say('D3', 'and me');  // …and Ben writes into it

    expect(inst.store.getSession(inst.sessionId)!.user_id).toBe(2);
    expect(inst.billed()).toEqual([[2, 'platform:discord', 1], [3, 'platform:discord', 1]]);
  });

  // The fallback that must fire ONLY where nobody was identified. Instance cron carries no sender and no
  // account, so its spend honestly belongs to the row — the same person /usage/by-day reports it under.
  it('falls back to the conversation owner, as `internal`, for automation nobody sent', async () => {
    const inst = instance({ platform: 'cron' });

    await inst.say(undefined, 'the nightly digest', { admin: true });

    expect(inst.billed()).toEqual([[1, 'internal', 1]]);
  });

  // A room has SEVERAL writers, which is what turns a stranded pin into a billing defect: the pin refuses
  // the next writer a pin of their own, so their whole turn is charged to the previous person.
  it('does not charge a colleague\'s turn to the writer whose turn was refused before it ran', async () => {
    let admits = false;
    const inst = instance({ admitsNewWork: () => admits });

    // Amy writes while the daemon is draining for shutdown: refused before a single provider request.
    await expect(inst.say('D2', 'anyone there')).rejects.toThrow(/shutting down/);
    admits = true;
    await inst.say('D3', 'morning');

    expect(inst.usage.pinnedOrigin(inst.sessionId)).toBeNull();
    expect(inst.billed()).toEqual([[3, 'platform:discord', 1]]);
  });
});
