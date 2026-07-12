import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { createSessionPersistenceProjector, persistCompaction, projectEvent, projectUserTurn, rehydrate } from '../../src/brain/persistence.js';
import { newCostMeter, runWithMeter } from '../../src/brain/openrouterMeter.js';
import { NO_REPLY_NUDGE } from '../../src/brain/messageView.js';
import type { AgentSession } from '@earendil-works/pi-coding-agent';

describe('brain persistence', () => {
  let db: ReturnType<typeof openDb>;
  let store: BrainStore;
  beforeEach(() => {
    db = openDb(':memory:');
    store = new BrainStore(db);
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

  it('reorders pre-projected steering into the settled PI run instead of leaving it before earlier output', () => {
    const initialId = projectUserTurn(store, 's1', 'initial clean prompt');
    // A delivered steer is projected at PI's message_start after the agent already emitted an
    // assistant/tool pair. PI's terminal run carries that true order.
    const steerId = projectUserTurn(store, 's1', 'steer after the tool');
    // Make the regression deterministic: generated rows are persisted at agent_end (much later), whereas
    // these already-durable users retain when they were actually received. created_at must remain metadata;
    // it cannot override the PI event sequence reconstructed by persistAgentRun.
    db.prepare('UPDATE brain_messages SET created_at = ? WHERE id = ?').run('2000-01-01 00:00:00', initialId);
    db.prepare('UPDATE brain_messages SET created_at = ? WHERE id = ?').run('2000-01-01 00:00:05', steerId);
    projectEvent(store, 's1', {
      type: 'agent_end', willRetry: false,
      messages: [
        { role: 'user', content: '<ephemeral context>initial clean prompt' },
        { role: 'assistant', content: 'I will inspect it.' },
        { role: 'tool', content: 'read_file complete' },
        { role: 'user', content: 'steer after the tool' },
        { role: 'assistant', content: 'Adjusted course.' },
      ],
    } as never);

    const rows = store.getMessages('s1');
    expect(rows.map((row) => row.role)).toEqual(['user', 'assistant', 'tool', 'user', 'assistant']);
    expect(rows.map((row) => JSON.parse(row.content).content)).toEqual([
      'initial clean prompt', 'I will inspect it.', 'read_file complete', 'steer after the tool', 'Adjusted course.',
    ]);
    expect(rows.find((row) => row.id === steerId)?.created_at).toBe('2000-01-01 00:00:05');
  });

  it('projectEvent ignores non-terminal events', () => {
    projectEvent(store, 's1', { type: 'queue_update', steering: [], followUp: [] } as never);
    expect(store.getMessages('s1')).toHaveLength(0);
  });

  it('persists overflow recovery in PI post-removal order, without the transient 400 assistant', () => {
    projectUserTurn(store, 's1', 'old question');
    projectEvent(store, 's1', { type: 'agent_end', willRetry: false, messages: [{ role: 'assistant', content: 'old answer' }] } as never);
    projectUserTurn(store, 's1', 'question at the context cliff');

    const overflow = {
      role: 'assistant', content: [], stopReason: 'error', provider: 'deepseek', model: 'deepseek-chat',
      errorMessage: '400 status code (no body)', timestamp: 10,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
    };
    const session = { messages: [] as unknown[] } as unknown as AgentSession;
    const project = createSessionPersistenceProjector(store, session, 's1', 200_000);

    // PI emits this before deciding to compact. It must not become durable yet.
    project({ type: 'agent_end', willRetry: false, messages: [overflow] } as never);
    expect(store.getMessages('s1').map((row) => row.role)).toEqual(['user', 'assistant', 'user']);

    // At compaction_end PI's live list still contains the overflow error after the kept tail. PI removes
    // it immediately after listeners return; the store must mirror that post-listener context.
    session.messages = [
      { role: 'compactionSummary', summary: 'old turn summarized', tokensBefore: 200_000 },
      { role: 'user', content: '<context>ephemeral</context>\n\nquestion at the context cliff' },
      overflow,
    ] as never;
    project({
      type: 'compaction_end', reason: 'overflow', result: { summary: 'old turn summarized' },
      aborted: false, willRetry: true,
    } as never);
    expect(store.getMessages('s1').map((row) => row.role)).toEqual(['compaction', 'user']);

    // The retry succeeds. Rehydration now equals PI's post-removal context plus that success.
    session.messages = session.messages.slice(0, -1) as never;
    project({ type: 'agent_end', willRetry: false, messages: [{ role: 'assistant', content: 'recovered answer', stopReason: 'stop' }] } as never);
    const context = rehydrate(store, 's1', process.cwd()).buildSessionContext().messages;
    expect(context.map((message) => message.role)).toEqual(['compactionSummary', 'user', 'assistant']);
    expect(JSON.stringify(context)).not.toContain('400 status code');
    expect(JSON.stringify(context)).not.toContain('ephemeral');
    expect(JSON.stringify(context)).toContain('recovered answer');
  });

  it('persists the deferred overflow assistant when recovery compaction itself fails', () => {
    projectUserTurn(store, 's1', 'too large');
    const overflow = {
      role: 'assistant', content: [], stopReason: 'error', provider: 'deepseek', model: 'deepseek-chat',
      errorMessage: '400 status code (no body)', timestamp: 10,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
    };
    const session = { messages: [overflow] } as unknown as AgentSession;
    const project = createSessionPersistenceProjector(store, session, 's1', 200_000);
    project({ type: 'agent_end', willRetry: false, messages: [overflow] } as never);
    project({ type: 'compaction_end', reason: 'overflow', result: undefined, aborted: false, willRetry: false } as never);
    expect(store.getMessages('s1').map((row) => row.role)).toEqual(['user', 'assistant']);
    expect(store.getMessages('s1').at(-1)!.content).toContain('400 status code');
  });

  it('persists a successful over-window assistant before non-retrying overflow compaction', () => {
    projectUserTurn(store, 's1', 'large but successful');
    const success = {
      role: 'assistant', content: 'complete answer', stopReason: 'stop', provider: 'relay', model: 'm', timestamp: 10,
      usage: { input: 210_000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 210_100, cost: { total: 0 } },
    };
    const session = { messages: [
      { role: 'compactionSummary', summary: 'large exchange summarized', tokensBefore: 210_100 }, success,
    ] } as unknown as AgentSession;
    const project = createSessionPersistenceProjector(store, session, 's1', 200_000);
    project({ type: 'agent_end', willRetry: false, messages: [success] } as never);
    expect(store.getMessages('s1').map((row) => row.role)).toEqual(['user', 'assistant']);
    project({
      type: 'compaction_end', reason: 'overflow', result: { summary: 'large exchange summarized' },
      aborted: false, willRetry: false,
    } as never);
    expect(store.getMessages('s1').map((row) => row.role)).toEqual(['compaction', 'assistant']);
    expect(store.getMessages('s1').at(-1)!.content).toContain('complete answer');
  });

  it('flushes a deferred overflow error when PI settles without a compaction_end', () => {
    projectUserTurn(store, 's1', 'nothing summarizable');
    const overflow = {
      role: 'assistant', content: [], stopReason: 'error', provider: 'deepseek', model: 'deepseek-chat',
      errorMessage: '400 status code (no body)', timestamp: 10,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
    };
    const session = { messages: [overflow] } as unknown as AgentSession;
    const project = createSessionPersistenceProjector(store, session, 's1', 200_000);
    project({ type: 'agent_end', willRetry: false, messages: [overflow] } as never);
    project({ type: 'agent_settled' } as never);
    expect(store.getMessages('s1').map((row) => row.role)).toEqual(['user', 'assistant']);
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

  it('persistCompaction does NOT drop a kept message when a pre-prompt compaction leaves a trailing unprocessed user row', () => {
    // Reproduces the pre-prompt auto-compact case (channels/turnRunner): projectUserTurn writes the NEW
    // user turn to the store BEFORE session.prompt(); PI's `_checkCompaction` then runs at the very start
    // of prompt() — BEFORE that user message is pushed to session.messages. So at compaction time the
    // store has ONE trailing user row ('q3') that PI's kept tail does NOT contain.
    projectUserTurn(store, 's1', 'q1');
    projectEvent(store, 's1', { type: 'agent_end', willRetry: false, messages: [{ role: 'assistant', content: 'a1' }] } as never);
    projectUserTurn(store, 's1', 'q2');
    projectEvent(store, 's1', { type: 'agent_end', willRetry: false, messages: [{ role: 'assistant', content: 'a2' }] } as never);
    projectUserTurn(store, 's1', 'q3'); // the in-flight turn's user row — persisted before prompt()
    expect(store.getMessages('s1').map((r) => r.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);

    // PI compacted at the start of q3's prompt(): it summarized q1/a1 and kept q2/a2. q3 is NOT in the
    // live context yet (it is only pushed after the compaction check), so the kept tail ends at a2.
    const session = {
      messages: [
        { role: 'compactionSummary', summary: 'q1/a1 summarized', tokensBefore: 400 },
        { role: 'user', content: [{ type: 'text', text: '<user_memories>x</user_memories>\n\nq2' }] },
        { role: 'assistant', content: 'a2' },
      ],
    } as unknown as AgentSession;

    persistCompaction(store, session, 's1');

    // The kept context (q2/a2) must survive, the trailing in-flight user row q3 stays as the newest row,
    // and only q1/a1 are folded into the divider. The bug dropped q2 and mis-kept q3 in its place.
    const rows = store.getMessages('s1');
    expect(rows.map((r) => r.role)).toEqual(['compaction', 'user', 'assistant', 'user']);
    expect(JSON.parse(rows[1]!.content)).toMatchObject({ content: 'q2' });
    expect(JSON.parse(rows[2]!.content)).toMatchObject({ content: 'a2' });
    expect(JSON.parse(rows[3]!.content)).toMatchObject({ content: 'q3' });
    // q1/a1 are gone from the rows (only referenced by the summary divider), and no clean row leaked framing.
    const body = JSON.stringify(rows.slice(1).map((r) => JSON.parse(r.content)));
    expect(body).not.toContain('q1');
    expect(body).not.toContain('user_memories');
  });

  it('persistCompaction does NOT delete a kept message when the kept tail is a lone user turn (all-user tail)', () => {
    // Adversarial edge: a huge user paste alone survives the cut (a user message is a valid PI cut point),
    // and its turn ends with NO assistant message (abort before first token). The kept tail is then a single
    // 'user' role. A NEXT user turn ('q_next') is projected in-flight. Role-only matching from the tail is
    // ambiguous here — both the in-flight row and the genuinely-kept giant are 'user' — so a smallest-skip
    // heuristic would keep just the in-flight row and DELETE the kept giant. The fix keeps both.
    projectUserTurn(store, 's1', 'q_old');
    projectEvent(store, 's1', { type: 'agent_end', willRetry: false, messages: [{ role: 'assistant', content: 'a_old' }] } as never);
    projectUserTurn(store, 's1', 'q_giant'); // huge paste, aborted turn → no assistant row follows
    projectUserTurn(store, 's1', 'q_next');  // the in-flight turn's user row, persisted before prompt()
    expect(store.getMessages('s1').map((r) => r.role)).toEqual(['user', 'assistant', 'user', 'user']);

    // PI compacted at the start of q_next's prompt(): summarized q_old/a_old, kept ONLY q_giant. q_next is
    // not in the live context yet, so the kept tail is the single user message q_giant.
    const session = {
      messages: [
        { role: 'compactionSummary', summary: 'q_old/a_old summarized', tokensBefore: 900 },
        { role: 'user', content: [{ type: 'text', text: '<user_memories>x</user_memories>\n\nq_giant' }] },
      ],
    } as unknown as AgentSession;

    persistCompaction(store, session, 's1');

    // q_giant (PI's kept tail) survives, q_next stays newest, only q_old/a_old fold into the divider.
    const rows = store.getMessages('s1');
    expect(rows.map((r) => r.role)).toEqual(['compaction', 'user', 'user']);
    expect(JSON.parse(rows[1]!.content)).toMatchObject({ content: 'q_giant' });
    expect(JSON.parse(rows[2]!.content)).toMatchObject({ content: 'q_next' });
  });
});
