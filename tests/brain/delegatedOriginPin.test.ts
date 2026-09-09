import { describe, it, expect } from 'vitest';
import { PlatformOrchestrator } from '../../src/brain/platforms.js';
import { IdentityResolver } from '../../src/brain/identity.js';
import { UsageOriginStore } from '../../src/store/usageOriginStore.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { openDb } from '../../src/store/db.js';
import { parseDelegatedTurnRequest, type DelegatedTurnRequest } from '../../src/brain/delegatedTurn.js';
import type { Policy } from '../../src/plugins/policy.js';

/** The SPAWN side of delegated attribution: what the orchestrator puts on the wire when a delegating turn
 *  asks for a child. Before the fix the request carried no origin at all, so the child — wherever it ran —
 *  had nothing to pin and its whole turn settled as `internal`. */

const POLICY: Policy = { allowedProjectIds: 'all' as const, allowedPaths: () => [] };
const IP = { value: '10.0.0.5', kind: 'ip' as const, trusted: true };

function instance() {
  const db = openDb(':memory:');
  const store = new BrainStore(db);
  const origins = new UsageOriginStore(db);
  store.createSession({ id: 'brain-1', userId: 1, model: 'kimi' });
  let sent: DelegatedTurnRequest | undefined;
  let handler!: (src: unknown, text: string) => Promise<unknown>;
  const adapter = {
    name: 'subagent',
    listen: (fn: never) => { handler = fn as never; },
    connect: async () => {}, control: () => {},
  };
  const orch = new PlatformOrchestrator({
    plugins: async () => ({ platforms: [adapter], platformPromptsFor: () => [] }) as never,
    platformOwner: () => 1,
    policyForUser: () => POLICY,
    identity: new IdentityResolver({
      platformOwner: () => 1,
      resolvePlatformUser: () => null,
      users: { get: (id: number) => ({ username: `u${id}` }) },
    } as never),
    channels: { fragmentFor: () => '', sessionOwnerUserId: () => 1 } as never,
    dispatch: { send: (request: DelegatedTurnRequest) => { sent = request; return Promise.resolve('done'); } } as never,
    usageOrigins: origins,
  });
  return {
    origins,
    delegate: async () => {
      if (!handler) await orch.startAll();
      await handler({
        platform: 'subagent',
        userId: 'sub-dlg-1',
        channelId: 'subagent-sub-dlg-1',
        roleIds: [],
        access: {
          admin: false,
          projectIds: [3],
          owner: true,
          parentSessionId: 'brain-1',
          permissionBoundary: { rules: [], unattendedAsks: 'deny' },
        },
      } as never, 'do the work');
      return sent;
    },
  };
}

describe('a delegation carries the origin of the turn that ordered it', () => {
  it('puts the parent turn’s pin, account included, on the delegated turn request', async () => {
    const inst = instance();
    inst.origins.recordRequest('brain-1', 2, IP, Date.now());

    const request = await inst.delegate();

    expect(request?.origin).toEqual({ ...IP, userId: 2 });
    // It has to survive the IPC hop as well: the runner is a second process with an empty pin map.
    expect(parseDelegatedTurnRequest(JSON.parse(JSON.stringify(request)))?.origin).toEqual({ ...IP, userId: 2 });
  });

  it('carries nothing when the delegating turn had no request behind it', async () => {
    const inst = instance();

    const request = await inst.delegate();

    expect(request?.origin).toBeUndefined();
  });
});
