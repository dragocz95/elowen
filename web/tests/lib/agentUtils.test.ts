import { describe, it, expect } from 'vitest';
import { taskAgentName, taskSessionName, agentDisplayName, taskElapsed, taskStartedMs, taskBlockers, tailSnippet, liveState, needsInputSessions, lastClosedTask, taskForSession, keysForOption, taskExec } from '../../lib/agentUtils';
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

describe('agentDisplayName', () => {
  it('strips the orca- prefix to the friendly agent name', () => {
    expect(agentDisplayName('orca-Iris')).toBe('Iris');
    expect(agentDisplayName('orca-Nova')).toBe('Nova');
  });
  it('falls back to the raw id when there is no prefix', () => {
    expect(agentDisplayName('weird')).toBe('weird');
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
  it('freezes the run at closed_at for a finished task (does not keep growing from now)', () => {
    const closed = task({ created_at: start, closed_at: '2026-06-18 10:03:00', status: 'closed' });
    // 'now' is hours later, but the run is frozen at the 3-minute close.
    expect(taskElapsed(closed, at('2026-06-18T15:00:00Z'))).toBe('3m');
  });
  it('measures from the real spawn (started:<ms> label), not the plan-time created_at', () => {
    // Mission row created at 10:00 but the agent only spawned 25 min later — elapsed must reflect
    // the spawn, so a run that ends at 10:28 reads as 3m, not 28m.
    const spawned = at('2026-06-18T10:25:00Z');
    const t = task({ created_at: start, labels: [`started:${spawned}`], closed_at: '2026-06-18 10:28:00', status: 'closed' });
    expect(taskElapsed(t, at('2026-06-18T11:00:00Z'))).toBe('3m');
  });
});

describe('taskStartedMs', () => {
  it('prefers the started:<ms> label over created_at', () => {
    expect(taskStartedMs(task({ created_at: '2026-06-18 10:00:00', labels: ['started:1750240000000'] }))).toBe(1750240000000);
  });
  it('falls back to created_at when there is no started label', () => {
    expect(taskStartedMs(task({ created_at: '2026-06-18 10:00:00', labels: ['agent:nova'] }))).toBe(Date.parse('2026-06-18T10:00:00Z'));
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

describe('needsInputSessions', () => {
  it('keeps only sessions whose signal is needs_input', () => {
    const signals = { 'orca-a': { type: 'working' as const }, 'orca-b': { type: 'needs_input' as const, question: '?' } };
    expect(needsInputSessions(['orca-a', 'orca-b', 'orca-c'], signals)).toEqual(['orca-b']);
  });
});

describe('lastClosedTask', () => {
  it('returns the closed task with the latest closed_at', () => {
    const a = task({ id: 'a', status: 'closed', closed_at: '2026-06-18 10:00:00' });
    const b = task({ id: 'b', status: 'closed', closed_at: '2026-06-18 12:00:00' });
    const c = task({ id: 'c', status: 'open' });
    expect(lastClosedTask([a, b, c])?.id).toBe('b');
  });
  it('returns null when nothing is closed', () => {
    expect(lastClosedTask([task({ status: 'open' })])).toBeNull();
  });
});

describe('taskForSession', () => {
  it('prefers the in_progress task when an agent name is reused', () => {
    const oldClosed = task({ id: 'old', status: 'closed', labels: ['agent:nova'], created_at: '2026-06-18 10:00:00' });
    const running = task({ id: 'run', status: 'in_progress', labels: ['agent:nova'], created_at: '2026-06-19 08:00:00' });
    expect(taskForSession([oldClosed, running], 'orca-nova')?.id).toBe('run');
  });
  it('falls back to the most recently created match', () => {
    const a = task({ id: 'a', status: 'closed', labels: ['agent:nova'], created_at: '2026-06-18 10:00:00' });
    const b = task({ id: 'b', status: 'closed', labels: ['agent:nova'], created_at: '2026-06-19 08:00:00' });
    expect(taskForSession([a, b], 'orca-nova')?.id).toBe('b');
  });
  it('returns undefined for non-orca names or no match', () => {
    expect(taskForSession([task({ labels: ['agent:nova'] })], 'tmux-x')).toBeUndefined();
    expect(taskForSession([task({ labels: ['agent:atlas'] })], 'orca-nova')).toBeUndefined();
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

describe('keysForOption', () => {
  it('option 1 (the focused default) needs no navigation — just Enter', () => {
    expect(keysForOption('1')).toEqual(['Enter']);
  });
  it('option N steps down N-1 times before Enter', () => {
    expect(keysForOption('2')).toEqual(['Down', 'Enter']);
    expect(keysForOption('4')).toEqual(['Down', 'Down', 'Down', 'Enter']);
  });
  it('never produces negative navigation for a bad id', () => {
    expect(keysForOption('0')).toEqual(['Enter']);
  });
});

describe('taskExec', () => {
  it('returns the exec label value', () => {
    expect(taskExec(['area:ui', 'exec:codex:gpt-5.4'])).toBe('codex:gpt-5.4');
  });
  it('returns empty string when absent or undefined', () => {
    expect(taskExec(['area:ui'])).toBe('');
    expect(taskExec(undefined)).toBe('');
  });
});
