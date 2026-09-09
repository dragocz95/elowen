import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { UsageOriginStore, billSettledTurn } from '../../src/store/usageOriginStore.js';
import { spawnOriginOfTurn } from '../../src/brain/spawnOrigin.js';
import { openDelegatedTurn } from '../../src/brain/session/turnSettled.js';

/** Who a DELEGATED child's spend is billed to.
 *
 *  The defect this pins: a child session has no request of its own, so `settleTurn` found no pin and every
 *  sub-agent turn — the bulk of this instance's spend — settled as `internal`, in a bucket the dashboard
 *  labelled "automation". The fix carries the parent turn's pin to the child at delegation time and stores
 *  it on the child's row, so its later turns keep the same answer.
 *
 *  Driven through the real stores and the real seam functions the delegation paths call, so it fails on a
 *  build without the inheritance rather than on a hand-written pin. */

const USAGE = { input: 900, output: 100, cacheRead: 0, cacheWrite: 0, total: 1000, cost: 0.5 };
// Pins age out after six hours, and `openDelegatedTurn` stamps its own pin with the real clock — so the
// parent's pin has to be recorded on that same clock or the sweep would drop it mid-test.
const AT = Date.now();
const IP = { value: '10.0.0.5', kind: 'ip' as const, trusted: true };

function instance() {
  const db = openDb(':memory:');
  const store = new BrainStore(db);
  const origins = new UsageOriginStore(db);
  // The parent conversation and the account that owns it. `user_id = 1` is the row owner everywhere below,
  // so a result billed to 2 can only have come from the pin, never from the fallback.
  store.createSession({ id: 'brain-1', userId: 1, model: 'kimi' });
  const settle = (sessionId: string): void =>
    billSettledTurn(origins, (id) => store.getSession(id)?.user_id, sessionId, USAGE, AT);
  return {
    store, origins, settle,
    billed: () => origins.topOrigins({ group: 'pair' }).map((r) => [r.userId, r.origin, r.turns]),
    /** The delegation seam: read the parent's live pin, spawn the child with it, run one child turn. */
    delegate: (childSessionId: string): void => {
      const carried = spawnOriginOfTurn(origins, 'brain-1');
      store.createSession({
        id: childSessionId, userId: 1, model: 'kimi', parentSessionId: 'brain-1',
        delegatedAccess: { admin: false, projectIds: [], owner: true, permissionBoundary: { rules: [], unattendedAsks: 'deny' } },
        ...(carried ? { spawnOrigin: carried } : {}),
      });
      const opened = openDelegatedTurn(origins, childSessionId, carried);
      try { settle(childSessionId); } finally { opened?.close(); }
    },
  };
}

describe('a delegated child is billed to whoever ordered the delegation', () => {
  it('inherits the origin AND the account of the pinned parent turn', () => {
    const inst = instance();
    // Account 2 writes into a conversation owned by account 1 — a shared room, the case where the row
    // owner is the wrong answer.
    inst.origins.recordRequest('brain-1', 2, IP, AT);

    inst.delegate('brain-ch-subagent-sub-dlg-1');
    inst.settle('brain-1');

    expect(inst.billed()).toEqual([[2, '10.0.0.5', 2]]);
  });

  it('keeps a nested child on the same origin, transitively', () => {
    const inst = instance();
    inst.origins.recordRequest('brain-1', 2, IP, AT);
    const child = 'brain-ch-subagent-sub-dlg-1';
    const carried = spawnOriginOfTurn(inst.origins, 'brain-1');
    inst.store.createSession({
      id: child, userId: 1, model: 'kimi', parentSessionId: 'brain-1',
      delegatedAccess: { admin: false, projectIds: [], owner: true, permissionBoundary: { rules: [], unattendedAsks: 'deny' } },
      ...(carried ? { spawnOrigin: carried } : {}),
    });
    const opened = openDelegatedTurn(inst.origins, child, carried);

    // The grandchild is spawned from INSIDE the child's running turn, which now holds a pin of its own.
    const nested = spawnOriginOfTurn(inst.origins, child);
    expect(nested).toEqual({ ...IP, userId: 2 });

    inst.settle(child);
    opened?.close();
    expect(inst.billed()).toEqual([[2, '10.0.0.5', 1]]);
  });

  it('stays internal for a child spawned from a cron turn, which no request ordered', () => {
    const inst = instance();
    // A scheduled wake-up pins nothing — that is what `internal` means.
    inst.delegate('brain-ch-subagent-sub-dlg-2');
    inst.settle('brain-1');

    expect(inst.billed()).toEqual([[1, 'internal', 2]]);
    expect(inst.store.spawnOriginFor('brain-ch-subagent-sub-dlg-2')).toBeUndefined();
  });

  it('bills a continuation from the stored origin, with the parent turn long gone', () => {
    const inst = instance();
    inst.origins.recordRequest('brain-1', 2, IP, AT);
    const child = 'brain-ch-subagent-sub-dlg-3';
    inst.delegate(child);
    // The parent turn settles, the daemon restarts: nothing is pinned anywhere any more. A recovery
    // respawn (and every DelegateContinue) reads the child's row instead — see sendDelegated.
    inst.settle('brain-1');
    expect(inst.origins.pinnedFor(child)).toBeNull();

    const stored = inst.store.spawnOriginFor(child);
    expect(stored).toEqual({ ...IP, userId: 2 });
    const opened = openDelegatedTurn(inst.origins, child, stored);
    try { inst.settle(child); } finally { opened?.close(); }

    expect(inst.billed()).toEqual([[2, '10.0.0.5', 3]]);
  });
});
