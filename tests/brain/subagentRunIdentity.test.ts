import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';
import { recordSubagentProgress, delegatedChildIdentity } from '../../src/brain/subagentRuns.js';
import type { BrainEvent, SubagentUpdate } from '../../src/brain/events.js';
import type { LiveBrain } from '../../src/brain/session/liveBrain.js';

const PARENT = 'brain-1';
const CHILD = 'brain-ch-subagent-sub-dlg-continue';
const CONTINUE_CALL = 'call-continue';

/** A delegated child's live record: channels live in the registry's CHANNEL map, never in `live`. */
function liveChild(over: { model?: string; thinkingLevel?: string; labels?: Record<string, string> } = {}) {
  return {
    sessionId: CHILD,
    model: over.model ?? 'kimi-coding/k3',
    thinkingLevel: over.thinkingLevel,
    thinkingLabels: over.labels ?? { high: 'High effort' },
    session: { thinkingLevel: over.thinkingLevel, dispose: () => {}, isStreaming: false },
  } as unknown as LiveBrain;
}

function harness(liveInChannel: LiveBrain | undefined) {
  const db = openDb(':memory:');
  const store = new BrainStore(db);
  const sessions = new LiveSessionRegistry<LiveBrain>();
  if (liveInChannel) sessions.channelTouch('subagent-sub-dlg-continue', liveInChannel);
  store.createSession({ id: PARENT, userId: 1, model: 'parent-model' });
  store.createSession({
    id: CHILD,
    userId: 1,
    model: 'kimi-coding/k3',
    parentSessionId: PARENT,
    delegatedAccess: {
      admin: false, owner: true, projectIds: [], permissionBoundary: null,
      ...(liveInChannel?.thinkingLevel ? { thinkingLevel: liveInChannel.thinkingLevel } : { thinkingLevel: 'high' }),
    },
  });
  const events: BrainEvent[] = [];
  const emit = (update: SubagentUpdate): boolean => recordSubagentProgress({
    store,
    claims: sessions,
    sessionId: PARENT,
    identityOf: (childSessionId, dispatch) => delegatedChildIdentity(store, sessions, childSessionId, dispatch),
    publish: (event) => { events.push(event); },
  }, update);
  const rows = () => store.getSubagentRuns(PARENT);
  return { store, sessions, emit, rows, events };
}

const continuation = (over: Partial<SubagentUpdate> = {}): SubagentUpdate => ({
  id: CONTINUE_CALL, sessionId: CHILD, status: 'running', task: 'apply the fix', tools: 0, seconds: 1, ...over,
});

describe('a DelegateContinue progress row carries the child\'s own reasoning effort', () => {
  it('reads the effective level off the LIVE child session (in-process idle continuation)', () => {
    const { emit, rows, events } = harness(liveChild({ thinkingLevel: 'high', model: 'kimi-coding/k3' }));
    // The plugin's continuation state carries NO model and NO thinkingLevel — that is the reported bug.
    expect(emit(continuation())).toBe(true);
    expect(rows().find((run) => run.toolCallId === CONTINUE_CALL)).toMatchObject({
      status: 'running',
      thinkingLevel: 'high',
      thinkingLabel: 'High effort',
      model: 'kimi-coding/k3',
    });
    expect(events.at(-1)).toMatchObject({ type: 'subagent', thinkingLevel: 'high', thinkingLabel: 'High effort' });
  });

  it('falls back to the durable delegated scope while the child lives in the runner', () => {
    // No live record in THIS process: a runner-hosted child (or the pre-spawn push of an idle
    // continuation). The scope is what the child's turn was stamped with — the only authority here.
    const { emit, rows } = harness(undefined);
    expect(emit(continuation({ model: undefined }))).toBe(true);
    expect(rows().find((run) => run.toolCallId === CONTINUE_CALL)).toMatchObject({
      thinkingLevel: 'high',
      thinkingLabel: 'high',
      model: 'kimi-coding/k3',
    });
  });

  it('lets the LIVE record override a stale scope after an explicit model change', () => {
    const { emit, rows } = harness(liveChild({ thinkingLevel: 'low', model: 'openai/gpt-5', labels: { low: 'Low effort' } }));
    expect(emit(continuation())).toBe(true);
    expect(rows().find((run) => run.toolCallId === CONTINUE_CALL)).toMatchObject({
      thinkingLevel: 'low',
      thinkingLabel: 'Low effort',
      model: 'openai/gpt-5',
    });
  });

  it('keeps a level the update itself resolved when there is no live record and no scope', () => {
    const { store, sessions, emit, rows } = harness(undefined);
    // A child whose row predates recorded scope levels: the fresh Delegate's pre-spawn resolution is all
    // the row can report, and the enrichment must keep it.
    store.createSession({
      id: 'brain-ch-subagent-sub-dlg-legacy', userId: 1, model: 'm', parentSessionId: PARENT,
      delegatedAccess: { admin: false, owner: true, projectIds: [], permissionBoundary: null },
    });
    const update = {
      id: 'call-legacy', sessionId: 'brain-ch-subagent-sub-dlg-legacy', status: 'running' as const,
      task: 'dig', tools: 0, seconds: 1, thinkingLevel: 'medium',
    };
    expect(emit(update)).toBe(true);
    expect(rows().find((run) => run.toolCallId === 'call-legacy')).toMatchObject({ thinkingLevel: 'medium' });
    expect(sessions.channelGet('subagent-sub-dlg-legacy')).toBeUndefined();
  });

  it('does not invent a level for a live child that runs on none', () => {
    // The live session reports no level (a ladder-less model, or an explicitly cleared one): that absence
    // is the effective truth, so neither the stale scope nor a guessed label may resurrect a level.
    const { emit, rows } = harness(liveChild({ thinkingLevel: undefined }));
    expect(emit(continuation())).toBe(true);
    const row = rows().find((run) => run.toolCallId === CONTINUE_CALL);
    expect(row?.thinkingLevel).toBeUndefined();
    expect(row?.thinkingLabel).toBeUndefined();
  });

  it('does not resurrect the dispatch-time level over a level-less live child', () => {
    // The delegating plugin resolved a level pre-spawn, but the live session now runs on none: the
    // dispatch value is stale, and only the live absence is the truth.
    const { store, sessions, emit, rows } = harness(liveChild({ thinkingLevel: undefined }));
    expect(emit(continuation({ thinkingLevel: 'medium', thinkingLabel: 'medium' }))).toBe(true);
    const row = rows().find((run) => run.toolCallId === CONTINUE_CALL);
    expect(row?.thinkingLevel).toBeUndefined();
    expect(row?.thinkingLabel).toBeUndefined();
    expect(sessions.get(CHILD) ?? sessions.channelGet('subagent-sub-dlg-continue')).toBeDefined();
    // (the identity source had the update's dispatch level available and still refused it)
    expect(store.getSession(CHILD)?.id).toBe(CHILD);
  });

  it('labels a scope-only level with the raw level id, never a guessed name', () => {
    const { emit, rows } = harness(undefined);
    expect(emit(continuation())).toBe(true);
    expect(rows().find((run) => run.toolCallId === CONTINUE_CALL)?.thinkingLabel).toBe('high');
  });
});

describe('delegatedChildIdentity', () => {
  it('reads a channel child through the channel map, a user session through the live map', () => {
    const db = openDb(':memory:');
    const store = new BrainStore(db);
    const sessions = new LiveSessionRegistry<LiveBrain>();
    store.createSession({ id: PARENT, userId: 1, model: 'm' });
    store.createSession({
      id: CHILD, userId: 1, model: 'm', parentSessionId: PARENT,
      delegatedAccess: { admin: false, owner: true, projectIds: [], permissionBoundary: null, thinkingLevel: 'high' },
    });
    const channelChild = liveChild({ thinkingLevel: 'high' });
    sessions.channelTouch('subagent-sub-dlg-continue', channelChild);
    expect(delegatedChildIdentity(store, sessions, CHILD)).toMatchObject({ thinkingLevel: 'high' });

    const ownerChild = 'brain-ch-subagent-sub-dlg-owner';
    store.createSession({
      id: ownerChild, userId: 1, model: 'm', parentSessionId: PARENT,
      delegatedAccess: { admin: false, owner: true, projectIds: [], permissionBoundary: null, thinkingLevel: 'low' },
    });
    sessions.set(ownerChild, { ...liveChild(), sessionId: ownerChild, thinkingLevel: 'low' } as unknown as LiveBrain);
    expect(delegatedChildIdentity(store, sessions, ownerChild)).toMatchObject({ thinkingLevel: 'low' });
  });

  it('returns undefined for a child with nothing to report', () => {
    const db = openDb(':memory:');
    const store = new BrainStore(db);
    const sessions = new LiveSessionRegistry<LiveBrain>();
    expect(delegatedChildIdentity(store, sessions, 'brain-ch-subagent-sub-dlg-x')).toBeUndefined();
  });
});
