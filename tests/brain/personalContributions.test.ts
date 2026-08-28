import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { KnownControls, PluginLogger } from '../../src/plugins/api.js';
import { setLogSink } from '../../src/shared/logger.js';
import { openDb } from '../../src/store/db.js';
import { UserStore } from '../../src/store/userStore.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { toolAuthorityForUser } from '../../src/brain/brainDeps.js';
import type { BrainDeps } from '../../src/brain/brainDeps.js';
import { composeSessionTools, visibleToolNames } from '../../src/brain/session/capabilities.js';
import { currentContributionUserId, currentWorkDir, runWithPolicy, type ToolPolicy } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import { ChannelSessionService } from '../../src/brain/channels.js';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';
import { LiveSessionSpawner } from '../../src/brain/service/spawner.js';
import { inMemoryModelRuntime } from '../../src/brain/providers.js';
import { LiveEventReplay } from '../../src/brain/session/liveEventReplay.js';
import { CardRegistry } from '../../src/brain/cards.js';
import { channelSessionId } from '../../src/brain/sessionId.js';
import { delegatedChannelSendOpts } from '../../src/brain/delegatedTurn.js';
import { IdentityResolver } from '../../src/brain/identity.js';
import type { BrainEvent } from '../../src/brain/events.js';

const POLICY: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };

const SILENT: PluginLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** One bridged MCP tool, built exactly as plugins/mcp/index.mjs `registerBridgedTool` builds one: the
 *  `mcp__<server>__<tool>` name, the `[server] …` description and the remote server's `inputSchema` wrapped
 *  in `Type.Unsafe` (or an empty object when the server declares none). `tag` only changes what the execute
 *  RETURNS, never the declared surface — that is what lets a test tell which owner's server answered.
 *
 *  It differs from the plugin in one respect: the plugin's execute calls a live MCP client, this one
 *  answers locally. Nothing here reads a tool's execute except by calling it, so the difference is confined
 *  to the assertion text. */
function bridgedTool(name: string, opts?: { description?: string; inputSchema?: Record<string, unknown>; tag?: string }): ToolDefinition {
  const server = name.split('__')[1] ?? name;
  return defineTool({
    name,
    label: name,
    description: opts?.description ?? `[${server}] echo`,
    parameters: opts?.inputSchema ? Type.Unsafe(opts.inputSchema) : Type.Object({}),
    execute: async () => ({ content: [{ type: 'text' as const, text: `ran ${name}${opts?.tag ? `@${opts.tag}` : ''}` }], details: {} }),
  }) as unknown as ToolDefinition;
}

/** A registry holding one instance tool plus the given PERSONAL tools, registered the way a plugin actually
 *  registers them: through the `PluginContext` the loader hands it, with `{ ownerUserId }` for a personal
 *  server (mcp plugin, `index.mjs` → `ctx.registerTool(defineTool({…}), { ownerUserId })`). Manifest
 *  `provides` gating is left off here — this harness is about ownership, and that gate has its own tests. */
function registryWith(
  personal: { name: string; ownerUserId: number; description?: string; inputSchema?: Record<string, unknown>; tag?: string }[],
  instance: string[] = ['Read'],
): PluginRegistry {
  const registry = new PluginRegistry();
  const files = registry.contextFor('files', {}, SILENT);
  for (const name of instance) files.registerTool(bridgedTool(name) as never);
  const mcp = registry.contextFor('mcp', {}, SILENT);
  for (const spec of personal) {
    mcp.registerTool(bridgedTool(spec.name, spec) as never, { ownerUserId: spec.ownerUserId });
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
    expect([...registry.sharedRoomToolOwners()]).toEqual([['mcp__amy__echo', new Set([2])], ['mcp__bob__echo', new Set([3])]]);
  });

  // One registered definition per name is all PI has — but only ONE account's turn ever runs at a time, so
  // when two colleagues both called their server `github` the one definition can serve both by dispatching
  // on the writer. Dropping it (as this used to) took a working tool away from both of them, silently.
  it('serves a name two accounts both claim from one definition that dispatches on the writer', async () => {
    const registry = registryWith([
      { name: 'mcp__github__list', ownerUserId: 2, tag: 'amy' },
      { name: 'mcp__github__list', ownerUserId: 3, tag: 'bob' },
      { name: 'mcp__amy__echo', ownerUserId: 2 },
    ]);

    const composed = registry.toolsFor(null, null, { allOwners: true });
    expect(composed.map((t) => t.name)).toContain('mcp__github__list');
    expect(registry.sharedRoomToolOwners().get('mcp__github__list')).toEqual(new Set([2, 3]));

    // …and the ONE definition runs the server of whoever is writing, never the other account's.
    const contested = composed.find((t) => t.name === 'mcp__github__list')!;
    const call = (contributionUserId: number | null): Promise<{ content: { text: string }[] }> => runWithPolicy(
      POLICY,
      () => contested.execute('c1', {} as never, undefined, undefined, {} as never) as Promise<{ content: { text: string }[] }>,
      { contributionUserId },
    );
    expect((await call(2)).content[0]!.text).toBe('ran mcp__github__list@amy');
    expect((await call(3)).content[0]!.text).toBe('ran mcp__github__list@bob');
    // Nobody's turn reaches either server (the composed session gate refuses this first; this is the
    // definition's own fail-closed answer).
    expect((await call(null)).content[0]!.text).toContain('belongs to another account');
    expect((await call(4)).content[0]!.text).toContain('belongs to another account');
  });

  // The honest limit of the merge above: one definition carries ONE parameter schema, so two genuinely
  // different tools that collided on a name cannot share it. That drop is the old behaviour — but it is
  // reported, because a tool that vanishes with no explanation is indistinguishable from a broken server.
  it('withholds a name whose two definitions describe different tools, and says so', () => {
    const lines: string[] = [];
    setLogSink({ push: (entry) => { lines.push(`${entry.level} ${entry.scope} ${entry.message}`); } });
    try {
      const registry = registryWith([
        { name: 'mcp__github__list', ownerUserId: 2, inputSchema: { type: 'object', properties: { repo: { type: 'string' } } } },
        { name: 'mcp__github__list', ownerUserId: 3, inputSchema: { type: 'object', properties: { project: { type: 'number' } } } },
        { name: 'mcp__amy__echo', ownerUserId: 2 },
      ]);

      const composed = registry.toolsFor(null, null, { allOwners: true }).map((t) => t.name);
      expect(composed).not.toContain('mcp__github__list');
      expect(composed).toContain('mcp__amy__echo');
      expect(registry.sharedRoomToolOwners().has('mcp__github__list')).toBe(false);
      // …and each of them still has it in their OWN chat, where the session has a single owner.
      expect(registry.toolsFor(2, null).map((t) => t.name)).toContain('mcp__github__list');

      const warned = lines.filter((l) => l.includes('mcp__github__list'));
      expect(warned, 'a room silently missing a tool is a support ticket nobody can answer').toHaveLength(1);
      expect(warned[0]).toContain('warn');
      expect(warned[0]).toContain('accounts 2, 3');
    } finally {
      setLogSink(undefined);
    }
  });

  // A description is what the model picks a tool from, so two servers that describe the same-named tool
  // differently are not interchangeable either — even when their parameters happen to match.
  it('treats a differing description as a different tool', () => {
    const registry = registryWith([
      { name: 'mcp__github__list', ownerUserId: 2, description: '[github] list issues' },
      { name: 'mcp__github__list', ownerUserId: 3, description: '[github] list deployments' },
    ]);
    expect(registry.sharedRoomToolOwners().has('mcp__github__list')).toBe(false);
  });

  // Composing four people's servers into one registry must not make the room behave like a session with
  // four servers: every turn is narrowed to the writer's own tools before the prompt is built, so the
  // automatic-deferral threshold has to be measured against what ONE of them actually sees.
  it('measures the deferral threshold against one writer, not the composed pile', () => {
    const registry = registryWith([
      { name: 'mcp__amy__one', ownerUserId: 2 }, { name: 'mcp__amy__two', ownerUserId: 2 },
      { name: 'mcp__bob__one', ownerUserId: 3 }, { name: 'mcp__bob__two', ownerUserId: 3 },
    ]);
    const roomDeferred = (threshold: number): Set<string> => {
      let deferred = new Set<string>();
      composeSessionTools({
        kind: 'foreign-channel',
        pluginTools: registry.toolsFor(null, null, { grantsEnforcedPerTurn: true, allOwners: true }),
        personalToolOwners: registry.sharedRoomToolOwners(),
        toolDeferral: {
          toolOwner: registry.toolOwner, toolDeferLoading: new Set(), planSafeToolNames: new Set(),
          builtinDeferLoading: [], options: { enabled: true, threshold },
        },
        toolSearch: (d) => { deferred = d; return []; },
      });
      return deferred;
    };
    // Two accounts with two MCP tools each: the worst-off writer faces two, which is AT the threshold.
    expect([...roomDeferred(2)]).toEqual([]);
    // One below it, and that same writer is over — so the room defers, as a single account's session would.
    expect([...roomDeferred(1)].sort()).toEqual(['mcp__amy__one', 'mcp__amy__two', 'mcp__bob__one', 'mcp__bob__two']);
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
  policy?: Policy;
  projects?: { list(): { id: number; path: string }[] };
  sandbox?: KnownControls['sandbox'];
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
  const workDirs: (string | undefined)[] = [];
  const session = {
    isStreaming: false,
    getContextUsage: () => ({ tokens: 50, contextWindow: 8000, percent: 1 }),
    messages: [] as { role?: string; content?: unknown }[],
    promptTemplates: [] as { name: string }[],
    prompt: vi.fn(async (text: string) => {
      prompts.push(text);
      workDirs.push(currentWorkDir());
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
    ...(opts.projects ? { projects: opts.projects } : {}),
    ...(opts.sandbox ? { sandbox: () => opts.sandbox } : {}),
    spawn: async (o: { sessionId: string; ownerUserId: number; contributionUserId?: number }) => {
      spawns.set(o.sessionId, { ...(o.contributionUserId != null ? { contributionUserId: o.contributionUserId } : {}) });
      if (!store.getSession(o.sessionId)) store.createSession({ id: o.sessionId, userId: o.ownerUserId, model: 'kimi' });
      return {
        session, sessionId: o.sessionId, ownerUserId: o.ownerUserId, model: 'kimi', providerId: 'moonshot',
        direct: false, requestProfile: { fast: false }, fastAvailable: false, thinkingLabels: {},
        contributionUserId: null, personalToolOwners: plugins.sharedRoomToolOwners(),
        workDir: opts.projects?.list()[0]?.path,
        pluginToolNames: new Set(all), listeners, replay: new LiveEventReplay(listeners),
        turnContext: () => ({ beforeUser: '', afterUser: '' }),
      };
    },
  } as never);

  const write = async (writerUserId: number | undefined, text: string): Promise<void> => {
    await svc.send({
      channelId, ownerUserId: 1, policy: opts.policy ?? POLICY,
      identity: { platform: 'discord', userId: `d${writerUserId ?? 'x'}`, admin: false, owner: false, conversation: 'shared', ...(writerUserId != null ? { elowenUserId: writerUserId } : {}) },
      ...(writerUserId != null ? { writerUserId } : {}),
    } as never, text);
  };
  const spawnedWith = (sessionId: string): { contributionUserId?: number } => {
    const seen = spawns.get(sessionId);
    if (!seen) throw new Error(`no session was spawned as ${sessionId} (saw ${[...spawns.keys()].join(', ')})`);
    return seen;
  };
  return { svc, store, registry, channelId, write, prompts, workDirs, spawnedWith, active: () => state.active };
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

  it('reorients alternating writers to their own active workspace in one durable room', async () => {
    const root = mkdtempSync(join(tmpdir(), 'elowen-room-workspaces-'));
    const project = join(root, 'project');
    const amyWorkspace = join(root, 'amy');
    const bobWorkspace = join(root, 'bob');
    mkdirSync(project); mkdirSync(amyWorkspace); mkdirSync(bobWorkspace);
    try {
      const policy: Policy = {
        allowedProjectIds: new Set([7]),
        allowedPaths: () => [project, amyWorkspace, bobWorkspace],
      };
      const sandbox: KnownControls['sandbox'] = {
        workspaceRoots: () => {
          const accountUserId = currentContributionUserId();
          return [{
            workspaceId: accountUserId === 2 ? 'ws-amy' : 'ws-bob',
            projectId: 7,
            path: accountUserId === 2 ? amyWorkspace : bobWorkspace,
          }];
        },
        workspacesFor: ({ userId }) => [{
          workspaceId: userId === 2 ? 'ws-amy' : 'ws-bob',
          projectId: 7,
          path: userId === 2 ? amyWorkspace : bobWorkspace,
          label: userId === 2 ? 'Amy' : 'Bob',
          branch: userId === 2 ? 'amy/topic' : 'bob/topic',
          baseRef: 'main',
        }],
        activeWorkspace: () => {
          const accountUserId = currentContributionUserId();
          return {
            workspaceId: accountUserId === 2 ? 'ws-amy' : 'ws-bob',
            projectId: 7,
            path: accountUserId === 2 ? amyWorkspace : bobWorkspace,
            label: accountUserId === 2 ? 'Amy' : 'Bob',
            branch: accountUserId === 2 ? 'amy/topic' : 'bob/topic',
            baseRef: 'main',
          };
        },
        prepareExecution: async () => ({}) as never,
      };
      const r = room({
        skills: [], channelId: 'discord-workspaces', policy, sandbox,
        projects: { list: () => [{ id: 7, path: project }] },
      });

      await r.write(2, 'amy turn');
      await r.write(3, 'bob turn');
      await r.write(2, 'amy again');

      expect(r.workDirs).toEqual([amyWorkspace, bobWorkspace, amyWorkspace]);
      expect(r.prompts[0]).toContain(`effective working directory for this turn is ${amyWorkspace}`);
      expect(r.prompts[1]).toContain(`effective working directory for this turn is ${bobWorkspace}`);
      expect(r.prompts[1]).not.toContain(amyWorkspace);
      expect(r.prompts[2]).toContain(amyWorkspace);
      expect(r.store.getSession(channelSessionId('discord-workspaces'))?.user_id).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  // A child carries no account identity of its own (delegatedExecution refuses one), so the Delegate call
  // captures the current room writer into its durable scope while the parent turn is live. The room clears
  // its transient writer after settlement; a resumed child must still compose from the captured account,
  // never from the room opener.
  it('composes a delegated child from the captured writer, never from the room\'s owner', async () => {
    const r = room({ skills: [skill('amy-checklist', 2)], channelId: 'discord-parent' });
    await r.write(2, 'go');
    const parentSessionId = channelSessionId('discord-parent');
    expect(r.registry.channelGet('discord-parent')!.turnWriterUserId).toBeNull();
    // The room row is anchored on account 1 — the opener — which is exactly the id a child must NOT take.
    expect(r.store.getSession(parentSessionId)!.user_id).toBe(1);

    const opts = delegatedChannelSendOpts({
      channelId: 'subagent-sub-1',
      ownerUserId: 1,
      parentSessionId,
      delegatedAccess: {
        admin: false,
        projectIds: [],
        owner: false,
        permissionBoundary: null,
        contributionUserId: 2,
      },
      accountAllow: undefined,
      scheduled: false,
    }, {
      policyForProjects: () => ({ allowedProjectIds: new Set<number>(), allowedPaths: () => [] }),
      identity: new IdentityResolver({ platformOwner: () => 1, resolvePlatformUser: () => null, users: { get: () => undefined } as never }),
    });
    await r.svc.send(opts as never, 'do the checklist');

    const child = r.spawnedWith('brain-ch-subagent-sub-1');
    expect(child.contributionUserId).toBe(2);
    // The child carries no account identity of its own — the captured scope is the only safe authority.
    expect(opts.identity.elowenUserId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------
// 4. What the REAL spawner composes, on each kind of session.
// ---------------------------------------------------------------------------------------------------

describe('the spawner composes a room differently from a session that has one owner', () => {
  const spawned = async (sessionId: string, opts: { channel?: boolean; direct?: boolean; deferTools?: boolean }) => {
    const plugins = registryWith([
      { name: 'mcp__amy__echo', ownerUserId: 2 },
      { name: 'mcp__bob__echo', ownerUserId: 3 },
    ]);
    for (const [name, ownerUserId] of [['shared-runbook', null], ['amy-checklist', 2]] as [string, number | null][]) {
      plugins.skills.push({ name, description: `does ${name}`, filePath: `/s/${name}.md`, baseDir: '/s' } as never);
      plugins.skillOwners.push('skills');
      plugins.skillOwnerUsers.push(ownerUserId);
    }
    const create = vi.fn(async () => ({ session: { sessionId, subscribe: () => () => {} }, applyCompaction: vi.fn() }));
    const spawner = new LiveSessionSpawner({
      config: { providers: [{ id: 'relay', label: 'Relay', type: 'openai' as const, baseUrl: 'http://relay.example/v1', models: ['gpt-5'], apiKey: 'k' }] },
      store: new BrainStore(openDb(':memory:')),
      runtime: await inMemoryModelRuntime(),
      users: { ensureAdvisorToken: () => 'token', get: () => ({ name: 'Amy', username: 'amy' }) },
      prompts: { render: () => 'PERSONA' },
      url: 'http://x',
      plugins: async () => plugins,
      factory: { create },
      sessionTaps: () => [],
      // Deferral withholds a tool's SCHEMA and advertises its name in the appended awareness block — which
      // is exactly the block a room must not build from the composed superset.
      ...(opts.deferTools
        ? { runtimeConfig: () => ({ toolDeferralEnabled: true, hostedToolSearch: {}, limits: { toolDeferThreshold: 0 } }) }
        : {}),
    } as never);
    const live = await spawner.spawn({ sessionId, ownerUserId: 2, selection: {}, policy: POLICY, autoCompact: false, ...opts } as never);
    const spec = create.mock.calls.at(-1)![0] as unknown as { tools: { name: string }[]; appendSystemPrompt: string[] };
    return { live, tools: spec.tools.map((t) => t.name), append: spec.appendSystemPrompt.join('\n') };
  };

  it('gives a room every account\'s personal tools and no baked-in skills block', async () => {
    const room = await spawned(channelSessionId('discord-x'), { channel: true, direct: false });
    expect(room.tools).toContain('mcp__amy__echo');
    expect(room.tools).toContain('mcp__bob__echo');
    expect([...room.live.personalToolOwners!]).toEqual([['mcp__amy__echo', new Set([2])], ['mcp__bob__echo', new Set([3])]]);
    expect(room.live.contributionUserId).toBeNull();
    // The announcement cannot live in the cached prefix here: it has to follow the writer, like the
    // authorisation does. It arrives with each turn instead (see the room turn tests above).
    expect(room.append).not.toContain('available_skills');
  });

  it('gives a session that HAS an owner only their own, announced once in the cached prompt', async () => {
    const own = await spawned('brain-2', {});
    expect(own.tools).toContain('mcp__amy__echo');
    expect(own.tools).not.toContain('mcp__bob__echo');
    expect(own.live.personalToolOwners).toBeUndefined();
    expect(own.live.contributionUserId).toBe(2);
    expect(own.append).toContain('amy-checklist');
    expect(own.append).toContain('shared-runbook');
  });

  // The deferred-tool awareness block is appended to the CACHED system prompt, which no per-turn pass
  // rewrites — so a personal tool named there is announced to every member of the room for the life of the
  // session, whatever the visibility pass does afterwards. In a room the name itself is the private part.
  it('never names an account\'s personal tool in a room\'s cached deferred-tools block', async () => {
    const room = await spawned(channelSessionId('discord-deferred'), { channel: true, direct: false, deferTools: true });
    // The tools are still composed and still deferred — this is about what the prompt ADVERTISES.
    expect(room.tools).toContain('mcp__amy__echo');
    expect(room.live.toolSearch!.deferred).toContain('mcp__amy__echo');
    expect(room.append).not.toContain('mcp__amy__echo');
    expect(room.append).not.toContain('mcp__bob__echo');

    // …while a session composed for ONE account announces that account's own deferred tools as before.
    const own = await spawned('brain-2', { deferTools: true });
    expect(own.append).toContain('mcp__amy__echo');
    expect(own.append).not.toContain('mcp__bob__echo');
  });
});

// ---------------------------------------------------------------------------------------------------
// 5. Mechanical contract: ownership is decided in one place, and reaches the turn.
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
    ]);
    // …and any of them that also RUNS a turn or composes a session's tool set must name the resolved owner
    // (or the instance set literally). The admin route answers a question ABOUT an account rather than
    // acting as one, so it legitimately names that account's id and does neither.
    const composing = callers.filter(({ code }) => /\brunWithPolicy\s*\(|\bcomposeSessionTools\s*\(/.test(code));
    expect(composing.length, 'the session composer seems to have been renamed').toBeGreaterThan(0);
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
      .toEqual(['brain/channels.ts', 'brain/service/turnContextBuilder.ts']);
    const offenders = surfaces
      .filter(({ code }) => !/\bcontributionUserId\s*[,:]/.test(code) && !/toolsFor\(\s*null/.test(code))
      .map(({ path }) => path);
    expect(offenders, 'a resolved contribution owner that never reaches runWithPolicy authorises nothing').toEqual([]);
  });
});
