import { describe, it, expect } from 'vitest';
import { TaskRefs } from '../../../src/store/taskRefs.js';
import { TaskStore } from '../../../plugins/work/src/store/taskStore.js';
import { Readiness } from '../../../plugins/work/src/store/readiness.js';
import { MissionStore } from '../../../plugins/agents/src/store/missionStore.js';
import { EventBus } from '../../../src/api/sse.js';
import type { ElowenEvent } from '../../../src/api/sse.js';
import { createServer } from '../../../src/api/server.js';
import { agentsPluginProvider } from '../../helpers/testApp.js';
import { FakeClock } from '../../../src/shared/clock.js';
import { FakeTmuxDriver } from '../../../src/tmux/fakeDriver.js';
import { ConfigStore } from '../../../src/store/configStore.js';
import { ProjectStore } from '../../../src/store/projectStore.js';
import { openPluginTablesDb } from '../../helpers/pluginTablesDb.js';

/** A daemon serving the task API the way the product does: the REAL work plugin (loaded from its dist
 *  build) root-mounts `/tasks*` and `/plan/*` over these stores, with the agents plugin loaded beside
 *  it — the plan/mission half of the flow resolves through its control, exactly as in the daemon.
 *  No user store, so the routes are exercised in open mode without auth. */
function makeApp(opts: { apiKey?: string; fakePlan?: string; extraProject?: boolean } = {}) {
  const db = openPluginTablesDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  if (opts.extraProject) db.prepare("INSERT INTO projects (id,slug,path) VALUES (2,'other','/p2')").run();
  const tasks = new TaskStore(db);
  const readiness = new Readiness(db);
  const config = new ConfigStore(db);
  if (opts.apiKey) config.update({ autopilot: { apiKey: opts.apiKey } });
  const projects = new ProjectStore(db);
  const bus = new EventBus();
  const tmux = new FakeTmuxDriver();
  const provider = agentsPluginProvider({ db, tasks, readiness, config, projects, bus, tmux, ...(opts.fakePlan ? { fakePlan: opts.fakePlan } : {}) });
  const app = createServer({
    tasks, taskRefs: new TaskRefs(db), missions: new MissionStore(db), bus,
    engine: null as never, tmux,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config, projects,
    plugins: provider,
  });
  return { app, db, tasks, config, bus, provider };
}

const post = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const patch = (body: unknown) => ({ method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('tasks CRUD', () => {
  it('POST /tasks creates and GET /tasks lists it', async () => {
    const { app } = makeApp();
    await app.request('/tasks', post({ id: 'elowen-1', project_id: 1, title: 'X' }));
    const list = await (await app.request('/tasks')).json() as { id: string }[];
    expect(list.map((t) => t.id)).toEqual(['elowen-1']);
  });

  it('GET /tasks?project_id=N narrows the list to one project; unknown id yields []', async () => {
    const { app } = makeApp({ extraProject: true });
    await app.request('/tasks', post({ id: 't-a', project_id: 1, title: 'A' }));
    await app.request('/tasks', post({ id: 't-b', project_id: 2, title: 'B' }));
    const all = await (await app.request('/tasks')).json() as { id: string }[];
    const p1 = await (await app.request('/tasks?project_id=1')).json() as { id: string }[];
    const p2 = await (await app.request('/tasks?project_id=2')).json() as { id: string }[];
    const p99 = await (await app.request('/tasks?project_id=99')).json() as { id: string }[];
    expect(all.map((t) => t.id).sort()).toEqual(['t-a', 't-b']);
    expect(p1.map((t) => t.id)).toEqual(['t-a']);
    expect(p2.map((t) => t.id)).toEqual(['t-b']);
    expect(p99).toEqual([]);
  });

  it('POST /tasks publishes a task SSE event', async () => {
    const { app, bus } = makeApp();
    const events: ElowenEvent[] = [];
    bus.subscribe((e) => events.push(e));
    await app.request('/tasks', post({ id: 'elowen-2', project_id: 1, title: 'Y' }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'task', taskId: 'elowen-2', status: 'open' });
  });

  it('POST /tasks with body {title} generates an id and sets status open', async () => {
    const { app } = makeApp();
    const res = await app.request('/tasks', post({ title: 'From UI' }));
    expect(res.status).toBe(201);
    const created = await res.json() as { id: string; title: string; status: string };
    expect(created.title).toBe('From UI');
    expect(created.status).toBe('open');
    expect(created.id).toBeTruthy();
    const list = await (await app.request('/tasks')).json() as { title: string }[];
    expect(list.some((t) => t.title === 'From UI')).toBe(true);
  });

  it('PATCH /tasks/:id sets the exec label', async () => {
    const { app } = makeApp();
    await app.request('/tasks', post({ id: 'elowen-e', project_id: 1, title: 'E' }));
    const res = await app.request('/tasks/elowen-e', patch({ exec: 'sonnet' }));
    expect(res.status).toBe(200);
    expect((await res.json() as { labels: string[] }).labels).toContain('exec:sonnet');
  });

  it('PATCH /tasks/:id updates title, type and priority', async () => {
    const { app } = makeApp();
    await app.request('/tasks', post({ id: 'elowen-u', project_id: 1, title: 'Old' }));
    const res = await app.request('/tasks/elowen-u', patch({ title: 'New', type: 'bug', priority: 'P0' }));
    expect(res.status).toBe(200);
    const t = await res.json() as { title: string; type: string; priority: string };
    expect(t.title).toBe('New'); expect(t.type).toBe('bug'); expect(t.priority).toBe('P0');
  });

  it('POST /tasks sets dependencies and GET /tasks/:id/deps returns them; PATCH replaces them', async () => {
    const { app } = makeApp();
    await app.request('/tasks', post({ id: 'dep-a', project_id: 1, title: 'A' }));
    await app.request('/tasks', post({ id: 'dep-b', project_id: 1, title: 'B' }));
    await app.request('/tasks', post({ id: 'dep-c', project_id: 1, title: 'C', deps: ['dep-a', 'dep-b'] }));
    const deps = await (await app.request('/tasks/dep-c/deps')).json() as string[];
    expect(deps.sort()).toEqual(['dep-a', 'dep-b']);
    await app.request('/tasks/dep-c', patch({ deps: ['dep-a'] }));
    expect(await (await app.request('/tasks/dep-c/deps')).json()).toEqual(['dep-a']);
    const all = await (await app.request('/tasks/deps')).json() as { task_id: string; depends_on_id: string }[];
    expect(all).toContainEqual({ task_id: 'dep-c', depends_on_id: 'dep-a' });
  });

  it('POST /tasks persists a description and PATCH updates it', async () => {
    const { app } = makeApp();
    const created = await (await app.request('/tasks', post({ title: 'X', description: 'do the thing' }))).json() as { id: string; description: string };
    expect(created.description).toBe('do the thing');
    const patched = await app.request(`/tasks/${created.id}`, patch({ description: 'changed' }));
    expect((await patched.json() as { description: string }).description).toBe('changed');
  });

  it('DELETE /tasks/:id removes the task and publishes a cancelled event', async () => {
    const { app, bus } = makeApp();
    const events: ElowenEvent[] = []; bus.subscribe((e) => events.push(e));
    await app.request('/tasks', post({ id: 'elowen-d', project_id: 1, title: 'Doomed' }));
    const res = await app.request('/tasks/elowen-d', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const list = await (await app.request('/tasks')).json() as { id: string }[];
    expect(list.some((t) => t.id === 'elowen-d')).toBe(false);
    expect(events.some((e) => e.type === 'task' && e.taskId === 'elowen-d' && e.status === 'cancelled')).toBe(true);
  });

  it('POST /tasks honours an explicit project_id (multi-project)', async () => {
    const { app } = makeApp({ extraProject: true });
    const res = await app.request('/tasks', post({ title: 'X', project_id: 2 }));
    expect(res.status).toBe(201);
    const created = await res.json() as { id: string; project_id: number };
    expect(created.project_id).toBe(2);
    expect(created.id.startsWith('p2-')).toBe(true); // id prefix derives from project 2's path basename
  });

  it('POST /tasks rejects an unknown project_id with 404', async () => {
    const { app } = makeApp();
    const res = await app.request('/tasks', post({ title: 'X', project_id: 99 }));
    expect(res.status).toBe(404);
  });

  it('returns 400 on a malformed JSON body (central onError, not a 500)', async () => {
    const { app } = makeApp();
    const res = await app.request('/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{ not json' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid JSON body' });
  });
});

describe('plan and replan', () => {
  it('POST /tasks/plan without an autopilot key returns 400', async () => {
    const { app } = makeApp(); // no apiKey configured
    const res = await app.request('/tasks/plan', post({ goal: 'do stuff' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'autopilot_key_missing' });
  });

  it('POST /tasks/plan decomposes a goal into an epic with sequential phase subtasks', async () => {
    const { app, tasks } = makeApp({ apiKey: 'k', fakePlan: '[{"title":"Schema","type":"task"},{"title":"API","type":"feature"}]' });
    const res = await app.request('/tasks/plan', post({ goal: 'build app' }));
    expect(res.status).toBe(202); // autopilot is an async plan job (the relay resolves it inline)
    const { jobId, epicId } = await res.json() as { jobId: string; epicId: string };
    const job = await (await app.request(`/plan/${jobId}`)).json() as { status: string };
    expect(job.status).toBe('done');
    const epic = tasks.get(epicId)!;
    expect(epic.type).toBe('epic');
    expect(epic.title).toBe('build app');
    const phases = tasks.descendants(epicId);
    expect(phases.map((p) => p.title)).toEqual(['Schema', 'API']);
    expect(phases.every((p) => p.parent_id === epicId)).toBe(true);
    // phase 2 depends on phase 1
    expect(tasks.depsAmong(phases.map((p) => p.id))).toEqual([{ task_id: phases[1]!.id, depends_on_id: phases[0]!.id }]);
  });

  it('POST /tasks/plan stores the model-assigned agent name as a label', async () => {
    const { app, tasks } = makeApp({ apiKey: 'k', fakePlan: '[{"title":"Schema","type":"task","agent":"Nova"}]' });
    const res = await app.request('/tasks/plan', post({ goal: 'build app' }));
    const { epicId } = await res.json() as { epicId: string };
    expect(tasks.descendants(epicId)[0]!.labels).toContain('agent:Nova');
  });

  it('POST /tasks/plan with supplied phases skips the LLM and needs no key', async () => {
    // No autopilot key at all: any request that reached the relay path would answer 400
    // 'autopilot_key_missing', so a 201 here proves the manual path never called the model.
    const { app } = makeApp();
    const res = await app.request('/tasks/plan', post({ goal: 'manual goal', phases: [{ title: 'One', type: 'feature' }, { title: 'Two' }] }));
    expect(res.status).toBe(201);
    const body = await res.json() as { epic: { title: string }; phases: { title: string; type: string }[] };
    expect(body.epic.title).toBe('manual goal');
    expect(body.phases.map((p) => [p.title, p.type])).toEqual([['One', 'feature'], ['Two', 'task']]);
  });

  it('POST /tasks/plan dryRun returns phases without creating any tasks', async () => {
    const { app } = makeApp({ apiKey: 'k', fakePlan: '[{"title":"A","type":"task"},{"title":"B"}]' });
    const res = await app.request('/tasks/plan', post({ goal: 'preview me', dryRun: true, prompt: 'custom {{goal}}' }));
    expect(res.status).toBe(202);
    const { jobId } = await res.json() as { jobId: string };
    const job = await (await app.request(`/plan/${jobId}`)).json() as { status: string; phases: { title: string }[] };
    expect(job.status).toBe('done');
    expect(job.phases.map((p) => p.title)).toEqual(['A', 'B']);
    expect(await (await app.request('/tasks')).json()).toEqual([]); // nothing persisted
  });

  it('POST /tasks/plan with engage=true engages a mission on the epic', async () => {
    const { app, provider } = makeApp({ apiKey: 'k', fakePlan: '[{"title":"Only phase"}]' });
    // Capture the engage the REAL plan flow performs, on the very engine instance it reaches through
    // the agents control — without letting it spawn anything.
    const control = (await provider.get()).control('agents')!;
    let engagedEpic = '';
    (control.engine() as { engage: (input: { epicId: string }) => Promise<unknown> }).engage = async (input) => {
      engagedEpic = input.epicId;
      return { id: 'm-x', epic_id: input.epicId, autonomy: 'L3', max_sessions: 1, state: 'active' };
    };
    const res = await app.request('/tasks/plan', post({ goal: 'ship it', engage: true }));
    expect(res.status).toBe(202);
    const { epicId } = await res.json() as { epicId: string };
    // The relay path finalizes (and engages) inline before responding, so the mission is engaged now.
    expect(engagedEpic).toBe(epicId);
  });

  it("POST /tasks/:epicId/phases inserts a phase chained after the epic's current tail", async () => {
    const { app, tasks } = makeApp();
    // Build an epic with two sequential phases (manual mode — no key needed).
    const plan = await (await app.request('/tasks/plan', post({ goal: 'epic', phases: [{ title: 'One' }, { title: 'Two' }] }))).json() as { epic: { id: string }; phases: { id: string }[] };
    const tail = plan.phases[1]!.id;
    // Insert a third phase.
    const res = await app.request(`/tasks/${plan.epic.id}/phases`, post({ phases: [{ title: 'Three', type: 'feature' }] }));
    expect(res.status).toBe(201);
    const body = await res.json() as { phases: { id: string; title: string; type: string; parent_id: string }[] };
    expect(body.phases.map((p) => [p.title, p.type])).toEqual([['Three', 'feature']]);
    expect(body.phases[0]!.parent_id).toBe(plan.epic.id);
    // The new phase waits on the previous tail (phase Two).
    expect(tasks.depsFor(body.phases[0]!.id)).toEqual([tail]);
  });

  it('POST /tasks/:epicId/phases replans a residual goal into chained phases', async () => {
    const { app, tasks } = makeApp({ apiKey: 'k', fakePlan: '[{"title":"R1"},{"title":"R2"}]' });
    const plan = await (await app.request('/tasks/plan', post({ goal: 'epic', phases: [{ title: 'One' }] }))).json() as { epic: { id: string }; phases: { id: string }[] };
    const res = await app.request(`/tasks/${plan.epic.id}/phases`, post({ goal: 'do more' }));
    expect(res.status).toBe(202); // residual replan is an async plan job (the relay resolves it inline)
    const all = tasks.descendants(plan.epic.id);
    const r1 = all.find((t) => t.title === 'R1')!; const r2 = all.find((t) => t.title === 'R2')!;
    expect([r1, r2].map((p) => p.title)).toEqual(['R1', 'R2']);
    expect(tasks.depsFor(r1.id)).toEqual([plan.phases[0]!.id]); // R1 after the existing phase
    expect(tasks.depsFor(r2.id)).toEqual([r1.id]); // R2 after R1
  });

  it("POST /tasks/:epicId/phases — a DAG replan does not overtake the epic's unfinished frontier", async () => {
    // Replan returns a DAG: R2 depends on R1 (resolved within the new batch), R1 is independent.
    const { app, tasks } = makeApp({ apiKey: 'k', fakePlan: '[{"title":"R1","id":"r1","dependsOn":[]},{"title":"R2","id":"r2","dependsOn":["r1"]}]' });
    const plan = await (await app.request('/tasks/plan', post({ goal: 'epic', phases: [{ title: 'One' }] }))).json() as { epic: { id: string }; phases: { id: string }[] };
    const leaf = plan.phases[0]!.id; // the epic's current unfinished frontier
    const res = await app.request(`/tasks/${plan.epic.id}/phases`, post({ goal: 'do more' }));
    expect(res.status).toBe(202);
    const all = tasks.descendants(plan.epic.id);
    const r1 = all.find((t) => t.title === 'R1')!; const r2 = all.find((t) => t.title === 'R2')!;
    expect(tasks.depsFor(r1.id)).toEqual([leaf]);                      // independent new root still waits on the frontier
    expect(tasks.depsFor(r2.id).sort()).toEqual([r1.id, leaf].sort()); // resolved-dep phase ALSO waits on the frontier, not just R1
  });

  it('POST /tasks/:epicId/phases returns 404 for a non-epic id', async () => {
    const { app } = makeApp();
    const res = await app.request('/tasks/nope/phases', post({ phases: [{ title: 'X' }] }));
    expect(res.status).toBe(404);
  });

  it('POST /tasks/:epicId/phases ticks an active mission so it picks up the new phase', async () => {
    const { app, tasks, provider } = makeApp();
    const control = (await provider.get()).control('agents')!;
    let ticked = '';
    const engine = control.engine() as { isActive: (id: string) => boolean; tick: (id: string) => Promise<void> };
    engine.isActive = (id) => id === 'm-E';
    engine.tick = async (id) => { ticked = id; };
    tasks.create({ id: 'E', project_id: 1, title: 'Epic', type: 'epic', description: 'goal' });
    const res = await app.request('/tasks/E/phases', post({ phases: [{ title: 'New', details: 'Validate the login redirect' }] }));
    expect(res.status).toBe(201);
    expect(ticked).toBe('m-E');
    // A manual phase's details flow through to the created task's description (next to the overall goal),
    // so the agent is told what to do — not just the phase title.
    const body = await res.json() as { phases: { description?: string }[] };
    expect(body.phases[0]!.description).toContain('Validate the login redirect');
    expect(body.phases[0]!.description).toContain('Overall goal: goal');
  });
});
