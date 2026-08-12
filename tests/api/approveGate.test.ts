import { describe, it, expect } from 'vitest';
import { makeTestApp } from '../helpers/testApp.js';

type App = ReturnType<typeof makeTestApp> extends Promise<infer T> ? T : never;

const approveGate = (t: App, id: string) =>
  t.app.request(`/tasks/${id}/approve-gate`, { method: 'POST', headers: { authorization: `Bearer ${t.token}` } });

/** Seed a predecessor phase `pred` and a dependent `dep` blocked behind it, marked with the review
 *  gate label `gatedby:<pred>`. Extra gating predecessors can be added by the caller. */
function gate(t: App, predId: string, depId: string) {
  t.deps.tasks.create({ id: predId, project_id: 1, title: predId, type: 'task', description: predId });
  if (!t.deps.tasks.get(depId)) t.deps.tasks.create({ id: depId, project_id: 1, title: depId, type: 'task', description: depId });
  t.deps.tasks.addDep(depId, predId);
  t.deps.tasks.setStatus(depId, 'blocked');
  t.deps.tasks.addLabel(depId, `gatedby:${predId}`);
}

describe('POST /tasks/:id/approve-gate (human approval of an escalated phase)', () => {
  it('re-opens a dependent gated solely by the approved phase', async () => {
    const t = await makeTestApp({});
    gate(t, 'elowen-A', 'elowen-D');
    const res = await approveGate(t, 'elowen-A');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ released: ['elowen-D'] });
    expect(t.deps.tasks.get('elowen-D')!.status).toBe('open');
    expect(t.deps.tasks.get('elowen-D')!.labels.some((l) => l === 'gatedby:elowen-A')).toBe(false);
  });

  it('does NOT release a dependent still gated by another predecessor (P1)', async () => {
    const t = await makeTestApp({});
    gate(t, 'elowen-A', 'elowen-D'); // D depends on A…
    gate(t, 'elowen-B', 'elowen-D'); // …and on B; both reviews gate it

    // Approving A alone must not start D while B is still unresolved.
    const r1 = await approveGate(t, 'elowen-A');
    expect(await r1.json()).toEqual({ released: [] });
    expect(t.deps.tasks.get('elowen-D')!.status).toBe('blocked');
    expect(t.deps.tasks.get('elowen-D')!.labels.some((l) => l === 'gatedby:elowen-A')).toBe(false); // A's hold cleared…
    expect(t.deps.tasks.get('elowen-D')!.labels.some((l) => l === 'gatedby:elowen-B')).toBe(true); // …but B's remains

    // Approving B too finally releases D.
    const r2 = await approveGate(t, 'elowen-B');
    expect(await r2.json()).toEqual({ released: ['elowen-D'] });
    expect(t.deps.tasks.get('elowen-D')!.status).toBe('open');
  });

  it('un-freezes the stalled mission whose escalated phase is approved', async () => {
    const t = await makeTestApp({});
    // Epic + a frozen (stalled) mission; phase A is closed+escalated and gates dependent D — both
    // children of the epic, mirroring a real escalation the human now resolves from the inbox.
    t.deps.tasks.create({ id: 'elowen-ep', project_id: 1, title: 'Epic', type: 'epic', description: 'e' });
    t.deps.tasks.create({ id: 'elowen-A', project_id: 1, title: 'A', type: 'task', parent_id: 'elowen-ep', description: 'A' });
    t.deps.tasks.setStatus('elowen-A', 'closed');
    t.deps.tasks.create({ id: 'elowen-D', project_id: 1, title: 'D', type: 'task', parent_id: 'elowen-ep', description: 'D' });
    t.deps.tasks.addDep('elowen-D', 'elowen-A');
    t.deps.tasks.setStatus('elowen-D', 'blocked');
    t.deps.tasks.addLabel('elowen-D', 'gatedby:elowen-A');
    t.deps.missions.create({ id: 'm-elowen-ep', epic_id: 'elowen-ep', autonomy: 'L3', max_sessions: 1 });
    t.deps.missions.setState('m-elowen-ep', 'stalled');

    const res = await approveGate(t, 'elowen-A');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ released: ['elowen-D'] });
    // The frozen mission resumed: resumeStalled flipped it active and ticked, so the freed dependent
    // didn't just unblock — it was picked straight up and spawned. Reaching 'in_progress' proves the
    // un-freeze drove a real tick, not just a state flip.
    expect(t.deps.missions.get('m-elowen-ep')!.state).toBe('active');
    expect(t.deps.tasks.get('elowen-D')!.status).toBe('in_progress');
  });

  it('refuses an agent token (403) — approving a gate is a human act', async () => {
    const t = await makeTestApp({});
    gate(t, 'elowen-A', 'elowen-D');
    const agentTok = t.deps.users.issueToken(t.deps.users.list()[0]!.id, 'agent');
    const res = await t.app.request('/tasks/elowen-A/approve-gate', { method: 'POST', headers: { authorization: `Bearer ${agentTok}` } });
    expect(res.status).toBe(403);
    expect(t.deps.tasks.get('elowen-D')!.status).toBe('blocked'); // the gate held
  });

  it('404s for an unknown task', async () => {
    const t = await makeTestApp({});
    const res = await approveGate(t, 'elowen-nope');
    expect(res.status).toBe(404);
  });
});
