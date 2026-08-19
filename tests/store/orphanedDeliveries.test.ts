import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';

const SCOPE = { admin: true, projectIds: [], owner: true, permissionBoundary: null };

/** A delegated result is only marked delivered once a PARENT TURN has taken it. An owner conversation
 *  always gets another turn eventually; a sub-agent whose own run is terminal never does, so its inbox
 *  entry waits forever — and the shutdown drain waits on that count globally, which is how one dead row
 *  made every restart burn the full ten-minute budget. */
describe('BrainStore.discardOrphanedDeliveries', () => {
  let store: BrainStore;
  let db: Db;
  beforeEach(() => { db = openDb(':memory:'); store = new BrainStore(db); });

  /** A sub-agent conversation that is itself the child of `parent`, with a run row in `status`. */
  const subAgent = (id: string, parent: string, callId: string, status: 'done' | 'error' | 'running'): void => {
    store.createSession({ id, userId: 1, model: 'm', parentSessionId: parent, delegatedAccess: SCOPE });
    store.upsertSubagentRun(parent, { id: callId, sessionId: id, status, task: 't', tools: 1, seconds: 1, model: 'm' });
  };

  /** Queue a result addressed TO `parent`, as a finished grandchild would. */
  const queueFor = (parent: string, callId: string, childId: string): void => {
    store.createSession({ id: childId, userId: 1, model: 'm', parentSessionId: parent, delegatedAccess: SCOPE });
    // The inbox only accepts a result whose (parent, tool call, child) triple is a real delegation.
    store.upsertSubagentRun(parent, { id: callId, sessionId: childId, status: 'done', task: 't', tools: 1, seconds: 1, model: 'm' });
    expect(store.enqueueSubagentResult(parent, {
      id: `res-${callId}`, toolCallId: callId, sessionId: childId, status: 'done',
      task: 't', result: 'answer', tools: 1, seconds: 1,
    })).toBe(true);
  };

  it('retires a result whose parent sub-agent has already finished', () => {
    store.createSession({ id: 'root', userId: 1, model: 'm' });
    subAgent('brain-ch-subagent-a', 'root', 'call-a', 'done');
    queueFor('brain-ch-subagent-a', 'call-a-1', 'brain-ch-subagent-a-child');

    expect(store.countPendingDeliveries()).toBe(1);
    expect(store.discardOrphanedDeliveries()).toBe(1);
    expect(store.countPendingDeliveries()).toBe(0);
    // Marked, not deleted: the answer stays readable in the delegation history.
    const rows = db.prepare("SELECT delivery_state FROM brain_subagent_results").all() as { delivery_state: string }[];
    expect(rows.map((r) => r.delivery_state)).toEqual(['acknowledged']);
  });

  it('leaves a result for a still-running sub-agent alone', () => {
    store.createSession({ id: 'root', userId: 1, model: 'm' });
    subAgent('brain-ch-subagent-b', 'root', 'call-b', 'running');
    queueFor('brain-ch-subagent-b', 'call-b-1', 'brain-ch-subagent-b-child');

    // A running parent — including one claimed for restart recovery — still gets a turn that takes it.
    expect(store.discardOrphanedDeliveries()).toBe(0);
    expect(store.countPendingDeliveries()).toBe(1);
  });

  it('never touches an owner conversation, which has no run row at all', () => {
    store.createSession({ id: 'root', userId: 1, model: 'm' });
    queueFor('root', 'call-c', 'brain-ch-subagent-c');

    // The user comes back and the next turn delivers it; retiring this would lose a real answer.
    expect(store.discardOrphanedDeliveries()).toBe(0);
    expect(store.countPendingDeliveries()).toBe(1);
  });
});
