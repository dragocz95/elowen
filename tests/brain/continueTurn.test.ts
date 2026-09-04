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
function fakeSession(initial: Msg[], opts: { seam?: boolean; model?: unknown; compaction?: (last: Msg, skip?: boolean) => Promise<boolean> } = {}) {
  let messages = initial.slice();
  const batches: unknown[][] = [];
  const order: string[] = [];
  const session = {
    get messages() { return messages; },
    agent: { state: { get messages() { return messages; }, set messages(next: Msg[]) { messages = next.slice(); }, systemPrompt: 'stale override' } },
    _baseSystemPrompt: 'the base prompt',
    _systemPromptOverride: 'stale override' as string | undefined,
    _pendingNextTurnMessages: [] as unknown[],
    ...('model' in opts ? { model: opts.model } : {}),
    ...(opts.compaction ? { _checkCompaction: vi.fn(async (last: Msg, skip?: boolean) => { order.push('compaction'); return opts.compaction!(last, skip); }) } : {}),
    ...(opts.seam === false ? {} : {
      _runAgentPrompt: vi.fn(async (batch: unknown[]) => {
        order.push('run');
        batches.push(batch);
        messages = [...messages, ...(batch as Msg[]), { role: 'assistant', content: [{ type: 'text', text: 'next step' }], stopReason: 'stop', usage }];
      }),
    }),
  };
  return { session: session as unknown as AgentSession, raw: session, batches, order, state: () => messages };
}

function storeWith(rows: { role: string; content: object }[], sessionId = 'brain-1'): { store: BrainStore; sessionId: string; db: ReturnType<typeof openDb> } {
  const db = openDb(':memory:');
  const store = new BrainStore(db);
  store.createSession({ id: sessionId, userId: 1, model: 'm' });
  projectUserTurn(store, sessionId, 'do the thing');
  rows.forEach((row, index) => store.appendMessage({ id: `r${index}`, sessionId, parentId: null, role: row.role, content: row.content }));
  return { store, sessionId, db };
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

  it('an unfinished sub-agent tail (an orphaned runner\'s aborted text) is RETIRED from PI state AND the transcript, then continued from the message before it', async () => {
    const { store, sessionId, db } = storeWith([
      { role: 'assistant', content: { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'Bash', arguments: {} }], stopReason: 'toolUse', usage } },
      { role: 'toolResult', content: { role: 'toolResult', toolCallId: 't1', content: [{ type: 'text', text: 'ok' }] } },
      { role: 'assistant', content: { role: 'assistant', content: [{ type: 'text', text: 'I will now sta' }], stopReason: 'aborted', usage } },
    ], 'brain-ch-subagent-orphan');
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
    // Retired, not deleted: the row is still in the table (its usage was paid for), just invisible.
    const raw = db.prepare('SELECT id, pending FROM brain_messages WHERE session_id = ? ORDER BY rowid').all(sessionId) as { id: string; pending: number }[];
    expect(raw.at(-1)).toEqual({ id: 'r2', pending: 2 });
  });

  it("keeps a user's own Esc-cut answer on the resume path too (settled, aborted, with text): nothing to continue", async () => {
    const { store, sessionId } = storeWith([
      { role: 'assistant', content: { role: 'assistant', content: [{ type: 'text', text: 'Once upon a' }], stopReason: 'aborted', usage } },
    ]);
    const { session, batches } = fakeSession(store.getMessages(sessionId).map((row) => JSON.parse(row.content) as Msg));
    expect(await continueInterruptedTurn(session, { store, sessionId })).toBe('nothing');
    expect(batches).toEqual([]);
    expect(store.getMessages(sessionId).map((row) => row.role)).toEqual(['user', 'assistant']);
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

  describe('does what PI\'s prompt() does before a run, minus the user message', () => {
    const tail: Msg[] = [
      { role: 'user', content: 'do the thing' },
      { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'Bash', arguments: {} }], stopReason: 'toolUse', usage },
      { role: 'toolResult', toolCallId: 't1', content: [{ type: 'text', text: '[interrupted] …' }] },
    ];

    it('runs the PRE-PROMPT compaction check on the last assistant BEFORE the first request, through the session seam', async () => {
      // A parked session that crossed its threshold while it ran must compact before the continuation's
      // first model call, exactly as it would before a new prompt (skipAbortedCheck=false is PI's
      // pre-prompt mode, the one the coordinator treats as admission-gating).
      const seen: [Msg, boolean | undefined][] = [];
      const { session, order } = fakeSession(tail, { compaction: async (last, skip) => { seen.push([last, skip]); return true; } });
      expect(await continueInterruptedTurn(session)).toBe('continued');
      expect(order).toEqual(['compaction', 'run']);
      expect(seen).toEqual([[tail[1], false]]);
    });

    it('resets the system prompt to the base prompt (a stale per-turn override never leaks into the continued turn)', async () => {
      const { session, raw } = fakeSession(tail);
      await continueInterruptedTurn(session);
      expect(raw.agent.state.systemPrompt).toBe('the base prompt');
      expect(raw._systemPromptOverride).toBeUndefined();
    });

    it('flushes messages queued for the next turn into the run — still no user message', async () => {
      const { session, raw, batches, state } = fakeSession(tail);
      const queued = { role: 'custom', customType: 'note', content: 'deliver next turn' };
      raw._pendingNextTurnMessages = [queued];
      expect(await continueInterruptedTurn(session)).toBe('continued');
      expect(batches).toEqual([[queued]]);
      expect(raw._pendingNextTurnMessages).toEqual([]);
      expect(state().map((m) => m.role)).toEqual(['user', 'assistant', 'toolResult', 'custom', 'assistant']);
    });

    it('refuses to continue without a selected model, like prompt() does', async () => {
      const { session, batches } = fakeSession(tail, { model: undefined });
      await expect(continueInterruptedTurn(session)).rejects.toThrow(/no model selected/);
      expect(batches).toEqual([]);
    });
  });
});
