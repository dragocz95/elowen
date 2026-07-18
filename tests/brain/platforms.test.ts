import { describe, it, expect } from 'vitest';
import { PlatformOrchestrator } from '../../src/brain/platforms.js';
import { IdentityResolver } from '../../src/brain/identity.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { ChannelSendOpts } from '../../src/brain/channels.js';
import { READ_ONLY_AGENT_TOOLS, type AgentDef } from '../../src/brain/agents/agentRegistry.js';

// A linked sender resolves to Elowen account #2 (non-admin); everyone else is unlinked.
const users = { get: (id: number) => ({ username: `u${id}` }) };
const linkedResolver = (linked: boolean) =>
  new IdentityResolver({ platformOwner: () => 1, resolvePlatformUser: () => (linked ? { id: 2, name: 'Amy', username: 'amy', admin: false } : null), users });

const userPolicy: Policy = { allowedProjectIds: new Set([7]), allowedPaths: () => ['/repo/7'] };
const rolePolicy: Policy = { allowedProjectIds: new Set([3]), allowedPaths: () => ['/repo/3'] };

/** Drive one inbound message through the orchestrator and capture the ChannelSendOpts it produces. */
async function runTurn(opts: { linked: boolean; access: Record<string, unknown> }): Promise<ChannelSendOpts> {
  let sent: ChannelSendOpts | undefined;
  let handler: ((src: never, text: string, onEvent?: unknown) => Promise<unknown>) | undefined;
  const adapter = { name: 'discord', listen: (fn: never) => { handler = fn as never; }, connect: async () => {}, control: () => {} };
  const orch = new PlatformOrchestrator({
    plugins: async () => ({ platforms: [adapter] }) as never,
    platformOwner: () => 1,
    policyForProjects: () => rolePolicy,
    policyForUser: () => userPolicy,
    disabledToolsFor: () => ['DiscordApi'], // Amy disabled this tool in her Elowen account
    identity: linkedResolver(opts.linked),
    channels: { send: async (o: ChannelSendOpts) => { sent = o; return 'ok'; }, fragmentFor: () => '' } as never,
  });
  await orch.startAll();
  await handler!({ platform: 'discord', userId: 'D9', channelId: 'c1', roleIds: [], access: opts.access } as never, 'hi');
  return sent!;
}

describe('PlatformOrchestrator — unified per-turn access', () => {
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

  it('anchors a delegated child to its non-owner parent account, never the platform owner', async () => {
    let sent: ChannelSendOpts | undefined;
    let handler: ((src: never, text: string) => Promise<unknown>) | undefined;
    const adapter = { name: 'subagent', listen: (fn: never) => { handler = fn as never; }, connect: async () => {} };
    const channels = {
      sessionOwnerUserId: (sessionId: string) => sessionId === 'brain-2' ? 2 : undefined,
      send: async (o: ChannelSendOpts) => { sent = o; return 'ok'; },
      fragmentFor: () => '',
    };
    const orch = new PlatformOrchestrator({
      plugins: async () => ({ platforms: [adapter] }) as never,
      platformOwner: () => 1,
      policyForProjects: () => rolePolicy,
      identity: linkedResolver(false),
      channels: channels as never,
    });
    await orch.startAll();

    await handler!({
      platform: 'subagent', userId: 'subagent', channelId: 'sub-1', roleIds: [],
      access: { admin: true, projectIds: [], parentSessionId: 'brain-2', permissionBoundary: null },
    } as never, 'inspect');

    expect(sent).toMatchObject({ ownerUserId: 2, parentSessionId: 'brain-2' });
    expect(sent?.identity?.owner).toBe(false); // a second admin's child is not the instance operator
  });

  it('preserves delegated origin-owner truth and exact allow+deny policy for an owner-anchored parent', async () => {
    let sent: ChannelSendOpts | undefined;
    let handler: ((src: never, text: string) => Promise<unknown>) | undefined;
    const adapter = { name: 'subagent', listen: (fn: never) => { handler = fn as never; }, connect: async () => {} };
    const orch = new PlatformOrchestrator({
      plugins: async () => ({ platforms: [adapter] }) as never,
      platformOwner: () => 1,
      policyForProjects: () => rolePolicy,
      identity: linkedResolver(false),
      channels: {
        sessionOwnerUserId: () => 1, // shared Discord parent rows are anchored to the operator
        send: async (o: ChannelSendOpts) => { sent = o; return 'ok'; },
        fragmentFor: () => '',
      } as never,
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
    const orch = new PlatformOrchestrator({
      plugins: async () => ({ platforms: [adapter] }) as never,
      platformOwner: () => 1,
      policyForProjects: () => rolePolicy,
      disabledToolsFor: () => ['terminal_exec'],
      identity: linkedResolver(false),
      channels: {
        sessionOwnerUserId: () => 1,
        send: async (o: ChannelSendOpts) => { sent = o; return 'ok'; },
        fragmentFor: () => '',
      } as never,
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
    const orch = new PlatformOrchestrator({
      plugins: async () => ({ platforms: [adapter] }) as never,
      platformOwner: () => 1,
      policyForProjects: () => rolePolicy,
      // The parent row belongs to the platform owner, while the original linked Discord participant is
      // a different account. The boundary must therefore travel in source access, not be inferred later.
      identity: linkedResolver(true),
      channels: {
        sessionOwnerUserId: () => 1,
        send: async (o: ChannelSendOpts) => { sent = o; return 'ok'; },
        fragmentFor: () => '',
      } as never,
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
    const orch = new PlatformOrchestrator({
      plugins: async () => ({ platforms: [adapter] }) as never,
      platformOwner: () => 1,
      policyForProjects: () => rolePolicy,
      identity: linkedResolver(false),
      agents: exploreDef,
      channels: { sessionOwnerUserId: () => 1, send: async (o: ChannelSendOpts) => { sent = o; return 'ok'; }, fragmentFor: () => '' } as never,
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
      originSend: async () => null, // ownership check failed host-side
    });
    await orch.startAll();
    const reply = await handler!({ platform: 'cron', userId: 'cron', channelId: 'job-1', roleIds: [],
      origin: { sessionId: 'brain-1-gone', userId: 1 }, access: { admin: true, projectIds: [] } } as never, 'wake up');
    expect(reply).toBe('channel reply');
    expect(sent?.channelId).toBe('cron-job-1'); // today's channel-keyed session
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
    });
    await orch.startAll();
    await handler!({ platform: 'discord', userId: 'D9', channelId: 'c1', roleIds: [], access: { admin: false, projectIds: [3] } } as never, 'hi');
    expect(sent!.toolPolicy).toBeUndefined();
    expect(sent!.policy).toBe(userPolicy);
  });
});
