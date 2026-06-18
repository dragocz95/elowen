import { describe, it, expect } from 'vitest';
import { taskAgentName, taskSessionName, taskElapsed, taskBlockers, tailSnippet, liveState } from '../../lib/agentUtils';
import type { Task } from '../../lib/types';

const task = (over: Partial<Task> = {}): Task => ({ id: 't1', title: 'T', status: 'open', ...over });

describe('taskAgentName', () => {
  it('extracts the agent name from an agent:<name> label', () => {
    expect(taskAgentName(task({ labels: ['exec:sonnet', 'agent:atlas'] }))).toBe('atlas');
  });
  it('returns null when there is no agent label', () => {
    expect(taskAgentName(task({ labels: ['exec:sonnet'] }))).toBeNull();
    expect(taskAgentName(task())).toBeNull();
  });
});

describe('taskSessionName', () => {
  it('builds the orca-<agent> tmux session name', () => {
    expect(taskSessionName(task({ labels: ['agent:nova'] }))).toBe('orca-nova');
  });
  it('returns null without an agent label', () => {
    expect(taskSessionName(task())).toBeNull();
  });
});

describe('taskElapsed', () => {
  const start = '2026-06-18 10:00:00'; // SQLite UTC format
  const at = (iso: string) => new Date(iso).getTime();
  it('formats seconds, minutes, hours and days compactly', () => {
    expect(taskElapsed(task({ created_at: start }), at('2026-06-18T10:00:30Z'))).toBe('30s');
    expect(taskElapsed(task({ created_at: start }), at('2026-06-18T10:03:00Z'))).toBe('3m');
    expect(taskElapsed(task({ created_at: start }), at('2026-06-18T15:00:00Z'))).toBe('5h');
    expect(taskElapsed(task({ created_at: start }), at('2026-06-20T10:00:00Z'))).toBe('2d');
  });
  it('clamps negatives to 0 and returns null without a start time', () => {
    expect(taskElapsed(task({ created_at: start }), at('2026-06-18T09:59:00Z'))).toBe('0s');
    expect(taskElapsed(task(), Date.now())).toBeNull();
  });
});

describe('taskBlockers', () => {
  const a = task({ id: 'a', status: 'closed' });
  const b = task({ id: 'b', status: 'in_progress' });
  const c = task({ id: 'c', status: 'open' });
  const byId = new Map([a, b, c].map((t) => [t.id, t]));
  const deps = [
    { task_id: 'c', depends_on_id: 'a' }, // resolved (closed) → not a blocker
    { task_id: 'c', depends_on_id: 'b' }, // unresolved → blocker
  ];
  it('returns only unresolved (not closed/cancelled) dependencies', () => {
    expect(taskBlockers('c', deps, byId).map((t) => t.id)).toEqual(['b']);
  });
  it('returns empty when there are no edges', () => {
    expect(taskBlockers('a', deps, byId)).toEqual([]);
  });
});

describe('liveState', () => {
  it('treats needs_input as the highest priority', () => {
    expect(liveState({ type: 'needs_input', question: '?' }, true)).toBe('needs_input');
  });
  it('reads a live session with no signal as working', () => {
    expect(liveState(undefined, true)).toBe('working');
    expect(liveState({ type: 'working' }, false)).toBe('working');
  });
  it('falls back to complete then idle', () => {
    expect(liveState({ type: 'complete' }, false)).toBe('complete');
    expect(liveState(undefined, false)).toBe('idle');
  });
});

describe('tailSnippet', () => {
  it('returns the last non-empty line, ANSI stripped', () => {
    expect(tailSnippet('first\n[32mnpm test passed[0m\n  \n')).toBe('npm test passed');
  });
  it('returns empty string for blank input', () => {
    expect(tailSnippet('')).toBe('');
    expect(tailSnippet('\n  \n')).toBe('');
  });
});
