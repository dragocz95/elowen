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

function makeApp() {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const tasks = new TaskStore(db);
  const bus = new EventBus();
  const a = createServer({ tasks, readiness: new Readiness(db), missions: new MissionStore(db), bus, engine: null as any, spawn: null as any, tmux: null as any, project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' } });
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

it('POST /sessions launches an agent on a task and marks it in_progress', async () => {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const tasks = new TaskStore(db); tasks.create({ id: 'orca-1', project_id: 1, title: 'X' });
  const tmux = new FakeTmuxDriver();
  const app = createServer({
    tasks, readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as any, spawn: new SpawnService({ tmux, agents: new AgentStore(db) }), tmux,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
  });
  const res = await app.request('/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: 'orca-1', exec: 'ollama/deepseek-v4-flash' }) });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.session).toMatch(/^orca-/);
  expect(tasks.get('orca-1')?.status).toBe('in_progress');
  expect(await tmux.list()).toContain(body.session);
});

it('PATCH /missions/:id pauses (drops from active) and resumes', async () => {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const missions = new MissionStore(db);
  missions.create({ id: 'm1', epic_id: 'e1', autonomy: 'L3', max_sessions: 1, cleared_guardrails: [] });
  const tmux = new FakeTmuxDriver();
  const engine = { tick: async () => {} } as unknown as MissionEngine;
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions, bus: new EventBus(),
    engine, spawn: null as any, tmux, project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
  });
  await app.request('/missions/m1', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'pause' }) });
  expect((await (await app.request('/missions')).json())).toEqual([]); // paused → not active
  expect(missions.get('m1')?.state).toBe('paused');
  await app.request('/missions/m1', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'resume' }) });
  expect(missions.get('m1')?.state).toBe('active');
});
