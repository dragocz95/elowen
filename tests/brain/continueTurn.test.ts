import { describe, it, expect, vi } from 'vitest';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { continuable, continueInterruptedTurn } from '../../src/brain/session/continueTurn.js';
import { settlePartialTurn, projectUserTurn } from '../../src/brain/persistence.js';

/** The silent resume, tail shape by tail shape: what the checkpoint leaves behind and what a continuation
 *  does with it — never a message, only PI's empty-batch loop start (or nothing at all). */

const usage = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110 };
type Msg = { role?: string; content?: unknown; stopReason?: string; usage?: unknown; toolCallId?: string };

/** A fake PI session exposing exactly the seam continueInterruptedTurn probes: `_runAgentPrompt` (records
 *  the batch, appends the next assistant) and the agent state setter PI's own retry uses. */
function fakeSession(initial: Msg[], opts: { seam?: boolean } = {}) {
  let messages = initial.slice();
  const batches: unknown[][] = [];
  const session = {
    get messages() { return messages; },
    agent: { state: { get messages() { return messages; }, set messages(next: Msg[]) { messages = next.slice(); } } },
    ...(opts.seam === false ? {} : {
      _runAgentPrompt: vi.fn(async (batch: unknown[]) => {
        batches.push(batch);
        messages = [...messages, { role: 'assistant', content: [{ type: 'text', text: 'next step' }], stopReason: 'stop', usage }];
      }),
    }),
  };
  return { session: session as unknown as AgentSession, batches, state: () => messages };
}

function storeWith(rows: { role: string; content: object }[]): { store: BrainStore; sessionId: string } {
  const store = new BrainStore(openDb(':memory:'));
  const sessionId = 'brain-1';
  store.createSession({ id: sessionId, userId: 1, model: 'm' });
  projectUserTurn(store, sessionId, 'do the thing');
  rows.forEach((row, index) => store.appendMessage({ id: `r${index}`, sessionId, parentId: null, role: row.role, content: row.content }));
  return { store, sessionId };
}

describe('continueInterruptedTurn — the resume is a continuation, never a message', () => {
  it('a tail of answered tool calls (the checkpoint after settlePartialTurn) continues with an EMPTY batch', async () => {
    const { session, batches, state } = fakeSession([
      { role: 'user', content: 'do the thing' },
      { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'Bash', arguments: {} }], stopReason: 'toolUse', usage },
      { role: 'toolResult', toolCallId: 't1', content: [{ type: 'text', text: '[interrupted] …' }] },
    ]);
    expect(await continueInterruptedTurn(session)).toBe('continued');
    expect(batches).toEqual([[]]); // nothing appended: PI runs the loop over the context as it stands
    expect(state().map((m) => m.role)).toEqual(['user', 'assistant', 'toolResult', 'assistant']);
  });

  it('a tail ending on the user message (nothing of the turn survived) continues the same way', async () => {
    const { session, batches } = fakeSession([{ role: 'user', content: 'do the thing' }]);
    expect(await continueInterruptedTurn(session)).toBe('continued');
    expect(batches).toEqual([[]]);
  });

  it('a provably final assistant tail is left alone: nothing to continue', async () => {
    const { session, batches, state } = fakeSession([
      { role: 'user', content: 'do the thing' },
      { role: 'assistant', content: [{ type: 'text', text: 'all done' }], stopReason: 'stop', usage },
    ]);
    expect(await continueInterruptedTurn(session)).toBe('nothing');
    expect(batches).toEqual([]);
    expect(state()).toHaveLength(2);
  });

  it('a partially streamed assistant tail is trimmed from PI state AND the durable transcript, then continued from the message before it', async () => {
    const { store, sessionId } = storeWith([
      { role: 'assistant', content: { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'Bash', arguments: {} }], stopReason: 'toolUse', usage } },
      { role: 'toolResult', content: { role: 'toolResult', toolCallId: 't1', content: [{ type: 'text', text: 'ok' }] } },
      { role: 'assistant', content: { role: 'assistant', content: [{ type: 'text', text: 'I will now sta' }] } }, // no stop, no usage
    ]);
    const before = store.getMessages(sessionId);
    const { session, batches, state } = fakeSession(before.map((row) => JSON.parse(row.content) as Msg));

    expect(await continueInterruptedTurn(session, { store, sessionId })).toBe('continued');
    expect(batches).toEqual([[]]);
    // The one row a resume may rewrite: the fragment. Everything before it is byte-identical.
    const after = store.getMessages(sessionId);
    expect(after.map((row) => row.id)).toEqual(before.slice(0, -1).map((row) => row.id));
    expect(after.map((row) => row.content)).toEqual(before.slice(0, -1).map((row) => row.content));
    expect(state().map((m) => m.role)).toEqual(['user', 'assistant', 'toolResult', 'assistant']);
    expect((state().at(-1) as Msg).stopReason).toBe('stop'); // the regenerated answer, not the fragment
  });

  it('an errored assistant left by a failed earlier resume is trimmed the same way (no double answer, no dead end)', async () => {
    const { store, sessionId } = storeWith([
      { role: 'assistant', content: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'provider unavailable' } },
    ]);
    const { session, batches } = fakeSession(store.getMessages(sessionId).map((row) => JSON.parse(row.content) as Msg));
    expect(await continueInterruptedTurn(session, { store, sessionId })).toBe('continued');
    expect(batches).toEqual([[]]);
    expect(store.getMessages(sessionId).map((row) => row.role)).toEqual(['user']);
  });

  it('never trims a provably final assistant from the durable transcript', async () => {
    const { store, sessionId } = storeWith([
      { role: 'assistant', content: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop', usage } },
    ]);
    const { session } = fakeSession(store.getMessages(sessionId).map((row) => JSON.parse(row.content) as Msg));
    expect(await continueInterruptedTurn(session, { store, sessionId })).toBe('nothing');
    expect(store.getMessages(sessionId).map((row) => row.role)).toEqual(['user', 'assistant']);
  });

  it('an empty transcript has nothing to continue', async () => {
    const { session, batches } = fakeSession([]);
    expect(await continueInterruptedTurn(session)).toBe('nothing');
    expect(batches).toEqual([]);
  });

  it('fails loudly when the PI runtime lacks the seam, instead of resuming nothing in silence', async () => {
    const { session } = fakeSession([{ role: 'user', content: 'x' }], { seam: false });
    await expect(continueInterruptedTurn(session)).rejects.toThrow(/continuation seam/);
  });

  it('the settled checkpoint of every interrupted shape is continuable, except a finished turn', () => {
    const shapes: { label: string; rows: { role: string; content: object }[]; continuableAfter: boolean }[] = [
      { label: 'pending tool calls', rows: [{ role: 'assistant', content: { role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'Bash', arguments: {} }], stopReason: 'toolUse' } }], continuableAfter: true },
      { label: 'pending Delegate', rows: [{ role: 'assistant', content: { role: 'assistant', content: [{ type: 'toolCall', id: 'd', name: 'Delegate', arguments: {} }], stopReason: 'toolUse' } }], continuableAfter: true },
      { label: 'partial assistant', rows: [{ role: 'assistant', content: { role: 'assistant', content: [{ type: 'text', text: 'half' }] } }], continuableAfter: true },
      { label: 'empty assistant (orphaned runner)', rows: [{ role: 'assistant', content: { role: 'assistant', content: [], stopReason: 'aborted' } }], continuableAfter: true },
      { label: 'final assistant', rows: [{ role: 'assistant', content: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop', usage } }], continuableAfter: false },
    ];
    for (const shape of shapes) {
      const { store, sessionId } = storeWith([]);
      shape.rows.forEach((row, index) => store.appendPendingMessage({ id: `p${index}`, sessionId, role: row.role, content: row.content }));
      const settled = settlePartialTurn(store, sessionId);
      expect(settled.tail, shape.label).toBe(shape.continuableAfter ? 'continuable' : 'final');
      expect(continuable(store.getMessages(sessionId).map((row) => JSON.parse(row.content) as Msg)), shape.label).toBe(shape.continuableAfter);
    }
  });
});
