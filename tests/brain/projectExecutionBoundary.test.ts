import { describe, expect, it } from 'vitest';
import { createProjectExecutionBoundary } from '../../src/brain/session/projectExecutionBoundary.js';

describe('project execution boundary', () => {
  it('keeps the current batch on A and commits B before the next step', async () => {
    const calls: string[] = [];
    const boundary = createProjectExecutionBoundary({
      current: () => ({ kind: 'host', projectId: 1 }),
      commit: async (ref) => { calls.push(`commit:${ref.projectId}`); },
    });
    const session = { agent: { prepareNextTurnWithContext: undefined } } as never;
    boundary.install(session);
    boundary.request({ kind: 'host', projectId: 2 });
    calls.push('batch:A');
    await session.agent.prepareNextTurnWithContext?.({ message: { content: [] }, toolResults: [] } as never, undefined);
    calls.push('next:B');
    expect(calls).toEqual(['batch:A', 'commit:2', 'next:B']);
  });

  it('does not persist a pending switch across a recreated boundary', async () => {
    const commits: string[] = [];
    const first = createProjectExecutionBoundary({ current: () => ({ kind: 'host', projectId: 1 }), commit: async (ref) => commits.push(String(ref.projectId)) });
    first.request({ kind: 'host', projectId: 2 });
    const restarted = createProjectExecutionBoundary({ current: () => ({ kind: 'host', projectId: 1 }), commit: async (ref) => commits.push(String(ref.projectId)) });
    const session = { agent: { prepareNextTurnWithContext: undefined } } as never;
    restarted.install(session);
    await session.agent.prepareNextTurnWithContext?.({ message: { content: [] }, toolResults: [] } as never, undefined);
    expect(commits).toEqual([]);
  });

  it('rejects a revoked target at commit and keeps A', async () => {
    const calls: string[] = [];
    const boundary = createProjectExecutionBoundary({
      current: () => ({ kind: 'host', projectId: 1 }),
      commit: async () => { throw new Error('target unavailable'); },
    });
    const session = { agent: { prepareNextTurnWithContext: undefined } } as never;
    boundary.install(session);
    boundary.request({ kind: 'host', projectId: 2 });
    await session.agent.prepareNextTurnWithContext?.({ message: { content: [] }, toolResults: [] } as never, undefined);
    calls.push('still:A');
    expect(calls).toEqual(['still:A']);
  });
});
