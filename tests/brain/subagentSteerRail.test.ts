import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { BrainStatusService } from '../../src/brain/service/statusService.js';
import { ConversationLifecycle } from '../../src/brain/service/lifecycle.js';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';
import { ClientAttachments } from '../../src/brain/service/attachments.js';
import { ElicitationRegistry } from '../../src/brain/elicitation.js';
import { CardRegistry } from '../../src/brain/cards.js';
import { PermissionApprovalService } from '../../src/brain/service/permissionApproval.js';
import { TranscriptModel } from '../../src/brain/transcriptModel.js';
import { recordSubagentProgress } from '../../src/brain/subagentRuns.js';
import { runningSubagentsBlock } from '../../src/brain/session/runningSubagents.js';
import type { BrainEvent, SubagentUpdate } from '../../src/brain/events.js';
import type { LiveBrain } from '../../src/brain/session/liveBrain.js';

const PARENT = 'brain-1';
const CHILD = 'brain-ch-subagent-sub-dlg-steer';
const MAIN_CALL = 'call-delegate';
const STEER_CALL = 'call-continue|fc_2';

/** The production shape this file pins (owner screenshot, 7 Sep 19:10): a parent delegates a child
 *  (MAIN_CALL, still working), then sends it a DelegateContinue (STEER_CALL) that is steered into the
 *  child's RUNNING turn and therefore returns immediately. Two run rows, one child, two different
 *  answers — and every projection has to agree on which one speaks for the child. */
function harness() {
  const db = openDb(':memory:');
  const store = new BrainStore(db);
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
  const status = new BrainStatusService({
    store,
    sessions,
    attachments: new ClientAttachments(),
    elicitation,
    cards: new CardRegistry(),
    lifecycle,
    permissions: new PermissionApprovalService({ elicitation }),
    config: undefined,
    runtime: undefined as unknown as ConstructorParameters<typeof BrainStatusService>[0]['runtime'],
  });
  store.createSession({ id: PARENT, userId: 1, model: 'm' });
  store.createSession({
    id: CHILD,
    userId: 1,
    model: 'm',
    parentSessionId: PARENT,
    delegatedAccess: { admin: true, owner: true, projectIds: [], permissionBoundary: null },
  });
  store.appendMessage({
    id: 'assistant-calls',
    sessionId: PARENT,
    parentId: null,
    role: 'assistant',
    content: {
      role: 'assistant',
      content: [
        { type: 'toolCall', id: MAIN_CALL, name: 'Delegate', arguments: { task: 'redesign the panel' } },
        { type: 'toolCall', id: STEER_CALL, name: 'DelegateContinue', arguments: { message: 'owner decision' } },
      ],
    },
  });
  const events: BrainEvent[] = [];
  const emit = (update: SubagentUpdate): boolean => recordSubagentProgress({
    store,
    claims: sessions,
    sessionId: PARENT,
    publish: (event) => { events.push(event); },
  }, update);
  const subsOf = (sessionId: string) => status.messagesOf(1, PARENT)
    .flatMap((message) => message.segments ?? [])
    .filter((segment): segment is Extract<typeof segment, { kind: 'tool' }> => segment.kind === 'tool')
    .map((segment) => segment.sub)
    .filter((sub): sub is NonNullable<typeof sub> => !!sub && sub.sessionId === sessionId);
  return { db, store, sessions, status, events, emit, subsOf };
}

const running = (id: string, over: Partial<SubagentUpdate> = {}): SubagentUpdate => ({
  id, sessionId: CHILD, status: 'running', task: 'redesign the panel', tools: 0, seconds: 1, ...over,
});

describe('a DelegateContinue steered into a running child settles its OWN call, not the child', () => {
  it('persists the steer row as done while the delegation that is still working stays running', () => {
    const { store, sessions, emit } = harness();
    // beginDelegatedCall holds the real run; the plugin's rows are the 'progress' source.
    sessions.setChildRunning(PARENT, CHILD, true);
    expect(emit(running(MAIN_CALL, { tools: 12, seconds: 400, model: 'claude-opus-5' }))).toBe(true);
    expect(emit(running(STEER_CALL, { task: 'Owner decision (19:10), change of approach' }))).toBe(true);
    // The steer entered the child's context and the tool returned — its own call is over.
    expect(emit(running(STEER_CALL, { task: 'Owner decision (19:10), change of approach', status: 'done' }))).toBe(true);

    const rows = store.getSubagentRuns(PARENT);
    expect(rows.find((run) => run.toolCallId === STEER_CALL)).toMatchObject({ status: 'done' });
    expect(rows.find((run) => run.toolCallId === MAIN_CALL)).toMatchObject({ status: 'running' });
  });

  it('tells the model about ONE running job — never the finished steer frozen at seconds=1', () => {
    const { store, sessions, emit } = harness();
    sessions.setChildRunning(PARENT, CHILD, true);
    emit(running(MAIN_CALL, { tools: 12, seconds: 400 }));
    emit(running(STEER_CALL, { task: 'Owner decision (19:10)' }));
    emit(running(STEER_CALL, { task: 'Owner decision (19:10)', status: 'done' }));

    const block = runningSubagentsBlock(sessions, store, PARENT);
    expect(block.match(/<subagent /g) ?? []).toHaveLength(1);
    expect(block).toContain('redesign the panel');
    expect(block).not.toContain('Owner decision');

    // …and once the delegation itself finishes, the reminder is empty rather than stuck.
    emit(running(MAIN_CALL, { tools: 18, seconds: 900, status: 'done' }));
    sessions.setChildRunning(PARENT, CHILD, false);
    expect(runningSubagentsBlock(sessions, store, PARENT)).toBe('');
  });

  it('keeps the transcript showing the child as running: the steer must not speak for it', () => {
    const { sessions, emit, subsOf } = harness();
    sessions.setChildRunning(PARENT, CHILD, true);
    emit(running(MAIN_CALL, { tools: 12, seconds: 400, model: 'claude-opus-5' }));
    emit(running(STEER_CALL, { task: 'Owner decision (19:10)' }));
    emit(running(STEER_CALL, { task: 'Owner decision (19:10)', status: 'done' }));

    const states = subsOf(CHILD);
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ status: 'running', task: 'redesign the panel', model: 'claude-opus-5' });
  });

  it('drops the finish marker once, when the CHILD settles — not when the steer returns', () => {
    const { store, sessions, emit } = harness();
    sessions.setChildRunning(PARENT, CHILD, true);
    emit(running(MAIN_CALL, { tools: 12, seconds: 400 }));
    emit(running(STEER_CALL, { task: 'Owner decision (19:10)' }));
    emit(running(STEER_CALL, { task: 'Owner decision (19:10)', status: 'done' }));
    // The child is still working: announcing a finish here is the "done, then restarted" flicker.
    expect(store.getSessionEvents(PARENT).filter((event) => event.kind === 'subagent')).toHaveLength(0);

    emit(running(MAIN_CALL, { tools: 18, seconds: 900, status: 'done' }));
    const markers = store.getSessionEvents(PARENT).filter((event) => event.kind === 'subagent');
    expect(markers).toHaveLength(1);
    expect(JSON.parse(markers[0]!.detail)).toMatchObject({ session: CHILD, task: 'redesign the panel', status: 'done' });
  });

  it('leaves a grandchild result queued for a child whose delegation is still running', () => {
    // discardOrphanedDeliveries answers "is anyone still waiting for this". Reading only the newest row
    // of the child would retire the answer over the steer's `done` while the child still has a turn coming.
    const { db, store, sessions, emit } = harness();
    const GRANDCHILD = 'brain-ch-subagent-sub-dlg-grand';
    sessions.setChildRunning(PARENT, CHILD, true);
    emit(running(MAIN_CALL, { tools: 12, seconds: 400 }));
    emit(running(STEER_CALL, { task: 'Owner decision (19:10)' }));
    emit(running(STEER_CALL, { task: 'Owner decision (19:10)', status: 'done' }));
    // The steer really is the last row touched; sub-second updates otherwise tie on the stored second.
    db.prepare("UPDATE brain_subagent_runs SET updated_at = '2030-01-01 00:00:00' WHERE tool_call_id = ?").run(STEER_CALL);

    store.createSession({
      id: GRANDCHILD, userId: 1, model: 'm', parentSessionId: CHILD,
      delegatedAccess: { admin: true, owner: true, projectIds: [], permissionBoundary: null },
    });
    expect(store.upsertSubagentRun(CHILD, {
      id: 'call-grand', sessionId: GRANDCHILD, status: 'done', task: 'dig', tools: 1, seconds: 1,
    })).toBe(true);
    expect(store.enqueueSubagentResult(CHILD, {
      id: 'res-grand', toolCallId: 'call-grand', sessionId: GRANDCHILD, status: 'done',
      task: 'dig', result: 'answer', tools: 1, seconds: 1,
    })).toBe(true);

    expect(store.discardOrphanedDeliveries()).toBe(0);
    expect(store.countPendingDeliveries()).toBe(1);
  });
});

describe('CLI telemetry rail — one row per child, chosen across that child\'s calls', () => {
  /** The rail's own scan (`streamCoordinator.subagentStates()` → `TranscriptModel.subagents()`). */
  const rail = (model: TranscriptModel) => model.subagents();
  const toolItem = (model: TranscriptModel, turn: number, id: string) => {
    const chatTurn = model.turnAt(turn);
    if (chatTurn?.role !== 'elowen') throw new Error('expected an assistant turn');
    for (const segment of chatTurn.segments) {
      if (segment.kind !== 'tools') continue;
      const item = segment.items.find((candidate) => candidate.id === id);
      if (item) return item;
    }
    throw new Error(`no tool row ${id}`);
  };

  it('keeps the steer terminal from the moment it returns, and the child running until it really ends', () => {
    const model = new TranscriptModel();
    model.apply({ type: 'tool', id: MAIN_CALL, name: 'Delegate', detail: 'redesign the panel' });
    model.apply({ type: 'tool', id: STEER_CALL, name: 'DelegateContinue', detail: 'owner decision' });

    // 1 — the delegation is working.
    model.apply({ type: 'subagent', ...running(MAIN_CALL, { tools: 12, seconds: 400, model: 'claude-opus-5' }) });
    // 2 — the follow-up raises its own row on the SAME child…
    model.apply({ type: 'subagent', ...running(STEER_CALL, { task: 'Owner decision (19:10)' }) });
    // 3 — …and returns the instant it is steered in.
    model.apply({ type: 'subagent', ...running(STEER_CALL, { task: 'Owner decision (19:10)', status: 'done' }) });

    expect(toolItem(model, 0, STEER_CALL).sub).toMatchObject({ status: 'done' });
    expect(rail(model)).toHaveLength(1);
    expect(rail(model)[0]).toMatchObject({ status: 'running', task: 'redesign the panel', model: 'claude-opus-5' });

    // 4 — the delegation keeps reporting progress; the steer stays terminal.
    model.apply({ type: 'subagent', ...running(MAIN_CALL, { tools: 15, seconds: 600, model: 'claude-opus-5' }) });
    expect(toolItem(model, 0, STEER_CALL).sub).toMatchObject({ status: 'done' });
    expect(rail(model).filter((agent) => agent.status === 'running')).toHaveLength(1);

    // 5 — and when it ends, nothing is left running.
    model.apply({ type: 'subagent', ...running(MAIN_CALL, { tools: 18, seconds: 900, status: 'done', model: 'claude-opus-5' }) });
    expect(rail(model).filter((agent) => agent.status === 'running')).toHaveLength(0);
    expect(rail(model)).toHaveLength(1);
  });

  it('shows a child as running when a recovering continuation follows a finished delegation (4 Sep)', () => {
    // The older Delegate row is `done`, the newer DelegateContinue is being recovered after a restart.
    // The synthetic anchor for the newer run is PREPENDED, so the older row is applied last — and a
    // last-write-wins projection reported the working child as finished.
    const model = new TranscriptModel([
      { role: 'assistant', text: '', segments: [{ kind: 'tool', id: STEER_CALL, name: 'DelegateContinue', sub: { sessionId: CHILD, status: 'running', task: 'continue: fix the blockers', tools: 3, seconds: 60 } }] },
      { role: 'assistant', text: '', segments: [{ kind: 'tool', id: MAIN_CALL, name: 'Delegate', sub: { sessionId: CHILD, status: 'done', task: 'first ask', tools: 40, seconds: 900 } }] },
    ]);

    expect(rail(model)).toHaveLength(1);
    expect(rail(model)[0]).toMatchObject({ status: 'running', task: 'continue: fix the blockers' });
  });

  it('still reports a child done once every call on it is terminal', () => {
    const model = new TranscriptModel();
    model.apply({ type: 'tool', id: MAIN_CALL, name: 'Delegate', detail: 'first ask' });
    model.apply({ type: 'tool', id: STEER_CALL, name: 'DelegateContinue', detail: 'follow-up' });
    model.apply({ type: 'subagent', ...running(MAIN_CALL, { task: 'first ask', status: 'done', tools: 40, seconds: 900 }) });
    model.apply({ type: 'subagent', ...running(STEER_CALL, { task: 'follow-up' }) });
    model.apply({ type: 'subagent', ...running(STEER_CALL, { task: 'follow-up', status: 'done', tools: 4, seconds: 30 }) });

    expect(rail(model)).toEqual([expect.objectContaining({ status: 'done', task: 'follow-up' })]);
  });
});
