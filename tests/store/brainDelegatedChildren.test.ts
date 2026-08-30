import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';

const SCOPE = { admin: true, projectIds: [], owner: true, permissionBoundary: null };

/** The listing that lets a parent conversation see which sub-agents it already ran. The security
 *  property under test is that it is keyed on the PARENT session and nothing else: a sibling
 *  conversation, another account, or a child of a different parent must never appear. */
describe('BrainStore.listDelegatedChildren', () => {
  let store: BrainStore;
  let db: Db;
  beforeEach(() => { db = openDb(':memory:'); store = new BrainStore(db); });

  const child = (id: string, parent: string, userId = 1): void => {
    store.createSession({ id, userId, model: 'm', parentSessionId: parent, delegatedAccess: SCOPE });
  };

  /** The run row's own `model` is a bare id recorded by the plugin and is absent entirely for workflow
   *  nodes, so the session row wins when the two disagree — it is the one that always knows what ran. */
  const childOn = (id: string, parent: string, model: string, provider: string): void => {
    store.createSession({ id, userId: 1, model, provider, parentSessionId: parent, delegatedAccess: SCOPE });
  };

  it('lists this conversation\'s own sub-agent children with their task, status and message count', () => {
    store.createSession({ id: 'root', userId: 1, model: 'm' });
    childOn('brain-ch-subagent-sub-a', 'root', 'claude', 'anthropic');
    store.setTitle('brain-ch-subagent-sub-a', 'Audit the auth module');
    store.appendMessage({ id: 'm1', sessionId: 'brain-ch-subagent-sub-a', parentId: null, role: 'user', content: 'go' });
    store.appendMessage({ id: 'm2', sessionId: 'brain-ch-subagent-sub-a', parentId: null, role: 'assistant', content: 'done' });
    expect(store.upsertSubagentRun('root', {
      id: 'call-1', sessionId: 'brain-ch-subagent-sub-a', status: 'done',
      task: 'Audit the auth module for missing checks', tools: 4, seconds: 12, model: 'claude',
    })).toBe(true);

    const rows = store.listDelegatedChildren('root');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sessionId).toBe('brain-ch-subagent-sub-a');
    expect(rows[0]!.task).toBe('Audit the auth module for missing checks');
    expect(rows[0]!.status).toBe('done');
    expect(rows[0]!.model).toBe('anthropic/claude');
    expect(rows[0]!.messages).toBe(2);
    expect(rows[0]!.title).toBe('Audit the auth module');
    // The listing renders this as the child's age, so it has to be the child session's own creation
    // stamp — any other value would date the sub-agent wrongly in the parent's listing.
    const created = db.prepare('SELECT created_at FROM brain_sessions WHERE id = ?')
      .get('brain-ch-subagent-sub-a') as { created_at: string };
    expect(rows[0]!.startedAt).toBe(created.created_at);
  });

  it('lists one latest row per child while any original call remains active, then settles terminally', () => {
    store.createSession({ id: 'root', userId: 1, model: 'm' });
    child('brain-ch-subagent-sub-a', 'root');
    expect(store.upsertSubagentRun('root', {
      id: 'delegate-original', sessionId: 'brain-ch-subagent-sub-a', status: 'running',
      task: 'Original task', tools: 2, seconds: 10,
    })).toBe(true);
    // A steered continuation finishes its own tool call while the ORIGINAL child call is still live. The
    // newest row's lifecycle is done, but the child as a whole must remain visibly running until every call
    // lifecycle for that child is terminal.
    expect(store.upsertSubagentRun('root', {
      id: 'delegate-continue', sessionId: 'brain-ch-subagent-sub-a', status: 'running',
      task: 'Finish after your children', tools: 0, seconds: 1,
    }, 'done')).toBe(true);

    expect(store.listDelegatedChildren('root')).toMatchObject([{
      sessionId: 'brain-ch-subagent-sub-a', task: 'Finish after your children', status: 'running',
    }]);
    expect(store.upsertSubagentRun('root', {
      id: 'delegate-original', sessionId: 'brain-ch-subagent-sub-a', status: 'done',
      task: 'Original task', tools: 2, seconds: 12,
    })).toBe(true);
    expect(store.listDelegatedChildren('root')).toMatchObject([{
      sessionId: 'brain-ch-subagent-sub-a', task: 'Finish after your children', status: 'done',
    }]);
  });

  // A workflow node is a real delegated child with a real transcript, but the engine records the DAG
  // rather than a per-child brain_subagent_runs row. It must still be listable (and continuable), so the
  // listing is driven by the session relation and only ENRICHED by the run row.
  it('includes a delegated child that has no brain_subagent_runs row (a workflow node)', () => {
    store.createSession({ id: 'root', userId: 1, model: 'm' });
    child('brain-ch-subagent-wf-w1-node', 'root');
    store.setTitle('brain-ch-subagent-wf-w1-node', 'Node task');
    const rows = store.listDelegatedChildren('root');
    expect(rows.map((r) => r.sessionId)).toEqual(['brain-ch-subagent-wf-w1-node']);
    // Nothing recorded the DAG here, so there is genuinely nothing to say about the node's progress.
    expect(rows[0]?.task).toBeUndefined();
    expect(rows[0]?.status).toBeUndefined();
  });

  // The node's task and status live in the DAG snapshot instead of a run row. Without reading it, a
  // finished workflow node listed as "unknown" forever — which is what the parent reads when it asks
  // what it already ran.
  it('describes a workflow node from the DAG snapshot when there is no run row', () => {
    store.createSession({ id: 'root', userId: 1, model: 'm' });
    child('brain-ch-subagent-wf-w1-review', 'root');
    expect(store.upsertWorkflowRun('root', {
      id: 'wf-1', toolCallId: 'call-9', title: 'Batch', status: 'done', background: true,
      nodes: [
        { id: 'review', task: 'Review the batch', status: 'done', deps: [], sessionId: 'brain-ch-subagent-wf-w1-review' },
        { id: 'other', task: 'Not this conversation', status: 'error', deps: [], sessionId: 'brain-ch-subagent-wf-elsewhere' },
      ],
    })).toBe(true);

    const rows = store.listDelegatedChildren('root');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('done');
    expect(rows[0]?.task).toBe('Review the batch');
  });

  // The session row is the only place that always knows which model actually ran, and it keeps the
  // provider — a bare model id is ambiguous once two providers serve similar names.
  it('reports the model as provider/model from the session row', () => {
    store.createSession({ id: 'root', userId: 1, model: 'm' });
    store.createSession({
      id: 'brain-ch-subagent-sub-k', userId: 1, model: 'k3', provider: 'kimi-coding',
      parentSessionId: 'root', delegatedAccess: SCOPE,
    });
    expect(store.listDelegatedChildren('root')[0]?.model).toBe('kimi-coding/k3');
  });

  it('never leaks another conversation\'s or another account\'s sub-agents', () => {
    store.createSession({ id: 'root', userId: 1, model: 'm' });
    store.createSession({ id: 'sibling', userId: 1, model: 'm' });
    store.createSession({ id: 'foreign-root', userId: 2, model: 'm' });
    child('brain-ch-subagent-sub-mine', 'root');
    child('brain-ch-subagent-sub-sibling', 'sibling');
    child('brain-ch-subagent-sub-foreign', 'foreign-root', 2);

    expect(store.listDelegatedChildren('root').map((r) => r.sessionId))
      .toEqual(['brain-ch-subagent-sub-mine']);
    expect(store.listDelegatedChildren('sibling').map((r) => r.sessionId))
      .toEqual(['brain-ch-subagent-sub-sibling']);
    expect(store.listDelegatedChildren('foreign-root').map((r) => r.sessionId))
      .toEqual(['brain-ch-subagent-sub-foreign']);
    expect(store.listDelegatedChildren('nope')).toEqual([]);
  });

  // Ownership is re-derived on READ, not trusted from the row: a child re-keyed to another account can
  // never be surfaced (and therefore never continued) through its old parent.
  it('drops a child whose owner no longer matches its parent', () => {
    store.createSession({ id: 'root', userId: 1, model: 'm' });
    child('brain-ch-subagent-sub-a', 'root');
    db.prepare("UPDATE brain_sessions SET user_id = 2 WHERE id = 'brain-ch-subagent-sub-a'").run();
    expect(store.listDelegatedChildren('root')).toEqual([]);
  });

  // Ordinary nested conversations (a task shell, a bound channel) can also carry parent_session_id.
  // Only the `brain-ch-subagent-*` family is a delegated sub-agent that can be continued.
  it('lists only sub-agent sessions, not every session that happens to have this parent', () => {
    store.createSession({ id: 'root', userId: 1, model: 'm' });
    child('brain-ch-subagent-sub-a', 'root');
    store.createSession({ id: 'brain-ch-discord-c1', userId: 1, model: 'm', parentSessionId: 'root' });
    expect(store.listDelegatedChildren('root').map((r) => r.sessionId))
      .toEqual(['brain-ch-subagent-sub-a']);
  });

  it('returns the most recent children first and honours the limit', () => {
    store.createSession({ id: 'root', userId: 1, model: 'm' });
    for (const n of [1, 2, 3]) {
      child(`brain-ch-subagent-sub-${n}`, 'root');
      // created_at has one-second resolution, so order within a test run comes from the insertion
      // sequence (rowid) — assert on that rather than sleeping.
    }
    expect(store.listDelegatedChildren('root').map((r) => r.sessionId))
      .toEqual(['brain-ch-subagent-sub-3', 'brain-ch-subagent-sub-2', 'brain-ch-subagent-sub-1']);
    expect(store.listDelegatedChildren('root', 2).map((r) => r.sessionId))
      .toEqual(['brain-ch-subagent-sub-3', 'brain-ch-subagent-sub-2']);
  });
});
