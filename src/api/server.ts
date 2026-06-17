import { basename } from 'node:path';
import { randomBytes } from 'node:crypto';
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
import type { Clock } from '../shared/clock.js';
import type { ConfigStore } from '../store/configStore.js';
import { assembleMissionDetail } from '../store/missionDetail.js';
import type { UserStore, User } from '../store/userStore.js';
import { authMiddleware } from './auth.js';
import type { EventStore } from '../store/eventStore.js';


export interface ServerDeps {
  tasks: TaskStore; readiness: Readiness; missions: MissionStore;
  engine: MissionEngine; spawn: SpawnService; tmux: TmuxDriver; bus: EventBus;
  project: { id: number; path: string };
  fallback: AgentSpec;
  clock: Clock;
  config: ConfigStore;
  users?: UserStore;
  events?: EventStore;
}

export function createServer(d: ServerDeps): Hono<{ Variables: { user: User; token: string } }> {
  const app = new Hono<{ Variables: { user: User; token: string } }>();
  app.use('*', cors());
  app.get('/health', c => c.json({ ok: true }));
  app.get('/activity', (c) => {
    if (!d.events) return c.json([]);
    const limit = Number(c.req.query('limit')) || undefined;
    const type = c.req.query('type') || undefined;
    return c.json(d.events.list({ limit, type }));
  });

  if (d.users) {
    const users = d.users;
    app.use('*', authMiddleware(users));

    app.post('/auth/login', async (c) => {
      const { username, password } = await c.req.json();
      const user = users.verify(username, password);
      if (!user) return c.json({ error: 'invalid credentials' }, 401);
      return c.json({ token: users.issueToken(user.id), user });
    });
    app.post('/auth/logout', (c) => { const t = c.get('token'); if (t) users.revokeToken(t); return c.json({ ok: true }); });
    app.get('/auth/me', (c) => c.json({ user: c.get('user') }));
    app.get('/users', (c) => c.json(users.list()));
    app.post('/users', async (c) => {
      const { username, password } = await c.req.json();
      try { return c.json(users.create(username, password), 201); }
      catch { return c.json({ error: 'username taken' }, 409); }
    });
    app.delete('/users/:id', (c) => {
      if (users.count() <= 1) return c.json({ error: 'cannot delete the last user' }, 400);
      users.delete(Number(c.req.param('id')));
      return c.json({ ok: true });
    });
  }

  app.get('/tasks', c => c.json(d.tasks.list()));
  app.post('/tasks', async c => {
    const b = await c.req.json() as { title: string; type?: string; priority?: string; id?: string };
    const id = b.id ?? `${basename(d.project.path)}-${randomBytes(4).toString('hex')}`;
    const created = d.tasks.create({ id, project_id: d.project.id, title: b.title, type: b.type, priority: b.priority });
    d.bus.publish({ type: 'task', taskId: created.id, status: created.status });
    return c.json(created, 201);
  });
  app.get('/tasks/ready', c => c.json(d.readiness.ready(1)));
  app.patch('/tasks/:id', async c => {
    const b = await c.req.json();
    const id = c.req.param('id');
    if (b.status) { d.tasks.setStatus(id, b.status); d.bus.publish({ type: 'task', taskId: id, status: b.status }); }
    if (typeof b.exec === 'string') { d.tasks.setExec(id, b.exec); }
    return c.json(d.tasks.get(id));
  });

  app.get('/sessions', async c => c.json(await d.tmux.list()));
  app.post('/sessions', async (c) => {
    const { taskId, exec } = await c.req.json() as { taskId: string; exec?: string };
    if (exec && !d.config.get().allowedExecs.includes(exec)) return c.json({ error: 'exec not allowed' }, 400);
    const spec = resolveExecutor(exec ? [`exec:${exec}`] : [], d.fallback);
    d.tasks.setStatus(taskId, 'in_progress');
    const { session } = await d.spawn.launch({ projectId: d.project.id, projectPath: d.project.path, taskId, agentName: uniqueName(), spec });
    d.bus.publish({ type: 'task', taskId, status: 'in_progress' });
    return c.json({ session }, 201);
  });
  app.delete('/sessions/:name', async c => { await d.tmux.kill(c.req.param('name')); return c.json({ ok: true }); });
  app.post('/sessions/:name/keys', async c => { const { keys } = await c.req.json(); await d.tmux.sendKeys(c.req.param('name'), keys); return c.json({ ok: true }); });
  app.get('/sessions/:name/pane', async c => c.json({ pane: await d.tmux.capturePane(c.req.param('name'), 60) }));

  app.get('/sessions/:name/stream', (c) => {
    const name = c.req.param('name');
    return streamSSE(c, async (stream) => {
      const frame = async () => {
        const pane = await d.tmux.capturePaneAnsi(name, 200);
        await stream.writeSSE({ data: JSON.stringify({ pane }), event: 'pane' });
      };
      await frame(); // first frame synchronously so clients render immediately
      const stop = d.clock.setInterval(() => { frame().catch(() => { /* transient capture error — skip this frame, keep the stream alive */ }); }, 1000);
      c.req.raw.signal.addEventListener('abort', stop);
      while (!c.req.raw.signal.aborted) await stream.sleep(1000);
      stop();
    });
  });

  app.get('/missions', c => c.json(d.missions.active()));
  app.get('/missions/:id', (c) => {
    const detail = assembleMissionDetail({ missions: d.missions, tasks: d.tasks }, c.req.param('id'));
    return detail ? c.json(detail) : c.json({ error: 'mission not found' }, 404);
  });
  app.post('/missions', async c => { const b = await c.req.json(); return c.json(await d.engine.engage(b), 201); });
  app.patch('/missions/:id', async (c) => {
    const id = c.req.param('id');
    const { action } = await c.req.json();
    if (action === 'pause') {
      d.missions.setState(id, 'paused');
    } else if (action === 'resume') {
      d.missions.setState(id, 'active');
      await d.engine.tick(id);
    }
    d.bus.publish({ type: 'mission', missionId: id, state: action === 'pause' ? 'paused' : 'active' });
    return c.json(d.missions.get(id));
  });
  app.delete('/missions/:id', async c => { await d.engine.disengage(c.req.param('id')); return c.json({ ok: true }); });

  app.get('/config', (c) => c.json(d.config.get()));
  app.put('/config', async (c) => { const patch = await c.req.json(); return c.json(d.config.update(patch)); });

  app.get('/events', c => streamSSE(c, async stream => {
    const off = d.bus.subscribe(e => void stream.writeSSE({ data: JSON.stringify(e), event: e.type }));
    c.req.raw.signal.addEventListener('abort', off);
    while (!c.req.raw.signal.aborted) await stream.sleep(30000);
  }));

  return app;
}
