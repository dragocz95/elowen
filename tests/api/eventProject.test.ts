import { describe, it, expect } from 'vitest';
import { eventProjectId, type EventProjectDeps } from '../../src/api/eventProject.js';
import type { ElowenEvent } from '../../src/api/sse.js';

// A fixed lookup table standing in for the real stores: t1→1, epicA→2. Session/job tenancy lives in
// the agents PLUGIN's registered resolver now — modeled by `pluginResolvers` (elowen-Nova→3, job1→4).
const pluginResolver = (e: ElowenEvent): number | null => {
  if (e.type === 'signal') return e.session === 'elowen-Nova' ? 3 : null;
  if (e.type === 'plan') return e.jobId === 'job1' ? 4 : null;
  return null;
};
const deps: EventProjectDeps = {
  taskProject: (id) => (({ t1: 1, epicA: 2 }) as Record<string, number>)[id] ?? null,
  pluginResolvers: () => [pluginResolver],
};
const signal = (session: string): ElowenEvent => ({ type: 'signal', session, signal: { type: 'needs_input' } as never });

describe('eventProjectId — single source of project resolution', () => {
  it('resolves task and review via the task', () => {
    expect(eventProjectId({ type: 'task', taskId: 't1', status: 'open' }, deps)).toBe(1);
    expect(eventProjectId({ type: 'review', missionId: 'm-epicA', taskId: 't1', approve: true, rationale: 'ok' }, deps)).toBe(1);
  });
  it('resolves a mission via its epic (strips the m- prefix)', () => {
    expect(eventProjectId({ type: 'mission', missionId: 'm-epicA', state: 'active' }, deps)).toBe(2);
  });
  it('resolves a signal via the plugin resolver (sole source of session tenancy)', () => {
    expect(eventProjectId(signal('elowen-Nova'), deps)).toBe(3);
  });
  it('resolves a plan via its epic when present, else via the plugin resolver (job lookup)', () => {
    expect(eventProjectId({ type: 'plan', jobId: 'job1', status: 'planning' }, deps)).toBe(4);
    expect(eventProjectId({ type: 'plan', jobId: 'unknown', status: 'done', epicId: 'epicA' }, deps)).toBe(2);
  });
  it('fails closed (null) when the referenced row is gone', () => {
    expect(eventProjectId({ type: 'task', taskId: 'gone', status: 'open' }, deps)).toBeNull();
    expect(eventProjectId({ type: 'mission', missionId: 'm-gone', state: 'active' }, deps)).toBeNull();
    expect(eventProjectId(signal('elowen-Ghost'), deps)).toBeNull();
  });
  it('fails closed (null) for signal/plan with NO plugin resolvers (plugin disabled)', () => {
    const bare: EventProjectDeps = { taskProject: deps.taskProject };
    expect(eventProjectId(signal('elowen-Nova'), bare)).toBeNull();
    expect(eventProjectId({ type: 'plan', jobId: 'job1', status: 'planning' }, bare)).toBeNull();
  });
});
