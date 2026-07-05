import { describe, it, expect } from 'vitest';
import { PlatformOrchestrator } from '../../src/brain/platforms.js';
import { IdentityResolver } from '../../src/brain/identity.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { ChannelSendOpts } from '../../src/brain/channels.js';

// A linked sender resolves to Orca account #2 (non-admin); everyone else is unlinked.
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
    disabledToolsFor: () => ['discord_api'], // Amy disabled this tool in her Orca account
    identity: linkedResolver(opts.linked),
    channels: { send: async (o: ChannelSendOpts) => { sent = o; return 'ok'; }, fragmentFor: () => '' } as never,
  });
  await orch.startAll();
  await handler!({ platform: 'discord', userId: 'D9', channelId: 'c1', roleIds: [], access: opts.access } as never, 'hi');
  return sent!;
}

describe('PlatformOrchestrator — unified per-turn access', () => {
  it('a LINKED sender runs fully through their Orca account: their policy + their tool deny-list', async () => {
    const sent = await runTurn({ linked: true, access: { admin: false, projectIds: [3], tools: ['memory_search'] } });
    expect(sent.policy).toBe(userPolicy); // Orca account policy, NOT the role's
    expect(sent.toolPolicy).toEqual({ deny: new Set(['discord_api']) }); // their disabled_tools, role allowlist ignored
    expect(sent.identity?.orcaUserId).toBe(2);
  });

  it('an UNLINKED sender falls back to the Role-ID policy + the role tool allowlist', async () => {
    const sent = await runTurn({ linked: false, access: { admin: false, projectIds: [3], tools: ['memory_search'] } });
    expect(sent.policy).toBe(rolePolicy); // the role's projects
    expect(sent.toolPolicy).toEqual({ allow: new Set(['memory_search']) }); // the role's tool allowlist
    expect(sent.identity?.orcaUserId).toBeUndefined();
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
