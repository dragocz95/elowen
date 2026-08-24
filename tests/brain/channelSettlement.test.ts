import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { ChannelSessionService } from '../../src/brain/channels.js';
import { channelSessionId } from '../../src/brain/sessionId.js';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';
import { LiveEventReplay } from '../../src/brain/session/liveEventReplay.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { UsageOriginStore } from '../../src/store/usageOriginStore.js';
import { openDb } from '../../src/store/db.js';
import { CardRegistry } from '../../src/brain/cards.js';
import { platformOrigin } from '../../src/api/clientIp.js';
import type { BrainEvent } from '../../src/brain/events.js';

/** Everything a room turn does BESIDES answering, asserted against a REAL BrainStore.
 *
 *  A mocked channel service proves only what the orchestrator SENDS, not what lands in the database, and
 *  that gap is exactly what hid the room-ownership rollover bug. Every assertion here reads the row back. */

function fakeBrain(sessionId: string) {
  const messages: { role?: string; content?: unknown }[] = [];
  const session = {
    isStreaming: false,
    isCompacting: false,
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
    lastRequestCacheTtlMs: undefined as number | undefined,
    listeners, replay: new LiveEventReplay(listeners), turnContext: () => ({ beforeUser: '', afterUser: '' }),
  };
}
type Brain = ReturnType<typeof fakeBrain>;

function setup(deps: Record<string, unknown> = {}, channelId = 'discord-settle') {
  const store = new BrainStore(openDb(':memory:'));
  const registry = new LiveSessionRegistry<Brain>();
  const cards = new CardRegistry(() => store);
  const spawn = vi.fn(async (o: { sessionId: string; ownerUserId: number }) => {
    if (!store.getSession(o.sessionId)) {
      store.createSession({ id: o.sessionId, userId: o.ownerUserId, model: 'kimi' });
    }
    return fakeBrain(o.sessionId);
  });
  const svc = new ChannelSessionService({
    registry, store, cards, users: { get: () => ({ username: 'o' }) }, spawn, ...deps,
  } as never);
  const sessionId = channelSessionId(channelId);
  // The room is OWNED by account 1 and WRITTEN by account 2 — the case every effect below turns on.
  const opts = {
    channelId, ownerUserId: 1, writerUserId: 2,
    policy: { allowedProjectIds: 'all' as const, allowedPaths: () => [] },
    identity: { userId: 7 },
  };
  return { store, registry, svc, sessionId, opts };
}

describe('a room turn settles like an owner turn', () => {
  it('records the WRITER as the last writer, not the account that owns the room', async () => {
    const { store, svc, sessionId, opts } = setup();

    await svc.send(opts, 'hello there');

    const row = store.getSession(sessionId)!;
    expect(row.user_id).toBe(1);            // the room still belongs to whoever opened it…
    expect(row.last_writer_user_id).toBe(2); // …and the register names who actually wrote in it
  });

  it('names a brand-new room from the sender\'s own words and never renames it afterwards', async () => {
    const { store, svc, sessionId, opts } = setup();

    await svc.send(opts, 'when does the shop open');
    expect(store.getSession(sessionId)!.title).toBe('when does the shop open');

    await svc.send(opts, 'and when does it close');
    expect(store.getSession(sessionId)!.title).toBe('when does the shop open');
  });

  it('curates the exchange into the WRITER\'s memory, gated by their own auto-save', async () => {
    const curator = { run: vi.fn(async () => {}) };
    const { svc, opts } = setup({ curator, userSettings: () => ({ autoSave: true }) });

    await svc.send(opts, 'remember I use pnpm');

    expect(curator.run).toHaveBeenCalledWith(2, 'remember I use pnpm', 're: remember I use pnpm');
  });

  it('leaves memory alone when the writer switched auto-save off', async () => {
    const curator = { run: vi.fn(async () => {}) };
    const { svc, opts } = setup({ curator, userSettings: () => ({ autoSave: false }) });

    await svc.send(opts, 'do not remember this');

    expect(curator.run).not.toHaveBeenCalled();
  });

  // A CreateSkill issued from Discord wrote a skill to disk and then silently never applied it: the owner
  // surface drained the reload after its turn and no room ever did.
  it('drains a plugin reload a tool requested during the turn', async () => {
    const drainPluginReload = vi.fn();
    const { svc, opts } = setup({ drainPluginReload });

    await svc.send(opts, 'create a skill');

    expect(drainPluginReload).toHaveBeenCalledOnce();
  });

  it('settles the turn AFTER the answer, so the reload cannot dispose the session mid-turn', async () => {
    const order: string[] = [];
    const drainPluginReload = vi.fn(() => { order.push('drain'); });
    const curator = { run: vi.fn(async () => {}) };
    const { svc, opts, registry } = setup({ drainPluginReload, curator, userSettings: () => ({}) });

    await svc.send(opts, 'go');
    registry.channelGet('discord-settle')!.session.prompt.mock.calls.forEach(() => order.unshift('prompt'));

    expect(order).toEqual(['prompt', 'drain']);
  });
});

// A room is where an expensive cold context actually accumulates — a cron channel keeps one conversation
// for weeks — and the trigger existed only for the owner chat.
describe('a room compacts a provably cold context before paying to re-cache it', () => {
  /** One channel turn against a session whose last message is `ageMs` old, with the assessment wired. */
  const runAged = async (aged: string, eligible: boolean) => {
    const compact = vi.fn(async () => {});
    let brain!: Brain;
    const store = new BrainStore(openDb(':memory:'));
    const registry = new LiveSessionRegistry<Brain>();
    const cards = new CardRegistry(() => store);
    const svc = new ChannelSessionService({
      registry, store, cards, users: { get: () => ({ username: 'o' }) },
      spawn: async (o: { sessionId: string; ownerUserId: number }) => {
        if (!store.getSession(o.sessionId)) store.createSession({ id: o.sessionId, userId: o.ownerUserId, model: 'kimi' });
        brain = fakeBrain(o.sessionId);
        Object.assign(brain.session, { compact });
        Object.assign(brain, {
          assessColdCompaction: () => (eligible
            ? { eligible: true, contextTokens: 500_000, floorTokens: 40_000 }
            : { eligible: false, reason: 'auto-compact-off' }),
        });
        return brain;
      },
    } as never);
    const opts = {
      // Rollover would otherwise archive the room long before the cache gate opens; a cron channel that
      // must keep continuity across runs disables it exactly like this, which is where this bites.
      channelId: 'cron-aged', ownerUserId: 1, idleRolloverMs: Infinity,
      policy: { allowedProjectIds: 'all' as const, allowedPaths: () => [] },
      identity: { userId: 7 },
    };
    await svc.send(opts, 'first');
    // Age the transcript past (or not past) the gate — the longest cache TTL pi-ai uses, plus its buffer.
    store.db.prepare(`UPDATE brain_messages SET created_at = datetime('now', ?)`).run(aged);
    await svc.send(opts, 'second');
    return compact;
  };

  it('compacts at the start of the turn that follows an expired prompt cache', async () => {
    expect(await runAged('-3 hours', true)).toHaveBeenCalledOnce();
  });

  it('leaves a warm context alone', async () => {
    expect(await runAged('-1 minute', true)).not.toHaveBeenCalled();
  });

  it('respects the session\'s own auto-compact verdict rather than compacting on age alone', async () => {
    expect(await runAged('-3 hours', false)).not.toHaveBeenCalled();
  });
});

describe('room spend is attributed to the person who wrote the turn', () => {
  // The whole reason this phase exists. `usage_by_origin` is a WRITE-TIME rollup: the pin is set before
  // the turn and consumed as it settles, and the answer is NEVER recovered by querying brain_messages,
  // which carries no origin at all.
  it('bills a non-owner\'s room turn to that non-owner, under the platform', () => {
    const db = openDb(':memory:');
    const usage = new UsageOriginStore(db);
    const at = Date.UTC(2026, 7, 24, 10, 0);

    // The orchestrator pins the WRITER (account 2) before handing the turn to the channel service…
    usage.recordRequest('brain-ch-discord-c1', 2, platformOrigin('discord'), at);
    // …and the daemon settles it. `userId` is what the settle carries, so the room's owner (account 1) is
    // used only when nobody was identified at all.
    const pin = usage.settleTurn('brain-ch-discord-c1');
    expect(pin).toEqual({ origin: platformOrigin('discord'), userId: 2 });

    usage.addTurn(pin.userId ?? 1, pin.origin, {
      input: 900, output: 100, cacheRead: 0, cacheWrite: 0, total: 1000, cost: 0.5,
    }, at);

    expect(usage.topOrigins({ group: 'pair' }).map((r) => [r.userId, r.origin, r.tokens, r.cost]))
      .toEqual([[2, 'platform:discord', 1000, 0.5]]);
  });
});

describe('the settlement contract', () => {
  const read = (file: string): string => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf-8');

  // A surface that carries fewer effects must do it by passing fewer arguments, never by keeping a second
  // copy — that is how the owner chat and the room drifted into curating different text, titling from
  // different input, and (for four of the six effects) one of them not doing it at all.
  it('is the only module either surface settles a turn through', () => {
    for (const file of ['src/brain/channels.ts', 'src/brain/service/turnRunner.ts']) {
      expect(read(file), `${file} must settle through the shared helper`).toContain('settleTurn(');
    }
    for (const file of ['src/brain/platforms.ts', 'src/brain/service/turnRunner.ts', 'src/api/routes/brainRouteContext.ts']) {
      expect(read(file), `${file} must open a turn through the shared helper`).toContain('openTurn(');
    }
    for (const file of ['src/brain/channels.ts', 'src/brain/service/turnAdmission.ts']) {
      expect(read(file), `${file} must title through the shared helper`).toContain('titleTurnConversation(');
    }
  });

  it('leaves no second copy of an absorbed effect on either surface', () => {
    const settled = read('src/brain/session/turnSettled.ts');
    // The origin pin: one caller of the store's write side, and it is this module.
    for (const file of [
      'src/brain/channels.ts', 'src/brain/platforms.ts', 'src/brain/service/turnRunner.ts',
      'src/api/routes/brainRouteContext.ts', 'src/api/routes/brainChat.ts',
    ]) {
      expect(read(file), `${file} pins an origin of its own`).not.toContain('recordRequest(');
    }
    expect(settled).toContain('recordRequest(');

    // The curator, the writer stamp and the provisional title likewise.
    for (const file of ['src/brain/channels.ts', 'src/brain/service/turnRunner.ts']) {
      const source = read(file);
      expect(source, `${file} runs the curator itself`).not.toMatch(/curator\.run\(/);
      expect(source, `${file} stamps the writer itself`).not.toContain('setLastWriter(');
    }
    for (const file of ['src/brain/channels.ts', 'src/brain/service/turnAdmission.ts']) {
      expect(read(file), `${file} writes a title of its own`).not.toContain('setTitle(');
    }
    expect(settled).toMatch(/curator\.run\(/);
    expect(settled).toContain('setLastWriter(');
    expect(settled).toContain('setTitle(');

    // The team feed left the HTTP layer entirely, so an owner turn that never arrives over HTTP is not
    // invisible in it.
    expect(read('src/api/routes/brainChat.ts'), 'the send route still publishes its own feed row')
      .not.toContain("type: 'activity'");
  });

  // Owner-only effects are expressed as ABSENT arguments, not as a surface check. A branch on the surface
  // is the shape that lets the two drift again.
  it('keeps owner-only effects out of the room by omission, never by a surface branch', () => {
    const channels = read('src/brain/channels.ts');
    expect(channels).toContain("// `notify` is owner-only and therefore absent");
    for (const file of ['src/brain/channels.ts', 'src/brain/platforms.ts', 'src/brain/service/turnRunner.ts']) {
      expect(read(file), `${file} branches on the surface instead of omitting an argument`)
        .not.toMatch(/surface\s*===/);
    }
  });
});
