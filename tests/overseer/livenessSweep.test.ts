import { describe, it, expect, vi } from 'vitest';
import { DecisionQueue } from '../../src/overseer/decisionQueue.js';
import { PaneActivityTracker } from '../../src/overseer/paneActivity.js';
import { sweepAgentLiveness, checkAction, type AgentLivenessDeps } from '../../src/overseer/livenessSweep.js';

const WORKER_IDLE = 300_000, OVERSEER_IDLE = 600_000, GRACE = 90_000, HARD = 1_800_000;

type RunOpts = {
  sessions: string[];
  now: number;
  tracker: PaneActivityTracker;
  pane?: (s: string) => string;
  deadSince?: Map<string, number>;
  inflight?: Set<string>;
  lastProgressAt?: Map<string, number>;
  progressReviewMs?: number;
  sessionTaskId?: AgentLivenessDeps['sessionTaskId'];
  programFor?: AgentLivenessDeps['programFor'];
  hasPrompt?: AgentLivenessDeps['hasPrompt'];
  checkWorker?: AgentLivenessDeps['checkWorker'];
};
const run = (q: DecisionQueue, o: RunOpts) =>
  sweepAgentLiveness({
    tmux: { list: async () => o.sessions, capturePane: async (s) => (o.pane ? o.pane(s) : 'static') },
    queue: q, tracker: o.tracker, now: o.now,
    deadSince: o.deadSince ?? new Map(), inflightChecks: o.inflight ?? new Set(),
    lastProgressAt: o.lastProgressAt ?? new Map(),
    sessionTaskId: o.sessionTaskId ?? (() => null),
    programFor: o.programFor ?? (() => 'claude-code'),
    hasPrompt: o.hasPrompt ?? (() => false),
    checkWorker: o.checkWorker ?? (async () => {}),
    workerIdleMs: WORKER_IDLE, overseerIdleMs: OVERSEER_IDLE, graceMs: GRACE, hardMs: HARD,
    progressReviewMs: o.progressReviewMs ?? 0, // disabled by default — most tests exercise the idle/wedge path
  });

describe('sweepAgentLiveness — overseer side', () => {
  it('NEVER escalates a live overseer whose pane keeps changing (the core fix: thinking ≠ stuck)', async () => {
    const q = new DecisionQueue(() => 0);
    const v = q.enqueue('m1', 'review', {});
    let settled = false; void v.then(() => { settled = true; });
    const tracker = new PaneActivityTracker(); const deadSince = new Map<string, number>();
    let frame = 0; const pane = () => `frame${frame}`;
    await run(q, { sessions: ['orca-overseer-m1'], pane, now: 0, tracker, deadSince });
    frame = 1; await run(q, { sessions: ['orca-overseer-m1'], pane, now: OVERSEER_IDLE, tracker, deadSince });
    frame = 2; const r = await run(q, { sessions: ['orca-overseer-m1'], pane, now: 2 * OVERSEER_IDLE, tracker, deadSince });
    expect(r.escalated).toEqual([]);
    expect(settled).toBe(false);
  });

  it('escalates a live overseer whose own pane has been static past the idle bar (wedged)', async () => {
    const q = new DecisionQueue(() => 0);
    const v = q.enqueue('m1', 'review', {});
    const id = q.pending()[0]!.id;
    const tracker = new PaneActivityTracker();
    await run(q, { sessions: ['orca-overseer-m1'], pane: () => 'frozen', now: 0, tracker });
    const r = await run(q, { sessions: ['orca-overseer-m1'], pane: () => 'frozen', now: OVERSEER_IDLE, tracker });
    expect(r.escalated).toEqual([id]);
    await expect(v).resolves.toMatchObject({ escalated: true, rationale: 'overseer timeout' });
  });

  it('does not escalate a live static overseer still under the idle bar', async () => {
    const q = new DecisionQueue(() => 0);
    q.enqueue('m1', 'review', {});
    const tracker = new PaneActivityTracker();
    await run(q, { sessions: ['orca-overseer-m1'], pane: () => 'frozen', now: 0, tracker });
    const r = await run(q, { sessions: ['orca-overseer-m1'], pane: () => 'frozen', now: OVERSEER_IDLE - 1, tracker });
    expect(r.escalated).toEqual([]);
  });

  it('the high absolute backstop escalates even a changing-pane overseer (animating-but-not-polling)', async () => {
    const q = new DecisionQueue(() => 0);
    void q.enqueue('m1', 'review', {});
    const id = q.pending()[0]!.id;
    const tracker = new PaneActivityTracker();
    let frame = 0; const pane = () => `frame${frame}`;
    await run(q, { sessions: ['orca-overseer-m1'], pane, now: 0, tracker });
    frame = 1; const r = await run(q, { sessions: ['orca-overseer-m1'], pane, now: HARD, tracker });
    expect(r.escalated).toEqual([id]); // pane idle is 0 (changed), but enqueuedAt is HARD ago
  });

  it('does not escalate a dead overseer within the grace window', async () => {
    const q = new DecisionQueue(() => 0);
    q.enqueue('m1', 'review', {});
    const tracker = new PaneActivityTracker(); const deadSince = new Map<string, number>();
    expect((await run(q, { sessions: [], now: 1000, tracker, deadSince })).escalated).toEqual([]);
    expect((await run(q, { sessions: [], now: 1000 + GRACE - 1, tracker, deadSince })).escalated).toEqual([]);
    expect(deadSince.get('m1')).toBe(1000);
  });

  it('escalates ALL pending for an overseer dead past the grace window', async () => {
    const q = new DecisionQueue(() => 0);
    const a = q.enqueue('m1', 'review', {});
    const b = q.enqueue('m1', 'prompt', {});
    const ids = q.pending().map((e) => e.id);
    const tracker = new PaneActivityTracker(); const deadSince = new Map<string, number>();
    await run(q, { sessions: [], now: 0, tracker, deadSince });
    const r = await run(q, { sessions: [], now: GRACE, tracker, deadSince });
    expect(r.escalated.sort()).toEqual([...ids].sort());
    await expect(a).resolves.toMatchObject({ escalated: true });
    await expect(b).resolves.toMatchObject({ escalated: true });
    expect(deadSince.has('m1')).toBe(false);
  });

  it('does not escalate when a dead overseer re-parks before grace elapses', async () => {
    const q = new DecisionQueue(() => 0);
    const v = q.enqueue('m1', 'review', {});
    let settled = false; void v.then(() => { settled = true; });
    const tracker = new PaneActivityTracker(); const deadSince = new Map<string, number>();
    await run(q, { sessions: [], now: 0, tracker, deadSince });
    const r = await run(q, { sessions: ['orca-overseer-m1'], pane: () => 'x', now: 60_000, tracker, deadSince });
    expect(r.escalated).toEqual([]);
    expect(settled).toBe(false);
    expect(deadSince.has('m1')).toBe(false);
  });

  it('prunes deadSince for missions answered since the last sweep', async () => {
    const q = new DecisionQueue(() => 0);
    q.enqueue('m1', 'review', {});
    const tracker = new PaneActivityTracker(); const deadSince = new Map<string, number>();
    await run(q, { sessions: [], now: 0, tracker, deadSince });
    expect(deadSince.has('m1')).toBe(true);
    q.resolve('m1', q.pending()[0]!.id, { approve: true, confidence: 1, rationale: 'ok' });
    await run(q, { sessions: [], now: 1000, tracker, deadSince });
    expect(deadSince.has('m1')).toBe(false);
  });
});

describe('sweepAgentLiveness — worker side', () => {
  const workerBase = (checkWorker: AgentLivenessDeps['checkWorker'], tracker: PaneActivityTracker, inflight: Set<string>, over: Partial<RunOpts> = {}): RunOpts => ({
    sessions: ['orca-patricia'], pane: () => 'wedged', tracker, inflight, now: 0,
    sessionTaskId: () => 't1', programFor: () => 'claude-code', hasPrompt: () => false, checkWorker, ...over,
  });

  it('wakes the overseer (checkWorker) for a worker idle past the bar with no prompt on screen', async () => {
    const q = new DecisionQueue(() => 0);
    const tracker = new PaneActivityTracker(); const inflight = new Set<string>();
    const checkWorker = vi.fn(() => new Promise<void>(() => { /* stays in-flight */ }));
    await run(q, workerBase(checkWorker, tracker, inflight, { now: 0 }));            // idle 0
    const r = await run(q, workerBase(checkWorker, tracker, inflight, { now: WORKER_IDLE })); // idle = bar
    expect(checkWorker).toHaveBeenCalledTimes(1);
    expect(checkWorker).toHaveBeenCalledWith('orca-patricia', 't1', 'wedged', 5, 'idle');
    expect(inflight.has('orca-patricia')).toBe(true);
    expect(r.checked).toEqual(['orca-patricia']);
  });

  it('does not check a worker that is sitting on a structured prompt (the deriver owns needs_input)', async () => {
    const q = new DecisionQueue(() => 0);
    const tracker = new PaneActivityTracker(); const inflight = new Set<string>();
    const checkWorker = vi.fn(async () => {});
    await run(q, workerBase(checkWorker, tracker, inflight, { now: 0, hasPrompt: () => true }));
    await run(q, workerBase(checkWorker, tracker, inflight, { now: WORKER_IDLE, hasPrompt: () => true }));
    expect(checkWorker).not.toHaveBeenCalled();
  });

  it('does not act on an empty capture (vanished session — stuck-detector domain)', async () => {
    const q = new DecisionQueue(() => 0);
    const tracker = new PaneActivityTracker(); const inflight = new Set<string>();
    const checkWorker = vi.fn(async () => {});
    await run(q, workerBase(checkWorker, tracker, inflight, { now: 0, pane: () => '' }));
    await run(q, workerBase(checkWorker, tracker, inflight, { now: WORKER_IDLE, pane: () => '' }));
    expect(checkWorker).not.toHaveBeenCalled();
  });

  it('in-flight guard: a static worker is checked once, not every tick', async () => {
    const q = new DecisionQueue(() => 0);
    const tracker = new PaneActivityTracker(); const inflight = new Set<string>();
    const checkWorker = vi.fn(() => new Promise<void>(() => { /* stays in-flight */ }));
    await run(q, workerBase(checkWorker, tracker, inflight, { now: 0 }));
    await run(q, workerBase(checkWorker, tracker, inflight, { now: WORKER_IDLE }));        // check #1
    await run(q, workerBase(checkWorker, tracker, inflight, { now: WORKER_IDLE + 30_000 })); // still in-flight → skip
    expect(checkWorker).toHaveBeenCalledTimes(1);
  });

  it('skips a worker session with no task row', async () => {
    const q = new DecisionQueue(() => 0);
    const tracker = new PaneActivityTracker(); const inflight = new Set<string>();
    const checkWorker = vi.fn(async () => {});
    await run(q, workerBase(checkWorker, tracker, inflight, { now: 0, sessionTaskId: () => null }));
    await run(q, workerBase(checkWorker, tracker, inflight, { now: WORKER_IDLE, sessionTaskId: () => null }));
    expect(checkWorker).not.toHaveBeenCalled();
  });

  it('skips pilot and advisor sessions entirely', async () => {
    const q = new DecisionQueue(() => 0);
    const tracker = new PaneActivityTracker(); const inflight = new Set<string>();
    const checkWorker = vi.fn(async () => {});
    const base = (now: number): RunOpts => ({ sessions: ['orca-pilot-planner', 'orca-advisor-7'], pane: () => 'frozen', tracker, inflight, now, sessionTaskId: () => 't1', checkWorker });
    await run(q, base(0));
    await run(q, base(WORKER_IDLE));
    expect(checkWorker).not.toHaveBeenCalled();
  });
});

describe('sweepAgentLiveness — progress check (routine glance at a WORKING worker)', () => {
  const PROGRESS = 600_000;
  // An actively-working worker: its pane changes every tick, so its idle stays at 0 (never wedged).
  const active = (checkWorker: AgentLivenessDeps['checkWorker'], tracker: PaneActivityTracker, inflight: Set<string>, lastProgressAt: Map<string, number>, frame: () => number, over: Partial<RunOpts> = {}): RunOpts => ({
    sessions: ['orca-iris'], pane: () => `frame${frame()}`, tracker, inflight, lastProgressAt, progressReviewMs: PROGRESS,
    now: 0, sessionTaskId: () => 't1', programFor: () => 'claude-code', hasPrompt: () => false, checkWorker, ...over,
  });

  it('first sight seeds the clock and does not fire; fires reason "progress" only once the interval elapses', async () => {
    const q = new DecisionQueue(() => 0);
    const tracker = new PaneActivityTracker(); const inflight = new Set<string>(); const lastProgressAt = new Map<string, number>();
    const checkWorker = vi.fn(async () => {});
    let f = 0; const frame = () => f;
    f = 0; await run(q, active(checkWorker, tracker, inflight, lastProgressAt, frame, { now: 0 }));        // first sight → seed
    expect(checkWorker).not.toHaveBeenCalled();
    expect(lastProgressAt.get('orca-iris')).toBe(0);
    f = 1; await run(q, active(checkWorker, tracker, inflight, lastProgressAt, frame, { now: PROGRESS - 1 })); // not due yet
    expect(checkWorker).not.toHaveBeenCalled();
    f = 2; const r = await run(q, active(checkWorker, tracker, inflight, lastProgressAt, frame, { now: PROGRESS })); // due
    expect(checkWorker).toHaveBeenCalledTimes(1);
    expect(checkWorker).toHaveBeenCalledWith('orca-iris', 't1', 'frame2', 0, 'progress');
    expect(r.checked).toEqual(['orca-iris']);
  });

  it('never fires when progress review is disabled (progressReviewMs = 0)', async () => {
    const q = new DecisionQueue(() => 0);
    const tracker = new PaneActivityTracker(); const inflight = new Set<string>(); const lastProgressAt = new Map<string, number>();
    const checkWorker = vi.fn(async () => {});
    let f = 0; const frame = () => f;
    f = 0; await run(q, active(checkWorker, tracker, inflight, lastProgressAt, frame, { now: 0, progressReviewMs: 0 }));
    f = 1; await run(q, active(checkWorker, tracker, inflight, lastProgressAt, frame, { now: 10 * PROGRESS, progressReviewMs: 0 }));
    expect(checkWorker).not.toHaveBeenCalled();
  });

  it('does not progress-check a worker sitting on a structured prompt', async () => {
    const q = new DecisionQueue(() => 0);
    const tracker = new PaneActivityTracker(); const inflight = new Set<string>(); const lastProgressAt = new Map<string, number>();
    const checkWorker = vi.fn(async () => {});
    let f = 0; const frame = () => f;
    f = 0; await run(q, active(checkWorker, tracker, inflight, lastProgressAt, frame, { now: 0, hasPrompt: () => true }));
    f = 1; await run(q, active(checkWorker, tracker, inflight, lastProgressAt, frame, { now: PROGRESS, hasPrompt: () => true }));
    expect(checkWorker).not.toHaveBeenCalled();
  });

  it('an idle-past-the-bar worker takes the wedge path even when a progress check would be due', async () => {
    const q = new DecisionQueue(() => 0);
    const tracker = new PaneActivityTracker(); const inflight = new Set<string>(); const lastProgressAt = new Map<string, number>();
    const checkWorker = vi.fn(async () => {});
    // Static pane → idle grows to the bar. progressReviewMs small so progress would also be "due".
    const base = (now: number): RunOpts => ({ sessions: ['orca-iris'], pane: () => 'wedged', tracker, inflight, lastProgressAt, progressReviewMs: 100_000, now, sessionTaskId: () => 't1', programFor: () => 'claude-code', hasPrompt: () => false, checkWorker });
    await run(q, base(0));
    await run(q, base(WORKER_IDLE));
    expect(checkWorker).toHaveBeenCalledTimes(1);
    expect(checkWorker).toHaveBeenCalledWith('orca-iris', 't1', 'wedged', 5, 'idle');
  });

  it('the shared in-flight guard blocks a progress check while any check is awaiting the overseer', async () => {
    const q = new DecisionQueue(() => 0);
    const tracker = new PaneActivityTracker(); const inflight = new Set<string>(['orca-iris']); const lastProgressAt = new Map<string, number>([['orca-iris', 0]]);
    const checkWorker = vi.fn(async () => {});
    let f = 0; const frame = () => f;
    f = 1; await run(q, active(checkWorker, tracker, inflight, lastProgressAt, frame, { now: PROGRESS + 1 }));
    expect(checkWorker).not.toHaveBeenCalled();
  });

  it('after a wedge check fires, a resumed worker is not immediately progress-checked (cadence reset on both arms)', async () => {
    const q = new DecisionQueue(() => 0);
    const tracker = new PaneActivityTracker(); const inflight = new Set<string>(); const lastProgressAt = new Map<string, number>();
    const checkWorker = vi.fn(async () => {});
    const wedged = (now: number): RunOpts => ({ sessions: ['orca-iris'], pane: () => 'wedged', tracker, inflight, lastProgressAt, progressReviewMs: PROGRESS, now, sessionTaskId: () => 't1', programFor: () => 'claude-code', hasPrompt: () => false, checkWorker });
    await run(q, wedged(0));                 // first sight (seeds lastProgressAt)
    await run(q, wedged(WORKER_IDLE));        // wedge check fires (reason 'idle'), stamps lastProgressAt = WORKER_IDLE
    expect(checkWorker).toHaveBeenCalledTimes(1);
    expect(lastProgressAt.get('orca-iris')).toBe(WORKER_IDLE);
    // Worker resumes (pane changes → idle 0) shortly after; progress must NOT fire on the stale stamp.
    await run(q, { sessions: ['orca-iris'], pane: () => 'resumed-output', tracker, inflight, lastProgressAt, progressReviewMs: PROGRESS, now: WORKER_IDLE + 30_000, sessionTaskId: () => 't1', programFor: () => 'claude-code', hasPrompt: () => false, checkWorker });
    expect(checkWorker).toHaveBeenCalledTimes(1);
  });
});

describe('checkAction — reason "idle" (wedge)', () => {
  const v = (p: Partial<{ approve: boolean; message: string; restart: boolean; rationale: string; escalated: boolean }>) =>
    ({ approve: false, confidence: 0, rationale: '', ...p });
  const idle = { reason: 'idle' as const, missionLive: true, nudges: 0, nudgeMax: 2 };

  it('no-ops when the mission is gone (drain race), regardless of verdict', () => {
    expect(checkAction(v({ message: 'hi' }), { ...idle, missionLive: false })).toEqual({ type: 'noop' });
    expect(checkAction(v({ rationale: 'mission disengaged' }), idle)).toEqual({ type: 'noop' });
  });

  it('approve → no-op (false alarm, still working)', () => {
    expect(checkAction(v({ approve: true }), idle)).toEqual({ type: 'noop' });
  });

  it('message → nudge until the budget is spent, then escalate', () => {
    expect(checkAction(v({ message: 'try X' }), { ...idle, nudges: 0 })).toEqual({ type: 'nudge', text: 'try X' });
    expect(checkAction(v({ message: 'try X' }), { ...idle, nudges: 1 })).toEqual({ type: 'nudge', text: 'try X' });
    expect(checkAction(v({ message: 'try X' }), { ...idle, nudges: 2 })).toEqual({ type: 'escalate' });
  });

  it('restart → restart; bare escalate → escalate', () => {
    expect(checkAction(v({ restart: true }), idle)).toEqual({ type: 'restart' });
    expect(checkAction(v({}), idle)).toEqual({ type: 'escalate' });
  });
});

describe('checkAction — reason "progress" (routine glance at a working agent)', () => {
  const v = (p: Partial<{ approve: boolean; message: string; restart: boolean; rationale: string; escalated: boolean }>) =>
    ({ approve: false, confidence: 0, rationale: '', ...p });
  const prog = { reason: 'progress' as const, missionLive: true, nudges: 0, nudgeMax: 2 };

  it('approve → no-op (on track, sends nothing)', () => {
    expect(checkAction(v({ approve: true }), prog)).toEqual({ type: 'noop' });
  });

  it('message → steer (delivered, NOT a budget-counted nudge) regardless of prior nudges', () => {
    expect(checkAction(v({ message: 'use B' }), prog)).toEqual({ type: 'steer', text: 'use B' });
    expect(checkAction(v({ message: 'use B' }), { ...prog, nudges: 5 })).toEqual({ type: 'steer', text: 'use B' });
  });

  it('restart → restart (truly hung)', () => {
    expect(checkAction(v({ restart: true }), prog)).toEqual({ type: 'restart' });
  });

  it('NEVER escalates a working agent: bare reject / timeout / fumbled flags → no-op', () => {
    expect(checkAction(v({}), prog)).toEqual({ type: 'noop' });                                   // bare reject
    expect(checkAction(v({ escalated: true, rationale: 'overseer timeout' }), prog)).toEqual({ type: 'noop' }); // timeout
  });

  it('still no-ops when the mission is gone', () => {
    expect(checkAction(v({ message: 'use B' }), { ...prog, missionLive: false })).toEqual({ type: 'noop' });
  });
});
