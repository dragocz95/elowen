import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import type { ConversationSubagentNode } from '../../src/store/brainDelegationStore.js';

const SCOPE = { admin: true, projectIds: [], owner: true, permissionBoundary: null };

/** The batched read model behind the conversation switcher's sub-agent tree.
 *
 *  It answers for a WHOLE listing at once, so the two properties under test are the security boundary —
 *  every child is revalidated against its real parent and owner at every level, never trusted from a run
 *  row or a DAG snapshot — and the bounds, which have to hold in the SELECT rather than only in the
 *  serialized answer. */
describe('BrainStore.conversationSubagentBranches', () => {
  let store: BrainStore;
  let db: Db;
  beforeEach(() => { db = openDb(':memory:'); store = new BrainStore(db); });

  const root = (id: string, userId = 1): void => { store.createSession({ id, userId, model: 'm' }); };
  const child = (id: string, parent: string, userId = 1, model = 'm', provider?: string): void => {
    store.createSession({ id, userId, model, ...(provider ? { provider } : {}), parentSessionId: parent, delegatedAccess: SCOPE });
  };
  const run = (parent: string, toolCallId: string, childId: string, over: Record<string, unknown> = {}, durable?: 'running' | 'done' | 'error'): boolean =>
    store.upsertSubagentRun(parent, {
      id: toolCallId, sessionId: childId, status: 'done', task: 'Do the thing', tools: 1, seconds: 1, ...over,
    }, durable);

  const branches = (ids: string[], bounds?: Parameters<BrainStore['conversationSubagentBranches']>[1]) =>
    store.conversationSubagentBranches(ids, bounds);
  const names = (nodes: readonly ConversationSubagentNode[]): string[] => nodes.map((n) => n.name);

  it('projects one delegate node per child with its stored name, status and qualified model', () => {
    root('root');
    child('brain-ch-subagent-sub-a', 'root', 1, 'k3', 'kimi-coding');
    expect(run('root', 'call-1', 'brain-ch-subagent-sub-a', { name: 'Audit auth', status: 'done' }, 'done')).toBe(true);

    const { byConversation, truncated } = branches(['root']);

    expect(truncated).toBe(false);
    expect(byConversation.root).toEqual([{
      kind: 'delegate',
      key: 'sub:brain-ch-subagent-sub-a',
      name: 'Audit auth',
      status: 'done',
      childSessionId: 'brain-ch-subagent-sub-a',
      model: 'kimi-coding/k3',
      children: [],
    }]);
  });

  /** No stored name on rows written before the field existed: the label falls back to the delegation's
   *  opening words under exactly the rule the plugin applies, so one child is never called two things. */
  it('falls back to the task-derived name when the run row stored none', () => {
    root('root');
    child('brain-ch-subagent-sub-a', 'root');
    run('root', 'call-1', 'brain-ch-subagent-sub-a', { task: 'Review the retention sweep, carefully, end to end.' });

    expect(names(branches(['root']).byConversation.root!)).toEqual(['Review the retention sweep, carefully']);
  });

  it('nests a delegation of a delegation under the child that started it', () => {
    root('root');
    child('brain-ch-subagent-sub-a', 'root');
    child('brain-ch-subagent-sub-b', 'brain-ch-subagent-sub-a');
    run('root', 'call-1', 'brain-ch-subagent-sub-a', { name: 'Parent' });
    run('brain-ch-subagent-sub-a', 'call-2', 'brain-ch-subagent-sub-b', { name: 'Nested' });

    const top = branches(['root']).byConversation.root!;

    expect(names(top)).toEqual(['Parent']);
    expect(names(top[0]!.children)).toEqual(['Nested']);
  });

  /** The host-owned lifecycle is the only column true for every row ever written: a run whose final
   *  progress upsert never landed still carries `running` in its display JSON forever. */
  it('takes the status from the lifecycle, not from a stale display state', () => {
    root('root');
    child('brain-ch-subagent-sub-a', 'root');
    run('root', 'call-1', 'brain-ch-subagent-sub-a', { status: 'running' }, 'done');

    expect(branches(['root']).byConversation.root![0]!.status).toBe('done');
  });

  /** A NULL lifecycle predates the recovery columns. Its JSON may say `running`, but nothing owns that
   *  run any more, so announcing it as live would put a permanently spinning row on the screen. */
  it('never calls a NULL-lifecycle row running on the strength of its old JSON', () => {
    root('root');
    child('brain-ch-subagent-sub-a', 'root');
    run('root', 'call-1', 'brain-ch-subagent-sub-a', { status: 'running' });
    db.prepare("UPDATE brain_subagent_runs SET lifecycle = NULL WHERE tool_call_id = 'call-1'").run();

    expect(branches(['root']).byConversation.root![0]!.status).toBe('interrupted');
  });

  it('maps a run parked for a human continuation as blocked rather than finished', () => {
    root('root');
    child('brain-ch-subagent-sub-a', 'root');
    run('root', 'call-1', 'brain-ch-subagent-sub-a');
    db.prepare("UPDATE brain_subagent_runs SET lifecycle = 'recovery_required' WHERE tool_call_id = 'call-1'").run();

    expect(branches(['root']).byConversation.root![0]!.status).toBe('blocked');
  });

  /** One row is one CALL. A steered continuation settles within a second while the delegation it steered
   *  into keeps working, so the newest row must not report the child as finished. */
  it('lets the still-running call speak for a child whose newer continuation already returned', () => {
    root('root');
    child('brain-ch-subagent-sub-a', 'root');
    run('root', 'call-original', 'brain-ch-subagent-sub-a', { name: 'Original' }, 'running');
    run('root', 'call-continue', 'brain-ch-subagent-sub-a', { name: 'Steered' }, 'done');

    const nodes = branches(['root']).byConversation.root!;

    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.status).toBe('running');
  });

  it('groups a workflow as its own row with its nodes under it, node sessions and all', () => {
    root('root');
    child('brain-ch-subagent-wf-w1-review', 'root');
    expect(store.upsertWorkflowRun('root', {
      id: 'wf-1', toolCallId: 'call-9', title: 'Batch', status: 'done',
      nodes: [
        { id: 'review', task: 'Review the batch', status: 'done', deps: [], sessionId: 'brain-ch-subagent-wf-w1-review' },
        { id: 'pending', task: 'Waiting on review', status: 'pending', deps: ['review'] },
      ],
    })).toBe(true);

    const nodes = branches(['root']).byConversation.root!;

    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ kind: 'workflow', key: 'wf:root:call-9', name: 'Batch', status: 'done' });
    // A workflow has no transcript of its own — it fans out to N node sessions — so the row only opens.
    expect(nodes[0]!.childSessionId).toBeUndefined();
    expect(nodes[0]!.children.map((n) => [n.kind, n.name, n.status, n.childSessionId])).toEqual([
      ['workflowNode', 'Review the batch', 'done', 'brain-ch-subagent-wf-w1-review'],
      // A node the engine never dispatched has no session to drill into, and says so instead of linking.
      ['workflowNode', 'Waiting on review', 'pending', undefined],
    ]);
  });

  it('hangs a workflow node\'s own delegations under that node', () => {
    root('root');
    child('brain-ch-subagent-wf-w1-review', 'root');
    child('brain-ch-subagent-sub-deep', 'brain-ch-subagent-wf-w1-review');
    store.upsertWorkflowRun('root', {
      id: 'wf-1', toolCallId: 'call-9', status: 'running',
      nodes: [{ id: 'review', task: 'Review', status: 'running', deps: [], sessionId: 'brain-ch-subagent-wf-w1-review' }],
    });
    run('brain-ch-subagent-wf-w1-review', 'call-10', 'brain-ch-subagent-sub-deep', { name: 'Deep' });

    const workflow = branches(['root']).byConversation.root![0]!;

    expect(names(workflow.children[0]!.children)).toEqual(['Deep']);
  });

  /** The engine writes a run row for a node it dispatched through the ordinary delegate path. Showing it
   *  as a direct child AND as a node of its workflow would put one sub-agent on screen twice. */
  it('shows a workflow node once, under its workflow rather than beside it', () => {
    root('root');
    child('brain-ch-subagent-wf-w1-review', 'root');
    store.upsertWorkflowRun('root', {
      id: 'wf-1', toolCallId: 'call-9', status: 'running',
      nodes: [{ id: 'review', task: 'Review', status: 'running', deps: [], sessionId: 'brain-ch-subagent-wf-w1-review' }],
    });
    run('root', 'call-9-node', 'brain-ch-subagent-wf-w1-review', { name: 'Review' });

    const nodes = branches(['root']).byConversation.root!;

    expect(nodes.map((n) => n.kind)).toEqual(['workflow']);
    expect(nodes[0]!.children.map((n) => n.childSessionId)).toEqual(['brain-ch-subagent-wf-w1-review']);
  });

  /** Retention deletes a child's transcript but the parent's run row survives until the parent goes too.
   *  The delegation still happened, so it is still listed — it simply has nowhere to drill into. */
  it('keeps a purged child as metadata with nothing to open', () => {
    root('root');
    child('brain-ch-subagent-sub-a', 'root');
    run('root', 'call-1', 'brain-ch-subagent-sub-a', { name: 'Gone soon' });
    db.prepare("DELETE FROM brain_sessions WHERE id = 'brain-ch-subagent-sub-a'").run();

    expect(branches(['root']).byConversation.root).toEqual([{
      kind: 'delegate', key: 'sub:brain-ch-subagent-sub-a', name: 'Gone soon',
      status: 'done', children: [],
    }]);
  });

  /** A child that EXISTS but is not this parent's, or has changed hands, is not a deleted child: rendering
   *  it as one would leak the fact that it exists, and its name with it. */
  it('drops an existing child whose parent or owner no longer matches, instead of calling it purged', () => {
    root('root');
    root('other');
    child('brain-ch-subagent-sub-foreign', 'root');
    child('brain-ch-subagent-sub-elsewhere', 'other');
    run('root', 'call-1', 'brain-ch-subagent-sub-foreign', { name: 'Reowned' });
    run('root', 'call-2', 'brain-ch-subagent-sub-elsewhere', { name: 'Not mine' });
    db.prepare("UPDATE brain_sessions SET user_id = 2 WHERE id = 'brain-ch-subagent-sub-foreign'").run();

    expect(branches(['root']).byConversation.root ?? []).toEqual([]);
  });

  it('refuses to hang a foreign account\'s workflow node under this conversation', () => {
    root('root');
    root('foreign-root', 2);
    store.createSession({ id: 'brain-ch-subagent-wf-w1-x', userId: 2, model: 'm', parentSessionId: 'foreign-root', delegatedAccess: SCOPE });
    store.upsertWorkflowRun('root', {
      id: 'wf-1', toolCallId: 'call-9', status: 'running',
      nodes: [{ id: 'x', task: 'Smuggled', status: 'running', deps: [], sessionId: 'brain-ch-subagent-wf-w1-x' }],
    });

    expect(branches(['root']).byConversation.root![0]!.children[0]!.childSessionId).toBeUndefined();
  });

  it('answers only for the roots it was asked about', () => {
    root('root');
    root('sibling');
    child('brain-ch-subagent-sub-a', 'root');
    child('brain-ch-subagent-sub-b', 'sibling');
    run('root', 'call-1', 'brain-ch-subagent-sub-a', { name: 'Mine' });
    run('sibling', 'call-2', 'brain-ch-subagent-sub-b', { name: 'Theirs' });

    expect(Object.keys(branches(['root']).byConversation)).toEqual(['root']);
    expect(branches([]).byConversation).toEqual({});
  });

  it('stops at the depth bound and marks the branch it cut', () => {
    root('root');
    let parent = 'root';
    for (const n of [1, 2, 3]) {
      const id = `brain-ch-subagent-sub-${n}`;
      child(id, parent);
      run(parent, `call-${n}`, id, { name: `Level ${n}` });
      parent = id;
    }

    const top = branches(['root'], { depth: 2 }).byConversation.root!;

    expect(names(top)).toEqual(['Level 1']);
    expect(names(top[0]!.children)).toEqual(['Level 2']);
    expect(top[0]!.children[0]!.children).toEqual([]);
    expect(top[0]!.children[0]!.truncated).toBe(true);
  });

  it('caps the direct children of one parent and says the list was cut', () => {
    root('root');
    for (const n of [1, 2, 3, 4]) {
      child(`brain-ch-subagent-sub-${n}`, 'root');
      run('root', `call-${n}`, `brain-ch-subagent-sub-${n}`, { name: `Child ${n}` });
    }

    const { byConversation, truncated } = branches(['root'], { childrenPerParent: 2 });

    expect(names(byConversation.root!)).toEqual(['Child 1', 'Child 2']);
    expect(truncated).toBe(true);
  });

  it('stops at the global node budget rather than serializing an instance-wide tree', () => {
    root('root');
    for (const n of [1, 2, 3, 4, 5]) {
      child(`brain-ch-subagent-sub-${n}`, 'root');
      run('root', `call-${n}`, `brain-ch-subagent-sub-${n}`, { name: `Child ${n}` });
    }

    const { byConversation, truncated } = branches(['root'], { nodes: 3 });

    expect(byConversation.root).toHaveLength(3);
    expect(truncated).toBe(true);
  });

  /** The whole point of the batch: a listing of hundreds of conversations costs a number of queries bound
   *  by the DEPTH of the deepest branch, never by how many conversations were asked about. */
  it('costs a bounded number of queries for a listing far larger than the root cap', () => {
    for (let n = 0; n < 300; n++) root(`root-${n}`);
    child('brain-ch-subagent-sub-a', 'root-0');
    run('root-0', 'call-1', 'brain-ch-subagent-sub-a', { name: 'One' });

    const original = db.prepare.bind(db);
    let queries = 0;
    (db as unknown as { prepare: typeof original }).prepare = (sql: string) => { queries += 1; return original(sql); };
    try {
      const { byConversation, truncated } = branches(Array.from({ length: 300 }, (_, n) => `root-${n}`));
      // Only the first 100 roots are answered for, and the caller is told the answer was cut.
      expect(Object.keys(byConversation)).toEqual(['root-0']);
      expect(truncated).toBe(true);
      expect(names(byConversation['root-0']!)).toEqual(['One']);
    } finally {
      (db as unknown as { prepare: typeof original }).prepare = original;
    }

    expect(queries).toBeLessThanOrEqual(12);
  });
});
