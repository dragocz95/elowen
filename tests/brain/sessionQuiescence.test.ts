import { afterEach, describe, expect, it } from 'vitest';
import { processRegistry, type ProcessHandle } from '../../src/brain/processRegistry.js';
import {
  isSparedChildSession,
  sessionHasWorkInFlight,
  sparedChildSessionIds,
  type SessionQuiescenceDeps,
} from '../../src/brain/service/sessionQuiescence.js';
import type { LiveBrain } from '../../src/brain/session/liveBrain.js';

/** One conversation with every busy signal switchable off (the quiet baseline) so each test proves that
 *  exactly ONE signal flips the shared predicate — behavior, not wiring. */
function harness(over: {
  live?: boolean;
  session?: Partial<{ isStreaming: boolean; steering: string[]; followUp: string[] }>;
  liveExtras?: Partial<Pick<LiveBrain, 'queuedSteer' | 'queuedFollowUp' | 'pendingCompactionEchoes' | 'deliveringUserEchoes'>>;
  parentAborting?: boolean;
  pendingAbort?: boolean;
  activeChildren?: boolean;
  elicitation?: boolean;
  subagentRuns?: { status: string; background?: boolean; autoDeliver?: boolean; sessionId: string }[];
  workflowRuns?: { status: string; background?: boolean; nodes: { status: string; sessionId?: string }[] }[];
  goalStatus?: string;
} = {}) {
  const live = over.live === false ? undefined : ({
    session: {
      isStreaming: over.session?.isStreaming ?? false,
      getSteeringMessages: () => over.session?.steering ?? [],
      getFollowUpMessages: () => over.session?.followUp ?? [],
    },
    ...over.liveExtras,
  } as unknown as LiveBrain);
  const deps: SessionQuiescenceDeps = {
    store: {
      getSubagentRuns: () => (over.subagentRuns ?? []),
      getWorkflowRuns: () => (over.workflowRuns ?? []),
      getGoal: () => (over.goalStatus ? { status: over.goalStatus } : undefined),
    } as unknown as SessionQuiescenceDeps['store'],
    sessions: {
      get: () => live,
      isParentAborting: () => over.parentAborting ?? false,
      hasPendingAbort: () => over.pendingAbort ?? false,
      hasActiveChildren: () => over.activeChildren ?? false,
    },
    elicitation: { pendingForSession: () => (over.elicitation ? {} as never : null) },
  };
  return deps;
}

const busy = (over: Parameters<typeof harness>[0]) => sessionHasWorkInFlight(harness(over), 's1');

describe('sessionHasWorkInFlight (the shared fail-closed busy predicate)', () => {
  afterEach(() => { for (const p of processRegistry.list()) processRegistry.remove(p.id); });

  it('a quiet live conversation has no work in flight', () => {
    expect(busy({})).toBe(false);
  });

  it('a conversation with no live record has nothing the predicate could protect', () => {
    expect(busy({ live: false })).toBe(false);
  });

  it('a streaming turn is work', () => {
    expect(busy({ session: { isStreaming: true } })).toBe(true);
  });

  it('an abort in progress (either fence) is work', () => {
    expect(busy({ parentAborting: true })).toBe(true);
    expect(busy({ pendingAbort: true })).toBe(true);
  });

  it('anything queued behind the turn is work — PI queues and the daemon mirrors alike', () => {
    expect(busy({ session: { steering: ['queued'] } })).toBe(true);
    expect(busy({ session: { followUp: ['queued'] } })).toBe(true);
    expect(busy({ liveExtras: { queuedSteer: [{ text: 'queued' }] } })).toBe(true);
    expect(busy({ liveExtras: { queuedFollowUp: [{ text: 'queued' }] } })).toBe(true);
    expect(busy({ liveExtras: { pendingCompactionEchoes: [{ id: 'e', text: 'queued' }] } })).toBe(true);
    expect(busy({ liveExtras: { deliveringUserEchoes: [{ text: 'queued' }] } })).toBe(true);
  });

  it('a parked question (elicitation) is work', () => {
    expect(busy({ elicitation: true })).toBe(true);
  });

  it('a running child is work — foreground registration and spared background delegates alike', () => {
    expect(busy({ activeChildren: true })).toBe(true);
    expect(busy({ subagentRuns: [{ status: 'running', background: true, sessionId: 'child' }] })).toBe(true);
    expect(busy({ workflowRuns: [{ status: 'running', background: true, nodes: [{ status: 'running', sessionId: 'node' }] }] })).toBe(true);
  });

  it('a running background job is work; a finished one is not', () => {
    const handle = (running: boolean): ProcessHandle => ({
      id: 'p1', command: 'sleep', cwd: '/tmp', startedAt: new Date().toISOString(),
      userId: 1, sessionId: 's1', completionMode: 'job',
      running: () => running, exitCode: () => (running ? null : 0), readAll: () => '', kill: () => {},
    });
    processRegistry.register(handle(true));
    expect(busy({})).toBe(true);
    processRegistry.remove('p1');
    processRegistry.register(handle(false));
    expect(busy({})).toBe(false);
  });

  it('an active goal is work even between turns — its timer re-prompts this very session', () => {
    expect(busy({ goalStatus: 'active' })).toBe(true);
    expect(busy({ goalStatus: 'completed' })).toBe(false);
  });
});

describe('sparedChildSessionIds', () => {
  const store = (subagentRuns: unknown[], workflowRuns: unknown[] = []) => ({
    getSubagentRuns: () => subagentRuns,
    getWorkflowRuns: () => workflowRuns,
  }) as unknown as Parameters<typeof sparedChildSessionIds>[0];

  it('spares running detached/background delegates, never foreground ones', () => {
    expect(sparedChildSessionIds(store([
      { status: 'running', background: true, sessionId: 'bg' },
      { status: 'running', autoDeliver: true, sessionId: 'detached' },
      { status: 'running', sessionId: 'foreground' },
      { status: 'done', background: true, sessionId: 'finished' },
    ]), 'p')).toEqual(new Set(['bg', 'detached']));
  });

  it('spares the running nodes of a background workflow', () => {
    expect(sparedChildSessionIds(store([], [
      { status: 'running', background: true, nodes: [{ status: 'running', sessionId: 'node-1' }, { status: 'done', sessionId: 'node-2' }] },
      { status: 'running', background: false, nodes: [{ status: 'running', sessionId: 'fg-node' }] },
    ]), 'p')).toEqual(new Set(['node-1']));
  });

  const durableStore = (
    sessions: Record<string, { parent_session_id: unknown; user_id: number }>,
    runs: Record<string, { status: string; background?: boolean; autoDeliver?: boolean; sessionId: string }[]> = {},
  ) => ({
    getSession: (sessionId: string) => sessions[sessionId],
    getSubagentRuns: (parentSessionId: string) => runs[parentSessionId] ?? [],
    getWorkflowRuns: () => [],
  }) as unknown as Parameters<typeof isSparedChildSession>[0];

  it('recognizes every descendant beneath a spared background edge for top-level channel resets', () => {
    const storeWithAncestry = durableStore({
      root: { parent_session_id: null, user_id: 1 },
      bg: { parent_session_id: 'root', user_id: 1 },
      foregroundGrandchild: { parent_session_id: 'bg', user_id: 1 },
    }, {
      root: [{ status: 'running', background: true, sessionId: 'bg' }],
      bg: [{ status: 'running', sessionId: 'foregroundGrandchild' }],
    });

    expect(isSparedChildSession(storeWithAncestry, 'bg')).toBe(true);
    expect(isSparedChildSession(storeWithAncestry, 'foregroundGrandchild')).toBe(true);
    expect(isSparedChildSession(storeWithAncestry, 'root')).toBe(false);
  });

  it('fails closed for missing, malformed, cross-owner, cyclic, or overlong ancestry', () => {
    expect(isSparedChildSession(durableStore({
      orphan: { parent_session_id: 'missing', user_id: 1 },
    }), 'orphan')).toBe(false);
    expect(isSparedChildSession(durableStore({
      malformed: { parent_session_id: 42, user_id: 1 },
    }), 'malformed')).toBe(false);
    expect(isSparedChildSession(durableStore({
      parent: { parent_session_id: null, user_id: 1 },
      foreign: { parent_session_id: 'parent', user_id: 2 },
    }, {
      parent: [{ status: 'running', background: true, sessionId: 'foreign' }],
    }), 'foreign')).toBe(false);
    expect(isSparedChildSession(durableStore({
      a: { parent_session_id: 'b', user_id: 1 },
      b: { parent_session_id: 'a', user_id: 1 },
    }), 'a')).toBe(false);

    let reads = 0;
    const endless = {
      getSession: (sessionId: string) => {
        reads += 1;
        return { parent_session_id: `${sessionId}.parent`, user_id: 1 };
      },
      getSubagentRuns: () => [],
      getWorkflowRuns: () => [],
    } as unknown as Parameters<typeof isSparedChildSession>[0];
    expect(isSparedChildSession(endless, 'leaf')).toBe(false);
    expect(reads).toBeLessThan(100);
  });
});
