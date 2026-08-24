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
import { currentToolPolicy, runWithPolicy, type ToolPolicy } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import { TurnContextBuilder } from '../../src/brain/service/turnContextBuilder.js';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';
import { LiveEventReplay } from '../../src/brain/session/liveEventReplay.js';
import { CardRegistry } from '../../src/brain/cards.js';
import { ChannelSessionService } from '../../src/brain/channels.js';
import { PlatformOrchestrator } from '../../src/brain/platforms.js';
import { IdentityResolver } from '../../src/brain/identity.js';
import type { ChannelSendOpts } from '../../src/brain/channels.js';
import type { BrainEvent } from '../../src/brain/events.js';

/** The instance's live tool catalogue. Almost everything in Elowen is plugin-contributed (files,
 *  terminal, web, MCP…), so the grant really does govern Read/Bash — only the core built-ins are outside
 *  it, which is the documented asymmetry in visibleToolNames. */
const BUILTIN = 'MemorySearch';
const PLUGIN_TOOLS = ['Read', 'Write', 'Bash', 'DiscordApi'];
const CATALOGUE = [BUILTIN, ...PLUGIN_TOOLS];

const POLICY: Policy = { allowedProjectIds: new Set([7]), allowedPaths: () => ['/repo/7'] };

/** A store shaped like a real instance: an admin (account 1, created first) plus a non-admin colleague. */
function accounts(): { users: UserStore; amy: number; admin: number; deps: Pick<BrainDeps, 'users' | 'plugins'> } {
  const users = new UserStore(openDb(':memory:'));
  const admin = users.create('operator', 'pw').id;
  const amy = users.create('amy', 'pw').id;
  const registry = new PluginRegistry();
  for (const name of PLUGIN_TOOLS) registry.toolOwner.set(name, 'core-ish');
  const deps = {
    users: users as unknown as BrainDeps['users'],
    plugins: { peek: () => registry } as unknown as BrainDeps['plugins'],
  };
  return { users, amy, admin, deps };
}

// ---------------------------------------------------------------------------------------------------
// 1. Both surfaces answer with the SAME grant.
// ---------------------------------------------------------------------------------------------------

/** A minimal live session that records what the model would actually be offered. */
function fakeSession(all: string[] = CATALOGUE) {
  const state = { active: [...all] };
  return {
    isStreaming: false,
    getContextUsage: () => ({ tokens: 50, contextWindow: 8000, percent: 1 }),
    messages: [] as { role?: string; content?: unknown }[],
    promptTemplates: [] as { name: string }[],
    prompt: vi.fn(async () => {}),
    steer: vi.fn(async () => {}),
    dispose: vi.fn(() => {}),
    getAllTools: () => all.map((name) => ({ name })),
    getActiveToolNames: () => state.active,
    setActiveToolsByName: (names: string[]) => { state.active = [...names]; },
    activeNames: () => state.active,
  };
}

/** What the OWNER chat offers account `userId`, and the policy its turn actually executes under. */
async function ownerSurface(
  deps: Pick<BrainDeps, 'users' | 'plugins'>,
  userId: number,
  catalogue = CATALOGUE,
): Promise<{ visible: string[]; policy: ToolPolicy | undefined }> {
  const store = new BrainStore(openDb(':memory:'));
  const sessions = new LiveSessionRegistry<never>();
  const session = fakeSession(catalogue);
  const listeners = new Set<(e: BrainEvent) => void>();
  const live = {
    session, sessionId: 'brain-owner-1', ownerUserId: userId, policy: POLICY, direct: false,
    model: 'kimi', providerId: 'moonshot', provider: 'moonshot', lastTurnMode: 'build' as const,
    pluginToolNames: new Set(catalogue.filter((name) => name !== BUILTIN)),
    planSafeToolNames: new Set<string>(), listeners, replay: new LiveEventReplay(listeners),
  };
  const builder = new TurnContextBuilder({
    store,
    sessions: sessions as never,
    permissions: { turnPermissions: () => undefined } as never,
    elicitation: {} as never,
    cards: new CardRegistry(() => store),
    identity: new IdentityResolver({ platformOwner: () => 1, resolvePlatformUser: () => null, users: deps.users as never }),
    prompts: undefined,
    users: deps.users,
    plugins: async () => undefined,
    toolAuthorityFor: (id: number) => toolAuthorityForUser(deps, id),
  } as never);

  let policy: ToolPolicy | undefined;
  await builder.buildScope(userId, live as never).run(async () => { policy = currentToolPolicy(); });
  return { visible: session.activeNames(), policy };
}

/** What the CHANNEL path offers the same account: the orchestrator resolves the writer's authority, and
 *  the channel service applies it to a session backed by a REAL BrainStore. A mocked channel would only
 *  prove what the orchestrator SENDS. */
async function channelSurface(
  deps: Pick<BrainDeps, 'users' | 'plugins'>,
  userId: number,
  catalogue = CATALOGUE,
): Promise<{ visible: string[]; policy: ToolPolicy | undefined; sentPolicy: ToolPolicy | undefined }> {
  let handler: ((src: never, text: string) => Promise<unknown>) | undefined;
  let sent: ChannelSendOpts | undefined;
  const adapter = { name: 'discord', listen: (fn: never) => { handler = fn as never; }, connect: async () => {} };
  const orch = new PlatformOrchestrator({
    plugins: async () => ({ platforms: [adapter] }) as never,
    platformOwner: () => 1,
    policyForUser: () => POLICY,
    toolAuthorityFor: (id: number) => toolAuthorityForUser(deps, id),
    identity: new IdentityResolver({
      platformOwner: () => 1,
      resolvePlatformUser: () => ({ id: userId, name: 'Amy', username: 'amy', admin: false }),
      users: deps.users as never,
    }),
    channels: {
      sessionOwnerUserId: () => undefined,
      send: async (o: ChannelSendOpts) => { sent = o; return 'ok'; },
      fragmentFor: () => '', setLastWriter: () => {},
    } as never,
    dispatch: { send: () => Promise.reject(new Error('must not delegate')) },
  } as never);
  await orch.startAll();
  await handler!({ platform: 'discord', userId: 'D9', channelId: 'c1', roleIds: [], access: { admin: false, projectIds: [7] } } as never, 'hi');

  // …and now the second half: what that ChannelSendOpts does to a real room session.
  const store = new BrainStore(openDb(':memory:'));
  const registry = new LiveSessionRegistry<never>();
  const session = fakeSession(catalogue);
  let policy: ToolPolicy | undefined;
  session.prompt.mockImplementation(async () => { policy = currentToolPolicy(); });
  const listeners = new Set<(e: BrainEvent) => void>();
  const svc = new ChannelSessionService({
    registry, store, cards: new CardRegistry(() => store),
    users: { get: () => ({ username: 'amy' }) },
    spawn: async (o: { sessionId: string; ownerUserId: number }) => {
      if (!store.getSession(o.sessionId)) store.createSession({ id: o.sessionId, userId: o.ownerUserId, model: 'kimi' });
      return {
        session, sessionId: o.sessionId, ownerUserId: o.ownerUserId, model: 'kimi', providerId: 'moonshot',
        direct: false, requestProfile: { fast: false }, fastAvailable: false, thinkingLabels: {},
        pluginToolNames: new Set(catalogue.filter((name) => name !== BUILTIN)),
        listeners, replay: new LiveEventReplay(listeners), turnContext: () => ({ beforeUser: '', afterUser: '' }),
      };
    },
  } as never);
  await svc.send({ ...sent!, channelId: 'discord-c1', ownerUserId: userId } as never, 'hi');
  return { visible: session.activeNames(), policy, sentPolicy: sent?.toolPolicy };
}

describe('a non-admin turn offers exactly the tools their account grants', () => {
  it('answers identically in the owner chat and in a platform room', async () => {
    const { users, amy, deps } = accounts();
    users.setAllowedTools(amy, ['Read', 'Write']);

    const owner = await ownerSurface(deps, amy);
    const channel = await channelSurface(deps, amy);

    // The built-in stays (allow narrows PLUGIN tools only); DiscordApi and Bash are ungranted, so the
    // model is never even told they exist.
    expect(owner.visible).toEqual([BUILTIN, 'Read', 'Write']);
    expect(channel.visible).toEqual(owner.visible);
    // …and the policy the turn EXECUTES under is the same grant on both surfaces, not merely the same
    // advertised list.
    expect(owner.policy).toEqual({ allow: new Set(['Read', 'Write']) });
    expect(channel.policy).toEqual(owner.policy);
    expect(channel.sentPolicy).toEqual(owner.policy);
  });

  it('shows a newly installed tool to nobody until an admin grants it', async () => {
    const { users, amy, admin, deps } = accounts();
    users.setAllowedTools(amy, ['Read', 'Write']);
    // A plugin (or an MCP server) loads and contributes a tool that existed in no admin's list.
    const grown = [...CATALOGUE, 'McpDeployProd'];

    const nonAdmin = await ownerSurface(deps, amy, grown);
    expect(nonAdmin.visible).not.toContain('McpDeployProd');
    // The whole point of moving off the deny-list: the old shape failed OPEN exactly here, because a tool
    // nobody had disabled yet was disabled for nobody.
    expect(nonAdmin.visible).toEqual([BUILTIN, 'Read', 'Write']);

    // The admin, who bypasses the grant, sees it immediately and can hand it out.
    expect((await ownerSurface(deps, admin, grown)).visible).toEqual(grown);

    users.setAllowedTools(amy, ['Read', 'Write', 'McpDeployProd']);
    expect((await ownerSurface(deps, amy, grown)).visible).toContain('McpDeployProd');
  });

  it('offers a brand-new account no plugin tool at all', async () => {
    const { amy, deps } = accounts(); // created, never granted anything
    const owner = await ownerSurface(deps, amy);
    expect(owner.visible).toEqual([BUILTIN]);
    expect(owner.policy).toEqual({ allow: new Set() });
  });
});

describe('an admin bypasses the grant, but not their own deny-list', () => {
  it('keeps every tool while an empty grant would strip a non-admin', async () => {
    const { users, admin, amy, deps } = accounts();
    users.setAllowedTools(admin, []);   // an operator narrowing their own account must not lock themselves out
    users.setAllowedTools(amy, []);

    expect(toolAuthorityForUser(deps, admin)).toBeUndefined();
    expect((await ownerSurface(deps, admin)).visible).toEqual(CATALOGUE);
    expect((await ownerSurface(deps, amy)).visible).toEqual([BUILTIN]);
  });

  it('still withholds what the admin explicitly disabled', async () => {
    const { users, admin, deps } = accounts();
    users.setDisabledTools(admin, ['DiscordApi']);

    // No allow restriction (bypass) — but the deny is an explicit choice, not an absence, so it holds.
    expect(toolAuthorityForUser(deps, admin)).toEqual({ deny: new Set(['DiscordApi']) });
    expect((await ownerSurface(deps, admin)).visible).toEqual([BUILTIN, 'Read', 'Write', 'Bash']);
  });
});

describe('the execute-time gate, not just prompt visibility', () => {
  const call = (tool: ToolDefinition, policy: ToolPolicy | undefined): Promise<{ content: { text: string }[] }> =>
    runWithPolicy(POLICY, () => tool.execute('call-1', {} as never, undefined, undefined, {} as never) as Promise<{ content: { text: string }[] }>, { toolPolicy: policy });

  const plugin = (name: string): { tool: ToolDefinition; ran: () => number } => {
    let runs = 0;
    return {
      ran: () => runs,
      tool: {
        name, label: name, description: name, parameters: {} as never,
        execute: async () => { runs++; return { content: [{ type: 'text', text: `ran ${name}` }], details: {} }; },
      } as unknown as ToolDefinition,
    };
  };

  // Hiding a tool from the prompt is not a security boundary: a model can name a tool it saw in an earlier
  // turn, in a compacted transcript, or simply guess it. The grant has to refuse the CALL.
  it('refuses a tool outside the grant even when the model names it directly', async () => {
    const { users, amy, deps } = accounts();
    users.setAllowedTools(amy, ['Read']);
    const policy = toolAuthorityForUser(deps, amy);

    const bash = plugin('Bash');
    const read = plugin('Read');
    const composed = composeSessionTools({ kind: 'owner-chat', pluginTools: [bash.tool, read.tool] });
    const gatedBash = composed.find((t) => t.name === 'Bash')!;
    const gatedRead = composed.find((t) => t.name === 'Read')!;

    const refused = await call(gatedBash, policy);
    expect(bash.ran()).toBe(0);
    expect(refused.content[0]!.text).toContain('not available to you');
    // The granted one still runs — a gate that refused everything would pass the test above for free.
    await call(gatedRead, policy);
    expect(read.ran()).toBe(1);
  });

  it('refuses every plugin tool for an account nobody has granted anything', async () => {
    const { amy, deps } = accounts();
    const read = plugin('Read');
    const gated = composeSessionTools({ kind: 'owner-chat', pluginTools: [read.tool] }).find((t) => t.name === 'Read')!;
    await call(gated, toolAuthorityForUser(deps, amy));
    expect(read.ran()).toBe(0);
  });
});

describe('unresolvable and partial account rows', () => {
  it('fails CLOSED for an id that resolves to no account', () => {
    const { deps } = accounts();
    const policy = toolAuthorityForUser(deps, 999);
    // An empty grant, NOT "unrestricted": a deleted account must inherit nothing rather than everything.
    expect(policy?.allow).toEqual(new Set());
    expect(visibleToolNames(CATALOGUE, new Set(PLUGIN_TOOLS), policy)).toEqual([BUILTIN]);
  });

  it('leaves a row whose grant field is absent unrestricted', () => {
    // Never a real row — the column carries a default, so this is a partial shape from a stub or a test
    // double. Reading it as "no tools" silently stripped a delegated child of a grant its scope had
    // legitimately captured, which is why it must stay distinct from BOTH cases above.
    const partial = {
      users: { get: () => ({ is_admin: false, granted_plugins: [], disabled_tools: [] }) } as unknown as BrainDeps['users'],
      plugins: { peek: () => new PluginRegistry() } as unknown as BrainDeps['plugins'],
    };
    expect(toolAuthorityForUser(partial, 5)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------
// Mechanical contract: one resolver, no hand-rolled sets.
// ---------------------------------------------------------------------------------------------------

/** Every `.ts` under src, minus the modules that legitimately OWN the two columns. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

/** Comments name these columns constantly (and should). Only real CODE references matter here. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

describe('tool authority is resolved in exactly one place', () => {
  const root = new URL('../../src/', import.meta.url).pathname;
  /** The storage layer, the wire type, the admin-facing API and SSO provisioning genuinely read and write
   *  these columns. Nothing else may: a second reader is a second opinion about what an account may do. */
  const OWNERS = [
    'store/db.ts', 'store/userStore.ts', 'store/toolRenames.ts', 'shared/wireContract.ts',
    'api/schemas/auth.ts', 'api/routes/auth.ts', 'auth/msSso.ts', 'brain/brainDeps.ts',
  ];

  it('no turn-path module reads disabled_tools or allowed_tools for itself', () => {
    const offenders = sourceFiles(root)
      .filter((path) => !OWNERS.some((owner) => path.endsWith(owner)))
      .filter((path) => /\b(disabled_tools|allowed_tools)\b/.test(stripComments(readFileSync(path, 'utf-8'))))
      .map((path) => path.slice(root.length));
    expect(offenders, 'authority must come from toolAuthorityForUser, never from a hand-rolled set').toEqual([]);
  });

  // The four wirings that RESOLVE an account's authority, plus the two turn builders that consume it.
  // `channels.ts` is deliberately absent: it receives an already-resolved policy as `opts.toolPolicy`, so
  // resolving one itself would be the second opinion this contract exists to prevent — and the test above
  // is what stops it growing one.
  it('every surface that mints a turn ToolPolicy asks the shared resolver', () => {
    for (const file of [
      'brain/brainService.ts', 'brain/service/delegatedSession.ts', 'daemon/bootstrap.ts',
      'brain/service/turnContextBuilder.ts', 'brain/platforms.ts',
    ]) {
      const source = readFileSync(join(root, file), 'utf-8');
      expect(source.includes('toolAuthorityFor'), `${file} must resolve authority through toolAuthorityFor`).toBe(true);
    }
  });
});
