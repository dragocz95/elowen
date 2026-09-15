import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { BrainService } from '../../src/brain/brainService.js';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { inMemoryModelRuntime } from '../../src/brain/providers.js';
import type { BrainEvent } from '../../src/brain/events.js';
import type { BrainWorkflowRun } from '../../src/store/brainStore.js';

/** Boot recovery publishing a workflow's progress to an ALREADY ATTACHED client when the origin
 *  conversation has no live brain — the state a restart leaves behind for every background DAG. The turn
 *  that started it is long gone and attaching a stream deliberately spawns nothing, so the replay journal
 *  these updates used to go through does not exist: they were dropped, and an open CLI kept rendering the
 *  node statuses its reconnect snapshot happened to catch. */

let sharedRuntime: ModelRuntime;
beforeAll(async () => { sharedRuntime = await inMemoryModelRuntime(); });

/** The smallest BrainService the resume path needs: a real store, no PI session ever spawned. */
function fakeDeps() {
  const db = openDb(':memory:');
  return {
    store: new BrainStore(db),
    runtime: sharedRuntime,
    users: { ensureAdvisorToken: () => 'token', get: () => ({ name: 'Filip', username: 'filip' }) },
    config: { providers: [{ id: 'relay', label: 'Relay', type: 'openai' as const, baseUrl: 'http://x/v1', models: ['m'], apiKey: 'k' }] },
    prompts: { render: vi.fn(() => 'PERSONA') },
    url: 'http://x',
    createSession: vi.fn(),
    resourceLoaderFactory: () => undefined,
  };
}

const RUNNING: BrainWorkflowRun = {
  id: 'wf-1', toolCallId: 'call-1', title: 'ship the parser', status: 'running',
  nodes: [
    { id: 'one', task: 'first', status: 'done', deps: [] },
    { id: 'two', task: 'second', status: 'running', deps: ['one'] },
  ],
};

describe('boot recovery publishes workflow progress to attached clients without a live brain', () => {
  it('delivers the terminal snapshot and its finish marker to a tapped session that is not live', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    d.store.createSession({ id: 'brain-1', userId: 1, model: 'm' });
    // The conversation that started the DAG: a display marker is deliberately never stacked above the
    // first message, so the transcript has to exist for the marker half of this assertion to mean anything.
    d.store.appendMessage({ id: 'msg-1', sessionId: 'brain-1', parentId: null, role: 'user', content: { role: 'user', content: 'run the workflow' } });
    expect(d.store.upsertWorkflowRun('brain-1', RUNNING)).toBe(true);

    const seen: BrainEvent[] = [];
    const off = svc.tapSession(1, 'brain-1', (event) => { seen.push(event); });
    try {
      // No workflow engine is wired, so the resume terminalizes the DAG — the same publish seam every
      // resumed node transition takes, reached here without a plugin registry.
      const outcome = await svc.resumeWorkflow({
        parentSessionId: 'brain-1', toolCallId: 'call-1', workflowId: 'wf-1', attempt: 1, state: RUNNING,
      });
      expect(outcome).toBe('terminalized');
    } finally { off(); }

    const workflow = seen.filter((event) => event.type === 'workflow');
    expect(workflow).toHaveLength(1);
    expect(workflow[0]).toMatchObject({ id: 'wf-1', toolCallId: 'call-1', status: 'cancelled' });
    // The node that finished before the restart keeps its result; only the interrupted one is terminalized.
    expect((workflow[0] as Extract<BrainEvent, { type: 'workflow' }>).nodes.map((n) => `${n.id}:${n.status}`))
      .toEqual(['one:done', 'two:error']);
    // The durable finish marker is recorded and announced on this path too, so the conversation keeps a
    // record that the DAG ended instead of silently losing it with the live session.
    const marker = seen.find((event) => event.type === 'session-event');
    expect(marker).toMatchObject({ kind: 'workflow' });
    expect(d.store.getSessionEvents('brain-1').map((event) => event.kind)).toContain('workflow');
  });
});
