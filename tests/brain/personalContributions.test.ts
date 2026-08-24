import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { openDb } from '../../src/store/db.js';
import { UserStore } from '../../src/store/userStore.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { toolAuthorityForUser } from '../../src/brain/brainDeps.js';
import type { BrainDeps } from '../../src/brain/brainDeps.js';
import { composeSessionTools, visibleToolNames } from '../../src/brain/session/capabilities.js';
import { runWithPolicy, type ToolPolicy } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import { ChannelSessionService } from '../../src/brain/channels.js';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';
import { LiveEventReplay } from '../../src/brain/session/liveEventReplay.js';
import { CardRegistry } from '../../src/brain/cards.js';
import { channelSessionId } from '../../src/brain/sessionId.js';
import { delegatedChannelSendOpts } from '../../src/brain/delegatedTurn.js';
import { IdentityResolver } from '../../src/brain/identity.js';
import type { BrainEvent } from '../../src/brain/events.js';

const POLICY: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };

/** A plugin tool that records whether it actually ran — "refused" and "ran and returned nothing" look
 *  identical from the result alone, and only one of them is a security guarantee. */
function plugin(name: string): { tool: ToolDefinition; ran: () => number } {
  let runs = 0;
  return {
    ran: () => runs,
    tool: {
      name, label: name, description: name, parameters: {} as never,
      execute: async () => { runs++; return { content: [{ type: 'text', text: `ran ${name}` }], details: {} }; },
    } as unknown as ToolDefinition,
  };
}

/** A registry holding one instance tool plus one PERSONAL tool per account — the real shape the mcp plugin
 *  produces (`mcp__<server>__<tool>`, registered with the owning account's id). */
function registryWith(personal: { name: string; ownerUserId: number }[], instance: string[] = ['Read']): PluginRegistry {
  const registry = new PluginRegistry();
  for (const name of instance) {
    registry.tools.push(plugin(name).tool);
    registry.toolOwnerUsers.push(null);
    registry.toolOwner.set(name, 'files');
  }
  for (const { name, ownerUserId } of personal) {
    registry.tools.push(plugin(name).tool);
    registry.toolOwnerUsers.push(ownerUserId);
    registry.toolOwner.set(name, 'mcp');
  }
  return registry;
}

// ---------------------------------------------------------------------------------------------------
// 1. Composition: a room carries everybody's personal tools, because it can carry them at no other time.
// ---------------------------------------------------------------------------------------------------

describe('a shared room composes every account\'s owner-scoped tools', () => {
  it('carries them only with allOwners, and reports who each one belongs to', () => {
    const registry = registryWith([
      { name: 'mcp__amy__echo', ownerUserId: 2 },
      { name: 'mcp__bob__echo', ownerUserId: 3 },
    ]);

    // What a room used to get: the instance set, and a colleague's server simply did not exist there.
    expect(registry.toolsFor(null, null, { grantsEnforcedPerTurn: true }).map((t) => t.name))
      .toEqual(['Read']);

    expect(registry.toolsFor(null, null, { grantsEnforcedPerTurn: true, allOwners: true }).map((t) => t.name))
      .toEqual(['Read', 'mcp__amy__echo', 'mcp__bob__echo']);
    expect([...registry.sharedRoomToolOwners()]).toEqual([['mcp__amy__echo', 2], ['mcp__bob__echo', 3]]);
  });

  // One registered definition per name is all PI has. Two accounts whose personal servers share a name
  // cannot both be served from it, and picking one would run somebody else's server under this writer.
  it('drops a name two accounts both claim, rather than picking one of them', () => {
    const registry = registryWith([
      { name: 'mcp__github__list', ownerUserId: 2 },
      { name: 'mcp__github__list', ownerUserId: 3 },
      { name: 'mcp__amy__echo', ownerUserId: 2 },
    ]);

    const composed = registry.toolsFor(null, null, { allOwners: true }).map((t) => t.name);
    expect(composed).not.toContain('mcp__github__list');
    expect(composed).toContain('mcp__amy__echo');
    expect(registry.sharedRoomToolOwners().has('mcp__github__list')).toBe(false);
    // …and each of them still has it in their OWN chat, where the session has a single owner.
    expect(registry.toolsFor(2, null).map((t) => t.name)).toContain('mcp__github__list');
  });

  it('lets an instance-wide definition of the same name keep serving everybody', () => {
    const registry = registryWith([{ name: 'Read', ownerUserId: 2 }], ['Read']);
    expect(registry.sharedRoomToolOwners().has('Read')).toBe(false);
    expect(registry.toolsFor(null, null, { allOwners: true }).map((t) => t.name)).toEqual(['Read']);
  });
});

// ---------------------------------------------------------------------------------------------------
// 2. THE security property: a personal tool is still only what its owner's grant allows.
// ---------------------------------------------------------------------------------------------------

describe('a writer\'s personal tools never exceed that writer\'s grant', () => {
  const accounts = (): { users: UserStore; amy: number; bob: number; deps: Pick<BrainDeps, 'users' | 'plugins'> } => {
    const users = new UserStore(openDb(':memory:'));
    users.create('operator', 'pw'); // account 1 is the admin — nobody here
    const amy = users.create('amy', 'pw').id;
    const bob = users.create('bob', 'pw').id;
    const registry = registryWith([
      { name: 'mcp__amy__echo', ownerUserId: amy },
      { name: 'mcp__bob__echo', ownerUserId: bob },
    ]);
    return {
      users, amy, bob,
      deps: {
        users: users as unknown as BrainDeps['users'],
        plugins: { peek: () => registry } as unknown as BrainDeps['plugins'],
      },
    };
  };

  const roomTools = (registry: PluginRegistry): {
    tools: ToolDefinition[];
    owners: ReadonlyMap<string, number>;
    call: (name: string, tp: ToolPolicy | undefined, contributionUserId: number | null) => Promise<string>;
  } => {
    const owners = registry.sharedRoomToolOwners();
    const tools = composeSessionTools({
      kind: 'foreign-channel',
      pluginTools: registry.toolsFor(null, null, { grantsEnforcedPerTurn: true, allOwners: true }),
      personalToolOwners: owners,
    });
    return {
      tools, owners,
      call: async (name, tp, contributionUserId) => {
        const tool = tools.find((t) => t.name === name)!;
        const out = await runWithPolicy(
          POLICY,
          () => tool.execute('c1', {} as never, undefined, undefined, {} as never) as Promise<{ content: { text: string }[] }>,
          { toolPolicy: tp, contributionUserId },
        );
        return out.content[0]!.text;
      },
    };
  };

  it('refuses the writer\'s own personal tool when their grant does not cover it', async () => {
    const { users, amy, deps } = accounts();
    users.setAllowedTools(amy, ['Read']); // an admin granted Read and nothing else
    const registry = deps.plugins!.peek()!;
    const room = roomTools(registry);
    const grant = toolAuthorityForUser(deps, amy);

    // Not offered…
    expect(visibleToolNames(room.tools.map((t) => t.name), new Set(room.tools.map((t) => t.name)), grant,
      { owners: room.owners, contributionUserId: amy }))
      .toEqual(['Read']);
    // …and refused if the model names it anyway, which is the half that is actually a boundary.
    expect(await room.call('mcp__amy__echo', grant, amy)).toContain('not available to you');
  });

  it('offers it the moment the admin grants it, including through a wildcard', async () => {
    const { users, amy, deps } = accounts();
    const registry = deps.plugins!.peek()!;
    const room = roomTools(registry);

    users.setAllowedTools(amy, ['Read', 'mcp__amy__echo']);
    expect(await room.call('mcp__amy__echo', toolAuthorityForUser(deps, amy), amy)).toBe('ran mcp__amy__echo');

    // A bridged MCP family can only be named by a pattern — its members exist at runtime. An intersection
    // written with Set.has/Array.includes answers "no" here, and that exact mistake has shipped six times.
    users.setAllowedTools(amy, ['mcp__*']);
    const wildcard = toolAuthorityForUser(deps, amy);
    expect(visibleToolNames(room.tools.map((t) => t.name), new Set(room.tools.map((t) => t.name)), wildcard,
      { owners: room.owners, contributionUserId: amy }))
      .toEqual(['mcp__amy__echo']);
    expect(await room.call('mcp__amy__echo', wildcard, amy)).toBe('ran mcp__amy__echo');
  });

  // The other half of the same guarantee: a grant is not ownership. Bob may hold a wildcard that covers
  // the NAME of Amy's server; the tool still belongs to her account and her turn.
  it('never lets a grant reach another account\'s personal tool', async () => {
    const { users, bob, deps } = accounts();
    users.setAllowedTools(bob, ['mcp__*', 'Read']);
    const registry = deps.plugins!.peek()!;
    const room = roomTools(registry);
    const grant = toolAuthorityForUser(deps, bob);

    // Amy's server is not even NAMED to Bob: in a room the name is itself private.
    expect(visibleToolNames(room.tools.map((t) => t.name), new Set(room.tools.map((t) => t.name)), grant,
      { owners: room.owners, contributionUserId: bob }))
      .toEqual(['Read', 'mcp__bob__echo']);
    expect(await room.call('mcp__amy__echo', grant, bob)).toContain('belongs to another account');
    // An admin bypasses the GRANT (toolAuthorityForUser returns no allow-list) and still does not own it.
    expect(await room.call('mcp__amy__echo', undefined, 1)).toContain('belongs to another account');
    // Nor does an unlinked sender, a cron job, or anything else with no account behind it.
    expect(await room.call('mcp__amy__echo', undefined, null)).toContain('belongs to another account');
    // And the tool Bob does own still runs, so the gate above is not simply refusing everything.
    expect(await room.call('mcp__bob__echo', grant, bob)).toBe('ran mcp__bob__echo');
  });
});

// ---------------------------------------------------------------------------------------------------
// 3. The room turn itself, against a real BrainStore — what the WRITER's turn actually gets.
// ---------------------------------------------------------------------------------------------------

const skill = (name: string, ownerUserId: number | null): { name: string; ownerUserId: number | null } =>
  ({ name, ownerUserId });

/** A channel service over a real store whose spawn composes the room the way the spawner does: the
 *  instance set plus every account's personal tools, with the ownership map the live carries. */
function room(opts: {
  skills: { name: string; ownerUserId: number | null }[];
  personalTools?: { name: string; ownerUserId: number }[];
  channelId?: string;
}) {
  const store = new BrainStore(openDb(':memory:'));
  const registry = new LiveSessionRegistry<never>();
  const plugins = registryWith(opts.personalTools ?? []);
  for (const s of opts.skills) {
    plugins.skills.push({ name: s.name, description: `does ${s.name}`, filePath: `/skills/${s.name}.md`, baseDir: '/skills' } as never);
    plugins.skillOwners.push('skills');
    plugins.skillOwnerUsers.push(s.ownerUserId);
  }
  const all = plugins.toolsFor(null, null, { grantsEnforcedPerTurn: true, allOwners: true }).map((t) => t.name);
  const state = { active: [...all] };
  const prompts: string[] = [];
  const session = {
    isStreaming: false,
    getContextUsage: () => ({ tokens: 50, contextWindow: 8000, percent: 1 }),
    messages: [] as { role?: string; content?: unknown }[],
    promptTemplates: [] as { name: string }[],
    prompt: vi.fn(async (text: string) => {
      prompts.push(text);
      session.messages.push({ role: 'assistant', content: 'ok' });
    }),
    steer: vi.fn(async () => {}),
    dispose: vi.fn(() => {}),
    getAllTools: () => all.map((name) => ({ name })),
    getActiveToolNames: () => state.active,
    setActiveToolsByName: (names: string[]) => { state.active = [...names]; },
  };
  const listeners = new Set<(e: BrainEvent) => void>();
  const channelId = opts.channelId ?? 'discord-room';
  const spawns = new Map<string, { contributionUserId?: number }>();
  const svc = new ChannelSessionService({
    registry, store, cards: new CardRegistry(() => store),
    users: { get: (id: number) => ({ username: `u${id}`, granted_plugins: [] }) },
    plugins: async () => plugins,
    spawn: async (o: { sessionId: string; ownerUserId: number; contributionUserId?: number }) => {
      spawns.set(o.sessionId, { ...(o.contributionUserId != null ? { contributionUserId: o.contributionUserId } : {}) });
      if (!store.getSession(o.sessionId)) store.createSession({ id: o.sessionId, userId: o.ownerUserId, model: 'kimi' });
      return {
        session, sessionId: o.sessionId, ownerUserId: o.ownerUserId, model: 'kimi', providerId: 'moonshot',
        direct: false, requestProfile: { fast: false }, fastAvailable: false, thinkingLabels: {},
        contributionUserId: null, personalToolOwners: plugins.sharedRoomToolOwners(),
        pluginToolNames: new Set(all), listeners, replay: new LiveEventReplay(listeners),
        turnContext: () => ({ beforeUser: '', afterUser: '' }),
      };
    },
  } as never);

  const write = async (writerUserId: number | undefined, text: string): Promise<void> => {
    await svc.send({
      channelId, ownerUserId: 1, policy: POLICY,
      identity: { platform: 'discord', userId: `d${writerUserId ?? 'x'}`, admin: false, owner: false, conversation: 'shared', ...(writerUserId != null ? { elowenUserId: writerUserId } : {}) },
      ...(writerUserId != null ? { writerUserId } : {}),
    } as never, text);
  };
  const spawnedWith = (sessionId: string): { contributionUserId?: number } => {
    const seen = spawns.get(sessionId);
    if (!seen) throw new Error(`no session was spawned as ${sessionId} (saw ${[...spawns.keys()].join(', ')})`);
    return seen;
  };
  return { svc, store, registry, channelId, write, prompts, spawnedWith, active: () => state.active };
}

describe('a room turn resolves personal contributions for whoever is writing', () => {
  it('announces the writer\'s own skills, and only theirs', async () => {
    const r = room({ skills: [skill('shared-runbook', null), skill('amy-checklist', 2), skill('bob-notes', 3)] });

    await r.write(2, 'what now?');
    expect(r.prompts.at(-1)).toContain('amy-checklist');
    expect(r.prompts.at(-1)).toContain('shared-runbook');
    expect(r.prompts.at(-1)).not.toContain('bob-notes');
    // In front of the writer's words: it says what the turn is able to do before it says what to do.
    expect(r.prompts.at(-1)!.indexOf('amy-checklist')).toBeLessThan(r.prompts.at(-1)!.indexOf('what now?'));

    // Same room, same session, next turn — a different colleague, a different set.
    await r.write(3, 'and now?');
    expect(r.prompts.at(-1)).toContain('bob-notes');
    expect(r.prompts.at(-1)).not.toContain('amy-checklist');

    // An unlinked sender has no account, so they get the instance set and nobody's private one — never
    // the room owner's, who is only whoever opened it.
    await r.write(undefined, 'hello?');
    expect(r.prompts.at(-1)).toContain('shared-runbook');
    expect(r.prompts.at(-1)).not.toContain('amy-checklist');
    expect(r.prompts.at(-1)).not.toContain('bob-notes');
  });

  it('advertises the writer\'s own personal tools and hides everybody else\'s', async () => {
    const r = room({
      skills: [],
      personalTools: [{ name: 'mcp__amy__echo', ownerUserId: 2 }, { name: 'mcp__bob__echo', ownerUserId: 3 }],
    });

    await r.write(2, 'first');
    expect(r.active()).toEqual(['Read', 'mcp__amy__echo']);

    await r.write(3, 'second');
    expect(r.active()).toEqual(['Read', 'mcp__bob__echo']);

    await r.write(undefined, 'third');
    expect(r.active()).toEqual(['Read']);
  });

  // The Phase C shape, for contributions: a child carries no account identity of its own (delegatedExecution
  // refuses one), so without the parent's LIVE record it inherits either nothing — "load my checklist and
  // follow it" silently finding none the moment the work is delegated — or, far worse, the room's row owner.
  it('composes a delegated child from the writer who delegated it, never from the room\'s owner', async () => {
    const r = room({ skills: [skill('amy-checklist', 2)], channelId: 'discord-parent' });
    await r.write(2, 'go');
    const parentSessionId = channelSessionId('discord-parent');
    expect(r.registry.channelGet('discord-parent')!.turnWriterUserId).toBe(2);
    // The room row is anchored on account 1 — the opener — which is exactly the id a child must NOT take.
    expect(r.store.getSession(parentSessionId)!.user_id).toBe(1);

    const opts = delegatedChannelSendOpts({
      channelId: 'subagent-sub-1',
      ownerUserId: 1,
      parentSessionId,
      delegatedAccess: { admin: false, projectIds: [], owner: false, permissionBoundary: null },
      accountAllow: undefined,
      scheduled: false,
    }, {
      policyForProjects: () => ({ allowedProjectIds: new Set<number>(), allowedPaths: () => [] }),
      identity: new IdentityResolver({ platformOwner: () => 1, resolvePlatformUser: () => null, users: { get: () => undefined } as never }),
    });
    await r.svc.send(opts as never, 'do the checklist');

    const child = r.spawnedWith('brain-ch-subagent-sub-1');
    expect(child.contributionUserId).toBe(2);
    // The child carries no account identity of its own — which is precisely why the id above cannot be
    // derived from identity and has to come off the parent.
    expect(opts.identity.elowenUserId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------
// 4. Mechanical contract: ownership is decided in one place, and reaches the turn.
// ---------------------------------------------------------------------------------------------------

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

describe('personal-contribution ownership is decided in exactly one place', () => {
  const root = new URL('../../src/', import.meta.url).pathname;
  const modules = (): { path: string; code: string }[] => sourceFiles(root)
    .map((path) => ({ path: path.slice(root.length), code: stripComments(readFileSync(path, 'utf-8')) }));

  /** The registry OWNS the per-account arrays; a second reader would be a second opinion about who owns
   *  a contribution. Derived: any other module touching them is reported by name. */
  it('no module outside the registry reads the per-account ownership arrays', () => {
    const offenders = modules()
      .filter(({ path }) => path !== 'plugins/registry.ts')
      .filter(({ code }) => /\b(toolOwnerUsers|skillOwnerUsers)\b/.test(code))
      .map(({ path }) => path);
    expect(offenders, 'ownership belongs to PluginRegistry — ask it, do not re-derive it').toEqual([]);
  });

  /** Every caller of skillsFor/toolsFor must name the contribution owner the ONE resolver produced, or
   *  name the instance set literally. Derived from the source: a new surface passing its own id — a room's
   *  opener, a session row's user_id — is reported here rather than shipping as a leak. */
  it('every skillsFor / toolsFor caller passes the resolved owner or a literal null', () => {
    const callers = modules()
      .filter(({ path }) => path !== 'plugins/registry.ts')
      .map(({ path, code }) => ({
        path, code,
        args: [...code.matchAll(/\b(?:skillsFor|toolsFor)\(\s*([^,)]+)/g)].map((m) => m[1]!.trim()),
      }))
      .filter(({ args }) => args.length > 0);
    // Derived, not remembered: whoever composes contributions is in this list by construction, so a new
    // surface cannot be born outside the check. Adding one means deciding — here, in review — which
    // account it composes for.
    expect(callers.map(({ path }) => path).sort(), 'the surfaces that compose plugin contributions').toEqual([
      'api/routes/auth.ts',            // the admin's tool-pill editor: what ONE account gets in its own chat
      'brain/service/spawner.ts',      // session composition
      'brain/session/turnSkills.ts',   // a room's per-turn announcement
      'brain/worker/brainWorker.ts',   // a task worker: the instance set, named literally
    ]);
    // …and any of them that also RUNS a turn or composes a session's tool set must name the resolved owner
    // (or the instance set literally). The admin route answers a question ABOUT an account rather than
    // acting as one, so it legitimately names that account's id and does neither.
    const composing = callers.filter(({ code }) => /\brunWithPolicy\s*\(|\bcomposeSessionTools\s*\(/.test(code));
    expect(composing.length, 'the session/turn composers seem to have been renamed').toBeGreaterThan(1);
    const ACCEPTED = /^(null|.*[Cc]ontribution(Owner)?UserId)$/;
    const offenders = composing.flatMap(({ path, args }) => args.filter((arg) => !ACCEPTED.test(arg)).map((arg) => ({ path, arg })));
    expect(offenders, 'compose contributions from contributionOwnerForSession, never from a locally chosen account id').toEqual([]);
  });

  /** …and the answer has to reach the turn, or the plugin holding the content cannot apply it. This is the
   *  seam the whole phase turns on: the skills plugin resolves its caller from `currentContributionUserId()`,
   *  which is empty unless the surface establishing the turn scope puts it there. */
  it('every surface that establishes a turn scope carries the contribution owner into it', () => {
    const surfaces = modules().filter(({ code }) =>
      /\brunWithPolicy\s*\(/.test(code) && /\b(?:skillsFor|toolsFor|contributionUserId)\b/.test(code));
    expect(surfaces.map((m) => m.path).sort(), 'the turn surfaces this contract covers')
      .toEqual(['brain/channels.ts', 'brain/service/turnContextBuilder.ts', 'brain/worker/brainWorker.ts']);
    const offenders = surfaces
      .filter(({ code }) => !/\bcontributionUserId\s*[,:]/.test(code) && !/toolsFor\(\s*null/.test(code))
      .map(({ path }) => path);
    expect(offenders, 'a resolved contribution owner that never reaches runWithPolicy authorises nothing').toEqual([]);
  });
});
