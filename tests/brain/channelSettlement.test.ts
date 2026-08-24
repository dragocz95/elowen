import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
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

function fakeBrain(sessionId: string, providerFails = false) {
  const messages: { role?: string; content?: unknown; stopReason?: string; errorMessage?: string }[] = [];
  const session = {
    isStreaming: false,
    isCompacting: false,
    getContextUsage: () => ({ tokens: 50, contextWindow: 8000, percent: 1 }),
    messages,
    promptTemplates: [] as { name: string }[],
    // PI RESOLVES prompt() on a provider error — the turn settles with an empty errored assistant, and the
    // channel service turns that into a throw. That is the ordinary failure shape, not an exotic one.
    prompt: vi.fn(async (t: string) => {
      messages.push(providerFails
        ? { role: 'assistant', content: '', stopReason: 'error', errorMessage: '' }
        : { role: 'assistant', content: `re: ${t}` });
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
    lastRequestCacheTtlMs: undefined as number | undefined,
    listeners, replay: new LiveEventReplay(listeners), turnContext: () => ({ beforeUser: '', afterUser: '' }),
  };
}
type Brain = ReturnType<typeof fakeBrain>;

function setup(deps: Record<string, unknown> = {}, channelId = 'discord-settle', providerFails = false) {
  const store = new BrainStore(openDb(':memory:'));
  const registry = new LiveSessionRegistry<Brain>();
  const cards = new CardRegistry(() => store);
  const spawn = vi.fn(async (o: { sessionId: string; ownerUserId: number }) => {
    if (!store.getSession(o.sessionId)) {
      store.createSession({ id: o.sessionId, userId: o.ownerUserId, model: 'kimi' });
    }
    return fakeBrain(o.sessionId, providerFails);
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

  // A turn that THROWS is still a turn that happened. Settling on the happy path meant a CreateSkill
  // issued from Discord in a turn whose final assistant errored wrote its skill to disk and the reload was
  // never drained — the exact defect the shared settlement exists to close — and the register lost the
  // writer for that message too.
  it('settles a turn the provider failed, so the skill it wrote is still applied', async () => {
    const drainPluginReload = vi.fn();
    const curator = { run: vi.fn(async () => {}) };
    const { store, svc, sessionId, opts } = setup(
      { drainPluginReload, curator, userSettings: () => ({}) }, 'discord-settle', true,
    );

    await expect(svc.send(opts, 'create a skill')).rejects.toThrow('the model returned no reply (provider error)');

    expect(drainPluginReload).toHaveBeenCalledOnce();
    expect(store.getSession(sessionId)!.last_writer_user_id).toBe(2);
    // …but a failed exchange stays out of the writer's memory, exactly as on the owner surface.
    expect(curator.run).not.toHaveBeenCalled();
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

// ---------------------------------------------------------------------------------------------------
// Mechanical contract: one settlement, no second copies, nothing that can drift.
//
// Every set below is DERIVED from the source rather than hand-listed, so a surface added next year is in
// the check by construction. The predecessor walked literal file arrays and matched substrings a comment
// could satisfy — it passed while three of the defects these tests now cover were sitting in the files it
// named. A check that a comment satisfies proves nothing.
// ---------------------------------------------------------------------------------------------------

const SRC = new URL('../../src/', import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

/** Comments discuss these effects constantly (and should). Only real CODE counts. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const modules = (): { path: string; code: string }[] => sourceFiles(SRC)
  .map((path) => ({ path: path.slice(SRC.length), code: stripComments(readFileSync(path, 'utf-8')) }));

/** The bodies of every `finally` block in `code`, brace-matched. Regex cannot answer "is this call in a
 *  finally", and that question is the entire contract for two of the effects here: settling on the happy
 *  path is what let a failed turn skip the writer stamp and the plugin-reload drain. */
function finallyBlocks(code: string): string[] {
  const blocks: string[] = [];
  const opener = /\bfinally\s*\{/g;
  for (let match = opener.exec(code); match; match = opener.exec(code)) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    for (; i < code.length && depth > 0; i++) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}') depth--;
    }
    blocks.push(code.slice(start, i - 1));
  }
  return blocks;
}

/** Names the symbol at all — as a call, through a bracket lookup (`store['recordRequest']`), or in a
 *  one-line wrapper. Deliberately stronger than matching `name(`: `recordRequest (`, the bracket form and
 *  a re-export all defeated that, and every one of them is a second copy of the effect. */
const names = (symbol: string): RegExp => new RegExp(`\\b${symbol}\\b`);

/** The module that DEFINES the three entry points. It names every one of them by construction, so it is
 *  never one of the surfaces a contract about callers is asking about. */
const DEFINER = 'brain/session/turnSettled.ts';

describe('the settlement contract', () => {
  // A surface that carries fewer effects must do it by passing fewer arguments, never by keeping a second
  // copy — that is how the owner chat and the room drifted into curating different text, titling from
  // different input, and (for four of the six effects) one of them not doing it at all.
  //
  // Each effect names the modules genuinely entitled to it: the storage layer that implements the write,
  // and the ONE module that decides when it happens.
  const EFFECTS: { effect: string; match: RegExp; owners: string[] }[] = [
    { effect: 'the origin pin', match: names('recordRequest'), owners: ['store/usageOriginStore.ts', 'brain/session/turnSettled.ts'] },
    { effect: 'the writer stamp', match: names('setLastWriter'), owners: ['store/brainStore.ts', 'brain/session/turnSettled.ts'] },
    // The factory is a genuine second writer of a DIFFERENT thing: a session spawned with an explicit
    // title (an archived branch, a restored transcript) is not a turn naming its conversation.
    { effect: 'the provisional title', match: names('setTitle'), owners: ['store/brainStore.ts', 'brain/session/turnSettled.ts', 'brain/session/factory.ts'] },
    { effect: 'the memory curator', match: /\bcurator\b[!?]?(?:\?\.)?\.\s*run\s*\(|\bcurator\b[^\n]{0,24}\[\s*['"`]run['"`]\s*\]/, owners: ['brain/session/turnSettled.ts'] },
  ];

  it.each(EFFECTS)('$effect is performed in exactly one place', ({ effect, match, owners }) => {
    const holders = modules().filter(({ code }) => match.test(code)).map(({ path }) => path).sort();
    // A rename that stopped matching would leave an empty set quietly passing.
    expect(holders, `${effect} seems to have been renamed — this check matches nothing`).not.toEqual([]);
    expect(holders, `${effect} has a second implementation`).toEqual([...owners].sort());
  });

  it('every turn surface settles through the shared helper, in a finally', () => {
    const surfaces = modules()
      .filter(({ path }) => path !== DEFINER)
      .filter(({ code }) => /\bsettleTurn\s*\(/.test(code));
    expect(surfaces.map((m) => m.path).sort(), 'the surfaces this contract covers')
      .toEqual(['brain/channels.ts', 'brain/service/turnRunner.ts', 'store/usageOriginStore.ts']);
    // The two that RUN a turn must settle it on every exit. A turn that throws is still a turn that
    // happened: it may have written a skill to disk, and somebody did write in the room.
    const running = surfaces.filter((m) => m.path !== 'store/usageOriginStore.ts');
    const offenders = running
      .filter(({ code }) => !finallyBlocks(code).some((block) => /\bsettleTurn\s*\(/.test(block)))
      .map(({ path }) => path);
    expect(offenders, 'a turn settled only on the happy path skips everything when it throws').toEqual([]);
  });

  it('every surface that opens a turn releases it, in a finally', () => {
    const openers = modules()
      .filter(({ path }) => path !== DEFINER)
      .filter(({ code }) => /\bopenTurn\s*\(/.test(code));
    expect(openers.map((m) => m.path).sort(), 'the surfaces that open a turn')
      .toEqual(['api/routes/brainRouteContext.ts', 'brain/platforms.ts', 'brain/service/turnRunner.ts']);
    // A surface that HOLDS the handle owns the pin's lifetime and must give it back on every exit —
    // otherwise the next writer in a shared room is refused a pin and their turn is billed to the
    // previous person. The route layer deliberately does not hold one: it pins a conversation for an
    // operation the brain runs later, so there is no turn here to close.
    const holders = openers.filter(({ code }) => /=\s*openTurn\s*\(/.test(code));
    expect(holders.map((m) => m.path).sort()).toEqual(['brain/platforms.ts', 'brain/service/turnRunner.ts']);
    const offenders = holders
      .filter(({ code }) => !finallyBlocks(code).some((block) => /\.close\s*\(\)/.test(block)))
      .map(({ path }) => path);
    expect(offenders, 'a pin released only on the happy path outlives the turn that set it').toEqual([]);
  });

  it('titles a conversation through the shared helper on both surfaces', () => {
    const titlers = modules()
      .filter(({ path }) => path !== DEFINER)
      .filter(({ code }) => /\btitleTurnConversation\s*\(/.test(code))
      .map(({ path }) => path).sort();
    expect(titlers).toEqual(['brain/channels.ts', 'brain/service/turnAdmission.ts']);
  });

  it('leaves the team feed out of the HTTP layer, so a turn that never arrives over HTTP is still in it', () => {
    const source = stripComments(readFileSync(join(SRC, 'api/routes/brainChat.ts'), 'utf-8'));
    expect(source, 'the send route still publishes its own feed row').not.toMatch(/type:\s*'activity'/);
  });

  // Owner-only effects are expressed as ABSENT arguments, not as a surface check. A branch on the surface
  // is the shape that lets the two drift again.
  it('keeps owner-only effects out of the room by omission, never by a surface branch', () => {
    const channels = stripComments(readFileSync(join(SRC, 'brain/channels.ts'), 'utf-8'));
    // Asserted against the CODE, not against a comment claiming it: the predecessor checked for the
    // sentence "notify is owner-only and therefore absent", which would have passed just as happily with
    // `notify` actually being passed one line below it.
    expect(channels, 'a room pushes a notification of its own').not.toMatch(/\bnotify\b/);
    // Both directions of the comparison and the `switch` form: the shape is what is banned, not one
    // spelling of it.
    const SURFACE_REF = String.raw`(?:\w+[.!?]*\.)*\w*[Ss]urface\w*\b`;
    const BRANCHES_ON_SURFACE = new RegExp(
      String.raw`\b${SURFACE_REF}\s*[!=]==?\s*['"\`]` // surface === 'web'
      + String.raw`|['"\`][^'"\`\n]*['"\`]\s*[!=]==?\s*${SURFACE_REF}` // 'web' === surface
      + String.raw`|\bswitch\s*\([^)]*[Ss]urface`, // switch (surface)
    );
    const offenders = modules()
      .filter(({ code }) => /\b(?:settleTurn|openTurn)\s*\(/.test(code))
      .filter(({ code }) => BRANCHES_ON_SURFACE.test(code))
      .map(({ path }) => path);
    expect(offenders, 'a settling surface branches on the surface instead of omitting an argument').toEqual([]);
  });
});
