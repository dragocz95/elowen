import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import type { TaskStore } from '../store/taskStore.js';
import type { Readiness } from '../store/readiness.js';
import type { MissionStore } from '../store/missionStore.js';
import type { MissionEngine } from '../overseer/missionEngine.js';
import type { SpawnService } from '../spawn/spawn.js';
import type { TmuxDriver } from '../tmux/types.js';
import type { EventBus } from './sse.js';
import type { AgentSpec } from '../spawn/commandBuilder.js';
import { resolveExecutor } from '../overseer/routing.js';
import { uniqueName } from '../daemon/uniqueName.js';

export interface ServerDeps {
  tasks: TaskStore; readiness: Readiness; missions: MissionStore;
  engine: MissionEngine; spawn: SpawnService; tmux: TmuxDriver; bus: EventBus;
  project: { id: number; path: string };
  fallback: AgentSpec;
}

export function createServer(d: ServerDeps): Hono {
  const app = new Hono();
  app.use('*', cors());
  app.get('/health', c => c.json({ ok: true }));

  app.get('/tasks', c => c.json(d.tasks.list()));
  app.post('/tasks', async c => { const b = await c.req.json(); const created = d.tasks.create(b); d.bus.publish({ type: 'task', taskId: created.id, status: created.status }); return c.json(created, 201); });
  app.get('/tasks/ready', c => c.json(d.readiness.ready(1)));
  app.patch('/tasks/:id', async c => { const b = await c.req.json(); const id = c.req.param('id'); if (b.status) { d.tasks.setStatus(id, b.status); d.bus.publish({ type: 'task', taskId: id, status: b.status }); } return c.json(d.tasks.get(id)); });

  app.get('/sessions', async c => c.json(await d.tmux.list()));
  app.post('/sessions', async (c) => {
    const { taskId, exec } = await c.req.json();
    const spec = resolveExecutor(exec ? [`exec:${exec}`] : [], d.fallback);
    d.tasks.setStatus(taskId, 'in_progress');
    const { session } = await d.spawn.launch({ projectId: d.project.id, projectPath: d.project.path, taskId, agentName: uniqueName(), spec });
    d.bus.publish({ type: 'task', taskId, status: 'in_progress' });
    return c.json({ session }, 201);
  });
  app.delete('/sessions/:name', async c => { await d.tmux.kill(c.req.param('name')); return c.json({ ok: true }); });
  app.post('/sessions/:name/keys', async c => { const { keys } = await c.req.json(); await d.tmux.sendKeys(c.req.param('name'), keys); return c.json({ ok: true }); });
  app.get('/sessions/:name/pane', async c => c.json({ pane: await d.tmux.capturePane(c.req.param('name'), 60) }));

  app.get('/missions', c => c.json(d.missions.active()));
  app.post('/missions', async c => { const b = await c.req.json(); return c.json(await d.engine.engage(b), 201); });
  app.delete('/missions/:id', async c => { await d.engine.disengage(c.req.param('id')); return c.json({ ok: true }); });

  app.get('/events', c => streamSSE(c, async stream => {
    const off = d.bus.subscribe(e => void stream.writeSSE({ data: JSON.stringify(e), event: e.type }));
    c.req.raw.signal.addEventListener('abort', off);
    while (!c.req.raw.signal.aborted) await stream.sleep(30000);
  }));

  return app;
}
