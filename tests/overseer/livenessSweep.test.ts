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
    sessionTaskId: o.sessionTaskId ?? (() => null),
    programFor: o.programFor ?? (() => 'claude-code'),
    hasPrompt: o.hasPrompt ?? (() => false),
    checkWorker: o.checkWorker ?? (async () => {}),
    workerIdleMs: WORKER_IDLE, overseerIdleMs: OVERSEER_IDLE, graceMs: GRACE, hardMs: HARD,
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
    expect(checkWorker).toHaveBeenCalledWith('orca-patricia', 't1', 'wedged', 5);
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

describe('checkAction', () => {
  const v = (p: Partial<{ approve: boolean; message: string; restart: boolean; rationale: string; escalated: boolean }>) =>
    ({ approve: false, confidence: 0, rationale: '', ...p });

  it('no-ops when the mission is gone (drain race), regardless of verdict', () => {
    expect(checkAction(v({ message: 'hi' }), { missionLive: false, nudges: 0, nudgeMax: 2 })).toEqual({ type: 'noop' });
    expect(checkAction(v({ rationale: 'mission disengaged' }), { missionLive: true, nudges: 0, nudgeMax: 2 })).toEqual({ type: 'noop' });
  });

  it('approve → no-op (false alarm, still working)', () => {
    expect(checkAction(v({ approve: true }), { missionLive: true, nudges: 0, nudgeMax: 2 })).toEqual({ type: 'noop' });
  });

  it('message → nudge until the budget is spent, then escalate', () => {
    expect(checkAction(v({ message: 'try X' }), { missionLive: true, nudges: 0, nudgeMax: 2 })).toEqual({ type: 'nudge', text: 'try X' });
    expect(checkAction(v({ message: 'try X' }), { missionLive: true, nudges: 1, nudgeMax: 2 })).toEqual({ type: 'nudge', text: 'try X' });
    expect(checkAction(v({ message: 'try X' }), { missionLive: true, nudges: 2, nudgeMax: 2 })).toEqual({ type: 'escalate' });
  });

  it('restart → restart; bare escalate → escalate', () => {
    expect(checkAction(v({ restart: true }), { missionLive: true, nudges: 0, nudgeMax: 2 })).toEqual({ type: 'restart' });
    expect(checkAction(v({}), { missionLive: true, nudges: 0, nudgeMax: 2 })).toEqual({ type: 'escalate' });
  });
});
