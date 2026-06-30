import { describe, it, expect } from 'vitest';
import { DecisionQueue } from '../../src/overseer/decisionQueue.js';
import { sweepDecisionTimeouts } from '../../src/overseer/decisionTimeout.js';

const GRACE = 90_000;
const HARD = 600_000;
const sweep = (queue: DecisionQueue, opts: { live: string[]; now: number; deadSince: Map<string, number> }) =>
  sweepDecisionTimeouts({ queue, liveSessions: new Set(opts.live), now: opts.now, deadSince: opts.deadSince, graceMs: GRACE, hardMs: HARD });

describe('sweepDecisionTimeouts', () => {
  it('does not escalate a slow-but-alive overseer under the hard ceiling', () => {
    const q = new DecisionQueue(() => 0);
    const verdict = q.enqueue('m1', 'review', {});
    let settled = false; void verdict.then(() => { settled = true; });
    const { escalated } = sweep(q, { live: ['orca-overseer-m1'], now: 5 * 60_000, deadSince: new Map() });
    expect(escalated).toEqual([]);
    expect(settled).toBe(false);
  });

  it('escalates an alive overseer past the hard ceiling (wedged, never answered)', async () => {
    const q = new DecisionQueue(() => 0);
    const verdict = q.enqueue('m1', 'review', {});
    const id = q.pending()[0]!.id;
    const { escalated } = sweep(q, { live: ['orca-overseer-m1'], now: HARD, deadSince: new Map() });
    expect(escalated).toEqual([id]);
    await expect(verdict).resolves.toMatchObject({ escalated: true, rationale: 'overseer timeout' });
  });

  it('does not escalate a dead overseer within the grace window (watchdog may re-park)', () => {
    const q = new DecisionQueue(() => 0);
    q.enqueue('m1', 'review', {});
    const deadSince = new Map<string, number>();
    const { escalated } = sweep(q, { live: [], now: 1000, deadSince }); // first seen dead at 1000
    expect(escalated).toEqual([]);
    const again = sweep(q, { live: [], now: 1000 + GRACE - 1, deadSince }); // still within grace
    expect(again.escalated).toEqual([]);
    expect(deadSince.get('m1')).toBe(1000);
  });

  it('escalates ALL pending for an overseer dead past the grace window', async () => {
    const q = new DecisionQueue(() => 0);
    const a = q.enqueue('m1', 'review', {});
    const b = q.enqueue('m1', 'prompt', {});
    const ids = q.pending().map((e) => e.id);
    const deadSince = new Map<string, number>();
    sweep(q, { live: [], now: 0, deadSince });               // start the clock at 0
    const { escalated } = sweep(q, { live: [], now: GRACE, deadSince }); // dead past grace
    expect(escalated.sort()).toEqual([...ids].sort());
    await expect(a).resolves.toMatchObject({ escalated: true });
    await expect(b).resolves.toMatchObject({ escalated: true });
    expect(deadSince.has('m1')).toBe(false); // cleared after escalation
  });

  it('does not escalate when a dead overseer re-parks before grace elapses', () => {
    const q = new DecisionQueue(() => 0);
    const verdict = q.enqueue('m1', 'review', {});
    let settled = false; void verdict.then(() => { settled = true; });
    const deadSince = new Map<string, number>();
    sweep(q, { live: [], now: 0, deadSince });                          // dead — clock starts
    const { escalated } = sweep(q, { live: ['orca-overseer-m1'], now: 60_000, deadSince }); // re-parked
    expect(escalated).toEqual([]);
    expect(settled).toBe(false);
    expect(deadSince.has('m1')).toBe(false); // alive → clock cleared
  });

  it('prunes deadSince for missions whose decisions were answered since the last sweep', () => {
    const q = new DecisionQueue(() => 0);
    const verdict = q.enqueue('m1', 'review', {});
    const deadSince = new Map<string, number>();
    sweep(q, { live: [], now: 0, deadSince });
    expect(deadSince.has('m1')).toBe(true);
    void verdict; q.resolve('m1', q.pending()[0]!.id, { approve: true, confidence: 1, rationale: 'ok' });
    sweep(q, { live: [], now: 1000, deadSince }); // m1 no longer pending
    expect(deadSince.has('m1')).toBe(false);
  });
});
