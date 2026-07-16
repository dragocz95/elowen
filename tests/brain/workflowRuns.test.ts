import { describe, expect, it } from 'vitest';
import { terminalizeWorkflow } from '../../src/brain/workflowRuns.js';
import type { WorkflowUpdate } from '../../src/brain/events.js';

const run = (nodes: WorkflowUpdate['nodes']): WorkflowUpdate => ({
  id: 'wf-1', toolCallId: 'call-1', title: 'Ship it', status: 'running', nodes,
});

describe('terminalizeWorkflow', () => {
  it('cancels the workflow and errors every node that never finished', () => {
    const out = terminalizeWorkflow(run([
      { id: 'a', task: 'a', status: 'done', deps: [], tokens: 10 },
      { id: 'b', task: 'b', status: 'running', deps: ['a'], sessionId: 's-b' },
      { id: 'c', task: 'c', status: 'pending', deps: ['b'] },
      { id: 'd', task: 'd', status: 'error', deps: [] },
    ]));

    // `cancelled` is what uniquely says "the daemon died under it" — the engine only writes
    // running/done/error, so the status is unambiguous evidence rather than a guess.
    expect(out.status).toBe('cancelled');
    expect(out.nodes.map((n) => n.status)).toEqual(['done', 'error', 'error', 'error']);
    // Terminal nodes are the record of what actually ran and must survive untouched.
    expect(out.nodes[0]).toEqual({ id: 'a', task: 'a', status: 'done', deps: [], tokens: 10 });
    expect(out.nodes[1]?.sessionId).toBe('s-b'); // the drill-in into what it managed to do still works
  });

  it('leaves the input untouched', () => {
    const before = run([{ id: 'a', task: 'a', status: 'running', deps: [] }]);
    terminalizeWorkflow(before);
    expect(before.status).toBe('running');
    expect(before.nodes[0]?.status).toBe('running');
  });
});
