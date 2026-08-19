import { describe, expect, it } from 'vitest';
import type { BrainEvent } from '../../src/brain/events.js';
import { LiveEventReplay, appendReplayBrainEvent } from '../../src/brain/session/liveEventReplay.js';
import { TranscriptModel } from '../../src/brain/transcriptModel.js';

describe('LiveEventReplay', () => {
  it('coalesces concurrent snapshot buffers without mutating their shared event object', () => {
    const first: BrainEvent = { type: 'text', delta: 'hel' };
    const next: BrainEvent = { type: 'text', delta: 'lo' };
    const streamA: BrainEvent[] = [];
    const streamB: BrainEvent[] = [];

    // LiveEventReplay fans the same object reference to every listener. Each route buffers it while its
    // snapshot frame flushes, then observes the same next delta.
    appendReplayBrainEvent(streamA, first, 2_048);
    appendReplayBrainEvent(streamB, first, 2_048);
    appendReplayBrainEvent(streamA, next, 2_048);
    appendReplayBrainEvent(streamB, next, 2_048);

    expect(first).toEqual({ type: 'text', delta: 'hel' });
    expect(streamA).toEqual([{ type: 'text', delta: 'hello' }]);
    expect(streamB).toEqual([{ type: 'text', delta: 'hello' }]);
    expect(streamA[0]).not.toBe(streamB[0]);
  });

  it('preserves every step as an ordered render boundary in snapshots and route buffers', () => {
    const events: BrainEvent[] = [
      { type: 'step', step: 1, maxSteps: 0 },
      { type: 'text', delta: 'first' },
      { type: 'tool', id: 'read-1', name: 'Read', detail: 'a.ts' },
      { type: 'step', step: 2, maxSteps: 0 },
      { type: 'text', delta: 'second' },
    ];
    const replay = new LiveEventReplay(new Set());
    const routeBuffer: BrainEvent[] = [];
    for (const event of events) {
      replay.publish(event);
      appendReplayBrainEvent(routeBuffer, event);
    }

    expect(replay.snapshot().events).toEqual(events);
    expect(routeBuffer).toEqual(events);

    const transcript = new TranscriptModel();
    for (const event of replay.snapshot().events) transcript.apply(event);
    expect(transcript.turnCount).toBe(2);
    expect(transcript.turnAt(0)).toMatchObject({ role: 'elowen', streaming: false });
    expect(transcript.turnAt(1)).toMatchObject({ role: 'elowen', streaming: true });
  });

  it('fans out every delta but coalesces the bounded replay snapshot', () => {
    const delivered: BrainEvent[] = [];
    const replay = new LiveEventReplay(new Set([(event: BrainEvent) => delivered.push(event)]));
    replay.beginRun();
    replay.publish({ type: 'text', delta: 'hel' });
    replay.publish({ type: 'text', delta: 'lo' });
    replay.publish({ type: 'reasoning', delta: 'a' });
    replay.publish({ type: 'reasoning', delta: 'b' });

    expect(delivered).toHaveLength(4);
    expect(replay.snapshot().events).toEqual([
      { type: 'text', delta: 'hello' },
      { type: 'reasoning', delta: 'ab' },
    ]);
  });

  // Coalescing used to re-serialize the WHOLE accumulated string on every provider chunk, which is
  // quadratic in the length of a streamed answer — paid on the event loop every other session shares.
  // The assertion is on TIME because that is the property being protected; a correctness-only test
  // passes just as happily with the quadratic version. The threshold is deliberately loose (the linear
  // version runs in single-digit ms here) so it flags an algorithmic regression, not a slow machine.
  it('coalesces a long stream in linear time', () => {
    const replay = new LiveEventReplay(new Set());
    replay.beginRun();
    const chunk = 'x'.repeat(200);
    const started = Date.now();
    for (let i = 0; i < 4_000; i++) replay.publish({ type: 'text', delta: chunk });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(1_500);
  });

  it('coalesces characters that JSON has to escape', () => {
    const replay = new LiveEventReplay(new Set());
    replay.beginRun();
    // Quotes and newlines serialize longer than they read, which is exactly what the incremental size
    // estimate has to account for.
    replay.publish({ type: 'text', delta: 'a"b' });
    replay.publish({ type: 'text', delta: '\nc' });
    expect(replay.snapshot().events).toEqual([{ type: 'text', delta: 'a"b\nc' }]);
  });

  // The size budget is what stops one very long answer from pinning half a megabyte per session. It is
  // enforced from the running `chars` total, so an incremental estimate that drifted would silently
  // disable it — the stream would just keep growing.
  it('still enforces the size budget on a stream that outgrows it', () => {
    const replay = new LiveEventReplay(new Set());
    replay.beginRun();
    const chunk = 'y'.repeat(64 * 1024);
    for (let i = 0; i < 12; i++) replay.publish({ type: 'text', delta: chunk });
    const [event] = replay.snapshot().events;
    const kept = event?.type === 'text' ? event.delta.length : 0;
    expect(kept).toBeLessThan(12 * chunk.length);
  });

  it('replaces snapshot-style progress and hard-bounds event count', () => {
    const replay = new LiveEventReplay(new Set());
    replay.publish({ type: 'tool_progress', id: 'run', text: 'one' });
    replay.publish({ type: 'tool_progress', id: 'run', text: 'two' });
    expect(replay.snapshot().events).toEqual([{ type: 'tool_progress', id: 'run', text: 'two' }]);

    for (let i = 0; i < 700; i++) replay.publish({ type: 'tool', id: `t${i}`, name: 'Read' });
    expect(replay.snapshot().events.length).toBeLessThanOrEqual(512);
  });

  it('coalesces sub-agent snapshots by parent tool-call id', () => {
    const replay = new LiveEventReplay(new Set());
    replay.publish({ type: 'subagent', id: 'delegate-1', sessionId: 'child', status: 'running', task: 'x', tools: 0, seconds: 0 });
    replay.publish({ type: 'subagent', id: 'delegate-1', sessionId: 'child', status: 'done', task: 'x', tools: 4, tokens: 99, seconds: 2 });
    expect(replay.snapshot().events).toEqual([{
      type: 'subagent', id: 'delegate-1', sessionId: 'child', status: 'done', task: 'x', tools: 4, tokens: 99, seconds: 2,
    }]);
  });

  it('coalesces workflow snapshots by workflow id', () => {
    const replay = new LiveEventReplay(new Set());
    const wf = (status: 'running' | 'done', id = 'wf-1') => ({
      type: 'workflow' as const, id, toolCallId: 'call-1', status,
      nodes: [{ id: 'a', task: 'a', status: 'done' as const, deps: [] }],
    });
    replay.publish(wf('running'));
    replay.publish(wf('done'));
    expect(replay.snapshot().events).toEqual([wf('done')]);

    // Two workflows are two entries — coalescing is per id, not per type.
    replay.publish(wf('running', 'wf-2'));
    expect(replay.snapshot().events).toHaveLength(2);
  });

  // A workflow re-fans the WHOLE DAG on every tool call of every node. Uncoalesced, that storm used to
  // push real transcript events out of the bounded journal, so a reconnect mid-run lost the conversation.
  it('does not let a workflow snapshot storm evict earlier transcript events', () => {
    const replay = new LiveEventReplay(new Set());
    replay.publish({ type: 'text', delta: 'the reply the user is reading' });
    for (let i = 0; i < 700; i++) {
      replay.publish({
        type: 'workflow', id: 'wf-1', toolCallId: 'call-1', status: 'running',
        nodes: [{ id: 'a', task: 'x'.repeat(500), status: 'running', deps: [], detail: `tool ${i}` }],
      });
    }
    const events = replay.snapshot().events;
    expect(events[0]).toEqual({ type: 'text', delta: 'the reply the user is reading' });
    expect(events).toHaveLength(2); // the text, plus exactly one live DAG snapshot
  });

  it('keeps only the newest authoritative goal snapshot', () => {
    const replay = new LiveEventReplay(new Set());
    const active = {
      session_id: 'brain-1', user_id: 1, status: 'active' as const, goal: 'Ship it', draft: '',
      subgoals: '[]', turns_used: 0, turn_budget: 8, last_verdict: '', last_evidence: '',
      paused_reason: '', created_at: '2026-07-12 10:00:00', updated_at: '2026-07-12 10:00:00',
    };
    replay.publish({ type: 'goal', goal: active });
    replay.publish({ type: 'goal', goal: { ...active, status: 'done', turns_used: 1, last_verdict: 'done' } });

    expect(replay.snapshot().events).toEqual([{
      type: 'goal', goal: { ...active, status: 'done', turns_used: 1, last_verdict: 'done' },
    }]);
  });

  it('drops transient deltas at the durable agent_end boundary', () => {
    const replay = new LiveEventReplay(new Set());
    replay.beginRun();
    replay.publish({ type: 'text', delta: 'now durable' });
    replay.settleRun();
    replay.publish({ type: 'idle' });
    expect(replay.snapshot().events).toEqual([{ type: 'idle' }]);
  });

  it('keeps an already-durable user as an ordered snapshot marker', () => {
    const delivered: BrainEvent[] = [];
    const replay = new LiveEventReplay(new Set([(event: BrainEvent) => delivered.push(event)]));
    replay.publish({ type: 'text', delta: 'before' });
    replay.publish({ type: 'user', text: 'steer the child', durableId: 'user-row-2' });
    replay.publish({ type: 'text', delta: 'after' });
    expect(delivered.at(1)).toEqual({ type: 'user', text: 'steer the child', durableId: 'user-row-2' });
    expect(replay.snapshot().events).toEqual([
      { type: 'text', delta: 'before' },
      { type: 'user', text: 'steer the child', durableId: 'user-row-2' },
      { type: 'text', delta: 'after' },
    ]);
  });

  it('marks a bounded transport snapshot as truncated and preserves replay cursor metadata outside event JSON', () => {
    const replay = new LiveEventReplay(new Set());
    replay.beginRun();
    replay.publish({ type: 'text', delta: 'one' });
    const first = replay.transportSnapshot();
    expect(first).toMatchObject({ run: 1, events: [{ type: 'text', delta: 'one' }], eventCursors: [1] });
    expect(JSON.stringify(first.events[0])).toBe('{"type":"text","delta":"one"}');

    for (let i = 0; i < 600; i++) replay.publish({ type: 'tool', id: `t${i}`, name: 'Read' });
    expect(replay.transportSnapshot().truncated).toBe(true);
  });
});
