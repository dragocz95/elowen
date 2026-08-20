import { describe, it, expect } from 'vitest';
import { PlatformOrchestrator } from '../../src/brain/platforms.js';
import { IdentityResolver } from '../../src/brain/identity.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { ChannelSendOpts } from '../../src/brain/channels.js';
import { READ_ONLY_AGENT_TOOLS, type AgentDef } from '../../src/brain/agents/agentRegistry.js';
import { normalizeDelegatedExecutionScope, PROMPT_TRUNCATION_MARKER } from '../../src/brain/delegatedScope.js';
import { delegatedChannelSendOpts, type DelegatedTurnRequest } from '../../src/brain/delegatedTurn.js';
import type { BrainEvent } from '../../src/brain/events.js';
import type { PlatformControlApi } from '../../src/plugins/api.js';

// A linked sender resolves to Elowen account #2 (non-admin); everyone else is unlinked.
const users = { get: (id: number) => ({ username: `u${id}` }) };
const linkedResolver = (linked: boolean) =>
  new IdentityResolver({ platformOwner: () => 1, resolvePlatformUser: () => (linked ? { id: 2, name: 'Amy', username: 'amy', admin: false } : null), users });

const userPolicy: Policy = { allowedProjectIds: new Set([7]), allowedPaths: () => ['/repo/7'] };
const rolePolicy: Policy = { allowedProjectIds: new Set([3]), allowedPaths: () => ['/repo/3'] };

/** The IN-PROCESS dispatch, wired exactly as BrainService wires it: the orchestrator hands over the
 *  delegated REQUEST and the shared builder composes the ChannelSendOpts the channel service receives.
 *  The delegated assertions below still read a real ChannelSendOpts — it is simply built one layer down
 *  now, in the single place the sub-agent runner builds it too. */
const dispatchInto = (
  channels: { send(o: ChannelSendOpts, text: string): Promise<string> },
  identity: IdentityResolver,
  policyForProjects?: (ids: number[]) => Policy,
) => ({
  send: (request: DelegatedTurnRequest, text: string, onEvent?: (e: BrainEvent) => void) =>
    channels.send(delegatedChannelSendOpts(request, { identity, ...(policyForProjects ? { policyForProjects } : {}) }, onEvent), text),
});
/** For a test whose platform never delegates: reaching the dispatch at all would be the bug. */
const noDispatch = { send: (): Promise<string> => Promise.reject(new Error('this test must not delegate')) };

/** Drive one inbound message through the orchestrator and capture the ChannelSendOpts it produces. */
async function runTurn(opts: { linked: boolean; access: Record<string, unknown> }): Promise<ChannelSendOpts> {
  let sent: ChannelSendOpts | undefined;
  let handler: ((src: never, text: string, onEvent?: unknown) => Promise<unknown>) | undefined;
  const adapter = { name: 'discord', listen: (fn: never) => { handler = fn as never; }, connect: async () => {}, control: () => {} };
  const orch = new PlatformOrchestrator({
    plugins: async () => ({
      platforms: [adapter],
      platformPromptsFor: (platform: string) => platform === 'discord' ? ['You are replying through Discord.'] : [],
    }) as never,
    platformOwner: () => 1,
    policyForProjects: () => rolePolicy,
    policyForUser: () => userPolicy,
    disabledToolsFor: () => ['DiscordApi'], // Amy disabled this tool in her Elowen account
    identity: linkedResolver(opts.linked),
    channels: { send: async (o: ChannelSendOpts) => { sent = o; return 'ok'; }, fragmentFor: () => '' } as never,
    dispatch: noDispatch,
  });
  await orch.startAll();
  await handler!({ platform: 'discord', userId: 'D9', channelId: 'c1', roleIds: [], access: opts.access } as never, 'hi');
  return sent!;
}

describe('PlatformOrchestrator — unified per-turn access', () => {
  it('appends the platform prompt even when a personal chat has no channel name', async () => {
    const sent = await runTurn({ linked: true, access: { admin: false, projectIds: [3] } });
    expect(sent.promptAppend).toEqual(['You are replying through Discord.']);
  });

  it('a LINKED sender runs fully through their Elowen account: their policy + their tool deny-list', async () => {
    const sent = await runTurn({ linked: true, access: { admin: false, projectIds: [3], tools: ['MemorySearch'] } });
    expect(sent.policy).toBe(userPolicy); // Elowen account policy, NOT the role's
    expect(sent.toolPolicy).toEqual({ deny: new Set(['DiscordApi']) }); // their disabled_tools, role allowlist ignored
    expect(sent.identity?.elowenUserId).toBe(2);
  });

  it('an UNLINKED sender falls back to the Role-ID policy + the role tool allowlist', async () => {
    const sent = await runTurn({ linked: false, access: { admin: false, projectIds: [3], tools: ['MemorySearch'] } });
    expect(sent.policy).toBe(rolePolicy); // the role's projects
    expect(sent.toolPolicy).toEqual({ allow: new Set(['MemorySearch']) }); // the role's tool allowlist
    expect(sent.identity?.elowenUserId).toBeUndefined();
  });

  it("an UNLINKED role with the '*' wildcard (or empty list) gets the FULL toolset, not an allow of literal '*'", async () => {
    const star = await runTurn({ linked: false, access: { admin: false, projectIds: [3], tools: ['*'] } });
    expect(star.toolPolicy).toBeUndefined(); // '*' = everything → no restriction (regression guard)
    const empty = await runTurn({ linked: false, access: { admin: false, projectIds: [3], tools: [] } });
    expect(empty.toolPolicy).toBeUndefined(); // empty list also = everything
  });

  it('an UNLINKED admin-role sender gets all-project policy and no tool restriction', async () => {
    const sent = await runTurn({ linked: false, access: { admin: true, projectIds: [], tools: undefined } });
    expect(sent.policy.allowedProjectIds).toBe('all');
    expect(sent.toolPolicy).toBeUndefined(); // admin role → full plugin toolset
  });

  it('runs a synthetic relay through the target account channel and only narrows its tools', async () => {
    let control: PlatformControlApi | undefined;
    let sent: ChannelSendOpts | undefined;
    let message = '';
    const adapter = {
      name: 'discord',
      listen: () => {},
      connect: async () => {},
      control: (api: PlatformControlApi) => { control = api; },
    };
    const orch = new PlatformOrchestrator({
      plugins: async () => ({ platforms: [adapter] }) as never,
      platformOwner: () => 1,
      policyForProjects: () => rolePolicy,
      policyForUser: () => userPolicy,
      disabledToolsFor: () => ['DiscordApi'],
      identity: linkedResolver(false),
      channels: {
        send: async (opts: ChannelSendOpts, text: string) => { sent = opts; message = text; return 'target reply'; },
        fragmentFor: () => '',
      } as never,
      dispatch: noDispatch,
    });
    await orch.startAll();

    const reply = await control!.relay({
      platform: 'discord', userId: 'D2', channelId: 'target#0', roleIds: [],
      access: { admin: false, projectIds: [3], actAsUserId: 2, denyTools: ['DiscordSend'] },
    }, 'agent relay');

    expect(reply).toBe('target reply');
    expect(message).toBe('agent relay');
    expect(sent).toMatchObject({ channelId: 'discord-target#0', writerUserId: 2, policy: userPolicy });
    expect(sent?.toolPolicy).toEqual({ deny: new Set(['DiscordApi', 'DiscordSend']) });
    expect(sent?.identity?.elowenUserId).toBe(2);
  });

  it('anchors a delegated child to its non-owner parent account, never the platform owner', async () => {
    let sent: ChannelSendOpts | undefined;
    let handler: ((src: never, text: string) => Promise<unknown>) | undefined;
    const adapter = { name: 'subagent', listen: (fn: never) => { handler = fn as never; }, connect: async () => {} };
    const channels = {
      sessionOwnerUserId: (sessionId: string) => sessionId === 'brain-2' ? 2 : undefined,
      send: async (o: ChannelSendOpts) => { sent = o; return 'ok'; },
      fragmentFor: () => '',
    };
    const resolver = linkedResolver(false);
    const orch = new PlatformOrchestrator({
      plugins: async () => ({ platforms: [adapter] }) as never,
      platformOwner: () => 1,
      policyForProjects: () => rolePolicy,
      identity: resolver,
      channels: channels as never,
      dispatch: dispatchInto(channels, resolver, () => rolePolicy),
    });
    await orch.startAll();

    await handler!({
      platform: 'subagent', userId: 'subagent', channelId: 'sub-1', roleIds: [],
      access: { admin: true, projectIds: [], parentSessionId: 'brain-2', permissionBoundary: null },
    } as never, 'inspect');

    expect(sent).toMatchObject({ ownerUserId: 2, parentSessionId: 'brain-2' });
    expect(sent?.identity?.owner).toBe(false); // a second admin's child is not the instance operator
  });

  // The parent-supplied context used to travel as ONE string, so the delegated-scope per-chunk bound
  // (8 000 chars) applied to every workflow dependency result joined together and a wide fan-in reached
  // its node with a fraction of the text. Each block must land as its OWN prompt append.
  it('carries a delegated child\'s context blocks as separate prompt appends', async () => {
    let sent: ChannelSendOpts | undefined;
    let handler: ((src: never, text: string) => Promise<unknown>) | undefined;
    const adapter = { name: 'subagent', listen: (fn: never) => { handler = fn as never; }, connect: async () => {} };
    const channels = {
      sessionOwnerUserId: () => 1,
      send: async (o: ChannelSendOpts) => { sent = o; return 'ok'; },
      fragmentFor: () => '',
    };
    const resolver = linkedResolver(false);
    const orch = new PlatformOrchestrator({
      plugins: async () => ({ platforms: [adapter] }) as never,
      platformOwner: () => 1,
      policyForProjects: () => rolePolicy,
      identity: resolver,
      channels: channels as never,
      dispatch: dispatchInto(channels, resolver, () => rolePolicy),
    });
    await orch.startAll();

    await handler!({
      platform: 'subagent', userId: 'subagent', channelId: 'sub-chunks', roleIds: [],
      access: {
        admin: true, owner: true, projectIds: [], parentSessionId: 'brain-1', permissionBoundary: null,
        prompt: 'role', context: ['shared background', 'result from node "a"', '  ', 'result from node "b"'],
      },
    } as never, 'inspect');

    // Blank blocks are dropped; the rest keep their order and stay separate, so each is bounded on its own.
    expect(sent?.promptAppend).toEqual(['role', 'shared background', 'result from node "a"', 'result from node "b"']);
    expect(sent?.delegatedAccess?.promptAppend).toEqual(['role', 'shared background', 'result from node "a"', 'result from node "b"']);
  });

  it('still accepts a delegated child\'s context as a single string', async () => {
    let sent: ChannelSendOpts | undefined;
    let handler: ((src: never, text: string) => Promise<unknown>) | undefined;
    const adapter = { name: 'subagent', listen: (fn: never) => { handler = fn as never; }, connect: async () => {} };
    const channels = {
      sessionOwnerUserId: () => 1,
      send: async (o: ChannelSendOpts) => { sent = o; return 'ok'; },
      fragmentFor: () => '',
    };
    const resolver = linkedResolver(false);
    const orch = new PlatformOrchestrator({
      plugins: async () => ({ platforms: [adapter] }) as never,
      platformOwner: () => 1,
      policyForProjects: () => rolePolicy,
      identity: resolver,
      channels: channels as never,
      dispatch: dispatchInto(channels, resolver, () => rolePolicy),
    });
    await orch.startAll();

    await handler!({
      platform: 'subagent', userId: 'subagent', channelId: 'sub-string', roleIds: [],
      access: {
        admin: true, owner: true, projectIds: [], parentSessionId: 'brain-1', permissionBoundary: null,
        prompt: 'role', context: 'one block',
      },
    } as never, 'inspect');

    expect(sent?.promptAppend).toEqual(['role', 'one block']);
  });

  /** Drive one delegated spawn and capture what the host handed the child. `fragment` stands in for the
   *  shared-channel system-prompt block, which is appended to the very same prompt budget. */
  const runDelegateWith = async (access: Record<string, unknown>, fragment = ''): Promise<ChannelSendOpts> => {
    let sent: ChannelSendOpts | undefined;
    let handler: ((src: never, text: string) => Promise<unknown>) | undefined;
    const adapter = { name: 'subagent', listen: (fn: never) => { handler = fn as never; }, connect: async () => {} };
    const channels = {
      sessionOwnerUserId: () => 1,
      send: async (o: ChannelSendOpts) => { sent = o; return 'ok'; },
      fragmentFor: () => fragment,
    };
    const resolver = linkedResolver(false);
    const orch = new PlatformOrchestrator({
      plugins: async () => ({ platforms: [adapter], platformPromptsFor: () => ['must not reach subagents'] }) as never,
      platformOwner: () => 1,
      policyForProjects: () => rolePolicy,
      identity: resolver,
      channels: channels as never,
      dispatch: dispatchInto(channels, resolver, () => rolePolicy),
    });
    await orch.startAll();
    await handler!({
      platform: 'subagent', userId: 'subagent', channelId: 'sub-budget', roleIds: [],
      ...(fragment ? { channelName: 'general' } : {}),
      access: { admin: true, owner: true, projectIds: [], parentSessionId: 'brain-1', permissionBoundary: null, ...access },
    } as never, 'inspect');
    return sent!;
  };

  // A user-authored `.md` agent role is not bounded by anything upstream. At 20 000 chars it breaches the
  // 8 000-char per-chunk scope ceiling on its own, which used to make normalizeDelegatedExecutionScope
  // reject the WHOLE scope: the delegation threw and the child never ran, with nothing saying why.
  it('splits an oversized role prompt across chunks instead of failing the whole delegation', async () => {
    const role = `ROLE-START${'r'.repeat(19_980)}ROLE-END`;
    const sent = await runDelegateWith({ prompt: role });
    const appends = sent.delegatedAccess?.promptAppend ?? [];
    expect(normalizeDelegatedExecutionScope(sent.delegatedAccess)).toBeDefined();
    expect(appends.length).toBeGreaterThan(1); // split, not dropped and not squeezed into one oversized chunk
    // The role arrives whole: 20 000 chars fit the 32 000-char total, they just need several chunks.
    const rejoined = appends.map((chunk) => chunk.replace(/^\[part \d+ of \d+\]\n/, '')).join('');
    expect(rejoined).toBe(role);
  });

  // Role + a context at the plugin's own maximum + the channel fragment is the combination that overruns
  // the 32 000-char total. The scope must still normalize (the child runs), and everything shortened has
  // to say so — a child silently missing half its role has no way to know.
  it('keeps role, context and channel fragment inside the scope budget, marking what it had to cut', async () => {
    // Sized to overflow the scope budget on purpose — the point of this test is what happens when the
    // sections together do NOT fit, so the load has to stay past the ceiling as that ceiling is raised.
    const context = Array.from({ length: 12 }, (_, i) => `block-${i}:${'c'.repeat(6_000)}`);
    const sent = await runDelegateWith(
      { prompt: `ROLE:${'r'.repeat(59_995)}`, context },
      `You are talking on Discord in #general.${'f'.repeat(400)}`,
    );
    const appends = sent.delegatedAccess?.promptAppend ?? [];
    expect(normalizeDelegatedExecutionScope(sent.delegatedAccess)).toBeDefined();
    expect(appends.length).toBeLessThanOrEqual(16);
    for (const chunk of appends) expect(chunk.length).toBeLessThanOrEqual(8_000);
    expect(appends.reduce((n, chunk) => n + chunk.length, 0)).toBeLessThanOrEqual(120_000);
    // The role still leads the appends, and the parent's context blocks all survive.
    expect(appends[0]).toContain('ROLE:');
    for (const block of context) expect(appends.join('\n')).toContain(block.slice(0, 20));
    // Nothing was shortened in silence.
    expect(appends.join('\n')).toContain(PROMPT_TRUNCATION_MARKER.trim());
  });

  it('preserves delegated origin-owner truth and exact allow+deny policy for an owner-anchored parent', async () => {
    let sent: ChannelSendOpts | undefined;
    let handler: ((src: never, text: string) => Promise<unknown>) | undefined;
    const adapter = { name: 'subagent', listen: (fn: never) => { handler = fn as never; }, connect: async () => {} };
    const channels = {
      sessionOwnerUserId: () => 1,
      send: async (o: ChannelSendOpts) => { sent = o; return 'ok'; },
      fragmentFor: () => '',
    };
    const resolver = linkedResolver(false);
    const orch = new PlatformOrchestrator({
      plugins: async () => ({ platforms: [adapter] }) as never,
      platformOwner: () => 1,
      policyForProjects: () => rolePolicy,
      identity: resolver,
      channels: channels as never,
      dispatch: dispatchInto(channels, resolver, () => rolePolicy),
    });
    await orch.startAll();

    await handler!({
      platform: 'subagent', userId: 'subagent', channelId: 'sub-foreign-admin', roleIds: [],
      access: {
        admin: true, owner: false, projectIds: [], parentSessionId: 'brain-owner-channel',
        toolPolicy: { allow: [], deny: ['DiscordApi'] },
        permissionBoundary: null,
      },
    } as never, 'inspect');

    expect(sent?.identity).toMatchObject({ admin: true, owner: false });
    expect(sent?.toolPolicy).toEqual({ allow: new Set(), deny: new Set(['DiscordApi']) });
    expect(sent?.delegatedAccess).toEqual({
      admin: true, projectIds: [], owner: false,
      permissionBoundary: null,
      toolPolicy: { allow: [], deny: ['DiscordApi'] },
    });
  });

  it('persists the account disabled-tools union in a delegated scope, never just the caller policy', async () => {
    let sent: ChannelSendOpts | undefined;
    let handler: ((src: never, text: string) => Promise<unknown>) | undefined;
    const adapter = { name: 'subagent', listen: (fn: never) => { handler = fn as never; }, connect: async () => {} };
    const channels = {
      sessionOwnerUserId: () => 1,
      send: async (o: ChannelSendOpts) => { sent = o; return 'ok'; },
      fragmentFor: () => '',
    };
    const resolver = linkedResolver(false);
    const orch = new PlatformOrchestrator({
      plugins: async () => ({ platforms: [adapter] }) as never,
      platformOwner: () => 1,
      policyForProjects: () => rolePolicy,
      disabledToolsFor: () => ['terminal_exec'],
      identity: resolver,
      channels: channels as never,
      dispatch: dispatchInto(channels, resolver, () => rolePolicy),
    });
    await orch.startAll();

    await handler!({
      platform: 'subagent', userId: 'subagent', channelId: 'sub-scope', roleIds: [],
      access: { admin: false, owner: true, projectIds: [3], parentSessionId: 'brain-owner', toolPolicy: { allow: ['Read'] }, permissionBoundary: null },
    } as never, 'inspect');

    expect(sent?.delegatedAccess).toEqual({
      admin: false, owner: true, projectIds: [3],
      permissionBoundary: null,
      toolPolicy: { allow: ['Read'], deny: ['terminal_exec'] },
    });
    expect(sent?.toolPolicy).toEqual({ allow: new Set(['Read']), deny: new Set(['terminal_exec']) });
  });

  it('carries a linked non-owner granular deny into the immutable child scope', async () => {
    let sent: ChannelSendOpts | undefined;
    let handler: ((src: never, text: string) => Promise<unknown>) | undefined;
    const adapter = { name: 'subagent', listen: (fn: never) => { handler = fn as never; }, connect: async () => {} };
    const boundary = {
      rules: [{ scope: 'tools' as const, pattern: 'Write', action: 'deny' as const }],
      unattendedAsks: 'deny' as const,
    };
    const channels = {
      sessionOwnerUserId: () => 1,
      send: async (o: ChannelSendOpts) => { sent = o; return 'ok'; },
      fragmentFor: () => '',
    };
    // The parent row belongs to the platform owner, while the original linked Discord participant is
    // a different account. The boundary must therefore travel in source access, not be inferred later.
    const resolver = linkedResolver(true);
    const orch = new PlatformOrchestrator({
      plugins: async () => ({ platforms: [adapter] }) as never,
      platformOwner: () => 1,
      policyForProjects: () => rolePolicy,
      identity: resolver,
      channels: channels as never,
      dispatch: dispatchInto(channels, resolver, () => rolePolicy),
    });
    await orch.startAll();

    await handler!({
      platform: 'subagent', userId: 'subagent', channelId: 'sub-linked-non-owner', roleIds: [],
      access: { admin: false, owner: false, projectIds: [3], parentSessionId: 'brain-owner', permissionBoundary: boundary },
    } as never, 'inspect');

    expect(sent?.delegatedAccess).toMatchObject({
      admin: false, owner: false, projectIds: [3], permissionBoundary: boundary,
    });
    expect(sent?.writerUserId).toBeUndefined(); // no owner/private-memory identity crosses the boundary
  });

  // A read-only agent TYPE (or a bare read_only delegation) reaches the child with the read-only preset —
  // read-only tools PLUS Bash (shell-gated by the minted boundary). Guards against two past regressions:
  //   1) a redundant read_only on the call stripping the type's shell, and
  //   2) a parent disabled-tools DENY list suppressing the preset (a deny is not an allow-list), which would
  //      over-widen the child to "everything but the denied tool".
  const exploreDef = (): Map<string, AgentDef> => new Map([['explore', {
    name: 'explore', description: 'read-only explore', body: 'You explore.',
    toolsSpec: 'read-only', source: 'builtin', filePath: '/explore.md',
  }]]);
  const runTypedDelegate = async (access: Record<string, unknown>): Promise<ChannelSendOpts> => {
    let sent: ChannelSendOpts | undefined;
    let handler: ((src: never, text: string) => Promise<unknown>) | undefined;
    const adapter = { name: 'subagent', listen: (fn: never) => { handler = fn as never; }, connect: async () => {} };
    const channels = { sessionOwnerUserId: () => 1, send: async (o: ChannelSendOpts) => { sent = o; return 'ok'; }, fragmentFor: () => '' };
    const resolver = linkedResolver(false);
    const orch = new PlatformOrchestrator({
      plugins: async () => ({ platforms: [adapter] }) as never,
      platformOwner: () => 1,
      policyForProjects: () => rolePolicy,
      identity: resolver,
      agents: exploreDef,
      channels: channels as never,
      dispatch: dispatchInto(channels, resolver, () => rolePolicy),
    });
    await orch.startAll();
    await handler!({ platform: 'subagent', userId: 'subagent', channelId: 'sub-typed', roleIds: [], access } as never, 'inspect');
    return sent!;
  };

  const sortedAllow = (sent: ChannelSendOpts): string[] => [...(sent.delegatedAccess?.toolPolicy?.allow ?? [])].sort();
  const presetSorted = [...READ_ONLY_AGENT_TOOLS].sort();

  it('applies the read-only type preset (incl. Bash) when the call pinned no allow-list', async () => {
    const sent = await runTypedDelegate({
      admin: false, owner: true, projectIds: [3], parentSessionId: 'brain-owner',
      agentType: 'explore', permissionBoundary: null,
    });
    expect(sortedAllow(sent)).toEqual(presetSorted);
    expect(sent.delegatedAccess?.toolPolicy?.allow).toContain('Bash');
  });

  it('keeps the preset AND the parent deny-list when the parent has disabled tools', async () => {
    const sent = await runTypedDelegate({
      admin: false, owner: true, projectIds: [3], parentSessionId: 'brain-owner',
      agentType: 'explore', toolPolicy: { deny: ['GitStatus'] }, permissionBoundary: null,
    });
    // The preset still sets the positive toolset (over-widen fixed) and the deny rides on top.
    expect(sortedAllow(sent)).toEqual(presetSorted);
    expect(sent.delegatedAccess?.toolPolicy?.deny).toEqual(['GitStatus']);
  });

  it('intersects an explicit call-level allow-list with the type preset (both only narrow)', async () => {
    const sent = await runTypedDelegate({
      admin: false, owner: true, projectIds: [3], parentSessionId: 'brain-owner',
      agentType: 'explore', toolPolicy: { allow: ['Read'] }, permissionBoundary: null,
    });
    expect(sent.delegatedAccess?.toolPolicy?.allow).toEqual(['Read']); // Read ∩ READ_ONLY_AGENT_TOOLS = Read
  });

  it('throws when the call-level allow-list is disjoint from the type preset (empty intersection)', async () => {
    // Write is not in READ_ONLY_AGENT_TOOLS — and never can be, since withholding it is the whole point
    // of the preset — so preset ∩ ['Write'] = [] and the child would have no tool it could ever run. The
    // host fails the spawn instead of muting it silently.
    await expect(runTypedDelegate({
      admin: false, owner: true, projectIds: [3], parentSessionId: 'brain-owner',
      agentType: 'explore', toolPolicy: { allow: ['Write'] }, permissionBoundary: null,
    })).rejects.toThrow('delegated tool scope is empty');
  });

  it('a bare read_only delegation (no type) takes the same host-side read-only path', async () => {
    // read_only without a subagent_type: the host applies READ_ONLY_AGENT_TOOLS + the minted boundary, so a
    // generic read-only child now gets read-only shell too — one read-only definition, no plugin toolset.
    const sent = await runTypedDelegate({
      admin: false, owner: true, projectIds: [3], parentSessionId: 'brain-owner',
      readOnly: true, permissionBoundary: null,
    });
    expect(sortedAllow(sent)).toEqual(presetSorted);
    expect(sent.delegatedAccess?.toolPolicy?.allow).toContain('Bash');
    // The minted read-only boundary denies writes and non-allowlisted shell even unattended.
    expect(sent.delegatedAccess?.permissionBoundary?.unattendedAsks).toBe('deny');
  });

  it('an origin-carrying message routes through the BOUND send (no channel session touched)', async () => {
    let sent: ChannelSendOpts | undefined;
    let handler: ((src: never, text: string, onEvent?: unknown) => Promise<unknown>) | undefined;
    const adapter = { name: 'cron', listen: (fn: never) => { handler = fn as never; }, connect: async () => {} };
    const originCalls: [number, string, string][] = [];
    const orch = new PlatformOrchestrator({
      plugins: async () => ({ platforms: [adapter] }) as never,
      platformOwner: () => 1,
      identity: linkedResolver(false),
      channels: { send: async (o: ChannelSendOpts) => { sent = o; return 'channel reply'; }, fragmentFor: () => '' } as never,
      dispatch: noDispatch,
      originSend: async (userId, sessionId, text) => { originCalls.push([userId, sessionId, text]); return 'bound reply'; },
    });
    await orch.startAll();
    const reply = await handler!({ platform: 'cron', userId: 'cron', channelId: 'job-1', roleIds: [],
      origin: { sessionId: 'brain-1-abc', userId: 1 }, access: { admin: true, projectIds: [] } } as never, 'wake up');
    expect(reply).toBe('bound reply');
    expect(originCalls).toEqual([[1, 'brain-1-abc', 'wake up']]);
    expect(sent).toBeUndefined(); // the channel path never ran
  });

  it('falls back to the channel path when the bound send refuses (origin session gone / foreign)', async () => {
    let sent: ChannelSendOpts | undefined;
    let handler: ((src: never, text: string) => Promise<unknown>) | undefined;
    const adapter = { name: 'cron', listen: (fn: never) => { handler = fn as never; }, connect: async () => {} };
    const orch = new PlatformOrchestrator({
      plugins: async () => ({ platforms: [adapter] }) as never,
      platformOwner: () => 1,
      identity: linkedResolver(false),
      channels: { send: async (o: ChannelSendOpts) => { sent = o; return 'channel reply'; }, fragmentFor: () => '' } as never,
      dispatch: noDispatch,
      originSend: async () => null, // ownership check failed host-side
    });
    await orch.startAll();
    const reply = await handler!({ platform: 'cron', userId: 'cron', channelId: 'job-1', roleIds: [],
      origin: { sessionId: 'brain-1-gone', userId: 1 }, access: { admin: true, projectIds: [] } } as never, 'wake up');
    expect(reply).toBe('channel reply');
    expect(sent?.channelId).toBe('cron-job-1'); // today's channel-keyed session
  });

  it('never falls back to the channel path for a job bound to an ACCOUNT rather than a conversation', async () => {
    let sent: ChannelSendOpts | undefined;
    let handler: ((src: never, text: string) => Promise<unknown>) | undefined;
    const adapter = { name: 'cron', listen: (fn: never) => { handler = fn as never; }, connect: async () => {} };
    const orch = new PlatformOrchestrator({
      plugins: async () => ({ platforms: [adapter] }) as never,
      platformOwner: () => 1,
      identity: linkedResolver(false),
      channels: { send: async (o: ChannelSendOpts) => { sent = o; return 'channel reply'; }, fragmentFor: () => '' } as never,
      dispatch: noDispatch,
      originSend: async () => null,
    });
    await orch.startAll();
    // The channel session is anchored on the instance owner, so falling through would persist this
    // person's job transcript under the operator's account. The scheduler keeps the outcome itself.
    const reply = await handler!({ platform: 'cron', userId: 'cron', channelId: 'job-1', roleIds: [],
      origin: { userId: 9 }, access: { admin: false, projectIds: [], actAsUserId: 9 } } as never, 'run it');
    expect(reply).toBeUndefined();
    expect(sent).toBeUndefined();
  });

  // A proactive push that reached nobody used to resolve like a successful one, so the cron scheduler
  // deleted the pending delivery it had promised to retry and the finished result was lost for good.
  describe('proactive notify', () => {
    const orchestratorWith = async (adapters: { name: string; notify?: (t: string, channelId?: string, notice?: unknown) => Promise<void> }[]) => {
      const orch = new PlatformOrchestrator({
        plugins: async () => ({ platforms: adapters.map((a) => ({ ...a, listen: () => {}, connect: async () => {} })) }) as never,
        platformOwner: () => 1,
        identity: linkedResolver(false),
        channels: { send: async () => 'ok', fragmentFor: () => '' } as never,
        dispatch: noDispatch,
      });
      await orch.startAll();
      return orch;
    };

    it('reports failure when EVERY notification sink threw', async () => {
      const orch = await orchestratorWith([
        { name: 'discord', notify: async () => { throw new Error('discord 500'); } },
        { name: 'telegram', notify: async () => { throw new Error('telegram timeout'); } },
      ]);
      await expect(orch.notify('the report')).rejects.toThrow(/discord 500.*telegram timeout/);
    });

    it('stays fail-open when one sink is down but another delivered', async () => {
      const delivered: string[] = [];
      const orch = await orchestratorWith([
        { name: 'discord', notify: async () => { throw new Error('discord 500'); } },
        { name: 'telegram', notify: async (t: string) => { delivered.push(t); } },
      ]);
      await expect(orch.notify('the report')).resolves.toBeUndefined();
      expect(delivered).toEqual(['the report']);
    });

    it('routes an encoded destination only to its owning platform and unwraps the raw id', async () => {
      const seen: { platform: string; channelId?: string }[] = [];
      const orch = await orchestratorWith([
        { name: 'discord', notify: async (_text, channelId) => { seen.push({ platform: 'discord', channelId }); } },
        { name: 'msteams', notify: async (_text, channelId) => { seen.push({ platform: 'msteams', channelId }); } },
      ]);
      await orch.notify('the report', 'destination:msteams:a%3Aconversation');
      expect(seen).toEqual([{ platform: 'msteams', channelId: 'a:conversation' }]);
    });

    it('rejects a targeted destination while its platform is unavailable so durable delivery retries', async () => {
      const orch = await orchestratorWith([{ name: 'msteams' }]);
      await expect(orch.notify('the report', 'destination:msteams:a%3Aconversation')).rejects.toThrow(/no notification sink/);
    });

    it('never broadcasts a stale or malformed routed destination through another platform', async () => {
      const seen: string[] = [];
      const orch = await orchestratorWith([{ name: 'msteams', notify: async () => { seen.push('msteams'); } }]);
      await expect(orch.notify('the report', 'destination:discord:100')).rejects.toThrow(/discord.*unavailable/);
      await expect(orch.notify('the report', 'destination:msteams:%E0%A4%A')).rejects.toThrow(/invalid notification destination/);
      expect(seen).toEqual([]);
    });

    it('resolves when no platform has a notification channel at all', async () => {
      const orch = await orchestratorWith([{ name: 'cron' }]);
      await expect(orch.notify('the report')).resolves.toBeUndefined();
    });

    // The daemon words its lifecycle announcements in English and names them, so an adapter can say them
    // in its configured language. Drop the descriptor anywhere along this path and nothing looks broken:
    // the English fallback still arrives, and a translated instance silently stays English forever.
    it('hands the notice descriptor to the adapter alongside the text', async () => {
      const seen: { text: string; notice?: unknown }[] = [];
      const orch = await orchestratorWith([
        { name: 'discord', notify: async (text, _channelId, notice) => { seen.push({ text, notice }); } },
      ]);
      await orch.notify('🛑 **Stopping** — Elowen is shutting down.', undefined, { key: 'stoppingIdle' });
      expect(seen).toEqual([{ text: '🛑 **Stopping** — Elowen is shutting down.', notice: { key: 'stoppingIdle' } }]);
    });

    it('leaves free-form notifications without a descriptor', async () => {
      const seen: unknown[] = [];
      const orch = await orchestratorWith([
        { name: 'discord', notify: async (_text, _channelId, notice) => { seen.push(notice); } },
      ]);
      await orch.notify('the cron result');
      expect(seen).toEqual([undefined]);
    });
  });

  it('a LINKED sender with no disabled tools gets an undefined tool policy (no restriction)', async () => {
    let sent: ChannelSendOpts | undefined;
    let handler: ((src: never, text: string) => Promise<unknown>) | undefined;
    const adapter = { name: 'discord', listen: (fn: never) => { handler = fn as never; }, connect: async () => {}, control: () => {} };
    const orch = new PlatformOrchestrator({
      plugins: async () => ({ platforms: [adapter] }) as never,
      platformOwner: () => 1,
      policyForProjects: () => rolePolicy,
      policyForUser: () => userPolicy,
      disabledToolsFor: () => [], // nothing disabled
      identity: linkedResolver(true),
      channels: { send: async (o: ChannelSendOpts) => { sent = o; return 'ok'; }, fragmentFor: () => '' } as never,
      dispatch: noDispatch,
    });
    await orch.startAll();
    await handler!({ platform: 'discord', userId: 'D9', channelId: 'c1', roleIds: [], access: { admin: false, projectIds: [3] } } as never, 'hi');
    expect(sent!.toolPolicy).toBeUndefined();
    expect(sent!.policy).toBe(userPolicy);
  });
});
