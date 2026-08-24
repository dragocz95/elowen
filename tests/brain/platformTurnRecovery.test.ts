import { describe, it, expect, vi } from 'vitest';
import { ChannelSessionService, type PlatformTurnResumeEnvelope } from '../../src/brain/channels.js';
import {
  MAX_PLATFORM_DELIVERY_ATTEMPTS,
  MAX_PLATFORM_RESUME_ATTEMPTS,
  platformTurnParkEligible,
  resumeDeliveryTarget,
  resumePlatformTurn,
  type PlatformTurnRecoveryDeps,
} from '../../src/brain/platformTurnRecovery.js';
import { channelSessionId } from '../../src/brain/sessionId.js';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';
import { LiveEventReplay } from '../../src/brain/session/liveEventReplay.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { UsageOriginStore, billSettledTurn } from '../../src/store/usageOriginStore.js';
import { openDb } from '../../src/store/db.js';
import { CardRegistry } from '../../src/brain/cards.js';
import type { BrainEvent } from '../../src/brain/events.js';
import type { Policy } from '../../src/plugins/policy.js';

const anyPolicy: Policy = { allowedProjectIds: 'all' as const, allowedPaths: () => [] };
const silentLog = () => ({ info: () => {}, warn: () => {}, error: () => {} });
const USAGE = { input: 900, output: 100, cacheRead: 0, cacheWrite: 0, total: 1000, cost: 0.5 };
const AT = Date.UTC(2026, 7, 24, 10, 0);

/** The minimal fake LiveBrain the channel suites use, extended with the custom-message seam the boot
 *  resume rides (`internalSystem` → sendCustomMessage must settle a FRESH assistant).
 *
 *  `settle` bills the turn's usage exactly where persistence.ts does — at agent_end, DURING the turn —
 *  because that timing is what consumes the origin pin. */
function fakeBrain(sessionId: string, settle: () => void) {
  const messages: { role?: string; content?: unknown; stopReason?: string }[] = [];
  const customSends: { customType: string; content: string }[] = [];
  const session = {
    isStreaming: false,
    getContextUsage: () => ({ tokens: 50, contextWindow: 8000, percent: 1 }),
    messages,
    promptTemplates: [] as { name: string }[],
    prompt: vi.fn(async (t: string) => { messages.push({ role: 'assistant', content: `re: ${t}` }); settle(); }),
    sendCustomMessage: vi.fn(async (msg: { customType: string; content: string }) => {
      customSends.push({ customType: msg.customType, content: msg.content });
      messages.push({ role: 'assistant', content: 'resumed answer' });
      settle();
    }),
    steer: vi.fn(async () => {}),
    dispose: vi.fn(() => {}),
    getAllTools: () => [] as { name: string }[],
    getActiveToolNames: () => [] as string[],
    setActiveToolsByName: () => {},
  };
  const listeners = new Set<(e: BrainEvent) => void>();
  return {
    session, sessionId, ownerUserId: 1, model: 'kimi', thinkingLevel: undefined as string | undefined,
    providerId: 'moonshot', direct: false, requestProfile: { fast: false }, fastAvailable: false,
    thinkingLabels: {}, pluginToolNames: new Set<string>(),
    turnSender: undefined as number | undefined, interactedAt: undefined as number | undefined,
    turnRecallUserId: undefined as number | null | undefined,
    customSends,
    listeners, replay: new LiveEventReplay(listeners), turnContext: () => ({ beforeUser: '', afterUser: '' }),
  };
}
type Brain = ReturnType<typeof fakeBrain>;

/** A valid captured shared-room turn for `discord-ops` — the envelope a park leaves behind. Variants
 *  are spread on top by the tests ({ ...envelopeFor(), scheduled: true }). */
function envelopeFor(channelId = 'discord-ops'): PlatformTurnResumeEnvelope {
  return {
    v: 1, platform: 'discord', channelId, ownerUserId: 1,
    direct: false, trusted: false, scheduled: false, accountUserId: 7,
    sender: { id: '42', name: 'Petra' },
    identity: {
      platform: 'discord', userId: '42', elowenUserId: 7, elowenUsername: 'petra',
      admin: false, owner: false, conversation: 'shared',
    },
    promptAppend: ['Platform surface prompt.\n'],
    deniedTools: ['Write'],
    model: { provider: 'moonshot', model: 'kimi' },
    promptCommand: false, turnText: 'kolik stojí barvení?', senderText: 'kolik stojí barvení?',
    capturedAt: '2026-08-24T00:00:00Z',
  };
}

function setup(channelId = 'discord-ops', opts: { admitsNewWork?: () => boolean } = {}) {
  const db = openDb(':memory:');
  const store = new BrainStore(db);
  // The REAL write-time rollup, wired as the daemon wires it — a money claim asserted against a mock
  // proves nothing (see tests/brain/originAttribution.test.ts).
  const usage = new UsageOriginStore(db);
  const registry = new LiveSessionRegistry<Brain>();
  const cards = new CardRegistry(() => store);
  const brains: Brain[] = [];
  const spawn = vi.fn(async (o: { sessionId: string; ownerUserId: number }) => {
    const b = fakeBrain(o.sessionId, () => billSettledTurn(
      usage, (id) => store.getSession(id)?.user_id, o.sessionId, USAGE, AT,
    ));
    brains.push(b);
    if (!store.getSession(o.sessionId)) store.createSession({ id: o.sessionId, userId: o.ownerUserId, model: 'kimi' });
    return b;
  });
  const svc = new ChannelSessionService({
    registry, store, cards, users: { get: () => ({ username: 'o' }) }, spawn,
    ...(opts.admitsNewWork ? { admitsNewWork: opts.admitsNewWork } : {}),
  } as never);
  const sessionId = channelSessionId(channelId);
  const delivered: { text: string; target: string }[] = [];
  const activity: { actorUserId: number | null; surface: string; target: string }[] = [];
  const users = { get: vi.fn((id: number) => (id === 7 ? { id: 7 } : undefined)) };
  const deps: PlatformTurnRecoveryDeps = {
    store,
    users,
    usageOrigins: usage,
    recordActivity: (e) => { activity.push(e); },
    resolvePlatformUser: vi.fn((platform: string, platformUserId: string) =>
      (platform === 'discord' && platformUserId === '42' ? { id: 7 } : null)),
    policyForUser: () => anyPolicy,
    toolAuthorityFor: () => undefined,
    send: (opts, text) => svc.send(opts, text),
    canDeliver: () => true,
    deliver: async (text, target) => { delivered.push({ text, target }); },
    log: silentLog(),
  };
  /** Park the given envelope exactly as a drained shutdown leaves it behind. */
  const park = (envelope: PlatformTurnResumeEnvelope) => {
    if (!store.getSession(sessionId)) store.createSession({ id: sessionId, userId: 1, model: 'kimi' });
    store.savePlatformTurnEnvelope(sessionId, JSON.stringify(envelope));
    store.markSessionParked(sessionId);
    return store.getSession(sessionId)!;
  };
  return {
    store, registry, svc, spawn, brains, sessionId, delivered, activity, users, deps, park, usage,
    /** The rollup as the admin view reads it: [account, address, turns]. */
    billed: () => usage.topOrigins({ group: 'pair' }).map((r) => [r.userId, r.origin, r.turns]),
  };
}

describe('platformTurnParkEligible — a platform turn parks only where a faithful resume exists', () => {
  it('accepts exactly a valid, deliverable, account-verified, unscheduled platform turn', () => {
    const { store, sessionId, park } = setup();
    park(envelopeFor());
    expect(platformTurnParkEligible(store, sessionId)).toBe(true);
  });

  it('refuses cron, scheduled, unlinked, missing, malformed and mismatched envelopes — fail closed', () => {
    const { store, sessionId, park } = setup();
    // No envelope at all: nothing to resume from.
    store.createSession({ id: sessionId, userId: 1, model: 'kimi' });
    expect(platformTurnParkEligible(store, sessionId)).toBe(false);
    // Malformed JSON fails closed.
    store.savePlatformTurnEnvelope(sessionId, '{not json');
    expect(platformTurnParkEligible(store, sessionId)).toBe(false);
    // An envelope naming a DIFFERENT channel than the session it sits on is not this turn's.
    store.savePlatformTurnEnvelope(sessionId, JSON.stringify(envelopeFor('discord-other')));
    expect(platformTurnParkEligible(store, sessionId)).toBe(false);
    // A scheduled turn has no boot resume (its delivery contract is the scheduler's).
    park({ ...envelopeFor(), scheduled: true });
    expect(platformTurnParkEligible(store, sessionId)).toBe(false);
    // An unlinked sender's turn would be refused by the authority resolver at boot — never park it.
    park({ ...envelopeFor(), accountUserId: null });
    expect(platformTurnParkEligible(store, sessionId)).toBe(false);
    // A turn with image attachments cannot be resumed faithfully: the bytes ride only the live prompt
    // (never the durable row), so the resumed model would see a text placeholder where the live turn saw
    // the picture — and the rehydrated prefix would no longer be the cached bytes. Never park it.
    park({ ...envelopeFor(), imageCount: 1 });
    expect(platformTurnParkEligible(store, sessionId)).toBe(false);
    // A zero count is the same as no images at all.
    park({ ...envelopeFor(), imageCount: 0 });
    expect(platformTurnParkEligible(store, sessionId)).toBe(true);
    // Cron sessions never park — even under a self-consistent, otherwise-eligible envelope (unscheduled,
    // verified account, encodable target), so this cannot pass for any OTHER fail-closed reason.
    const cronSession = channelSessionId('cron-job-1');
    const cronEnvelope: PlatformTurnResumeEnvelope = {
      ...envelopeFor('cron-job-1'), platform: 'cron',
      identity: { ...envelopeFor('cron-job-1').identity, platform: 'cron' },
    };
    store.createSession({ id: cronSession, userId: 1, model: 'kimi' });
    store.savePlatformTurnEnvelope(cronSession, JSON.stringify(cronEnvelope));
    expect(platformTurnParkEligible(store, cronSession)).toBe(false);
    // Sub-agent and non-channel sessions are other substrates' business.
    expect(platformTurnParkEligible(store, channelSessionId('subagent-x'))).toBe(false);
    expect(platformTurnParkEligible(store, 'brain-1')).toBe(false);
  });

  it('derives the shared-room delivery target from the registry key, and prefers a direct chat\'s own', () => {
    // `<platform>-<threadOrChannel>`: the tail is the platform's own send address for that room/thread.
    expect(resumeDeliveryTarget(envelopeFor('discord-1234-5678'))).toBe('destination:discord:1234-5678');
    expect(resumeDeliveryTarget({ ...envelopeFor(), deliveryTarget: 'destination:discord:dm9' })).toBe('destination:discord:dm9');
    // A key that does not carry its own platform prefix cannot name a target — fail closed.
    expect(resumeDeliveryTarget({ ...envelopeFor(), platform: 'telegram' })).toBeNull();
    expect(resumeDeliveryTarget(envelopeFor('discord-'))).toBeNull();
  });
});

describe('resumePlatformTurn — the boot resume of a parked platform channel turn', () => {
  it('continues the turn at the tail and delivers EXACTLY ONE fresh reply to the exact room', async () => {
    const { store, brains, sessionId, delivered, deps, park } = setup();
    const row = park(envelopeFor());

    await resumePlatformTurn(deps, row);

    // One fresh outbound post, routed to the thread the interrupted turn came from.
    expect(delivered).toEqual([{ text: 'resumed answer', target: 'destination:discord:ops' }]);
    // The continuation rode the hidden custom-system seam — appended at the tail, never a fake user row.
    expect(brains).toHaveLength(1);
    expect(brains[0]!.customSends).toHaveLength(1);
    expect(brains[0]!.customSends[0]!.customType).toBe('restart-resume');
    expect(store.getMessages(sessionId).filter((m) => m.role === 'user')).toHaveLength(0);
    // Durable stand-down: marker and envelope gone (nothing can resume this turn again) and — because
    // the post was CONFIRMED — no pending delivery either.
    expect(store.getSession(sessionId)!.parked_at).toBeNull();
    expect(store.platformTurnEnvelope(sessionId)).toBeUndefined();
    expect(store.pendingPlatformDelivery(sessionId)).toBeUndefined();

    // A second sweep (a wiring mistake, or the next boot) finds durable state saying "done" and posts
    // nothing — the no-double-reply decision comes from the store, not from the transcript's shape.
    await resumePlatformTurn(deps, { id: sessionId, park_attempts: 0 });
    expect(delivered).toHaveLength(1);
    expect(brains).toHaveLength(1);
  });

  it('re-derives authority from the account: a vanished account refuses, without a model turn', async () => {
    const { store, spawn, brains, sessionId, delivered, deps, park } = setup();
    const row = park(envelopeFor());
    deps.users.get = vi.fn(() => undefined) as never;

    await resumePlatformTurn(deps, row);

    // No session was spawned, no model was called — refusal happens before any turn.
    expect(spawn).not.toHaveBeenCalled();
    expect(brains).toHaveLength(0);
    // Terminal: marker and envelope cleared, and the room is told visibly instead of silently.
    expect(store.getSession(sessionId)!.parked_at).toBeNull();
    expect(store.platformTurnEnvelope(sessionId)).toBeUndefined();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.text).toMatch(/could not be resumed/);
    expect(delivered[0]!.text).not.toBe('resumed answer');
  });

  it('re-proves the platform identity → account binding: an unlinked sender refuses, without a model turn', async () => {
    const { store, spawn, brains, sessionId, delivered, deps, park } = setup();
    const row = park(envelopeFor());
    // The Discord sender unlinked their Elowen account while the daemon was down. The account row still
    // exists — only the binding is gone — so the users.get existence check alone would let this through.
    deps.resolvePlatformUser = vi.fn(() => null);

    await resumePlatformTurn(deps, row);

    expect(spawn).not.toHaveBeenCalled();
    expect(brains).toHaveLength(0);
    expect(store.getSession(sessionId)!.parked_at).toBeNull();
    expect(store.platformTurnEnvelope(sessionId)).toBeUndefined();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.text).toMatch(/could not be resumed/);
  });

  it('refuses a platform identity relinked to a DIFFERENT account instead of resuming as the old one', async () => {
    const { store, spawn, brains, sessionId, delivered, deps, park } = setup();
    const row = park(envelopeFor());
    // Between park and boot the platform id was claimed by another Elowen account. Resuming as the
    // captured account 7 would run (and answer) with an account the sender no longer is.
    deps.resolvePlatformUser = vi.fn(() => ({ id: 9 }));

    await resumePlatformTurn(deps, row);

    expect(spawn).not.toHaveBeenCalled();
    expect(brains).toHaveLength(0);
    expect(store.getSession(sessionId)!.parked_at).toBeNull();
    expect(store.platformTurnEnvelope(sessionId)).toBeUndefined();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.text).toMatch(/could not be resumed/);
    expect(delivered[0]!.text).not.toBe('resumed answer');
  });

  it('an envelope carrying image attachments fails closed at resume: no model turn, visible give-up', async () => {
    const { store, spawn, sessionId, delivered, deps, park } = setup();
    // Written by an older build (or by hand): the park gate refuses these now, but the resume must not
    // trust that — the durable transcript cannot reproduce the image the live turn saw.
    const row = park({ ...envelopeFor(), imageCount: 2 });

    await resumePlatformTurn(deps, row);

    expect(spawn).not.toHaveBeenCalled();
    expect(store.getSession(sessionId)!.parked_at).toBeNull();
    expect(store.platformTurnEnvelope(sessionId)).toBeUndefined();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.text).toMatch(/re-send/);
  });

  it('a message that arrived between park and boot wins: admission clears the marker and the sweep stands down', async () => {
    const { store, svc, sessionId, delivered, deps, park } = setup();
    park(envelopeFor());

    // The room speaks after the restart, before the sweep reaches this row.
    await svc.send({
      channelId: 'discord-ops', ownerUserId: 1, direct: false, policy: anyPolicy,
      identity: {
        platform: 'discord', userId: '42', elowenUserId: 7, elowenUsername: 'petra',
        admin: false, owner: false, conversation: 'shared' as const,
      },
      sender: { id: '42', name: 'Petra' }, writerUserId: 7,
    }, 'a ještě střih prosím');
    // Their message IS the continuation: turn admission cleared the marker before any lock.
    expect(store.getSession(sessionId)!.parked_at).toBeNull();

    // The sweep (still holding its pre-boot worklist row) must not inject a second continuation.
    await resumePlatformTurn(deps, { id: sessionId, park_attempts: 0 });
    expect(delivered).toHaveLength(0);
  });

  it('a lost claim race skips WITHOUT touching the running turn\'s envelope', async () => {
    const { store, spawn, sessionId, delivered, deps, park } = setup();
    park(envelopeFor());
    // The inbound turn is mid-flight: it cleared the marker at admission and its own envelope is live.
    store.clearSessionPark(sessionId);

    await resumePlatformTurn(deps, { id: sessionId, park_attempts: 0 });

    expect(spawn).not.toHaveBeenCalled();
    expect(delivered).toHaveLength(0);
    // The envelope belongs to the RUNNING turn now — the sweep must leave it alone.
    expect(store.platformTurnEnvelope(sessionId)).toBeDefined();
  });

  it('an already-delivered answer is decided from durable state: marker without envelope resumes nothing', async () => {
    const { store, spawn, sessionId, delivered, deps } = setup();
    // The live path clears the envelope strictly before the reply reaches the adapter, so this durable
    // state means the answer was already handed over when the process died.
    store.createSession({ id: sessionId, userId: 1, model: 'kimi' });
    store.markSessionParked(sessionId);

    await resumePlatformTurn(deps, store.getSession(sessionId)!);

    expect(spawn).not.toHaveBeenCalled();
    expect(delivered).toHaveLength(0);
    expect(store.getSession(sessionId)!.parked_at).toBeNull();
  });

  it('a post that fails is retried by the next boot from the computed answer, never by a second model turn', async () => {
    const { store, brains, sessionId, delivered, deps, park } = setup();
    const row = park(envelopeFor());
    deps.deliver = vi.fn(async () => { throw new Error('discord API POST → HTTP 500'); });

    // Resolves rather than rejecting — a rejection would abort the rest of the sweep — and reports
    // `failed`, never `resumed`: the answer exists but nobody in that room has it yet.
    await expect(resumePlatformTurn(deps, row)).resolves.toBe('failed');
    expect(brains).toHaveLength(1);

    // The next boot finds the computed answer durably deliverable and posts THAT text. No second model
    // turn: the envelope the model path runs from was consumed when the answer became durable.
    deps.deliver = async (text, target) => { delivered.push({ text, target }); };
    await expect(resumePlatformTurn(deps, store.getSession(sessionId)!)).resolves.toBe('resumed');
    expect(delivered).toEqual([{ text: 'resumed answer', target: 'destination:discord:ops' }]);
    expect(brains).toHaveLength(1);
    // Confirmed: the answer is retired, so no third boot re-posts it.
    expect(store.pendingPlatformDelivery(sessionId)).toBeUndefined();
  });

  it('never re-runs the model on a delivery retry: the envelope is consumed the moment the answer lands', async () => {
    const { store, spawn, sessionId, deps, park } = setup();
    const row = park(envelopeFor());
    deps.deliver = vi.fn(async () => { throw new Error('discord API POST → HTTP 500'); });

    await resumePlatformTurn(deps, row);

    // The two durable states are mutually exclusive: the promotion swapped the prompt inputs a model
    // turn would need for the finished text. There is nothing left to spend a turn on.
    expect(store.platformTurnEnvelope(sessionId)).toBeUndefined();
    expect(store.getSession(sessionId)!.parked_at).toBeNull();
    expect(store.pendingPlatformDelivery(sessionId)).toMatchObject({
      reply: 'resumed answer', target: 'destination:discord:ops',
      platform: 'discord', platformUserId: '42', accountUserId: 7, attempts: 1,
    });
    spawn.mockClear();

    // Two more boots, both failing to post: still not one further spawn.
    await resumePlatformTurn(deps, store.getSession(sessionId)!);
    await resumePlatformTurn(deps, store.getSession(sessionId)!);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('caps the delivery retries and then gives up VISIBLY instead of re-posting forever', async () => {
    const { store, brains, sessionId, delivered, deps, park } = setup();
    const row = park(envelopeFor());
    const failing = vi.fn(async () => { throw new Error('discord API POST → HTTP 500'); });
    deps.deliver = failing;

    // The boot that computes the answer posts once; each later boot spends exactly one more attempt.
    await expect(resumePlatformTurn(deps, row)).resolves.toBe('failed');
    for (let i = 1; i < MAX_PLATFORM_DELIVERY_ATTEMPTS; i += 1) {
      await expect(resumePlatformTurn(deps, store.getSession(sessionId)!)).resolves.toBe('failed');
    }
    expect(failing).toHaveBeenCalledTimes(MAX_PLATFORM_DELIVERY_ATTEMPTS);
    expect(store.pendingPlatformDelivery(sessionId)!.attempts).toBe(MAX_PLATFORM_DELIVERY_ATTEMPTS);

    // Past the cap the answer is durably given up on — and the room is TOLD, not left silent.
    deps.deliver = async (text, target) => { delivered.push({ text, target }); };
    await expect(resumePlatformTurn(deps, store.getSession(sessionId)!)).resolves.toBe('terminalized');
    expect(failing).toHaveBeenCalledTimes(MAX_PLATFORM_DELIVERY_ATTEMPTS);
    expect(store.pendingPlatformDelivery(sessionId)).toBeUndefined();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.text).toMatch(/re-send/);
    expect(delivered[0]!.text).not.toBe('resumed answer');
    // One model turn paid for, across the whole bounded retry sequence.
    expect(brains).toHaveLength(1);
  });

  it('a delivery retry re-proves the sender → account binding: a vanished account refuses to post', async () => {
    const { store, brains, sessionId, delivered, deps, park } = setup();
    const row = park(envelopeFor());
    deps.deliver = vi.fn(async () => { throw new Error('discord API POST → HTTP 500'); });
    await resumePlatformTurn(deps, row);
    expect(store.pendingPlatformDelivery(sessionId)).toBeDefined();

    // The account was deleted between the two boots. A pending answer must not become a back door
    // around the check the model path makes.
    deps.users.get = vi.fn(() => undefined) as never;
    deps.deliver = async (text, target) => { delivered.push({ text, target }); };

    await expect(resumePlatformTurn(deps, store.getSession(sessionId)!)).resolves.toBe('terminalized');

    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.text).toMatch(/could not be resumed/);
    expect(delivered[0]!.text).not.toBe('resumed answer');
    // Terminal — no later boot retries a binding that cannot come back.
    expect(store.pendingPlatformDelivery(sessionId)).toBeUndefined();
    expect(brains).toHaveLength(1);
  });

  it('a delivery retry refuses a platform identity that unlinked or was relinked to another account', async () => {
    for (const resolver of [() => null, () => ({ id: 9 })]) {
      const { store, sessionId, delivered, deps, park } = setup();
      const row = park(envelopeFor());
      deps.deliver = vi.fn(async () => { throw new Error('discord API POST → HTTP 500'); });
      await resumePlatformTurn(deps, row);

      deps.resolvePlatformUser = vi.fn(resolver);
      deps.deliver = async (text, target) => { delivered.push({ text, target }); };

      await expect(resumePlatformTurn(deps, store.getSession(sessionId)!)).resolves.toBe('terminalized');

      expect(delivered).toHaveLength(1);
      expect(delivered[0]!.text).toMatch(/could not be resumed/);
      expect(delivered[0]!.text).not.toBe('resumed answer');
      expect(store.pendingPlatformDelivery(sessionId)).toBeUndefined();
    }
  });

  it('an unavailable platform spends an attempt rather than posting or stranding the answer forever', async () => {
    const { store, sessionId, delivered, deps, park } = setup();
    const row = park(envelopeFor());
    deps.deliver = vi.fn(async () => { throw new Error('discord API POST → HTTP 500'); });
    await resumePlatformTurn(deps, row);

    // The Discord plugin is uninstalled before the next boot. Nothing can be posted — including the
    // give-up notice — but the retry must stay bounded rather than living on every future boot.
    deps.canDeliver = () => false;
    await expect(resumePlatformTurn(deps, store.getSession(sessionId)!)).resolves.toBe('failed');
    expect(store.pendingPlatformDelivery(sessionId)!.attempts).toBe(2);
    await expect(resumePlatformTurn(deps, store.getSession(sessionId)!)).resolves.toBe('failed');
    await expect(resumePlatformTurn(deps, store.getSession(sessionId)!)).resolves.toBe('terminalized');
    expect(store.pendingPlatformDelivery(sessionId)).toBeUndefined();
    expect(delivered).toHaveLength(0);
  });

  it('an uninstalled/unconnected platform fails closed: marker cleared, no turn, no crash', async () => {
    const { store, spawn, sessionId, delivered, deps, park } = setup();
    const row = park(envelopeFor());
    deps.canDeliver = () => false;

    await resumePlatformTurn(deps, row);

    expect(spawn).not.toHaveBeenCalled();
    expect(delivered).toHaveLength(0);
    expect(store.getSession(sessionId)!.parked_at).toBeNull();
    expect(store.platformTurnEnvelope(sessionId)).toBeUndefined();
  });

  it('gives up VISIBLY past the attempt cap instead of stacking resume turns forever', async () => {
    const { store, spawn, sessionId, delivered, deps, park } = setup();
    park(envelopeFor());
    for (let i = 0; i < MAX_PLATFORM_RESUME_ATTEMPTS; i += 1) store.claimParkResumeAttempt(sessionId);

    await resumePlatformTurn(deps, store.getSession(sessionId)!);

    expect(spawn).not.toHaveBeenCalled();
    expect(store.getSession(sessionId)!.parked_at).toBeNull();
    expect(store.platformTurnEnvelope(sessionId)).toBeUndefined();
    // The room itself is told — the platform twin of the owner sweep's phone push.
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.text).toMatch(/re-send/);
  });

  it('a failed resume turn keeps the marker (attempt counted durably) for the next boot', async () => {
    const { store, sessionId, delivered, deps, park } = setup();
    const row = park(envelopeFor());
    deps.send = vi.fn(async () => { throw new Error('provider is down'); });

    await resumePlatformTurn(deps, row);

    expect(delivered).toHaveLength(0);
    expect(store.getSession(sessionId)!.parked_at).not.toBeNull();
    expect(store.getSession(sessionId)!.park_attempts).toBe(1);
    expect(store.platformTurnEnvelope(sessionId)).toBeDefined();
  });

  it('clears an invariant-breach marker (owner/subagent/cron rows) without resuming', async () => {
    const { store, spawn, delivered, deps } = setup();
    const cronSession = channelSessionId('cron-job-9');
    store.createSession({ id: cronSession, userId: 1, model: 'kimi' });
    store.savePlatformTurnEnvelope(cronSession, JSON.stringify(envelopeFor('cron-job-9')));
    store.markSessionParked(cronSession);

    await resumePlatformTurn(deps, store.getSession(cronSession)!);

    expect(spawn).not.toHaveBeenCalled();
    expect(delivered).toHaveLength(0);
    expect(store.getSession(cronSession)!.parked_at).toBeNull();
  });
});

/** A resumed turn spends real model tokens, so it is opened exactly like the live turn it continues —
 *  driven here through the real BrainStore, the real ChannelSessionService and the real UsageOriginStore,
 *  because the defect this closes was never in the store: it was a turn that never reached it. */
describe('resumePlatformTurn — the resumed turn is billed and reported like the live turn it continues', () => {
  it('bills the PLATFORM origin to the writer account, not the room owner, and reports one feed row', async () => {
    const { store, sessionId, deps, park, billed, activity, usage } = setup();
    // The room belongs to account 1 (whoever opened it); the interrupted turn was written by account 7.
    const row = park(envelopeFor());
    expect(store.getSession(sessionId)!.user_id).toBe(1);

    await expect(resumePlatformTurn(deps, row)).resolves.toBe('resumed');

    expect(billed()).toEqual([[7, 'platform:discord', 1]]);
    // Actor and surface only — the feed is instance-wide, so nothing of the message may ride along.
    expect(activity).toEqual([{ actorUserId: 7, surface: 'discord', target: 'discord-ops' }]);
    // Consumed by the settling turn, so nothing is left pinned to this room.
    expect(usage.pinnedOrigin(sessionId)).toBeNull();
  });

  it('leaves no pin behind when the resume spends nothing — refused before, or inside, the send', async () => {
    let admits = true;
    const { sessionId, deps, park, billed, activity, usage } = setup('discord-ops', { admitsNewWork: () => admits });

    // (1) Refused before the model runs: the account vanished while the daemon was down. Nothing spent,
    //     so nothing may be billed or announced at all.
    deps.users.get = vi.fn(() => undefined) as never;
    await expect(resumePlatformTurn(deps, park(envelopeFor()))).resolves.toBe('terminalized');
    expect(usage.pinnedOrigin(sessionId)).toBeNull();
    expect(billed()).toEqual([]);
    expect(activity).toEqual([]);

    // (2) Refused INSIDE the send, after the turn was opened: this boot is already draining again, so
    //     the turn is rejected before its first provider request and the marker is kept for the next
    //     boot. The pin must go with it — a room is written by several people, and a pin stranded here
    //     would bill the next writer's whole turn to account 7.
    deps.users.get = vi.fn((id: number) => (id === 7 ? { id: 7 } : undefined)) as never;
    admits = false;
    await expect(resumePlatformTurn(deps, park(envelopeFor()))).resolves.toBe('failed');

    expect(usage.pinnedOrigin(sessionId)).toBeNull();
    expect(billed()).toEqual([]);
    // The turn was opened this time — it was about to run — so the feed reports it exactly once.
    expect(activity).toEqual([{ actorUserId: 7, surface: 'discord', target: 'discord-ops' }]);
  });

  it('does not bill or announce again on a boot that only RE-POSTS an answer already paid for', async () => {
    const { store, sessionId, delivered, deps, park, billed, activity, usage } = setup();
    const row = park(envelopeFor());
    deps.deliver = vi.fn(async () => { throw new Error('discord API POST → HTTP 500'); });

    // The boot that computes the answer pays for it, and reports it.
    await expect(resumePlatformTurn(deps, row)).resolves.toBe('failed');
    expect(billed()).toEqual([[7, 'platform:discord', 1]]);
    expect(activity).toHaveLength(1);

    // The next boot runs no model — it re-posts existing text. A second origin row would invent spend
    // that never happened, and a second feed row would report one exchange twice in a feed the whole
    // team reads; the boot that did the work already recorded both.
    deps.deliver = async (text, target) => { delivered.push({ text, target }); };
    await expect(resumePlatformTurn(deps, store.getSession(sessionId)!)).resolves.toBe('resumed');

    expect(delivered).toEqual([{ text: 'resumed answer', target: 'destination:discord:ops' }]);
    expect(billed()).toEqual([[7, 'platform:discord', 1]]);
    expect(activity).toHaveLength(1);
    expect(usage.pinnedOrigin(sessionId)).toBeNull();
  });
});
