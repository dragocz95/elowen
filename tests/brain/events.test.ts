import { describe, it, expect } from 'vitest';
import { toBrainEvent } from '../../src/brain/events.js';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';

const ev = (e: unknown) => toBrainEvent(e as AgentSessionEvent);

describe('retry notices (reconnect line above the input)', () => {
  it('renders a compact reconnect counter and digs the human message out of a provider JSON blob', () => {
    const raw = '429 {"error":{"message":"Rate limit exceeded: free-models-per-day","code":429},"user_id":"abc"}';
    expect(ev({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, errorMessage: raw }))
      .toEqual({ type: 'notice', kind: 'retry', message: 'reconnecting 1/3 · Rate limit exceeded: free-models-per-day…' });
  });

  it('falls back to the plain text (or just the counter) when there is no JSON payload', () => {
    expect(ev({ type: 'auto_retry_start', attempt: 2, maxAttempts: 5, errorMessage: 'socket hang up' }))
      .toEqual({ type: 'notice', kind: 'retry', message: 'reconnecting 2/5 · socket hang up…' });
    expect(ev({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3 }))
      .toEqual({ type: 'notice', kind: 'retry', message: 'reconnecting 1/3…' });
    // Unparseable blob with no prefix → counter only, never raw JSON.
    expect(ev({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, errorMessage: '{broken json' }))
      .toEqual({ type: 'notice', kind: 'retry', message: 'reconnecting 1/3…' });
  });

  it('clears with a short done notice on retry end', () => {
    expect(ev({ type: 'auto_retry_end', success: true })).toEqual({ type: 'notice', kind: 'retry', message: 'reconnected', done: true });
    expect(ev({ type: 'auto_retry_end', success: false })).toEqual({ type: 'notice', kind: 'retry', message: 'reconnect failed', done: true });
  });
});

describe('compaction status notice (single source of truth, no false success)', () => {
  it('compaction_start opens the one status line', () => {
    expect(ev({ type: 'compaction_start', reason: 'manual' }))
      .toEqual({ type: 'notice', kind: 'compaction', message: 'compacting context…' });
  });

  it('a REAL compaction (result present, not aborted) closes it with "context compacted"', () => {
    expect(ev({ type: 'compaction_end', reason: 'manual', aborted: false, result: { summary: 's', estimatedTokensAfter: 10 } }))
      .toEqual({ type: 'notice', kind: 'compaction', message: 'context compacted', done: true });
  });

  it('a no-op compaction (no result) clears the line WITHOUT a false "context compacted"', () => {
    // PI emits compaction_start then a resultless compaction_end for a too-small/already-compacted session.
    expect(ev({ type: 'compaction_end', reason: 'manual', aborted: false, result: undefined }))
      .toEqual({ type: 'notice', kind: 'compaction', message: '', done: true });
  });

  it('an aborted/cancelled compaction also clears the line without claiming success', () => {
    expect(ev({ type: 'compaction_end', reason: 'manual', aborted: true, result: { summary: 's' } }))
      .toEqual({ type: 'notice', kind: 'compaction', message: '', done: true });
  });
});

describe('tool_execution_update → tool_progress (live run_command streaming)', () => {
  const update = (toolName: string, toolCallId: string, text: string, now?: number) =>
    toBrainEvent({ type: 'tool_execution_update', toolName, toolCallId, partialResult: { content: [{ type: 'text', text }], details: {} } } as unknown as AgentSessionEvent, now);

  it('maps a run_command partial to a tool_progress carrying the output tail', () => {
    expect(update('run_command', 'r1', 'building…\n', 1_000))
      .toEqual({ type: 'tool_progress', id: 'r1', text: 'building…' });
  });

  it('is SCOPED to run_command — every other tool\'s update is dropped (no _update re-noise)', () => {
    expect(update('read_file', 'x1', 'partial file body', 1_000)).toBeNull();
    expect(update('grep', 'x2', 'match', 1_000)).toBeNull();
  });

  it('THROTTLES to one progress per tool call per window, then emits again once the window passes', () => {
    expect(update('run_command', 'r2', 'a', 1_000)).toEqual({ type: 'tool_progress', id: 'r2', text: 'a' });
    expect(update('run_command', 'r2', 'ab', 1_050)).toBeNull();          // within 100ms → dropped
    expect(update('run_command', 'r2', 'abc', 1_120)).toEqual({ type: 'tool_progress', id: 'r2', text: 'abc' }); // past the window
  });

  it('throttles independently per tool call id', () => {
    expect(update('run_command', 'r3', 'x', 2_000)).toEqual({ type: 'tool_progress', id: 'r3', text: 'x' });
    // A different call is not blocked by r3's recent emit even at the same instant.
    expect(update('run_command', 'r4', 'y', 2_000)).toEqual({ type: 'tool_progress', id: 'r4', text: 'y' });
  });

  it('drops an empty partial (nothing to show yet)', () => {
    expect(update('run_command', 'r5', '   \n', 3_000)).toBeNull();
  });

  it('a tool_execution_end releases the throttle slot so a later reuse emits immediately', () => {
    expect(update('run_command', 'r6', 'first', 4_000)).toEqual({ type: 'tool_progress', id: 'r6', text: 'first' });
    toBrainEvent({ type: 'tool_execution_end', toolName: 'run_command', toolCallId: 'r6', result: { content: [], details: {} } } as unknown as AgentSessionEvent, 4_010);
    // Same instant as the end: the slot is cleared, so a fresh partial emits without waiting the window.
    expect(update('run_command', 'r6', 'again', 4_010)).toEqual({ type: 'tool_progress', id: 'r6', text: 'again' });
  });
});

describe('tool_execution_end → diff event (hook-annotated edits)', () => {
  it('a plain diff result maps to a diff event without an output view', () => {
    expect(ev({ type: 'tool_execution_end', toolName: 'edit_file', toolCallId: 'c1', result: { content: [], details: { diff: '+    1 x' } } }))
      .toEqual({ type: 'diff', diff: '+    1 x', id: 'c1' });
  });

  it('a diff result carrying details.notes rides a notes-only output view alongside the diff', () => {
    const e = ev({
      type: 'tool_execution_end', toolName: 'edit_file', toolCallId: 'c1',
      result: { content: [], details: { diff: '+    1 x', notes: ['formatted a.ts with prettier'] } },
    });
    expect(e).toMatchObject({ type: 'diff', diff: '+    1 x', id: 'c1' });
    expect((e as { output?: { notes?: string[]; text?: string } }).output).toMatchObject({ text: '', notes: ['formatted a.ts with prettier'] });
  });
});
