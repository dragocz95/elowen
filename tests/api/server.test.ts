import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { Readiness } from '../../src/store/readiness.js';
import { MissionStore } from '../../src/store/missionStore.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';

function app() {
  const db = openDb(':memory:'); db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const tasks = new TaskStore(db);
  return createServer({ tasks, readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(), engine: null as any, spawn: null as any, tmux: null as any });
}

describe('api', () => {
  it('GET /health returns ok', async () => {
    const res = await app().request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
  it('POST /tasks creates and GET /tasks lists it', async () => {
    const a = app();
    await a.request('/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'orca-1', project_id: 1, title: 'X' }) });
    const list = await (await a.request('/tasks')).json();
    expect(list.map((t: any) => t.id)).toEqual(['orca-1']);
  });
});
