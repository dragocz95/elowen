import { describe, it, expect } from 'vitest';
import { PlatformOrchestrator } from '../../src/brain/platforms.js';
import { IdentityResolver } from '../../src/brain/identity.js';
import { UsageOriginStore, billSettledTurn } from '../../src/store/usageOriginStore.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { openDb } from '../../src/store/db.js';
import { parseDelegatedTurnRequest, type DelegatedTurnRequest } from '../../src/brain/delegatedTurn.js';
import { DelegatedSessionService } from '../../src/brain/service/delegatedSession.js';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';
import type { LiveBrain } from '../../src/brain/session/liveBrain.js';
import type { DelegatedExecutionScope } from '../../src/brain/delegatedScope.js';
import type { Policy } from '../../src/plugins/policy.js';

/** The SPAWN side of delegated attribution: what the orchestrator puts on the wire when a delegating turn
 *  asks for a child. Before the fix the request carried no origin at all, so the child — wherever it ran —
 *  had nothing to pin and its whole turn settled as `internal`. A second block drives the CONTINUATION
 *  side: a DelegateContinue arriving on an idle child must be billed to the parent turn's LIVE pin — the
 *  colleague actually driving the child right now — not to whoever's request spawned it. */

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

/** The CONTINUATION side, driven through the real `continueSubagent` → `sendDelegated` seam. The fake
 *  channel `send` stands in for the settling turn: the one place the pin opened for the child is consumed
 *  (production wires the same `billSettledTurn` call at turn settlement in daemon/brainCore.ts), so the
 *  rollup read below is the attribution the child's turn actually recorded. */

const CONTINUATION_USAGE = { input: 900, output: 100, cacheRead: 0, cacheWrite: 0, total: 1000, cost: 0.5 };
// Pins age out after six hours; `openDelegatedTurn` stamps its own pin with the real clock, so the
// parent's live pin must be recorded on that same clock.
const CONTINUATION_AT = Date.now();
const PARENT = 'brain-1';
const CHILD = 'brain-ch-subagent-sub-dlg-c1';
// Two colleagues, two addresses: the child was spawned by account 1 from address Y, and is being driven
// NOW by account 2 from address X. The row owner is 1 everywhere, so a row billed to 2 can only have
// come from the live pin, never from a fallback.
const ORIGIN_X = { value: '10.0.0.5', kind: 'ip' as const, trusted: true };
const ORIGIN_Y = { value: '10.0.0.9', kind: 'ip' as const, trusted: true };

function continuationInstance() {
  const db = openDb(':memory:');
  const store = new BrainStore(db);
  const origins = new UsageOriginStore(db);
  const scope: DelegatedExecutionScope = { admin: true, projectIds: [], owner: true, permissionBoundary: null };
  store.createSession({ id: PARENT, userId: 1, model: 'k3' });
  store.createSession({
    id: CHILD, userId: 1, model: 'k3', parentSessionId: PARENT, delegatedAccess: scope,
    spawnOrigin: { value: ORIGIN_Y.value, kind: ORIGIN_Y.kind, trusted: true, userId: 1 },
  });
  const svc = new DelegatedSessionService({
    store,
    sessions: new LiveSessionRegistry<LiveBrain>(),
    channelService: {
      send: async () => {
        // The settling turn consumes the opened pin — exactly what the real turn runner does at settlement.
        billSettledTurn(origins, (id) => store.getSession(id)?.user_id, CHILD, CONTINUATION_USAGE, CONTINUATION_AT);
        return 'the idle turn answered';
      },
      // settledCall runs an idle continuation under this fence; the fake just runs the turn.
      sendRemote: (_req: unknown, run: () => Promise<string>) => run(),
      steerDelegatedTurn: async () => 'idle' as const,
    } as never,
    identity: { forDelegatedTurn: () => ({ platform: 'subagent', userId: 'subagent', admin: true, owner: true }) } as never,
    users: { get: () => ({}) } as never,
    usageOrigins: origins,
  });
  return {
    store, origins,
    billed: () => origins.topOrigins({ group: 'pair' }).map((r) => [r.userId, r.origin, r.turns]),
    continueChild: (): Promise<unknown> =>
      svc.continueSubagent(PARENT, CHILD, 'go on', { admin: true, projectIds: [], owner: true, permissionBoundary: null }),
  };
}

describe('a DelegateContinue is billed to the turn that ordered it, not to the stored spawn origin', () => {
  it('settles under the parent turn’s live pin — a shared room, another account driving the child', async () => {
    const inst = continuationInstance();
    // The child's row still carries the SPAWN's attribution: account 1 from address Y.
    expect(inst.store.spawnOriginFor(CHILD)).toEqual({ ...ORIGIN_Y, userId: 1 });

    // A turn written by account 2 from address X is running in the parent right now; its DelegateContinue
    // is the request that ordered this continuation.
    inst.origins.recordRequest(PARENT, 2, ORIGIN_X, CONTINUATION_AT);
    await inst.continueChild();

    expect(inst.billed()).toEqual([[2, ORIGIN_X.value, 1]]);
  });

  it('falls back to the stored spawn origin when the parent holds no live pin', async () => {
    const inst = continuationInstance();

    // No live pin anywhere — the ordering parent turn is long gone (a recovery respawn, a drain).
    await inst.continueChild();

    expect(inst.billed()).toEqual([[1, ORIGIN_Y.value, 1]]);
  });
});
