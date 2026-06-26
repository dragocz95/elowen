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

  it('de-duplicates agent names across phases so sessions can never collide', async () => {
    // The pilot (an LLM) can hand the SAME agent name to several phases. Agent names double as tmux
    // session names and as the janitor's session↔task key, so duplicates cause "duplicate session"
    // spawn failures and stall the mission. persistPlan must keep the first and drop the rest.
    const { app, token } = await makeTestApp({ apiKey: '' });
    await app.request('/config', { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ autopilot: { pilotExec: 'claude:opus' } }) });
    const { jobId } = await (await app.request('/tasks/plan', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'agent plan' }) })).json() as { jobId: string };
    await app.request(`/plan/${jobId}/submit`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ phases: [
      { title: 'One', type: 'task', agent: 'claude' },
      { title: 'Two', type: 'task', agent: 'claude' },
      { title: 'Three', type: 'task', agent: 'claude' },
    ] }) });
    const tasks = await (await app.request('/tasks', { headers: { authorization: `Bearer ${token}` } })).json() as { title: string; labels: string[] }[];
    const phases = tasks.filter((t) => ['One', 'Two', 'Three'].includes(t.title));
    const agentNames = phases.map((t) => t.labels.find((l) => l.startsWith('agent:'))).filter(Boolean);
    expect(new Set(agentNames).size).toBe(agentNames.length); // no two phases share an agent name
    expect(agentNames).toContain('agent:claude'); // the first occurrence is honoured
  });

  it('stamps the optional mission name on the epic title, keeping the full goal as the description', async () => {
    const { app, token } = await makeTestApp({ fakePlan: '[{"title":"P","type":"task"}]', apiKey: 'k' });
    const { epicId } = await (await app.request('/tasks/plan', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'rebuild the whole onboarding flow with email verification', name: 'Onboarding v2' }) })).json() as { epicId: string };
    const tasks = await (await app.request('/tasks', { headers: { authorization: `Bearer ${token}` } })).json() as { id: string; title: string; description: string }[];
    const epic = tasks.find((t) => t.id === epicId)!;
    expect(epic.title).toBe('Onboarding v2');                                                  // short name → title
    expect(epic.description).toBe('rebuild the whole onboarding flow with email verification'); // full goal → description
  });

  it('falls back to the goal for the epic title when no mission name is given', async () => {
    const { app, token } = await makeTestApp({ fakePlan: '[{"title":"P","type":"task"}]', apiKey: 'k' });
    const { epicId } = await (await app.request('/tasks/plan', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'just the goal', name: '   ' }) })).json() as { epicId: string };
    const tasks = await (await app.request('/tasks', { headers: { authorization: `Bearer ${token}` } })).json() as { id: string; title: string; description: string }[];
    const epic = tasks.find((t) => t.id === epicId)!;
    expect(epic.title).toBe('just the goal');       // blank name → goal
    expect(epic.description).toBe('just the goal');
  });

  it('stamps a pr:off epic label when the task opts out of the PR workflow', async () => {
    const { app, token } = await makeTestApp({ fakePlan: '[{"title":"P","type":"task"}]', apiKey: 'k' });
    const { epicId } = await (await app.request('/tasks/plan', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'no PR please', prEnabled: false }) })).json() as { epicId: string };
    const tasks = await (await app.request('/tasks', { headers: { authorization: `Bearer ${token}` } })).json() as { id: string; labels: string[] }[];
    expect(tasks.find((t) => t.id === epicId)?.labels).toContain('pr:off');
  });

  it('stamps a pr:on epic label when the task opts in, and nothing when left to default', async () => {
    const { app, token } = await makeTestApp({ fakePlan: '[{"title":"P","type":"task"}]', apiKey: 'k' });
    const on = await (await app.request('/tasks/plan', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'PR on', prEnabled: true }) })).json() as { epicId: string };
    const def = await (await app.request('/tasks/plan', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'PR default' }) })).json() as { epicId: string };
    const tasks = await (await app.request('/tasks', { headers: { authorization: `Bearer ${token}` } })).json() as { id: string; labels: string[] }[];
    expect(tasks.find((t) => t.id === on.epicId)?.labels).toContain('pr:on');
    const defLabels = tasks.find((t) => t.id === def.epicId)?.labels ?? [];
    expect(defLabels.some((l) => l.startsWith('pr:'))).toBe(false); // inherit → no override label
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

describe('persistPlan — DAG from phase dependsOn', () => {
  const post = (app: Awaited<ReturnType<typeof makeTestApp>>['app'], token: string, goal: string) =>
    app.request('/tasks/plan', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ goal }) });

  it('wires per-phase dependsOn so independent phases are ready at once and a dependent one waits', async () => {
    const fakePlan = JSON.stringify([
      { title: 'API', type: 'feature', id: 'api', dependsOn: [] },
      { title: 'Docs', type: 'chore', id: 'docs', dependsOn: [] },
      { title: 'Wire', type: 'feature', id: 'wire', dependsOn: ['api', 'docs'] },
    ]);
    const { app, token, deps } = await makeTestApp({ fakePlan, apiKey: 'k' });
    const { epicId } = await (await post(app, token, 'build it')).json() as { epicId: string };
    const tasks = await (await app.request('/tasks', { headers: { authorization: `Bearer ${token}` } })).json() as { id: string; title: string }[];
    const id = (t: string) => tasks.find((x) => x.title === t)!.id;

    expect(deps.tasks.depsFor(id('API'))).toEqual([]);           // independent → no deps
    expect(deps.tasks.depsFor(id('Docs'))).toEqual([]);
    expect(deps.tasks.depsFor(id('Wire')).sort()).toEqual([id('API'), id('Docs')].sort());
    // Two independent phases are ready simultaneously — the whole point of the DAG.
    expect(deps.readiness.readyForEpic(epicId).map((t) => t.title).sort()).toEqual(['API', 'Docs']);
  });

  it('falls back to the legacy linear chain when no phase carries an id', async () => {
    const fakePlan = JSON.stringify([{ title: 'P1' }, { title: 'P2' }, { title: 'P3' }]);
    const { app, token, deps } = await makeTestApp({ fakePlan, apiKey: 'k' });
    const { epicId } = await (await post(app, token, 'legacy')).json() as { epicId: string };
    const tasks = await (await app.request('/tasks', { headers: { authorization: `Bearer ${token}` } })).json() as { id: string; title: string }[];
    const id = (t: string) => tasks.find((x) => x.title === t)!.id;

    expect(deps.tasks.depsFor(id('P1'))).toEqual([]);            // first phase, fresh epic → no leaves
    expect(deps.tasks.depsFor(id('P2'))).toEqual([id('P1')]);    // chained
    expect(deps.tasks.depsFor(id('P3'))).toEqual([id('P2')]);
    expect(deps.readiness.readyForEpic(epicId).map((t) => t.title)).toEqual(['P1']); // one at a time
  });

  it('auto-enables PR mode (pr:on) when more than one session is requested and PR is left to default', async () => {
    const { app, token } = await makeTestApp({ fakePlan: '[{"title":"P","type":"task"}]', apiKey: 'k' });
    const { epicId } = await (await app.request('/tasks/plan', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'parallel work', maxSessions: 2 }) })).json() as { epicId: string };
    const tasks = await (await app.request('/tasks', { headers: { authorization: `Bearer ${token}` } })).json() as { id: string; labels: string[] }[];
    expect(tasks.find((t) => t.id === epicId)?.labels).toContain('pr:on');
  });

  it('does not override an explicit PR opt-out even when multiple sessions are requested', async () => {
    const { app, token } = await makeTestApp({ fakePlan: '[{"title":"P","type":"task"}]', apiKey: 'k' });
    const { epicId } = await (await app.request('/tasks/plan', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'parallel but no PR', maxSessions: 2, prEnabled: false }) })).json() as { epicId: string };
    const tasks = await (await app.request('/tasks', { headers: { authorization: `Bearer ${token}` } })).json() as { id: string; labels: string[] }[];
    expect(tasks.find((t) => t.id === epicId)?.labels).toContain('pr:off');
  });

  it('leaves PR to default for a single-session plan (no auto pr:on)', async () => {
    const { app, token } = await makeTestApp({ fakePlan: '[{"title":"P","type":"task"}]', apiKey: 'k' });
    const { epicId } = await (await app.request('/tasks/plan', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'solo', maxSessions: 1 }) })).json() as { epicId: string };
    const tasks = await (await app.request('/tasks', { headers: { authorization: `Bearer ${token}` } })).json() as { id: string; labels: string[] }[];
    expect((tasks.find((t) => t.id === epicId)?.labels ?? []).some((l) => l.startsWith('pr:'))).toBe(false);
  });

  it('does not let a phase with only unknown (typo\'d) deps start immediately — falls back to the previous phase', async () => {
    const fakePlan = JSON.stringify([
      { title: 'First', type: 'feature', id: 'first', dependsOn: [] },
      { title: 'Second', type: 'feature', id: 'second', dependsOn: ['nope'] }, // references a phase that doesn't exist
    ]);
    const { app, token, deps } = await makeTestApp({ fakePlan, apiKey: 'k' });
    const { epicId } = await (await post(app, token, 'typo deps')).json() as { epicId: string };
    const tasks = await (await app.request('/tasks', { headers: { authorization: `Bearer ${token}` } })).json() as { id: string; title: string }[];
    const id = (t: string) => tasks.find((x) => x.title === t)!.id;

    expect(deps.tasks.depsFor(id('First'))).toEqual([]);             // genuinely independent → ready
    expect(deps.tasks.depsFor(id('Second'))).toEqual([id('First')]); // declared-but-unmapped → waits on the previous phase, not ready now
    expect(deps.readiness.readyForEpic(epicId).map((t) => t.title)).toEqual(['First']); // ordering preserved, no early parallel start
  });

  it('breaks a hallucinated dependency cycle instead of deadlocking the mission', async () => {
    const fakePlan = JSON.stringify([
      { title: 'A', id: 'a', dependsOn: ['b'] },
      { title: 'B', id: 'b', dependsOn: ['a'] },
    ]);
    const { app, token, deps } = await makeTestApp({ fakePlan, apiKey: 'k' });
    const { epicId } = await (await post(app, token, 'cycle')).json() as { epicId: string };
    // Exactly one edge survives the cycle guard, so at least one phase is ready — never a deadlock.
    const edges = deps.tasks.allDeps();
    expect(edges).toHaveLength(1);
    expect(deps.readiness.readyForEpic(epicId).length).toBeGreaterThan(0);
  });
});
