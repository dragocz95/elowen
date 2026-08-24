import { describe, it, expect, vi } from 'vitest';
import {
  ChannelSessionService,
  normalizePlatformTurnEnvelope,
  resolvePlatformTurnAuthority,
  serializePlatformEnvelope,
  type PlatformTurnResumeEnvelope,
} from '../../src/brain/channels.js';
import { channelSessionId } from '../../src/brain/sessionId.js';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';
import { LiveEventReplay } from '../../src/brain/session/liveEventReplay.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { openDb } from '../../src/store/db.js';
import { CardRegistry } from '../../src/brain/cards.js';
import type { BrainEvent } from '../../src/brain/events.js';
import type { Policy } from '../../src/plugins/policy.js';

/** Same minimal fake LiveBrain the other channel suites use — only what send() touches. */
function fakeBrain(sessionId: string) {
  const messages: { role?: string; content?: unknown }[] = [];
  const session = {
    isStreaming: false,
    getContextUsage: () => ({ tokens: 50, contextWindow: 8000, percent: 1 }),
    messages,
    promptTemplates: [] as { name: string }[],
    prompt: vi.fn(async (t: string) => { messages.push({ role: 'assistant', content: `re: ${t}` }); }),
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
    listeners, replay: new LiveEventReplay(listeners), turnContext: () => ({ beforeUser: '', afterUser: '' }),
  };
}
type Brain = ReturnType<typeof fakeBrain>;

function setup(channelId = 'discord-envelope') {
  const store = new BrainStore(openDb(':memory:'));
  const registry = new LiveSessionRegistry<Brain>();
  const cards = new CardRegistry(() => store);
  const spawned: { extraAppend?: string[] }[] = [];
  const spawn = vi.fn(async (o: { sessionId: string; ownerUserId: number; extraAppend?: string[] }) => {
    spawned.push({ extraAppend: o.extraAppend });
    if (!store.getSession(o.sessionId)) {
      store.createSession({ id: o.sessionId, userId: o.ownerUserId, model: 'kimi' });
    }
    return fakeBrain(o.sessionId);
  });
  const svc = new ChannelSessionService({
    registry, store, cards, users: { get: () => ({ username: 'o' }) }, spawn,
  } as never);
  return { store, registry, svc, spawned, sessionId: channelSessionId(channelId) };
}

const anyPolicy: Policy = { allowedProjectIds: 'all' as const, allowedPaths: () => [] };

/** A validated shared-room turn from a linked sender, the richest ordinary platform shape. */
const sharedOpts = (channelId: string) => ({
  channelId,
  ownerUserId: 1,
  direct: false,
  policy: anyPolicy,
  promptAppend: ['Platform surface prompt.\n', 'You are talking on discord in #ops.\nOwner: o\n'],
  model: { provider: 'moonshot', model: 'kimi' },
  toolPolicy: { deny: new Set(['Bash', 'Write']) },
  identity: {
    platform: 'discord', userId: '42', elowenUserId: 7, elowenUsername: 'petra',
    admin: false, owner: false, conversation: 'shared' as const,
  },
  sender: { id: '42', name: 'Petra' },
  writerUserId: 7,
  historyPlatform: 'discord',
});

describe('platform turn resume envelope', () => {
  it('is durably captured before the model call and dropped once the turn settles', async () => {
    const { store, registry, svc, sessionId } = setup('discord-cap');
    const opts = sharedOpts('discord-cap');

    // Snapshot the durable row at the exact moment a process death would interrupt the turn.
    let midTurn: string | undefined;
    const spawnedBrain: Brain[] = [];
    (svc as unknown as { d: { spawn: (o: never) => Promise<Brain> } }).d.spawn = async (o: never) => {
      const b = fakeBrain(sessionId);
      const inner = b.session.prompt;
      b.session.prompt = vi.fn(async (t: string) => {
        midTurn = store.platformTurnEnvelope(sessionId);
        await inner(t);
      }) as Brain['session']['prompt'];
      spawnedBrain.push(b);
      if (!store.getSession((o as { sessionId: string }).sessionId)) {
        store.createSession({ id: (o as { sessionId: string }).sessionId, userId: 1, model: 'kimi' });
      }
      return b;
    };

    await svc.send(opts, 'kolik stojí barvení?');

    // Mid-turn: the row exists and round-trips through the validator with the exact captured facts.
    expect(midTurn).toBeDefined();
    const envelope = normalizePlatformTurnEnvelope(JSON.parse(midTurn!));
    expect(envelope).not.toBeNull();
    expect(envelope).toMatchObject({
      v: 1,
      platform: 'discord',
      channelId: 'discord-cap',
      ownerUserId: 1,
      direct: false,
      trusted: false,
      scheduled: false,
      accountUserId: 7,
      sender: { id: '42', name: 'Petra' },
      identity: {
        platform: 'discord', userId: '42', elowenUserId: 7, elowenUsername: 'petra',
        admin: false, owner: false, conversation: 'shared',
      },
      deniedTools: ['Bash', 'Write'],
      model: { provider: 'moonshot', model: 'kimi' },
      historyPlatform: 'discord',
      promptCommand: false,
      senderText: 'kolik stojí barvení?',
    });
    // Settled: nothing left to resume, the row is gone.
    expect(store.platformTurnEnvelope(sessionId)).toBeUndefined();
    expect(store.platformTurnEnvelopes()).toEqual([]);
    expect(registry.channelGet('discord-cap')).toBeDefined();
  });

  it('captures the prompt inputs verbatim: identical bytes to what the live turn used', async () => {
    const { store, svc, spawned, sessionId } = setup('discord-bytes');
    const opts = sharedOpts('discord-bytes');

    let midTurn: string | undefined;
    const origSave = store.savePlatformTurnEnvelope.bind(store);
    store.savePlatformTurnEnvelope = (id: string, envelope: string) => { midTurn = envelope; origSave(id, envelope); };

    await svc.send(opts, 'objednej mě na pátek');

    const envelope = normalizePlatformTurnEnvelope(JSON.parse(midTurn!))!;
    // The spawn-time prompt append and the captured one are the same bytes, element by element.
    expect(spawned[0]?.extraAppend).toBeDefined();
    expect(envelope.promptAppend).toStrictEqual(spawned[0]!.extraAppend);
    for (const [i, chunk] of envelope.promptAppend!.entries()) {
      expect(chunk === spawned[0]!.extraAppend![i]).toBe(true);
    }
    // The captured turn text is the exact serialized string the durable user row received — the same
    // bytes serializePlatformEnvelope produced for the live turn, attribution included.
    const userRow = store.getMessages(sessionId).find((m) => m.role === 'user')!;
    const persisted = JSON.parse(userRow.content) as { content: string };
    expect(envelope.turnText === persisted.content).toBe(true);
    expect(envelope.turnText).toBe(serializePlatformEnvelope({
      source: 'platform_message', untrusted: true, platform: 'discord',
      channelId: 'discord-bytes', author: { id: '42', name: 'Petra' }, text: 'objednej mě na pátek',
    }));
  });

  it('captures an unlinked shared sender with a null account (never someone else’s)', async () => {
    const { store, svc, sessionId } = setup('discord-unlinked');
    const opts = { ...sharedOpts('discord-unlinked') };
    delete (opts as { writerUserId?: number }).writerUserId;
    opts.identity = { ...opts.identity, elowenUserId: undefined as never, elowenUsername: undefined as never };

    let midTurn: string | undefined;
    const origSave = store.savePlatformTurnEnvelope.bind(store);
    store.savePlatformTurnEnvelope = (id: string, envelope: string) => { midTurn = envelope; origSave(id, envelope); };

    await svc.send(opts, 'hello');

    const envelope = normalizePlatformTurnEnvelope(JSON.parse(midTurn!))!;
    expect(envelope.accountUserId).toBeNull();
    expect(sessionId).toBe(channelSessionId('discord-unlinked'));
  });

  it('does not capture turns that are not ordinary platform turns', async () => {
    const { store, svc, sessionId } = setup('discord-nocap');
    const save = vi.spyOn(store, 'savePlatformTurnEnvelope');
    // No conversation classification (the pre-envelope harness shape): not an ordinary platform turn.
    await svc.send({
      channelId: 'discord-nocap', ownerUserId: 1, policy: anyPolicy, identity: { userId: 7 },
    } as never, 'plain');
    expect(save).not.toHaveBeenCalled();
    expect(store.platformTurnEnvelope(sessionId)).toBeUndefined();
  });

  it('reads sanely for a pre-upgrade session: no row, and malformed rows fail closed', () => {
    const { store } = setup();
    // A session that existed before this table shipped simply has no envelope row.
    store.createSession({ id: 'brain-ch-old', userId: 1, model: 'kimi' });
    expect(store.platformTurnEnvelope('brain-ch-old')).toBeUndefined();
    expect(store.platformTurnEnvelopes()).toEqual([]);
    // Durable JSON is validated on read: garbage, wrong versions and half-shapes are all null.
    expect(normalizePlatformTurnEnvelope(undefined)).toBeNull();
    expect(normalizePlatformTurnEnvelope('not an object')).toBeNull();
    expect(normalizePlatformTurnEnvelope({})).toBeNull();
    expect(normalizePlatformTurnEnvelope({ v: 2 })).toBeNull();
    const valid: PlatformTurnResumeEnvelope = {
      v: 1, platform: 'discord', channelId: 'discord-x', ownerUserId: 1,
      direct: false, trusted: false, scheduled: false, accountUserId: 7,
      identity: { platform: 'discord', userId: '42', admin: false, owner: false, conversation: 'shared' },
      promptCommand: false, turnText: 't', senderText: 't', capturedAt: '2026-08-24T00:00:00Z',
    };
    expect(normalizePlatformTurnEnvelope(JSON.parse(JSON.stringify(valid)))).toStrictEqual(valid);
    // An otherwise-valid envelope of an UNKNOWN version must fail closed, not parse best-effort.
    expect(normalizePlatformTurnEnvelope({ ...valid, v: 2 })).toBeNull();
    expect(normalizePlatformTurnEnvelope({ ...valid, identity: { ...valid.identity, conversation: 'delegated' } })).toBeNull();
    expect(normalizePlatformTurnEnvelope({ ...valid, accountUserId: 'seven' })).toBeNull();
    expect(normalizePlatformTurnEnvelope({ ...valid, promptAppend: ['ok', 7] })).toBeNull();
    expect(normalizePlatformTurnEnvelope({ ...valid, turnText: undefined })).toBeNull();
  });

  it('re-derives authority from the account and refuses when it cannot', () => {
    const envelope: PlatformTurnResumeEnvelope = {
      v: 1, platform: 'discord', channelId: 'discord-x', ownerUserId: 1,
      direct: false, trusted: true, scheduled: false, accountUserId: 7,
      identity: { platform: 'discord', userId: '42', admin: true, owner: false, conversation: 'shared' },
      deniedTools: ['Write'], promptCommand: false, turnText: 't', senderText: 't',
      capturedAt: '2026-08-24T00:00:00Z',
    };
    const accountPolicy: Policy = { allowedProjectIds: new Set([3]), allowedPaths: () => [] };
    const stillLinked = (platform: string, platformUserId: string) =>
      (platform === 'discord' && platformUserId === '42' ? { id: 7 } : null);

    // The happy path: the ACCOUNT's current policy — never the stored trusted/admin elevation — plus
    // the deny union of the account's fresh denies and the captured turn denies (narrow-only replay),
    // and the account's CURRENT allow grant, which a resume must carry or it would run wider than the
    // live turn ever could.
    const resolved = resolvePlatformTurnAuthority(envelope, {
      resolvePlatformUser: stillLinked,
      policyForUser: (id) => (id === 7 ? accountPolicy : undefined),
      toolAuthorityFor: () => ({ allow: ['Read', 'mcp__*'], deny: new Set(['Bash']) }),
    });
    expect(resolved.accountUserId).toBe(7);
    expect(resolved.policy).toBe(accountPolicy);
    expect([...resolved.toolPolicy!.deny!].sort()).toEqual(['Bash', 'Write']);
    expect([...resolved.toolPolicy!.allow!]).toEqual(['Read', 'mcp__*']);

    // A resumed turn whose account holds an EMPTY grant keeps that empty grant. This is the fail-closed
    // case and the one a replay must never quietly widen into "no allow list at all".
    const starved = resolvePlatformTurnAuthority(envelope, {
      resolvePlatformUser: stillLinked,
      policyForUser: (id) => (id === 7 ? accountPolicy : undefined),
      toolAuthorityFor: () => ({ allow: [], deny: new Set() }),
    });
    expect([...starved.toolPolicy!.allow!]).toEqual([]);

    // An account that no longer resolves REFUSES — no operator fallback, no ambient policy.
    expect(() => resolvePlatformTurnAuthority(envelope, {
      resolvePlatformUser: stillLinked,
      policyForUser: () => undefined,
      toolAuthorityFor: () => undefined,
    })).toThrow(/no longer resolves — refusing/);

    // A turn with no verified account was never resumable; the account resolver is not even consulted.
    const policyForUser = vi.fn(() => anyPolicy);
    expect(() => resolvePlatformTurnAuthority({ ...envelope, accountUserId: null }, {
      resolvePlatformUser: stillLinked,
      policyForUser,
      toolAuthorityFor: () => undefined,
    })).toThrow(/no verified account — refusing/);
    expect(policyForUser).not.toHaveBeenCalled();
  });

  it('re-proves the platform binding: an unlinked or relinked identity refuses before any policy is read', () => {
    const envelope: PlatformTurnResumeEnvelope = {
      v: 1, platform: 'discord', channelId: 'discord-x', ownerUserId: 1,
      direct: false, trusted: false, scheduled: false, accountUserId: 7,
      identity: { platform: 'discord', userId: '42', admin: false, owner: false, conversation: 'shared' },
      promptCommand: false, turnText: 't', senderText: 't', capturedAt: '2026-08-24T00:00:00Z',
    };
    // The captured account id is a stored CLAIM about who the platform sender was. The binding must be
    // re-proven at resume — unlinked (null) and relinked-to-another-account both refuse, and neither may
    // even consult the account's policy on the way out.
    const policyForUser = vi.fn(() => anyPolicy);
    const toolAuthorityFor = (): undefined => undefined;
    expect(() => resolvePlatformTurnAuthority(envelope, { resolvePlatformUser: () => null, policyForUser, toolAuthorityFor }))
      .toThrow(/no longer links to account 7 — refusing/);
    expect(() => resolvePlatformTurnAuthority(envelope, { resolvePlatformUser: () => ({ id: 9 }), policyForUser, toolAuthorityFor }))
      .toThrow(/no longer links to account 7 — refusing/);
    expect(policyForUser).not.toHaveBeenCalled();
    // The binding is looked up by the envelope's OWN platform identity, not anything wider.
    const resolvePlatformUser = vi.fn((platform: string, platformUserId: string) =>
      (platform === 'discord' && platformUserId === '42' ? { id: 7 } : null));
    expect(resolvePlatformTurnAuthority(envelope, { resolvePlatformUser, policyForUser, toolAuthorityFor }).accountUserId).toBe(7);
    expect(resolvePlatformUser).toHaveBeenCalledWith('discord', '42');
  });
});
