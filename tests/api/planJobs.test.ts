import { describe, it, expect } from 'vitest';
import { makeTestApp } from '../helpers/testApp.js';

describe('async plan jobs (relay path)', () => {
  it('POST /tasks/plan (autopilot, relay) returns 202 with a job that resolves done', async () => {
    const { app, token } = await makeTestApp({ fakePlan: '[{"title":"Phase A","type":"task"}]', apiKey: 'k' });
    const res = await app.request('/tasks/plan', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'do X' }) });
    expect(res.status).toBe(202);
    const { jobId, epicId } = await res.json() as { jobId: string; epicId: string };
    expect(jobId).toMatch(/^pj-/);
    const job = await (await app.request(`/plan/${jobId}`, { headers: { authorization: `Bearer ${token}` } })).json() as { status: string; phases: unknown[] };
    expect(job.status).toBe('done');
    expect(job.phases).toHaveLength(1);
    expect(epicId).toBeTruthy();
  });

  it('POST /tasks/plan agent mode (pilotExec set) returns 202 with a planning job', async () => {
    const { app, token } = await makeTestApp({ apiKey: '' });
    await app.request('/config', { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ autopilot: { pilotExec: 'claude:opus' } }) });
    const planRes = await app.request('/tasks/plan', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'agent plan' }) });
    expect(planRes.status).toBe(202);
    const { jobId } = await planRes.json() as { jobId: string };
    const job = await (await app.request(`/plan/${jobId}`, { headers: { authorization: `Bearer ${token}` } })).json() as { status: string };
    expect(job.status).toBe('planning');
  });

  it('POST /plan/:id/submit validates phases and creates the epic children', async () => {
    const { app, token } = await makeTestApp({ apiKey: '' });
    await app.request('/config', { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ autopilot: { pilotExec: 'claude:opus' } }) });
    const { jobId } = await (await app.request('/tasks/plan', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'agent plan' }) })).json() as { jobId: string };
    const submit = await app.request(`/plan/${jobId}/submit`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ phases: [{ title: 'Build', type: 'feature' }] }) });
    expect(submit.status).toBe(200);
    const tasks = await (await app.request('/tasks', { headers: { authorization: `Bearer ${token}` } })).json() as { title: string }[];
    expect(tasks.some((t) => t.title === 'Build')).toBe(true);
  });

  it('tears down the Pilot tmux session once the plan job settles (no lingering planner)', async () => {
    const t = await makeTestApp({ apiKey: '' });
    // A pilot is planning: its session is live and recorded on the job.
    const job = t.deps.planJobs.create({ goal: 'g', projectId: 1, epicId: null, dryRun: false });
    t.deps.planJobs.setSession(job.id, 'orca-pilot-Atlas');
    await t.deps.tmux.spawn('orca-pilot-Atlas', { cwd: '/o', command: 'planning' });
    expect(await t.deps.tmux.list()).toContain('orca-pilot-Atlas');
    // The pilot submits its plan → the job settles → its session must be reaped so it can't linger
    // and later collide with a fresh plan job's name.
    const res = await t.app.request(`/plan/${job.id}/submit`, { method: 'POST', headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ phases: [{ title: 'Build', type: 'feature' }] }) });
    expect(res.status).toBe(200);
    expect(await t.deps.tmux.list()).not.toContain('orca-pilot-Atlas');
  });

  it('POST /plan/:id/submit rejects empty/invalid phases', async () => {
    const { app, token } = await makeTestApp({ apiKey: '' });
    await app.request('/config', { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ autopilot: { pilotExec: 'claude:opus' } }) });
    const { jobId } = await (await app.request('/tasks/plan', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'g' }) })).json() as { jobId: string };
    const submit = await app.request(`/plan/${jobId}/submit`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ phases: [] }) });
    expect(submit.status).toBe(400);
  });

  // Read the resolved exec for a child task by title (exec lives as an `exec:<spec>` label).
  async function execOf(app: Awaited<ReturnType<typeof makeTestApp>>['app'], token: string, title: string): Promise<string | undefined> {
    const tasks = await (await app.request('/tasks', { headers: { authorization: `Bearer ${token}` } })).json() as { title: string; labels: string[] }[];
    const t = tasks.find((x) => x.title === title);
    return t?.labels.find((l) => l.startsWith('exec:'))?.slice('exec:'.length);
  }
  const putConfig = (app: Awaited<ReturnType<typeof makeTestApp>>['app'], token: string, patch: unknown) =>
    app.request('/config', { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(patch) });

  it('autoModel mode applies a valid per-phase exec and falls back (no label) for an invalid one', async () => {
    const { app, token } = await makeTestApp({ apiKey: 'k', fakePlan: '[{"title":"A","type":"task","exec":"sonnet"},{"title":"B","type":"task","exec":"deepseek/x"}]' });
    await putConfig(app, token, { allowedExecs: ['sonnet'], modelNotes: { sonnet: 'coder' }, defaults: { exec: 'sonnet' } });
    const res = await app.request('/tasks/plan', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'g', autoModel: true }) });
    expect(res.status).toBe(202);
    expect(await execOf(app, token, 'A')).toBe('sonnet');       // valid → applied
    expect(await execOf(app, token, 'B')).toBeUndefined();        // not allowed → unset → runtime default
  });

  it('manual mode ignores a per-phase exec and applies the chosen job exec uniformly', async () => {
    const { app, token } = await makeTestApp({ apiKey: 'k', fakePlan: '[{"title":"A","type":"task","exec":"codex:gpt-5.4"}]' });
    await putConfig(app, token, { allowedExecs: ['sonnet', 'codex:gpt-5.4'] });
    const res = await app.request('/tasks/plan', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'g', exec: 'sonnet' }) });
    expect(res.status).toBe(202);
    expect(await execOf(app, token, 'A')).toBe('sonnet');         // job.exec wins; phase.exec ignored
  });

  it('POST /tasks/plan dryRun (autopilot) returns 202; job resolves done with phases, nothing persisted', async () => {
    const { app, token } = await makeTestApp({ fakePlan: '[{"title":"A","type":"task"},{"title":"B"}]', apiKey: 'k' });
    const { jobId } = await (await app.request('/tasks/plan', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'preview', dryRun: true }) })).json() as { jobId: string };
    const job = await (await app.request(`/plan/${jobId}`, { headers: { authorization: `Bearer ${token}` } })).json() as { status: string; phases: { title: string }[] };
    expect(job.status).toBe('done');
    expect(job.phases.map((p) => p.title)).toEqual(['A', 'B']);
    expect(await (await app.request('/tasks', { headers: { authorization: `Bearer ${token}` } })).json()).toEqual([]);
  });
});
