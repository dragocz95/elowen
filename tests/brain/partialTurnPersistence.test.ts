import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { answeredToolCallPrefix, settlePartialTurn, projectUserTurn, projectEvent } from '../../src/brain/persistence.js';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';

/** PI message shapes, trimmed to the fields the persistence path actually reads. */
const assistantSaying = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] });
const assistantCalling = (...ids: string[]) => ({ role: 'assistant', content: ids.map((id) => ({ type: 'toolCall', id, name: 'bash', arguments: {} })) });
const toolResult = (toolCallId: string) => ({ role: 'toolResult', toolCallId, toolName: 'bash', content: [{ type: 'text', text: 'ok' }], isError: false });

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

  /** What the session's live projector does while PI works through a turn. */
  const midTurn = (...messages: unknown[]) => messages.forEach((m, i) =>
    store.appendPendingMessage({ id: `entry-${i}`, sessionId: 's1', role: (m as { role: string }).role, content: m }));

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

  it('replaces the mid-turn rows instead of duplicating the whole turn', () => {
    projectUserTurn(store, 's1', 'do the thing');
    store.appendPendingMessage({ id: 'e0', sessionId: 's1', role: 'assistant', content: assistantCalling('t1') });
    store.appendPendingMessage({ id: 'e1', sessionId: 's1', role: 'toolResult', content: toolResult('t1') });
    store.appendPendingMessage({ id: 'e2', sessionId: 's1', role: 'assistant', content: assistantSaying('done') });

    projectEvent(store, 's1', agentEnd({ role: 'user', content: 'do the thing' }, assistantCalling('t1'), toolResult('t1'), assistantSaying('done')));

    expect(rolesOf(store, 's1')).toEqual(['user', 'assistant', 'toolResult', 'assistant']);
    expect(store.pendingMessages('s1')).toEqual([]);
  });

  // A run with no pre-projected user row (an internal nudge) takes persistAgentRun's fallback append path.
  // That path must still land on a store the provisional rows have already been cleared from.
  it('does not duplicate on the fallback append path either', () => {
    store.appendPendingMessage({ id: 'e0', sessionId: 's1', role: 'assistant', content: assistantSaying('nudged reply') });
    projectEvent(store, 's1', agentEnd(assistantSaying('nudged reply')));
    expect(rolesOf(store, 's1')).toEqual(['assistant']);
    expect(store.pendingMessages('s1')).toEqual([]);
  });

  it('a re-delivered entry (resubscribe) cannot write the same row twice', () => {
    store.appendPendingMessage({ id: 'e0', sessionId: 's1', role: 'assistant', content: assistantSaying('once') });
    store.appendPendingMessage({ id: 'e0', sessionId: 's1', role: 'assistant', content: assistantSaying('once') });
    expect(store.pendingMessages('s1')).toHaveLength(1);
  });
});
