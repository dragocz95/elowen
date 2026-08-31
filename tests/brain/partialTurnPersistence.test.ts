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

  it('drops a tool call the crash cut off from its result, so the history stays replayable', () => {
    projectUserTurn(store, 's1', 'do the thing');
    midTurn(assistantCalling('t1'), toolResult('t1'), assistantCalling('t2')); // died before t2 answered

    settlePartialTurn(store, 's1');
    expect(rolesOf(store, 's1')).toEqual(['user', 'assistant', 'toolResult']);
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

    settlePartialTurn(store, 's1');
    expect(store.getMessages('s1').map((row) => row.id)).toEqual(displayed.map((row) => row.id));
    expect(store.getMessages('s1').every((row) => row.pending === 0)).toBe(true);
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
