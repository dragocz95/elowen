import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { persistCompaction, projectEvent, projectUserTurn, rehydrate } from '../../src/brain/persistence.js';
import { newCostMeter, runWithMeter } from '../../src/brain/openrouterMeter.js';
import { NO_REPLY_NUDGE } from '../../src/brain/messageView.js';
import type { AgentSession } from '@earendil-works/pi-coding-agent';

describe('brain persistence', () => {
  let store: BrainStore;
  beforeEach(() => {
    store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: 's1', userId: 1, model: 'm' });
  });

  it('projectUserTurn persists the user prompt', () => {
    projectUserTurn(store, 's1', 'hi there');
    const msgs = store.getMessages('s1');
    expect(msgs.at(-1)!.role).toBe('user');
    expect(JSON.parse(msgs.at(-1)!.content)).toMatchObject({ content: 'hi there' });
  });

  it('projectEvent persists assistant messages from agent_end', () => {
    projectEvent(store, 's1', { type: 'agent_end', willRetry: false, messages: [{ role: 'assistant', content: 'hello' }] } as never);
    const msgs = store.getMessages('s1');
    expect(msgs.at(-1)!.role).toBe('assistant');
    expect(JSON.parse(msgs.at(-1)!.content)).toMatchObject({ content: 'hello' });
  });

  it('projectEvent ignores non-terminal events', () => {
    projectEvent(store, 's1', { type: 'queue_update', steering: [], followUp: [] } as never);
    expect(store.getMessages('s1')).toHaveLength(0);
  });

  const costOf = (row: { content: string }) => JSON.parse(row.content).usage?.cost?.total;

  it('stamps the ambient meter cost onto the last assistant row (pi-ai dropped it)', () => {
    const meter = { ...newCostMeter(), reported: true, costUsd: 0.0125 };
    runWithMeter(meter, () => {
      projectEvent(store, 's1', { type: 'agent_end', willRetry: false, messages: [
        { role: 'assistant', content: 'thinking', usage: { totalTokens: 100 } },
        { role: 'tool', content: 'ran' },
        { role: 'assistant', content: 'done', usage: { totalTokens: 20 } }, // last assistant → carries cost
      ] } as never);
      return Promise.resolve();
    });
    const rows = store.getMessages('s1');
    const assistants = rows.filter((r) => r.role === 'assistant');
    expect(costOf(assistants[0]!)).toBeUndefined();      // earlier assistant untouched
    expect(costOf(assistants[1]!)).toBeCloseTo(0.0125);  // real provider cost stamped on the last one
  });

  it('does NOT stamp when the meter never saw a provider cost', () => {
    const meter = { ...newCostMeter(), reported: false, costUsd: 0 };
    runWithMeter(meter, () => {
      projectEvent(store, 's1', { type: 'agent_end', willRetry: false, messages: [{ role: 'assistant', content: 'x', usage: { totalTokens: 5 } }] } as never);
      return Promise.resolve();
    });
    expect(costOf(store.getMessages('s1')[0]!)).toBeUndefined();
  });

  it('stamps only the DELTA across two agent_end events under one meter (no double-count)', () => {
    const meter = { ...newCostMeter(), reported: true, costUsd: 0.01 };
    runWithMeter(meter, () => {
      projectEvent(store, 's1', { type: 'agent_end', willRetry: false, messages: [{ role: 'assistant', content: 'a', usage: {} }] } as never);
      meter.costUsd = 0.017; // the thinking-only nudge added more spend
      projectEvent(store, 's1', { type: 'agent_end', willRetry: false, messages: [{ role: 'assistant', content: 'b', usage: {} }] } as never);
      return Promise.resolve();
    });
    const [first, second] = store.getMessages('s1');
    expect(costOf(first!)).toBeCloseTo(0.01);   // first event's total
    expect(costOf(second!)).toBeCloseTo(0.007);  // only the delta, not the cumulative 0.017
  });

  it('rehydrate replays stored messages into an in-memory SessionManager', () => {
    projectUserTurn(store, 's1', 'earlier q');
    const sm = rehydrate(store, 's1', process.cwd());
    expect(sm.isPersisted()).toBe(false);
    expect(sm.getEntries().length).toBeGreaterThanOrEqual(1);
  });

  it('persistCompaction keeps the CLEAN store tail (never the live prompted text) + a divider, and rehydrate replays the shrunk context', () => {
    // A full pre-compaction log in the store — the CLEAN rows projectUserTurn/projectEvent wrote.
    projectUserTurn(store, 's1', 'q1');
    projectEvent(store, 's1', { type: 'agent_end', willRetry: false, messages: [{ role: 'assistant', content: 'a1' }] } as never);
    projectUserTurn(store, 's1', 'q2');
    projectEvent(store, 's1', { type: 'agent_end', willRetry: false, messages: [{ role: 'assistant', content: 'a2' }] } as never);
    expect(store.getMessages('s1')).toHaveLength(4);

    // PI compacted in-memory: session.messages is [compactionSummary, ...keptTail]. The kept USER entry
    // carries the EPHEMERAL live-prompt framing (memory block, turn context) + an image part — exactly
    // what must NEVER be persisted. persistCompaction must ignore this content and keep the store's own
    // clean 'q2' row instead.
    const session = {
      messages: [
        { role: 'compactionSummary', summary: 'q1/a1/q2 summarized', tokensBefore: 500 },
        { role: 'user', content: [{ type: 'text', text: '<user_memories>secret</user_memories>\n\n<context>...</context>\n\nq2' }, { type: 'image', data: 'BASE64PIXELS' }] },
        { role: 'assistant', content: 'a2' },
      ],
    } as unknown as AgentSession;

    persistCompaction(store, session, 's1');

    // The store now holds the divider + kept tail, not the full log.
    const rows = store.getMessages('s1');
    expect(rows.map((r) => r.role)).toEqual(['compaction', 'user', 'assistant']);
    // The kept user row is the CLEAN persisted text — no leaked framing, no image bytes.
    const userContent = JSON.stringify(JSON.parse(rows[1]!.content));
    expect(JSON.parse(rows[1]!.content)).toMatchObject({ content: 'q2' });
    expect(userContent).not.toContain('user_memories');
    expect(userContent).not.toContain('BASE64PIXELS');

    // Rehydrate replays the SHRUNK context (summary + tail), so the token savings survive a respawn
    // instead of the full uncompacted log coming back.
    const sm = rehydrate(store, 's1', process.cwd());
    const ctx = sm.buildSessionContext();
    expect(ctx.messages).toHaveLength(3);
    expect(ctx.messages[0]).toMatchObject({ role: 'compactionSummary', summary: 'q1/a1/q2 summarized' });
    // The rehydrated user turn is the clean text, so the model never re-reads the stale ephemeral blocks.
    expect(JSON.stringify(ctx.messages[1])).not.toContain('user_memories');
  });

  it('persistCompaction maps NO_REPLY_NUDGE tails correctly — a nudge user message has no store row, so it is not counted', () => {
    // Turn A (kept), then a thinking-only turn B whose nudge produced the real reply. The store has NO
    // row for the NO_REPLY_NUDGE user prompt (projectUserTurn is never called for it), only its reply.
    projectUserTurn(store, 's1', 'qA');
    projectEvent(store, 's1', { type: 'agent_end', willRetry: false, messages: [{ role: 'assistant', content: 'aA' }] } as never);
    projectUserTurn(store, 's1', 'qB');
    projectEvent(store, 's1', { type: 'agent_end', willRetry: false, messages: [{ role: 'assistant', content: '' }] } as never); // thinking-only
    projectEvent(store, 's1', { type: 'agent_end', willRetry: false, messages: [{ role: 'assistant', content: 'aB' }] } as never); // nudge reply
    expect(store.getMessages('s1').map((r) => r.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'assistant']);

    // PI's kept tail keeps turn B — including the extra NO_REPLY_NUDGE user message PI holds but the store
    // never persisted. keepLastN must exclude it → keep the last 3 store rows (qB, thinking, aB).
    const session = {
      messages: [
        { role: 'compactionSummary', summary: 'turn A', tokensBefore: 100 },
        { role: 'user', content: 'qB (framed)' },
        { role: 'assistant', content: '' },
        { role: 'user', content: [{ type: 'text', text: NO_REPLY_NUDGE }] },
        { role: 'assistant', content: 'aB' },
      ],
    } as unknown as AgentSession;

    persistCompaction(store, session, 's1');

    const rows = store.getMessages('s1');
    // divider + exactly the last 3 clean store rows of turn B (turn A's qA/aA are dropped).
    expect(rows.map((r) => r.role)).toEqual(['compaction', 'user', 'assistant', 'assistant']);
    expect(JSON.parse(rows[1]!.content)).toMatchObject({ content: 'qB' });
    expect(JSON.stringify(rows.map((r) => JSON.parse(r.content)))).not.toContain('qA');
  });
});
