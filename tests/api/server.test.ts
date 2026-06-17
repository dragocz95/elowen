import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { Readiness } from '../../src/store/readiness.js';
import { MissionStore } from '../../src/store/missionStore.js';
import { EventBus } from '../../src/api/sse.js';
import type { OrcaEvent } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';

function makeApp() {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const tasks = new TaskStore(db);
  const bus = new EventBus();
  const a = createServer({ tasks, readiness: new Readiness(db), missions: new MissionStore(db), bus, engine: null as any, spawn: null as any, tmux: null as any });
  return { app: a, bus };
}

describe('api', () => {
  it('GET /health returns ok', async () => {
    const { app } = makeApp();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
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
