import { describe, it, expect } from 'vitest';
import { PlatformOrchestrator } from '../../src/brain/platforms.js';
import { IdentityResolver } from '../../src/brain/identity.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { ChannelSendOpts } from '../../src/brain/channels.js';
import type { AgentDef } from '../../src/brain/agents/agentRegistry.js';
import { delegatedChannelSendOpts, type DelegatedTurnRequest } from '../../src/brain/delegatedTurn.js';
import type { BrainEvent } from '../../src/brain/events.js';

const rolePolicy: Policy = { allowedProjectIds: new Set([3]), allowedPaths: () => ['/repo/3'] };
const users = { get: (id: number) => ({ username: `u${id}` }) };

const exploreDef = (): Map<string, AgentDef> => new Map([['explore', {
  name: 'explore', description: 'read-only explore', body: 'You explore.',
  toolsSpec: 'read-only', source: 'builtin', filePath: '/explore.md',
}]]);

/** One delegated spawn through the real orchestrator, returning the ChannelSendOpts the child would run
 *  under — `delegatedAccess` is the exact scope that gets persisted on the child's session row. */
async function spawn(access: Record<string, unknown>): Promise<ChannelSendOpts> {
  let sent: ChannelSendOpts | undefined;
  let handler: ((src: never, text: string) => Promise<unknown>) | undefined;
  const adapter = { name: 'subagent', listen: (fn: never) => { handler = fn as never; }, connect: async () => {} };
  const channels = { sessionOwnerUserId: () => 1, send: async (o: ChannelSendOpts) => { sent = o; return 'ok'; }, fragmentFor: () => '' };
  const identity = new IdentityResolver({ platformOwner: () => 1, resolvePlatformUser: () => null, users });
  const orch = new PlatformOrchestrator({
    plugins: async () => ({ platforms: [adapter] }) as never,
    platformOwner: () => 1,
    policyForProjects: () => rolePolicy,
    identity,
    agents: exploreDef,
    channels: channels as never,
    dispatch: {
      send: (request: DelegatedTurnRequest, text: string, onEvent?: (e: BrainEvent) => void) =>
        channels.send(delegatedChannelSendOpts(request, { identity, policyForProjects: () => rolePolicy }, onEvent), text),
    },
  });
  await orch.startAll();
  await handler!({ platform: 'subagent', userId: 'subagent', channelId: 'sub-prov', roleIds: [], access } as never, 'inspect');
  return sent!;
}

const base = { admin: false, owner: true, projectIds: [3], parentSessionId: 'brain-owner', permissionBoundary: null };

/** Whether a read-only sub-agent may LATER be given write access is decided once, here, at spawn — the
 *  durable scope is the only thing a continuation can consult, and it cannot otherwise tell a read-only
 *  child from an ordinary narrow one, nor who asked for it. */
describe('PlatformOrchestrator — promotion provenance on the durable child scope', () => {
  it('marks a read_only delegation the caller chose as promotable, and records who chose it', async () => {
    const sent = await spawn({ ...base, readOnly: true, principal: 'elowen:1' });
    expect(sent.delegatedAccess?.readOnlyOrigin).toBe('requested');
    expect(sent.delegatedAccess?.spawnedBy).toBe('elowen:1');
  });

  it('locks a read-only agent TYPE — the operator defined that role, the caller did not', async () => {
    const sent = await spawn({ ...base, agentType: 'explore', principal: 'elowen:1' });
    expect(sent.delegatedAccess?.readOnlyOrigin).toBe('imposed');
  });

  it('locks a child spawned from a PLANNING turn, which never held the access to hand over', async () => {
    const sent = await spawn({ ...base, readOnly: true, planMode: true, principal: 'elowen:1' });
    expect(sent.delegatedAccess?.readOnlyOrigin).toBe('imposed');
  });

  it('records nothing for an ordinary writing child — there is no clamp to lift', async () => {
    const sent = await spawn({ ...base, principal: 'elowen:1' });
    expect(sent.delegatedAccess?.readOnlyOrigin).toBeUndefined();
  });

  // An unidentified delegating turn leaves the child unpromotable rather than promotable-by-anyone.
  it('records no spawner when the delegating turn carried no identity', async () => {
    const sent = await spawn({ ...base, readOnly: true });
    expect(sent.delegatedAccess?.spawnedBy).toBeUndefined();
    expect(sent.delegatedAccess?.readOnlyOrigin).toBe('requested');
  });
});
