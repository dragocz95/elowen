import { describe, it, expect, afterEach } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { BrainStatusService, setWorkflowLivenessProbe } from '../../src/brain/service/statusService.js';
import { ConversationLifecycle } from '../../src/brain/service/lifecycle.js';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';
import { ClientAttachments } from '../../src/brain/service/attachments.js';
import { ElicitationRegistry } from '../../src/brain/elicitation.js';
import { CardRegistry } from '../../src/brain/cards.js';
import { PermissionApprovalService } from '../../src/brain/service/permissionApproval.js';
import type { LiveBrain } from '../../src/brain/session/liveBrain.js';
import type { BrainSegment } from '../../src/shared/wireContract.js';

// The incident this file guards: auto-compaction trimmed a conversation's WorkflowStart row out of the
// durable history while the engine kept running the DAG. Every workflow rendering — the transcript chip,
// the panel projection and live-event attachment — keys on that row, so the running workflow silently
// vanished from the UI of the very conversation that owned it. The status reads must pin a synthetic
// anchor into what they return (see withWorkflowAnchors).

const SESSION = 'brain-1';

function harness() {
  const store = new BrainStore(openDb(':memory:'));
  const sessions = new LiveSessionRegistry<LiveBrain>();
  const elicitation = new ElicitationRegistry();
  const lifecycle = new ConversationLifecycle({
    store,
    sessions,
    attachments: new ClientAttachments(),
    elicitation,
    goals: { cancelGoalContinuation: () => {} } as unknown as ConstructorParameters<typeof ConversationLifecycle>[0]['goals'],
    spawn: () => Promise.reject(new Error('no spawn in this harness')),
    selectionAllowed: () => true,
  });
  const cards = new CardRegistry(() => store);
  const status = new BrainStatusService({
    store,
    sessions,
    attachments: new ClientAttachments(),
    elicitation,
    cards,
    lifecycle,
    permissions: new PermissionApprovalService({ elicitation }),
    config: undefined,
    runtime: undefined as unknown as ConstructorParameters<typeof BrainStatusService>[0]['runtime'],
  });
  store.createSession({ id: SESSION, userId: 1, model: 'stored-model', provider: 'stored-provider' });
  return { store, sessions, cards, status };
}

/** A post-compaction tail that no longer contains the WorkflowStart tool row. */
function seedCompactedTail(store: BrainStore, turns: number) {
  store.appendMessage({ id: 'c0', sessionId: SESSION, parentId: null, role: 'compaction', content: { role: 'compactionSummary', summary: 'older turns' } });
  for (let i = 0; i < turns; i += 1) {
    store.appendMessage({ id: `u${i}`, sessionId: SESSION, parentId: null, role: 'user', content: { role: 'user', content: `question ${i}` } });
    store.appendMessage({ id: `a${i}`, sessionId: SESSION, parentId: null, role: 'assistant', content: { role: 'assistant', content: [{ type: 'text', text: `answer ${i}` }] } });
  }
}

const runningRun = {
  id: 'wf-1', toolCallId: 'call-wf', title: 'Ship it', status: 'running',
  nodes: [{ id: 'gather', task: 'gather facts', status: 'running', deps: [] }],
};

/** Registered live origin — a genuinely running workflow has one; without it the stale-row read-time
 *  fallback terminalizes the run (statusService.workflowRuns), which is its own test below. */
function liveOrigin(sessions: LiveSessionRegistry<LiveBrain>) {
  sessions.set(SESSION, {
    sessionId: SESSION,
    model: 'live-model',
    providerId: 'live-provider',
    lastTurnMode: 'build',
    session: { isStreaming: false, messages: [], getContextUsage: () => undefined, getSteeringMessages: () => [], getFollowUpMessages: () => [] },
    replay: { transportSnapshot: () => ({ cursor: 0, events: [], run: 0, eventCursors: [] }) },
  } as unknown as LiveBrain);
}

const anchorItems = (views: { segments?: BrainSegment[] }[]) => views
  .flatMap((v) => v.segments ?? [])
  .filter((s): s is Extract<BrainSegment, { kind: 'tool' }> => s.kind === 'tool' && s.id === 'call-wf');

describe('stream snapshot session identity and cards', () => {
  it('falls back to the stored session identity and restores persisted cards without a live brain', () => {
    const { cards, status } = harness();
    const card = { id: 'todos', pinned: true, items: [{ text: 'Ship it', status: 'in_progress' as const }] };
    cards.set(SESSION, card);

    const snapshot = status.streamSnapshot(1, SESSION);

    // This harness configures no providers, so the public id is all that resolves — the label stays
    // empty and there is no live session to name an internal usage provider.
    expect(snapshot.session).toEqual({ model: 'stored-model', provider: 'stored-provider', providerLabel: '', usageProvider: '' });
    expect(snapshot.cards).toEqual([card]);
  });

  it('prefers the tapped live brain identity over the stored fallback', () => {
    const { sessions, status } = harness();
    liveOrigin(sessions);

    expect(status.streamSnapshot(1, SESSION).session).toEqual({ model: 'live-model', provider: 'live-provider', providerLabel: '', usageProvider: '' });
  });
});

describe('status reads pin a synthetic anchor for a running workflow', () => {
  it('messagesPage first page carries the anchor even though the window has no WorkflowStart row', () => {
    const { store, sessions, status } = harness();
    seedCompactedTail(store, 40); // 81 rows, far more than the page below
    expect(store.upsertWorkflowRun(SESSION, runningRun)).toBe(true);
    liveOrigin(sessions);

    const page = status.messagesPage(1, SESSION, { limit: 50 });
    const anchors = anchorItems(page.items);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.wf).toMatchObject({ id: 'wf-1', status: 'running' });
    // The pin rides the page, it does not displace it: the newest turn is still the newest (session-event
    // markers may trail it, so compare against the newest ASSISTANT view).
    expect(page.items.filter((v) => v.role === 'assistant' && v.text).at(-1)?.text).toBe('answer 39');
    expect(page.items[0]?.id).toBe('wf-anchor-call-wf');
  });

  it('older pages are never pinned, so paging back cannot duplicate the anchor', () => {
    const { store, sessions, status } = harness();
    seedCompactedTail(store, 40);
    store.upsertWorkflowRun(SESSION, runningRun);
    liveOrigin(sessions);

    const first = status.messagesPage(1, SESSION, { limit: 20 });
    expect(first.nextBefore).not.toBeNull();
    const older = status.messagesPage(1, SESSION, { limit: 20, before: first.nextBefore! });
    expect(anchorItems(older.items)).toHaveLength(0);
  });

  it('the stream snapshot (reconnect hydration) carries the anchor in its windowed history', () => {
    const { store, sessions, status } = harness();
    seedCompactedTail(store, 40);
    store.upsertWorkflowRun(SESSION, runningRun);
    liveOrigin(sessions);

    const snapshot = status.streamSnapshot(1, SESSION, { limit: 50 });
    expect(anchorItems(snapshot.history)).toHaveLength(1);
    // And in the un-windowed variant (the CLI attaches without a history page).
    expect(anchorItems(status.streamSnapshot(1, SESSION).history)).toHaveLength(1);
  });

  it('messagesOf (read-only full history) carries the anchor too', () => {
    const { store, sessions, status } = harness();
    seedCompactedTail(store, 3);
    store.upsertWorkflowRun(SESSION, runningRun);
    liveOrigin(sessions);
    expect(anchorItems(status.messagesOf(1, SESSION))).toHaveLength(1);
  });

  it('does not pin when the real WorkflowStart row is inside the window', () => {
    const { store, sessions, status } = harness();
    store.appendMessage({
      id: 'wf-row', sessionId: SESSION, parentId: null, role: 'assistant',
      content: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-wf', name: 'WorkflowStart', arguments: {} }] },
    });
    store.upsertWorkflowRun(SESSION, runningRun);
    liveOrigin(sessions);

    const page = status.messagesPage(1, SESSION, { limit: 50 });
    const anchors = anchorItems(page.items);
    expect(anchors).toHaveLength(1); // the REAL row, wf attached by shaping
    expect(page.items.some((v) => v.id === 'wf-anchor-call-wf')).toBe(false);
  });

  // The read-time stale fallback stays intact: with no live origin the 'running' row is terminalized
  // for display, and a terminalized run must not be resurrected as a pinned running anchor.
  it('a stale running row without a live origin is not pinned', () => {
    const { store, status } = harness();
    seedCompactedTail(store, 2);
    store.upsertWorkflowRun(SESSION, runningRun);
    expect(anchorItems(status.messagesPage(1, SESSION, { limit: 50 }).items)).toHaveLength(0);
  });

  // history() is the channel-connect read — the fourth endpoint that must pin. Its own positive test,
  // because removing just its withWorkflowAnchors call would leave every other endpoint's test green.
  it('history (the active-conversation read) carries the anchor too', () => {
    const { store, sessions, status } = harness();
    seedCompactedTail(store, 3);
    store.upsertWorkflowRun(SESSION, runningRun);
    liveOrigin(sessions);
    const anchors = anchorItems(status.history(1));
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.wf).toMatchObject({ id: 'wf-1', status: 'running' });
  });
});

// "Running" must mean the ENGINE still holds the DAG, not merely that the origin PI session is alive:
// when a terminal snapshot fails to persist (or boot reconcile misses one), the row claims `running`
// forever, and a session-liveness check would synthesize a phantom anchor until the next restart.
describe('the engine liveness probe overrides session-liveness guessing', () => {
  afterEach(() => { setWorkflowLivenessProbe(() => undefined); });

  it('a running row the engine disowns is terminalized despite a live origin session', () => {
    const { store, sessions, status } = harness();
    seedCompactedTail(store, 2);
    store.upsertWorkflowRun(SESSION, runningRun);
    liveOrigin(sessions);
    setWorkflowLivenessProbe((id) => (id === 'wf-1' ? false : undefined));
    expect(anchorItems(status.messagesPage(1, SESSION, { limit: 50 }).items)).toHaveLength(0);
    expect(anchorItems(status.history(1))).toHaveLength(0);
  });

  it('a running row the engine confirms stays pinned even without a live origin session', () => {
    // The origin PI session can be reaped while a BACKGROUND workflow keeps running — the engine's
    // answer must win in this direction too, or the running DAG vanishes exactly like the incident.
    const { store, status } = harness();
    seedCompactedTail(store, 2);
    store.upsertWorkflowRun(SESSION, runningRun);
    setWorkflowLivenessProbe((id) => (id === 'wf-1' ? true : undefined));
    const anchors = anchorItems(status.messagesPage(1, SESSION, { limit: 50 }).items);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.wf).toMatchObject({ id: 'wf-1', status: 'running' });
  });

  it('an unanswerable probe falls back to origin-session liveness (boot window, unwired tests)', () => {
    const { store, sessions, status } = harness();
    seedCompactedTail(store, 2);
    store.upsertWorkflowRun(SESSION, runningRun);
    liveOrigin(sessions);
    setWorkflowLivenessProbe(() => undefined);
    expect(anchorItems(status.messagesPage(1, SESSION, { limit: 50 }).items)).toHaveLength(1);
  });
});

describe('status reads keep running sub-agents visible across parent compaction', () => {
  const subagentItems = (views: { segments?: BrainSegment[] }[]) => views
    .flatMap((view) => view.segments ?? [])
    .filter((segment): segment is Extract<BrainSegment, { kind: 'tool' }> => segment.kind === 'tool' && segment.sub !== undefined);

  function seedDelegation(store: BrainStore, id: string, child: string) {
    store.createSession({ id: child, userId: 1, model: 'child-model', provider: 'child-provider', parentSessionId: SESSION });
    store.appendMessage({
      id: `anchor-${id}`, sessionId: SESSION, parentId: null, role: 'assistant',
      content: { role: 'assistant', content: [{ type: 'toolCall', id, name: 'Delegate', arguments: { task: `task ${id}` } }] },
    });
    expect(store.upsertSubagentRun(SESSION, {
      id, sessionId: child, status: 'running', task: `task ${id}`, tools: 2, seconds: 30, background: true,
    })).toBe(true);
  }

  it('projects a genuinely running child after compaction deletes its Delegate tool row, but still hides a dead child', () => {
    const { store, sessions, status } = harness();
    seedDelegation(store, 'call-live', 'child-live');
    seedDelegation(store, 'call-dead', 'child-dead');
    sessions.setChildRunning(SESSION, 'child-live', true);
    // "Dead" is a durable fact — the call's lifecycle closed (here with its display projection left at
    // `running`, the steered-continuation shape). Liveness is read off the lifecycle, the same answer
    // DelegateList gives, not off the registry: a live row with no edge yet is still a running child.
    expect(store.upsertSubagentRun(SESSION, {
      id: 'call-dead', sessionId: 'child-dead', status: 'running', task: 'task call-dead', tools: 2, seconds: 30, background: true,
    }, 'error')).toBe(true);

    store.appendMessage({ id: 'u-tail', sessionId: SESSION, parentId: null, role: 'user', content: { role: 'user', content: 'newer question' } });
    store.appendMessage({ id: 'a-tail', sessionId: SESSION, parentId: null, role: 'assistant', content: { role: 'assistant', content: [{ type: 'text', text: 'newer answer' }] } });

    expect(subagentItems(status.streamSnapshot(1, SESSION).history).map((item) => item.id)).toEqual(['call-live']);

    store.compactSessionMessages(SESSION, {
      id: 'summary', role: 'compaction', content: { role: 'compactionSummary', summary: 'older turns' },
    }, 2);
    expect(store.getMessages(SESSION).map((row) => row.id)).toEqual(['summary', 'u-tail', 'a-tail']);
    expect(store.getSubagentRuns(SESSION).map((run) => run.toolCallId)).toEqual(['call-live', 'call-dead']);

    const projected = subagentItems(status.streamSnapshot(1, SESSION).history);
    expect(projected.map((item) => item.id)).toEqual(['call-live']);
    expect(projected[0]?.sub).toMatchObject({ sessionId: 'child-live', status: 'running' });
  });
});
