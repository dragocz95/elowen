import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import {
  answeredToolCallPrefix, recoverablePartialTurnRows, settlePartialTurn, projectUserTurn, createSessionPersistenceProjector,
} from '../../src/brain/persistence.js';
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';

/** PI message shapes, trimmed to the fields the persistence path actually reads. */
const assistantSaying = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] });
const assistantCalling = (...ids: string[]) => ({ role: 'assistant', content: ids.map((id) => ({ type: 'toolCall', id, name: 'bash', arguments: {} })) });
const toolResult = (toolCallId: string) => ({ role: 'toolResult', toolCallId, toolName: 'bash', content: [{ type: 'text', text: 'ok' }], isError: false });

/** The real projector, wired as the session factory wires it. Everything mid-turn MUST be driven through
 *  this rather than by calling the store directly: the previous version of this fix hooked an event PI
 *  only ever emits with `type: "custom"` entries, so the mirror never once ran in production — and these
 *  tests all passed anyway, because they reached past the projector straight into the store. `session` is
 *  read only by the compaction path, which none of these tests take. */
const projectorFor = (store: BrainStore, sessionId: string): ((event: AgentSessionEvent) => void) =>
  createSessionPersistenceProjector(store, { messages: [] } as unknown as AgentSession, sessionId, 200_000);

/** What PI emits the moment it has finished one message of the live turn. */
const messageEnd = (message: unknown) => ({ type: 'message_end', message }) as unknown as AgentSessionEvent;

const rolesOf = (store: BrainStore, id: string) => store.getMessages(id).map((m) => m.role);
const textsOf = (store: BrainStore, id: string) => store.getMessages(id).map((m) => JSON.parse(m.content).content?.[0]?.text ?? JSON.parse(m.content).content);

describe('answeredToolCallPrefix', () => {
  const serialize = (...messages: unknown[]) => messages.map((m) => JSON.stringify(m));

  it('accepts a run where every tool call got its result', () => {
    expect(answeredToolCallPrefix(serialize(assistantCalling('t1'), toolResult('t1'), assistantSaying('done')))).toBe(3);
  });

  // A provider rejects any context holding a tool call with no result, so a turn cut off between the call
  // and its result must NOT come back as history — it would poison every later turn with a 400.
  it('cuts a tail whose tool call never got its result', () => {
    expect(answeredToolCallPrefix(serialize(assistantCalling('t1'), toolResult('t1'), assistantCalling('t2')))).toBe(2);
  });

  it('waits for EVERY result of a parallel call, not just the first', () => {
    const parallel = serialize(assistantCalling('t1', 't2'), toolResult('t1'));
    expect(answeredToolCallPrefix(parallel)).toBe(0);
    expect(answeredToolCallPrefix([...parallel, JSON.stringify(toolResult('t2'))])).toBe(3);
  });

  it('stops at a row it cannot parse rather than trusting what follows it', () => {
    expect(answeredToolCallPrefix([JSON.stringify(assistantSaying('kept')), '{oops', JSON.stringify(assistantSaying('lost'))])).toBe(1);
  });

  it('has nothing to keep when the very first thing was an unanswered call', () => {
    expect(answeredToolCallPrefix(serialize(assistantCalling('t1')))).toBe(0);
  });
});

// The bug: everything a turn produced reached SQLite only at agent_end, so a daemon restart mid-turn threw
// away the whole run — every tool call, every word — leaving just the user's prompt.
describe('a turn interrupted by a daemon restart', () => {
  let store: BrainStore;
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
    store = new BrainStore(db);
    store.createSession({ id: 's1', userId: 1, model: 'm' });
  });

  /** PI working through a turn, driven through the real projector. */
  const midTurn = (...messages: unknown[]) => {
    const project = projectorFor(store, 's1');
    messages.forEach((m) => project(messageEnd(m)));
  };

  // The regression that matters: the mirror has to actually FIRE. Asserting on the store alone cannot see
  // a projector that silently drops every event, which is exactly how this shipped broken once already.
  it('mirrors each message as PI finishes it, without waiting for the turn to settle', () => {
    const project = projectorFor(store, 's1');
    projectUserTurn(store, 's1', 'do the thing');

    project(messageEnd(assistantCalling('t1')));
    expect(store.pendingMessages('s1')).toHaveLength(1);
    project(messageEnd(toolResult('t1')));
    expect(store.pendingMessages('s1').map((row) => row.role)).toEqual(['assistant', 'toolResult']);
  });

  // The real prompt already has a clean durable row; PI's live user message carries the turn framing
  // (memory/permission blocks, raw image bytes, the no-reply nudge) that must never reach history.
  it('never mirrors a user message', () => {
    const project = projectorFor(store, 's1');
    project(messageEnd({ role: 'user', content: [{ type: 'text', text: 'framing the model sees, not history' }] }));
    expect(store.pendingMessages('s1')).toEqual([]);
  });

  // PI routes these to other entry types, and agent_end never reports them as run output — a mirrored row
  // would be one no settled turn could ever reconcile away.
  it('never mirrors a role that agent_end will not account for', () => {
    const project = projectorFor(store, 's1');
    for (const role of ['custom', 'bashExecution', 'compactionSummary', 'branchSummary']) {
      project(messageEnd({ role, content: [] }));
    }
    expect(store.pendingMessages('s1')).toEqual([]);
  });

  it('keeps the work the agent had already done when the daemon dies mid-turn', () => {
    projectUserTurn(store, 's1', 'do the thing');
    midTurn(assistantCalling('t1'), toolResult('t1'), assistantSaying('half a thought'));

    settlePartialTurn(store, 's1'); // the daemon restarts → the conversation is respawned
    expect(rolesOf(store, 's1')).toEqual(['user', 'assistant', 'toolResult', 'assistant']);
    expect(textsOf(store, 's1')[3]).toBe('half a thought');
    expect(store.pendingMessages('s1')).toEqual([]); // settled — the next turn must not discard them
  });

  it('answers a tool call the restart cut off with an `interrupted` error result, so the history stays replayable AND honest', () => {
    projectUserTurn(store, 's1', 'do the thing');
    midTurn(assistantCalling('t1'), toolResult('t1'), assistantCalling('t2')); // died before t2 answered

    const answered = settlePartialTurn(store, 's1');
    // The call is KEPT (the first version deleted it, and a resumed turn could then repeat the mutation
    // without knowing it had already started) and answered, so no provider rejects the context.
    expect(answered).toEqual([{ id: 't2', name: 'bash' }]);
    expect(rolesOf(store, 's1')).toEqual(['user', 'assistant', 'toolResult', 'assistant', 'toolResult']);
    const synthetic = JSON.parse(store.getMessages('s1').at(-1)!.content) as { toolCallId: string; isError: boolean; details: unknown; content: { text: string }[] };
    expect(synthetic.toolCallId).toBe('t2');
    expect(synthetic.isError).toBe(true);
    expect(synthetic.details).toEqual({ interrupted: true });
    expect(synthetic.content[0]!.text).toMatch(/\[interrupted\].*effect is unknown/);
    expect(store.pendingMessages('s1')).toEqual([]);
  });

  it('answers EVERY unanswered call of a parallel batch, one result per call', () => {
    projectUserTurn(store, 's1', 'do the thing');
    midTurn(assistantCalling('a', 'b', 'c'), toolResult('b')); // b answered, a and c cut off

    expect(settlePartialTurn(store, 's1').map((call) => call.id).sort()).toEqual(['a', 'c']);
    const results = store.getMessages('s1').filter((row) => row.role === 'toolResult')
      .map((row) => JSON.parse(row.content) as { toolCallId: string; isError: boolean });
    expect(results.map((r) => r.toolCallId).sort()).toEqual(['a', 'b', 'c']);
    expect(results.filter((r) => r.isError).map((r) => r.toolCallId).sort()).toEqual(['a', 'c']);
  });

  it('tells a waiting Delegate call that its sub-agent resumes on its own, never "effect unknown"', () => {
    store.createSession({ id: 'brain-ch-subagent-kid', userId: 1, model: 'm', parentSessionId: 's1' });
    store.upsertSubagentRun('s1', { id: 'd1', sessionId: 'brain-ch-subagent-kid', status: 'running', task: 'dig', tools: 0, seconds: 1 });
    projectUserTurn(store, 's1', 'delegate it');
    midTurn({ role: 'assistant', content: [{ type: 'toolCall', id: 'd1', name: 'Delegate', arguments: {} }] });

    settlePartialTurn(store, 's1');
    const text = (JSON.parse(store.getMessages('s1').at(-1)!.content) as { content: { text: string }[] }).content[0]!.text;
    expect(text).toContain('brain-ch-subagent-kid');
    expect(text).toMatch(/resumed automatically/);
    expect(text).toMatch(/do NOT re-delegate/);
    expect(text).not.toMatch(/effect is unknown/);
  });

  it('folds a sub-agent answer that was already final before the pause straight into the interrupted Delegate result', () => {
    // The parent's blocked Delegate call never returned, but the child HAD finished: its answer is in
    // its transcript. Handing it over here is what lets the resumed parent continue at once instead of
    // waiting for anything (the "parent does not get the result" symptom).
    store.createSession({ id: 'brain-ch-subagent-done', userId: 1, model: 'm', parentSessionId: 's1' });
    store.appendMessage({ id: 'kid-a', sessionId: 'brain-ch-subagent-done', parentId: null, role: 'assistant', content: assistantSaying('THE ANSWER: 42') });
    store.upsertSubagentRun('s1', { id: 'd2', sessionId: 'brain-ch-subagent-done', status: 'done', task: 'dig', tools: 0, seconds: 1 });
    projectUserTurn(store, 's1', 'delegate it');
    midTurn({ role: 'assistant', content: [{ type: 'toolCall', id: 'd2', name: 'Delegate', arguments: {} }] });

    settlePartialTurn(store, 's1');
    const text = (JSON.parse(store.getMessages('s1').at(-1)!.content) as { content: { text: string }[] }).content[0]!.text;
    expect(text).toContain('THE ANSWER: 42');
    expect(text).toMatch(/result recovered/);
  });

  it('defines the same ordered rows for parked display and later settlement', () => {
    projectUserTurn(store, 's1', 'do the thing');
    midTurn(assistantCalling('t1'), toolResult('t1'));
    projectUserTurn(store, 's1', 'steer between steps');
    midTurn(assistantSaying('finished before restart'), assistantCalling('t2')); // unsafe suffix

    const displayed = recoverablePartialTurnRows(store.getMessages('s1'));
    expect(displayed.map((row) => row.role)).toEqual(['user', 'assistant', 'toolResult', 'user', 'assistant']);
    expect(displayed.map((row) => JSON.parse(row.content).content?.[0]?.text ?? JSON.parse(row.content).content))
      .toContain('finished before restart');

    // The settled transcript is exactly the displayed prefix, plus the interrupted call and its synthetic
    // answer — the display never shows a call as running that nothing is executing.
    settlePartialTurn(store, 's1');
    const settled = store.getMessages('s1');
    expect(settled.slice(0, displayed.length).map((row) => row.id)).toEqual(displayed.map((row) => row.id));
    expect(settled.slice(displayed.length).map((row) => row.role)).toEqual(['assistant', 'toolResult']);
    expect(settled.every((row) => row.pending === 0)).toBe(true);
  });

  it('leaves a conversation with no interrupted turn completely alone', () => {
    projectUserTurn(store, 's1', 'hi');
    settlePartialTurn(store, 's1');
    expect(rolesOf(store, 's1')).toEqual(['user']);
  });
});

// The other half of the contract: when the turn DOES settle, agent_end is authoritative. Its messages are
// the same ones already mirrored, so the provisional rows have to go — or the turn lands in the transcript
// twice.
describe('a turn that settles normally', () => {
  let store: BrainStore;
  beforeEach(() => {
    store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: 's1', userId: 1, model: 'm' });
  });

  const agentEnd = (...messages: unknown[]) => ({ type: 'agent_end', messages, willRetry: false }) as unknown as AgentSessionEvent;

  // Drives the same projector instance through the whole turn, exactly as a live session does: PI mirrors
  // each message as it lands, then agent_end settles the run.
  it('replaces the mid-turn rows instead of duplicating the whole turn', () => {
    const project = projectorFor(store, 's1');
    projectUserTurn(store, 's1', 'do the thing');
    project(messageEnd(assistantCalling('t1')));
    project(messageEnd(toolResult('t1')));
    project(messageEnd(assistantSaying('done')));

    project(agentEnd({ role: 'user', content: 'do the thing' }, assistantCalling('t1'), toolResult('t1'), assistantSaying('done')));

    expect(rolesOf(store, 's1')).toEqual(['user', 'assistant', 'toolResult', 'assistant']);
    expect(store.pendingMessages('s1')).toEqual([]);
  });

  // A run with no pre-projected user row (an internal nudge) takes persistAgentRun's fallback append path.
  // That path must still land on a store the provisional rows have already been cleared from.
  it('does not duplicate on the fallback append path either', () => {
    const project = projectorFor(store, 's1');
    project(messageEnd(assistantSaying('nudged reply')));
    project(agentEnd(assistantSaying('nudged reply')));
    expect(rolesOf(store, 's1')).toEqual(['assistant']);
    expect(store.pendingMessages('s1')).toEqual([]);
  });
});
