import { describe, it, expect } from 'vitest';
import { PlatformOrchestrator } from '../../src/brain/platforms.js';
import { IdentityResolver } from '../../src/brain/identity.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { ToolPolicy } from '../../src/plugins/policyContext.js';
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
async function runTurn(opts: { linked: boolean; access: Record<string, unknown> }): Promise<ChannelSendOpts | undefined> {
  let sent: ChannelSendOpts | undefined;
  let handler: ((src: never, text: string, onEvent?: unknown) => Promise<unknown>) | undefined;
  const adapter = { name: 'discord', listen: (fn: never) => { handler = fn as never; }, connect: async () => {}, control: () => {} };
  const orch = new PlatformOrchestrator({
    plugins: async () => ({
      platforms: [adapter],
      platformPromptsFor: (platform: string) => platform === 'discord' ? ['You are replying through Discord.'] : [],
    }) as never,
    platformOwner: () => 1,
    policyForUser: () => userPolicy,
    toolAuthorityFor: () => ({ deny: new Set(['DiscordApi']) }), // Amy disabled this tool in her Elowen account
    identity: linkedResolver(opts.linked),
    channels: { sessionOwnerUserId: () => undefined, send: async (o: ChannelSendOpts) => { sent = o; return 'ok'; }, fragmentFor: () => '', setLastWriter: () => {} } as never,
    dispatch: noDispatch,
  });
  await orch.startAll();
  await handler!({ platform: 'discord', userId: 'D9', channelId: 'c1', roleIds: [], access: opts.access } as never, 'hi');
  return sent;
}

describe('PlatformOrchestrator — unified per-turn access', () => {
  it('appends the platform prompt even when a personal chat has no channel name', async () => {
    const sent = await runTurn({ linked: true, access: { admin: false, projectIds: [3] } });
    expect(sent?.promptAppend).toEqual(['You are replying through Discord.']);
  });

  it('a linked sender in a shared room uses their account policy and personal deny-list', async () => {
    const sent = await runTurn({
      linked: true,
      access: { admin: false, projectIds: [3], tools: ['MemorySearch'], denyTools: ['DiscordSend'] },
    });
    expect(sent?.policy).toBe(userPolicy);
    expect(sent?.toolPolicy).toEqual({ deny: new Set(['DiscordApi', 'DiscordSend']) });
    expect(sent?.identity).toMatchObject({ elowenUserId: 2, admin: false, owner: false, conversation: 'shared' });
  });

  it('an UNLINKED sender gets no project access, no tools and no model turn', async () => {
    const sent = await runTurn({
      linked: false,
      access: { admin: true, projectIds: [3], tools: ['MemorySearch'], denyTools: ['DiscordSend'] },
    });
    expect(sent).toBeUndefined();
  });

  it('runs a synthetic relay through the target account policy and only narrows its tools', async () => {
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
      policyForUser: () => userPolicy,
      toolAuthorityFor: () => ({ deny: new Set(['DiscordApi']) }),
      identity: linkedResolver(false),
      channels: {
          sessionOwnerUserId: () => undefined,
        send: async (opts: ChannelSendOpts, text: string) => { sent = opts; message = text; return 'target reply'; },
        fragmentFor: () => '', setLastWriter: () => {},
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
    expect(sent?.identity).toMatchObject({ elowenUserId: 2, admin: false, owner: false, conversation: 'shared' });
  });

  it('reads and writes Fast for the invoking linked account, with per-user isolation', async () => {
    let control: PlatformControlApi | undefined;
    const fast = new Map<number, boolean>();
    const identity = new IdentityResolver({
      platformOwner: () => 1,
      resolvePlatformUser: (_platform, platformUserId) => platformUserId === 'D2'
        ? { id: 2, name: 'Amy', admin: false }
        : platformUserId === 'D3' ? { id: 3, name: 'Bob', admin: false } : null,
      users,
    });
    const adapter = {
      name: 'discord', listen: () => {}, connect: async () => {},
      control: (api: PlatformControlApi) => { control = api; },
    };
    const orch = new PlatformOrchestrator({
      plugins: async () => ({ platforms: [adapter] }) as never,
      platformOwner: () => 1,
      identity,
      fastMode: (userId) => fast.get(userId) === true,
      setFastMode: (userId, on) => {
        const next = on ?? !(fast.get(userId) === true);
        fast.set(userId, next);
        return next;
      },
      channels: { status: () => ({ fastAvailable: true }) } as never,
      dispatch: noDispatch,
    });
    await orch.startAll();
    const ref = { platform: 'discord', channelId: 'c1' };

    expect(control!.setAccountFast!(ref, 'D2', true)).toEqual({ fast: true, fastAvailable: true });
    expect(control!.fastStatus!(ref, 'D2')).toEqual({ fast: true, fastAvailable: true });
    expect(control!.fastStatus!(ref, 'D3')).toEqual({ fast: false, fastAvailable: true });
    expect(control!.setAccountFast!(ref, 'D3')).toEqual({ fast: true, fastAvailable: true });
    expect(control!.setAccountFast!(ref, 'unknown', true)).toBeNull();
  });

  it('anchors a delegated child to its non-owner parent account, never the platform owner', async () => {
    let sent: ChannelSendOpts | undefined;
    let handler: ((src: never, text: string) => Promise<unknown>) | undefined;
    const adapter = { name: 'subagent', listen: (fn: never) => { handler = fn as never; }, connect: async () => {} };
    const channels = {
      sessionOwnerUserId: (sessionId: string) => sessionId === 'brain-2' ? 2 : undefined,
      send: async (o: ChannelSendOpts) => { sent = o; return 'ok'; },
      fragmentFor: () => '', setLastWriter: () => {},
    };
    const resolver = linkedResolver(false);
    const orch = new PlatformOrchestrator({
      plugins: async () => ({ platforms: [adapter] }) as never,
      platformOwner: () => 1,
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
    expect(sent?.policy.allowedProjectIds).toBe('all');
    // Authority is the captured delegated access. The child is deliberately NOT attributed to the account
    // owning its row: memory tools treat any identity carrying `elowenUserId` as that account acting, and
    // a child spawned from a shared room inherits the operator as row owner.
    expect(sent?.identity).toMatchObject({ admin: true, owner: false, conversation: 'delegated' });
    expect(sent?.identity?.elowenUserId).toBeUndefined();
  });

  it('mints only a durable workspace ref and never forwards the resolved host path to dispatch', async () => {
    let request: DelegatedTurnRequest | undefined;
    let handler: ((src: never, text: string) => Promise<unknown>) | undefined;
    const adapter = { name: 'subagent', listen: (fn: never) => { handler = fn as never; }, connect: async () => {} };
    const resolver = linkedResolver(false);
    const orch = new PlatformOrchestrator({
      plugins: async () => ({ platforms: [adapter] }) as never,
      platformOwner: () => 1,
      identity: resolver,
      channels: { sessionOwnerUserId: () => 1 } as never,
      sandbox: () => ({
        workspacesFor: () => [{ workspaceId: 'ws_explicit', projectId: 3, path: '/host/secret/ws', label: 'w', branch: 'b', baseRef: 'main' }],
        resolveWorkspace: () => ({ accountUserId: 1, workspaceId: 'ws_explicit', projectId: 3, path: '/host/secret/ws' }),
      }) as never,
      dispatch: { send: async (value) => { request = value; return 'ok'; } },
    });
    await orch.startAll();
    await handler!({
      platform: 'subagent', userId: 'subagent', channelId: 'sub-workspace', roleIds: [],
      access: {
        admin: true, projectIds: [], parentSessionId: 'brain-1', permissionBoundary: null,
        contributionUserId: 1, workspaceId: 'ws_explicit', cwd: '/host/parent',
      },
    } as never, 'inspect');
    expect(request?.delegatedAccess.workspaceRef).toEqual({ workspaceId: 'ws_explicit', projectId: 3 });
    expect(request).not.toHaveProperty('clientCwd');
    expect(JSON.stringify(request)).not.toContain('/host/secret/ws');
  });

  // A shared room is anchored on the operator because it has no single author, so the owner column alone
  // reported a colleague's Teams room as the operator's own conversation. The writer is recorded per turn
  // instead of being derived on read, which would mean scanning the message table for every listing.
  // A room belongs to whoever opened it. Anchoring it on the operator filed a colleague's Teams room
  // under the operator's name; the register then needed a tooltip to explain the discrepancy away.
  describe('a shared room', () => {
    const spawn = async (existingOwner: number | undefined): Promise<number | undefined> => {
      let sentOwner: number | undefined;
      let handler: ((src: never, text: string) => Promise<unknown>) | undefined;
      const adapter = { name: 'discord', listen: (fn: never) => { handler = fn as never; }, connect: async () => {} };
      const orch = new PlatformOrchestrator({
        plugins: async () => ({ platforms: [adapter] }) as never,
        platformOwner: () => 1, // the instance operator
        policyForUser: () => userPolicy,
        identity: linkedResolver(true), // the sender resolves to account 2
        channels: {
          sessionOwnerUserId: () => existingOwner,
          send: async (o: { ownerUserId: number }) => { sentOwner = o.ownerUserId; return 'ok'; },
          setLastWriter: () => {},
          fragmentFor: () => '',
        } as never,
        dispatch: noDispatch,
      });
      await orch.startAll();
      await handler!({ platform: 'discord', userId: 'D9', channelId: 'c1', roleIds: [], access: { admin: false, projectIds: [3] } } as never, 'hi');
      return sentOwner;
    };

    it('is opened by its first writer, not by the operator who happens to host the instance', async () => {
      expect(await spawn(undefined)).toBe(2);
    });

    // The other half of the rule, and the half that actually bites: `ownerUserId` is compared against the
    // live channel, so sending the operator for a row owned by somebody else respawns it every turn.
    it('keeps sending the owner the row already has, so the live channel is not rebuilt every turn', async () => {
      expect(await spawn(7)).toBe(7);
    });
  });

  // Who WROTE the turn is recorded one layer down now (settleTurn, against a real store — see
  // channelSettlement.test.ts). What belongs here is the other half of the same question: whose spend it
  // is. The room's owner and its writer are different people, and until this pin existed every room turn
  // settled as `internal` billed to the owner.
  it('pins a room turn to the WRITER and the platform, before the turn runs', async () => {
    const pins: [string, number, string][] = [];
    const order: string[] = [];
    let handler: ((src: never, text: string) => Promise<unknown>) | undefined;
    const adapter = { name: 'discord', listen: (fn: never) => { handler = fn as never; }, connect: async () => {} };
    const orch = new PlatformOrchestrator({
      plugins: async () => ({ platforms: [adapter] }) as never,
      platformOwner: () => 1,
      policyForUser: () => userPolicy,
      identity: linkedResolver(true), // the sender resolves to account 2
      usageOrigins: {
        recordRequest: (sessionId, userId, origin) => {
          order.push('pin');
          pins.push([sessionId, userId, origin.value]);
          return 1;
        },
        releasePin: () => { order.push('release'); },
        repointPin: () => {},
      },
      channels: {
        sessionOwnerUserId: () => 1, // …while the ROOM is owned by account 1
        send: async () => { order.push('send'); return 'ok'; },
        setLastWriter: () => {},
        fragmentFor: () => '',
      } as never,
      dispatch: noDispatch,
    });
    await orch.startAll();
    await handler!({ platform: 'discord', userId: 'D9', channelId: 'c1', roleIds: [], access: { admin: false, projectIds: [3] } } as never, 'hi');

    expect(pins).toEqual([['brain-ch-discord-c1', 2, 'platform:discord']]);
    // Pinned BEFORE the turn: the settle that consumes the pin happens inside the send, so a pin written
    // afterwards would be consumed by nothing and the turn would settle as `internal` anyway. And given
    // back AFTER it, so a turn refused before it reached the provider cannot leave its pin on the room for
    // the next colleague to be billed under.
    expect(order).toEqual(['pin', 'send', 'release']);
  });

  describe('a direct 1:1 chat', () => {
    /** One inbound direct message, against a channel store whose row is owned by `rowOwner`
     *  (undefined = the conversation does not exist yet). */
    const runDirect = async (rowOwner: number | undefined): Promise<ChannelSendOpts> => {
      const sent = await runDirectWithAdoption(rowOwner);
      return sent.opts;
    };

    /** As {@link runDirect}, but also reporting what was asked of the store. `adoptPersonalChat` mirrors the
     *  real compare-and-swap: it only reports a transfer while the row still sits on the account named. */
    const runDirectWithAdoption = async (
      rowOwner: number | undefined,
    ): Promise<{ opts: ChannelSendOpts; adoptCalls: [string, number, number][] }> => {
      let sent: ChannelSendOpts | undefined;
      let handler: ((src: never, text: string) => Promise<unknown>) | undefined;
      const adoptCalls: [string, number, number][] = [];
      let owner = rowOwner;
      const adapter = { name: 'discord', listen: (fn: never) => { handler = fn as never; }, connect: async () => {} };
      const channels = {
        sessionOwnerUserId: () => rowOwner,
        adoptPersonalChat: (sessionId: string, from: number, to: number) => {
          adoptCalls.push([sessionId, from, to]);
          if (owner !== from) return false;
          owner = to;
          return true;
        },
        send: async (o: ChannelSendOpts) => { sent = o; return 'ok'; },
        fragmentFor: () => '', setLastWriter: () => {},
      };
      const orch = new PlatformOrchestrator({
        plugins: async () => ({ platforms: [adapter] }) as never,
        platformOwner: () => 1,
        policyForUser: () => userPolicy,
        toolAuthorityFor: () => ({ deny: new Set(['DiscordApi']) }),
        identity: linkedResolver(true), // resolves the sender to account 2
        channels: channels as never,
        dispatch: noDispatch,
      });
      await orch.startAll();
      await handler!({ platform: 'discord', userId: 'D9', channelId: 'c1', roleIds: [], direct: true, access: { admin: false, projectIds: [3] } } as never, 'hi');
      return { opts: sent!, adoptCalls };
    };

    it('anchors a brand-new one on its own sender and exposes only the validated direct identity', async () => {
      const sent = await runDirect(undefined);
      expect(sent).toMatchObject({ direct: true, ownerUserId: 2 });
      expect(sent.policy).toBe(userPolicy);
      expect(sent.toolPolicy).toEqual({ deny: new Set(['DiscordApi']) });
      expect(sent.identity?.conversation).toBe('direct');
      expect(sent.deliveryTarget).toBe('destination:discord:c1');
    });

    // A private chat lands on the operator when its sender had not linked their account yet, or when the
    // bot opened the chat proactively and there was no sender to anchor on. That fallback used to be
    // permanent, so a colleague's DM stayed filed under the operator's name for good.
    it('takes a chat back off the operator fallback once its sender is verified', async () => {
      const { opts, adoptCalls } = await runDirectWithAdoption(1);
      expect(adoptCalls).toEqual([['brain-ch-discord-c1', 1, 2]]);
      expect(opts).toMatchObject({ direct: true, ownerUserId: 2 });
      expect(opts.identity?.conversation).toBe('direct');
      expect(opts.deliveryTarget).toBe('destination:discord:c1');
    });

    // The operator anchor is a PLACEHOLDER, so handing it over is safe. A row already belonging to a real
    // person is not: personal skills and bound delivery both resolve from the session's owner, so letting
    // a message move it would serve that person's private context to whoever writes here next.
    it('never takes a chat away from a third party', async () => {
      const { opts, adoptCalls } = await runDirectWithAdoption(3);
      expect(adoptCalls).toEqual([]);
      expect(opts?.direct).toBe(false);
      expect(opts?.identity?.conversation).toBe('shared');
      expect(opts?.deliveryTarget).toBeUndefined();
    });

    it('is direct again once the row is the sender\'s own', async () => {
      const sent = await runDirect(2);
      expect(sent).toMatchObject({ direct: true, ownerUserId: 2 });
    });

    it('rejects an unlinked human even when the adapter claims actAsUserId', async () => {
      let sent: ChannelSendOpts | undefined;
      let handler: ((src: never, text: string) => Promise<unknown>) | undefined;
      const adapter = { name: 'discord', listen: (fn: never) => { handler = fn as never; }, connect: async () => {} };
      const orch = new PlatformOrchestrator({
        plugins: async () => ({ platforms: [adapter] }) as never,
        platformOwner: () => 1,
        policyForUser: () => userPolicy,
        identity: linkedResolver(false),
        channels: { sessionOwnerUserId: () => undefined, send: async (opts: ChannelSendOpts) => { sent = opts; return 'ok'; }, fragmentFor: () => '', setLastWriter: () => {} } as never,
        dispatch: noDispatch,
      });
      await orch.startAll();
      const reply = await handler!({
        platform: 'discord', userId: 'unverified', channelId: 'c1', roleIds: [], direct: true,
        access: { admin: false, projectIds: [], actAsUserId: 2 },
      } as never, 'relay');
      expect(reply).toBeUndefined();
      expect(sent).toBeUndefined();
    });
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
      fragmentFor: () => '', setLastWriter: () => {},
    };
    const resolver = linkedResolver(false);
    const orch = new PlatformOrchestrator({
      plugins: async () => ({ platforms: [adapter] }) as never,
      platformOwner: () => 1,
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
      fragmentFor: () => '', setLastWriter: () => {},
    };
    const resolver = linkedResolver(false);
    const orch = new PlatformOrchestrator({
      plugins: async () => ({ platforms: [adapter] }) as never,
      platformOwner: () => 1,
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
      fragmentFor: () => '', setLastWriter: () => {},
    };
    const resolver = linkedResolver(false);
    const orch = new PlatformOrchestrator({
      plugins: async () => ({ platforms: [adapter] }) as never,
      platformOwner: () => 1,
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
      fragmentFor: () => '', setLastWriter: () => {},
    };
    const resolver = linkedResolver(false);
    const orch = new PlatformOrchestrator({
      plugins: async () => ({ platforms: [adapter] }) as never,
      platformOwner: () => 1,
      toolAuthorityFor: () => ({ deny: new Set(['terminal_exec']) }),
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
      fragmentFor: () => '', setLastWriter: () => {},
    };
    // The parent row belongs to the platform owner, while the original linked Discord participant is
    // a different account. The boundary must therefore travel in source access, not be inferred later.
    const resolver = linkedResolver(true);
    const orch = new PlatformOrchestrator({
      plugins: async () => ({ platforms: [adapter] }) as never,
      platformOwner: () => 1,
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
  const runTypedDelegate = async (
    access: Record<string, unknown>,
    toolAuthorityFor?: (userId: number) => ToolPolicy | undefined,
  ): Promise<ChannelSendOpts> => {
    let sent: ChannelSendOpts | undefined;
    let handler: ((src: never, text: string) => Promise<unknown>) | undefined;
    const adapter = { name: 'subagent', listen: (fn: never) => { handler = fn as never; }, connect: async () => {} };
    const channels = { sessionOwnerUserId: () => 1, send: async (o: ChannelSendOpts) => { sent = o; return 'ok'; }, fragmentFor: () => '', setLastWriter: () => {} };
    const resolver = linkedResolver(false);
    const orch = new PlatformOrchestrator({
      plugins: async () => ({ platforms: [adapter] }) as never,
      platformOwner: () => 1,
      identity: resolver,
      agents: exploreDef,
      channels: channels as never,
      ...(toolAuthorityFor ? { toolAuthorityFor } : {}),
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

  // `users.allowed_tools` defaults to the `*` marker and the migration that turns it into a real list runs
  // AFTER the deploy. In that window a non-admin's whole grant — and therefore the allow-list on every
  // delegate call they make — is literally `['*']`. Intersecting that with an exact `Array.includes`
  // produced the empty set, so every read-only or typed sub-agent a non-admin spawned threw
  // 'delegated tool scope is empty' from the moment of deploy until the migration ran.
  it('a pre-migration `*` allow-list restricts nothing, rather than emptying the preset', async () => {
    const sent = await runTypedDelegate({
      admin: false, owner: true, projectIds: [3], parentSessionId: 'brain-owner',
      agentType: 'explore', toolPolicy: { allow: ['*'] }, permissionBoundary: null,
    });
    expect(sortedAllow(sent)).toEqual(presetSorted);
  });

  // The permanent half of the same bug: `mcp__*` is in the preset because bridged MCP names only exist at
  // runtime, so it can never equal a concrete granted name. Dropping it left every non-admin read-only
  // child with no MCP at all.
  it('resolves the preset\'s MCP wildcard against the concrete MCP tools the caller was granted', async () => {
    const sent = await runTypedDelegate({
      admin: false, owner: true, projectIds: [3], parentSessionId: 'brain-owner',
      agentType: 'explore', toolPolicy: { allow: ['Read', 'mcp__github__issue', 'Write'] }, permissionBoundary: null,
    });
    // Write is outside the preset and stays out; the family entry resolves to the granted member.
    expect(sortedAllow(sent)).toEqual(['Read', 'mcp__github__issue']);
  });

  // The parent's CURRENT grant has to narrow the child on the SPAWN path too, not only on the owner's
  // drill-in continuation. It travels beside the frozen scope (accountAllow) rather than inside it,
  // because the scope is immutable and this half must be re-read on every turn.
  it('intersects the spawning account\'s current grant into the child\'s executing policy', async () => {
    const sent = await runTypedDelegate({
      admin: false, owner: true, projectIds: [3], parentSessionId: 'brain-owner',
      agentType: 'explore', toolPolicy: { allow: ['Read', 'Grep'] }, permissionBoundary: null,
    }, () => ({ allow: new Set(['Read']) })); // the admin has since revoked Grep from the account
    // The captured scope still records what the child was minted with (the normalizer sorts it)…
    expect(sortedAllow(sent)).toEqual(['Grep', 'Read']);
    // …but the policy the turn actually executes under is that scope ∩ the account's grant right now.
    expect(sent.toolPolicy).toEqual({ allow: new Set(['Read']) });
  });

  it('reads the current grant from the captured settings account, not the room owner', async () => {
    const authorityIds: number[] = [];
    const sent = await runTypedDelegate({
      admin: false, owner: false, projectIds: [3], parentSessionId: 'brain-owner',
      agentType: 'explore', toolPolicy: { allow: ['Read', 'Grep'] }, permissionBoundary: null,
      settingsUserId: 3, contributionUserId: 3,
    }, (userId) => {
      authorityIds.push(userId);
      return { allow: new Set(['Read']) };
    });

    expect(authorityIds).toEqual([3]);
    expect(sent.delegatedAccess).toMatchObject({ settingsUserId: 3, contributionUserId: 3 });
    expect(sent.toolPolicy).toEqual({ allow: new Set(['Read']) });
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

  it('runs an instance-owned cron turn with host authority and no account or origin', async () => {
    let sent: ChannelSendOpts | undefined;
    let message = '';
    let handler: ((src: never, text: string) => Promise<unknown>) | undefined;
    const adapter = { name: 'cron', listen: (fn: never) => { handler = fn as never; }, connect: async () => {} };
    const orch = new PlatformOrchestrator({
      plugins: async () => ({ platforms: [adapter] }) as never,
      platformOwner: () => 1,
      identity: linkedResolver(false),
      channels: {
          sessionOwnerUserId: () => undefined,
        send: async (opts: ChannelSendOpts, text: string) => { sent = opts; message = text; return 'instance reply'; },
        fragmentFor: () => '', setLastWriter: () => {},
      } as never,
      dispatch: noDispatch,
    });
    await orch.startAll();

    const reply = await handler!({
      platform: 'cron', userId: 'cron', channelId: 'job-instance', roleIds: [],
      access: { admin: true, projectIds: [], scheduled: true, denyTools: ['BlockedForTurn'] },
    } as never, 'run instance maintenance');

    expect(reply).toBe('instance reply');
    expect(message).toBe('run instance maintenance');
    expect(sent).toMatchObject({
      channelId: 'cron-job-instance', ownerUserId: 1, writerUserId: undefined,
      scheduled: true, trusted: true,
    });
    expect(sent?.policy.allowedProjectIds).toBe('all');
    expect(sent?.toolPolicy).toEqual({ deny: new Set(['BlockedForTurn']) });
    expect(sent?.identity).toMatchObject({ platform: 'cron', admin: true, owner: true });
  });

  // Instance automation is not a user account, so there is nobody to hold a grant against. The
  // accountless cron shape must stay DENY-only — expressed as an omitted allow-list, not as an empty one,
  // which would silently strip every plugin tool from the instance's own scheduled work.
  it('gives the accountless instance cron no allow-list, whatever the account resolver would answer', async () => {
    let sent: ChannelSendOpts | undefined;
    let handler: ((src: never, text: string) => Promise<unknown>) | undefined;
    const adapter = { name: 'cron', listen: (fn: never) => { handler = fn as never; }, connect: async () => {} };
    const orch = new PlatformOrchestrator({
      plugins: async () => ({ platforms: [adapter] }) as never,
      platformOwner: () => 1,
      // Wired, and deliberately narrow: reaching for it here would clamp the instance job to one account's
      // grant — and reaching for the OPERATOR's would hand instance authority to whoever holds account 1.
      toolAuthorityFor: () => ({ allow: new Set(['Read']), deny: new Set(['DiscordApi']) }),
      identity: linkedResolver(false),
      channels: {
        sessionOwnerUserId: () => undefined,
        send: async (o: ChannelSendOpts) => { sent = o; return 'instance reply'; },
        fragmentFor: () => '', setLastWriter: () => {},
      } as never,
      dispatch: noDispatch,
    });
    await orch.startAll();

    await handler!({
      platform: 'cron', userId: 'cron', channelId: 'job-instance', roleIds: [],
      access: { admin: true, projectIds: [], scheduled: true, denyTools: ['BlockedForTurn'] },
    } as never, 'run instance maintenance');

    expect(sent?.writerUserId).toBeUndefined();
    expect(sent?.toolPolicy).toEqual({ deny: new Set(['BlockedForTurn']) });
    expect(sent?.toolPolicy?.allow).toBeUndefined();
  });

  it('does not widen stale owned or origin cron shapes into instance authority', async () => {
    let sends = 0;
    let handler: ((src: never, text: string) => Promise<unknown>) | undefined;
    const adapter = { name: 'cron', listen: (fn: never) => { handler = fn as never; }, connect: async () => {} };
    const identity = new IdentityResolver({
      platformOwner: () => 1,
      resolvePlatformUser: () => null,
      users: { get: () => null },
    });
    const orch = new PlatformOrchestrator({
      plugins: async () => ({ platforms: [adapter] }) as never,
      platformOwner: () => 1,
      identity,
      channels: { sessionOwnerUserId: () => undefined, send: async () => { sends++; return 'must not run'; }, fragmentFor: () => '', setLastWriter: () => {} } as never,
      dispatch: noDispatch,
      originSend: async () => null,
    });
    await orch.startAll();

    const staleOwner = await handler!({
      platform: 'cron', userId: 'cron', channelId: 'stale-owner', roleIds: [],
      access: { admin: true, projectIds: [], actAsUserId: 99 },
    } as never, 'stale owner');
    const staleOrigin = await handler!({
      platform: 'cron', userId: 'cron', channelId: 'stale-origin', roleIds: [],
      origin: { sessionId: 'gone', userId: 99 }, access: { admin: true, projectIds: [] },
    } as never, 'stale origin');

    expect(staleOwner).toBeUndefined();
    expect(staleOrigin).toBeUndefined();
    expect(sends).toBe(0);
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
      channels: { sessionOwnerUserId: () => undefined, send: async (o: ChannelSendOpts) => { sent = o; return 'channel reply'; }, fragmentFor: () => '', setLastWriter: () => {} } as never,
      dispatch: noDispatch,
      originSend: async (userId, sessionId, text) => { originCalls.push([userId, sessionId!, text]); return 'bound reply'; },
    });
    await orch.startAll();
    const reply = await handler!({ platform: 'cron', userId: 'cron', channelId: 'job-1', roleIds: [],
      origin: { sessionId: 'brain-1-abc', userId: 1 }, access: { admin: true, projectIds: [] } } as never, 'wake up');
    expect(reply).toBe('bound reply');
    expect(originCalls).toEqual([[1, 'brain-1-abc', 'wake up']]);
    expect(sent).toBeUndefined(); // the channel path never ran
  });

  it('runs a direct origin through the channel session and confirms only after platform delivery', async () => {
    let sent: ChannelSendOpts | undefined;
    let handler: ((src: never, text: string, onEvent?: (event: BrainEvent) => void) => Promise<unknown>) | undefined;
    const delivered: { text: string; channelId?: string }[] = [];
    const cron = { name: 'cron', listen: (fn: never) => { handler = fn as never; }, connect: async () => {} };
    const discord = {
      name: 'discord', listen: () => {}, connect: async () => {},
      notify: async (text: string, channelId?: string) => { delivered.push({ text, channelId }); },
    };
    const events: BrainEvent[] = [];
    const orch = new PlatformOrchestrator({
      plugins: async () => ({ platforms: [cron, discord], platformPromptsFor: (platform: string) => platform === 'discord' ? ['DIRECT SURFACE'] : [] }) as never,
      platformOwner: () => 1,
      policyForUser: () => userPolicy,
      toolAuthorityFor: () => ({ deny: new Set(['DiscordApi']) }),
      identity: linkedResolver(false),
      channels: {
          sessionOwnerUserId: () => undefined,
        mayDeliverDirectSession: (userId: number, sessionId: string, channelId: string) =>
          userId === 2 && sessionId === 'brain-ch-discord-dm-7' && channelId === 'discord-dm-7',
        send: async (opts: ChannelSendOpts) => { sent = opts; return 'scheduled reply'; },
        fragmentFor: () => '', setLastWriter: () => {},
      } as never,
      dispatch: noDispatch,
      originSend: async () => { throw new Error('owner-chat path must not run'); },
    });
    await orch.startAll();

    const reply = await handler!({
      platform: 'cron', userId: 'cron', channelId: 'job-1', roleIds: [],
      origin: { sessionId: 'brain-ch-discord-dm-7', userId: 2, deliveryTarget: 'destination:discord:dm-7' },
      access: { admin: false, projectIds: [], actAsUserId: 2 },
    } as never, 'wake up', (event) => events.push(event));

    expect(reply).toBe('scheduled reply');
    expect(sent).toMatchObject({
      channelId: 'discord-dm-7', ownerUserId: 2, direct: true,
      writerUserId: 2, deliveryTarget: 'destination:discord:dm-7', policy: userPolicy,
      promptAppend: ['DIRECT SURFACE'],
    });
    expect(sent?.identity?.conversation).toBe('direct');
    expect(sent?.toolPolicy).toEqual({ deny: new Set(['DiscordApi']) });
    expect(delivered).toEqual([{ text: 'scheduled reply', channelId: 'dm-7' }]);
    expect(events.at(-1)).toEqual({ type: 'delivery', sessionId: 'brain-ch-discord-dm-7' });
  });

  it('does not confirm direct delivery when the platform outbound sink fails', async () => {
    let handler: ((src: never, text: string, onEvent?: (event: BrainEvent) => void) => Promise<unknown>) | undefined;
    const events: BrainEvent[] = [];
    const orch = new PlatformOrchestrator({
      plugins: async () => ({ platforms: [
        { name: 'cron', listen: (fn: never) => { handler = fn as never; }, connect: async () => {} },
        { name: 'discord', listen: () => {}, connect: async () => {}, notify: async () => { throw new Error('offline'); } },
      ] }) as never,
      platformOwner: () => 1,
      policyForUser: () => userPolicy,
      identity: linkedResolver(false),
      channels: {
          sessionOwnerUserId: () => undefined,
        mayDeliverDirectSession: () => true,
        send: async () => 'scheduled reply',
        fragmentFor: () => '', setLastWriter: () => {},
      } as never,
      dispatch: noDispatch,
    });
    await orch.startAll();

    await expect(handler!({
      platform: 'cron', userId: 'cron', channelId: 'job-1', roleIds: [],
      origin: { sessionId: 'brain-ch-discord-dm-7', userId: 2, deliveryTarget: 'destination:discord:dm-7' },
      access: { admin: false, projectIds: [], actAsUserId: 2 },
    } as never, 'wake up', (event) => events.push(event))).rejects.toThrow('offline');
    expect(events.some((event) => event.type === 'delivery')).toBe(false);
  });

  it('falls back to the channel path when the bound send refuses (origin session gone / foreign)', async () => {
    let sent: ChannelSendOpts | undefined;
    let handler: ((src: never, text: string) => Promise<unknown>) | undefined;
    const adapter = { name: 'cron', listen: (fn: never) => { handler = fn as never; }, connect: async () => {} };
    const orch = new PlatformOrchestrator({
      plugins: async () => ({ platforms: [adapter] }) as never,
      platformOwner: () => 1,
      policyForUser: () => userPolicy,
      identity: linkedResolver(false),
      channels: { sessionOwnerUserId: () => undefined, send: async (o: ChannelSendOpts) => { sent = o; return 'channel reply'; }, fragmentFor: () => '', setLastWriter: () => {} } as never,
      dispatch: noDispatch,
      originSend: async () => null, // ownership check failed host-side
    });
    await orch.startAll();
    const reply = await handler!({ platform: 'cron', userId: 'cron', channelId: 'job-1', roleIds: [],
      origin: { sessionId: 'brain-1-gone', userId: 1 },
      access: { admin: false, projectIds: [], actAsUserId: 1 },
    } as never, 'wake up');
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
      channels: { sessionOwnerUserId: () => undefined, send: async (o: ChannelSendOpts) => { sent = o; return 'channel reply'; }, fragmentFor: () => '', setLastWriter: () => {} } as never,
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
        channels: { sessionOwnerUserId: () => undefined, send: async () => 'ok', fragmentFor: () => '', setLastWriter: () => {} } as never,
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

  it('a linked shared sender with an unrestricted role and no denies gets no tool restriction', async () => {
    let sent: ChannelSendOpts | undefined;
    let handler: ((src: never, text: string) => Promise<unknown>) | undefined;
    const adapter = { name: 'discord', listen: (fn: never) => { handler = fn as never; }, connect: async () => {}, control: () => {} };
    const orch = new PlatformOrchestrator({
      plugins: async () => ({ platforms: [adapter] }) as never,
      platformOwner: () => 1,
      policyForUser: () => userPolicy,
      toolAuthorityFor: () => undefined, // nothing disabled
      identity: linkedResolver(true),
      channels: { sessionOwnerUserId: () => undefined, send: async (o: ChannelSendOpts) => { sent = o; return 'ok'; }, fragmentFor: () => '', setLastWriter: () => {} } as never,
      dispatch: noDispatch,
    });
    await orch.startAll();
    await handler!({ platform: 'discord', userId: 'D9', channelId: 'c1', roleIds: [], access: { admin: false, projectIds: [3] } } as never, 'hi');
    expect(sent!.toolPolicy).toBeUndefined();
    expect(sent!.policy).toBe(userPolicy);
  });
});
