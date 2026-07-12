import { describe, expect, it } from 'vitest';
import type { BrainEvent } from '../../src/brain/events.js';
import { appendBufferedBrainEvent, LiveEventReplay } from '../../src/brain/session/liveEventReplay.js';

describe('LiveEventReplay', () => {
  it('coalesces concurrent snapshot buffers without mutating their shared event object', () => {
    const first: BrainEvent = { type: 'text', delta: 'hel' };
    const next: BrainEvent = { type: 'text', delta: 'lo' };
    const streamA: BrainEvent[] = [];
    const streamB: BrainEvent[] = [];

    // LiveEventReplay fans the same object reference to every listener. Each route buffers it while its
    // snapshot frame flushes, then observes the same next delta.
    appendBufferedBrainEvent(streamA, first, 2_048);
    appendBufferedBrainEvent(streamB, first, 2_048);
    appendBufferedBrainEvent(streamA, next, 2_048);
    appendBufferedBrainEvent(streamB, next, 2_048);

    expect(first).toEqual({ type: 'text', delta: 'hel' });
    expect(streamA).toEqual([{ type: 'text', delta: 'hello' }]);
    expect(streamB).toEqual([{ type: 'text', delta: 'hello' }]);
    expect(streamA[0]).not.toBe(streamB[0]);
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

  it('replaces snapshot-style progress and hard-bounds event count', () => {
    const replay = new LiveEventReplay(new Set());
    replay.publish({ type: 'tool_progress', id: 'run', text: 'one' });
    replay.publish({ type: 'tool_progress', id: 'run', text: 'two' });
    expect(replay.snapshot().events).toEqual([{ type: 'tool_progress', id: 'run', text: 'two' }]);

    for (let i = 0; i < 700; i++) replay.publish({ type: 'tool', id: `t${i}`, name: 'read_file' });
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

    for (let i = 0; i < 600; i++) replay.publish({ type: 'tool', id: `t${i}`, name: 'read_file' });
    expect(replay.transportSnapshot().truncated).toBe(true);
  });
});
