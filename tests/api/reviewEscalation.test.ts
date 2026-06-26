import { describe, it, expect } from 'vitest';
import { makeTestApp } from '../helpers/testApp.js';
import type { OrcaEvent } from '../../src/api/sse.js';

const enableReview = async (app: ReturnType<typeof makeTestApp> extends Promise<infer T> ? T : never, token: string) =>
  app.app.request('/config', { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ autopilot: { overseerExec: 'claude:opus', reviewOnDone: true } }) });

const closePhase = (app: ReturnType<typeof makeTestApp> extends Promise<infer T> ? T : never, token: string, id: string, summary = 'done') =>
  app.app.request(`/tasks/${id}`, { method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'closed', outcome: 'ok', result_summary: summary }) });

describe('review escalation + self-heal', () => {
  it('publishes a review event on the bus when the verdict approves', async () => {
    const t = await makeTestApp({});
    await enableReview(t, t.token);
    const { missionId, childId } = t.deps.seedMissionWithChain();
    const events: OrcaEvent[] = [];
    t.deps.bus.subscribe((e) => events.push(e));
    const poll = t.deps.decisionQueue.next(missionId, 2000);
    await closePhase(t, t.token, childId);
    const req = await poll;
    t.deps.decisionQueue.resolve(missionId, req!.id, { approve: true, confidence: 0.9, rationale: 'looks good' });
    await new Promise((r) => setTimeout(r, 30));
    const review = events.find((e) => e.type === 'review');
    expect(review).toMatchObject({ type: 'review', taskId: childId, approve: true, rationale: 'looks good' });
  });

  it('hands the overseer the real evidence (changed files + working diff), not just the self-report', async () => {
    const t = await makeTestApp({});
    await enableReview(t, t.token);
    const { missionId, childId } = t.deps.seedMissionWithChain();
    const poll = t.deps.decisionQueue.next(missionId, 2000);
    await closePhase(t, t.token, childId, 'I changed two files');
    const req = await poll;
    expect(req!.kind).toBe('review');
    // Self-report is still there…
    expect(req!.context).toMatchObject({ summary: 'I changed two files', outcome: 'ok' });
    // …but now alongside the real evidence the overseer judges (keys always present; empty in a
    // non-git test workspace, populated against a real repo).
    expect(req!.context).toHaveProperty('changedFiles');
    expect(Array.isArray(req!.context.changedFiles)).toBe(true);
    expect(req!.context).toHaveProperty('diff');
    expect(req!.context).toHaveProperty('diffTruncated');
    // Resolve so the pending review doesn't dangle into the next test.
    t.deps.decisionQueue.resolve(missionId, req!.id, { approve: true, confidence: 0.9, rationale: 'ok' });
  });

  it('publishes a review event with approve=false and the rationale on escalation', async () => {
    const t = await makeTestApp({});
    await enableReview(t, t.token);
    const { missionId, childId } = t.deps.seedMissionWithChain('L2'); // L2 → no self-heal, pure escalation
    const events: OrcaEvent[] = [];
    t.deps.bus.subscribe((e) => events.push(e));
    const poll = t.deps.decisionQueue.next(missionId, 2000);
    await closePhase(t, t.token, childId);
    const req = await poll;
    t.deps.decisionQueue.resolve(missionId, req!.id, { approve: false, confidence: 0, rationale: 'scope creep' });
    await new Promise((r) => setTimeout(r, 30));
    const review = events.find((e) => e.type === 'review');
    expect(review).toMatchObject({ type: 'review', taskId: childId, approve: false, rationale: 'scope creep' });
  });

  it('L3: a rejected review re-opens the closed phase with feedback and re-spawns it (self-heal)', async () => {
    const t = await makeTestApp({});
    await enableReview(t, t.token);
    const { missionId, childId, nextId } = t.deps.seedMissionWithChain('L3');
    const poll = t.deps.decisionQueue.next(missionId, 2000);
    await closePhase(t, t.token, childId);
    const req = await poll;
    t.deps.decisionQueue.resolve(missionId, req!.id, { approve: false, confidence: 0, rationale: 'missing tests' });
    await new Promise((r) => setTimeout(r, 40)); // verdict .then() re-opens + ticks (re-spawn)
    const phase = t.deps.tasks.get(childId)!;
    expect(phase.status).toBe('in_progress'); // re-spawned to fix
    expect(phase.resume_note).toContain('missing tests'); // review feedback pinned as the fixing agent's new input
    expect(phase.labels.some((l) => l === 'reviewfix:1')).toBe(true); // bounded counter bumped
    expect(t.deps.tasks.get(nextId)!.status).toBe('blocked'); // next phase still gated
  });

  it('L3: re-closing a self-healed phase re-reviews it and an approval releases the gated dependent', async () => {
    const t = await makeTestApp({});
    await enableReview(t, t.token);
    const { missionId, childId, nextId } = t.deps.seedMissionWithChain('L3');
    // Round 1: close P1 → review enqueued, P2 gated (blocked), verdict rejects → P1 self-heals (re-opens).
    const poll1 = t.deps.decisionQueue.next(missionId, 2000);
    await closePhase(t, t.token, childId);
    const req1 = await poll1;
    t.deps.decisionQueue.resolve(missionId, req1!.id, { approve: false, confidence: 0, rationale: 'fix it' });
    await new Promise((r) => setTimeout(r, 40));
    expect(t.deps.tasks.get(childId)!.status).toBe('in_progress'); // re-spawned to fix
    expect(t.deps.tasks.get(nextId)!.status).toBe('blocked'); // dependent still gated
    // Round 2: the agent fixes and closes P1 again. The re-close MUST re-review (the gate can't go
    // dark just because the dependent is already 'blocked' from round 1) — else the mission strands.
    const poll2 = t.deps.decisionQueue.next(missionId, 2000);
    await closePhase(t, t.token, childId, 'fixed now');
    const req2 = await poll2;
    expect(req2?.kind).toBe('review'); // the fixed phase is reviewed again, not silently accepted
    // Approve the fix → the gated dependent is released and spawned (mission advances, no strand).
    t.deps.decisionQueue.resolve(missionId, req2!.id, { approve: true, confidence: 0.9, rationale: 'good' });
    await new Promise((r) => setTimeout(r, 40));
    expect(t.deps.tasks.get(nextId)!.status).toBe('in_progress'); // released — the mission did NOT hang
  });

  it('L3: after the self-heal budget (2) is spent, it escalates instead of re-spawning', async () => {
    const t = await makeTestApp({});
    await enableReview(t, t.token);
    const { missionId, childId, nextId } = t.deps.seedMissionWithChain('L3');
    t.deps.tasks.bumpReviewFix(childId); // pretend two fixes already happened
    t.deps.tasks.bumpReviewFix(childId);
    const poll = t.deps.decisionQueue.next(missionId, 2000);
    await closePhase(t, t.token, childId);
    const req = await poll;
    t.deps.decisionQueue.resolve(missionId, req!.id, { approve: false, confidence: 0, rationale: 'still wrong' });
    await new Promise((r) => setTimeout(r, 40));
    expect(t.deps.tasks.get(childId)!.status).toBe('closed'); // NOT re-spawned — budget spent
    expect(t.deps.tasks.get(nextId)!.status).toBe('blocked'); // halted for a human
  });

  it('a terminal phase (no dependents) enqueues no review — there is nothing to gate', async () => {
    const t = await makeTestApp({});
    await enableReview(t, t.token);
    const { missionId, nextId } = t.deps.seedMissionWithChain('L3'); // nextId is the last phase — nothing depends on it
    t.deps.tasks.setStatus(nextId, 'in_progress'); // pretend it was spawned and is now finishing
    const poll = t.deps.decisionQueue.next(missionId, 120); // should TIME OUT: no review is enqueued
    await closePhase(t, t.token, nextId);
    const req = await poll;
    expect(req).toBeNull(); // a phase with no open dependents must not be reviewed
    expect(t.deps.tasks.get(nextId)!.status).toBe('closed'); // and certainly never resurrected
  });

  it('a mission that disengages mid-review does not resurrect the closed phase', async () => {
    const t = await makeTestApp({});
    await enableReview(t, t.token);
    const { missionId, childId, nextId } = t.deps.seedMissionWithChain('L3');
    const poll = t.deps.decisionQueue.next(missionId, 2000);
    await closePhase(t, t.token, childId); // review enqueued (nextId is gated)
    await poll;
    // The mission tears down while the review is still pending: state flips + the queue drains with the
    // synthetic 'mission disengaged' verdict. The verdict handler must NOT self-heal a dead mission.
    t.deps.missions.setState(missionId, 'disengaged');
    t.deps.decisionQueue.drain(missionId);
    await new Promise((r) => setTimeout(r, 40));
    expect(t.deps.tasks.get(childId)!.status).toBe('closed'); // not re-opened by a phantom self-heal
    expect(t.deps.tasks.get(childId)!.labels.some((l) => l.startsWith('reviewfix:'))).toBe(false); // no fix burned
    expect(t.deps.tasks.get(nextId)!.status).toBe('blocked'); // left for the (gone) mission, not spawned
  });

  it('L2: a rejected review does NOT self-heal — the phase stays closed, the next stays blocked', async () => {
    const t = await makeTestApp({});
    await enableReview(t, t.token);
    const { missionId, childId, nextId } = t.deps.seedMissionWithChain('L2');
    const poll = t.deps.decisionQueue.next(missionId, 2000);
    await closePhase(t, t.token, childId);
    const req = await poll;
    t.deps.decisionQueue.resolve(missionId, req!.id, { approve: false, confidence: 0, rationale: 'nope' });
    await new Promise((r) => setTimeout(r, 40));
    expect(t.deps.tasks.get(childId)!.status).toBe('closed'); // human-in-the-loop: no auto re-spawn
    expect(t.deps.tasks.get(nextId)!.status).toBe('blocked');
  });

  it('L3: a timeout-escalated review does NOT self-heal — it waits for a human (no reopen livelock)', async () => {
    const t = await makeTestApp({});
    await enableReview(t, t.token);
    const { missionId, childId, nextId } = t.deps.seedMissionWithChain('L3');
    const poll = t.deps.decisionQueue.next(missionId, 2000);
    await closePhase(t, t.token, childId);
    const req = await poll;
    // The overseer never answered: the queue's timeout produces this shape (`escalated: true`). Even on
    // L3 (which self-heals real rejects) this must NOT re-open the phase — that synthetic-reject reopen
    // was the infinite livelock. It stays closed and waits for a human instead.
    t.deps.decisionQueue.resolve(missionId, req!.id, { approve: false, confidence: 0, rationale: 'overseer timeout', escalated: true });
    await new Promise((r) => setTimeout(r, 40));
    expect(t.deps.tasks.get(childId)!.status).toBe('closed'); // NOT re-spawned despite L3
    expect(t.deps.tasks.get(childId)!.labels.some((l) => l.startsWith('reviewfix:'))).toBe(false); // self-heal budget not burned
    expect(t.deps.tasks.get(nextId)!.status).toBe('blocked'); // halted for a human
  });
});
