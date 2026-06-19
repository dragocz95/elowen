import { basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { hermesStatus, installHermesPlugin } from '../integrations/hermesInstall.js';
import { detectClis } from '../integrations/cliDetection.js';
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
import { decompose, VALID_TYPES as VALID_PHASE_TYPES } from '../overseer/planner.js';
import { RelayClient } from '../inference/client.js';
import type { InferenceClient, RelayConfig } from '../inference/types.js';
import { uniqueName } from '../daemon/uniqueName.js';
import type { Clock } from '../shared/clock.js';
import type { ConfigStore } from '../store/configStore.js';
import { assembleMissionDetail } from '../store/missionDetail.js';
import type { UserStore, User } from '../store/userStore.js';
import { authMiddleware } from './auth.js';
import type { EventStore } from '../store/eventStore.js';
import type { ProjectStore } from '../store/projectStore.js';
import type { GitReader } from '../git/gitReader.js';


export interface ServerDeps {
  tasks: TaskStore; readiness: Readiness; missions: MissionStore;
  engine: MissionEngine; spawn: SpawnService; tmux: TmuxDriver; bus: EventBus;
  project: { id: number; path: string };
  fallback: AgentSpec;
  clock: Clock;
  config: ConfigStore;
  users?: UserStore;
  events?: EventStore;
  projects?: ProjectStore;
  git?: GitReader;
  /** Factory for the planning LLM client; defaults to RelayClient. Overridable in tests. */
  makeInference?: (cfg: RelayConfig) => InferenceClient;
}

export function createServer(d: ServerDeps): Hono<{ Variables: { user: User; token: string } }> {
  const app = new Hono<{ Variables: { user: User; token: string } }>();
  app.use('*', cors());
  app.get('/health', c => c.json({ ok: true }));

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

  app.get('/projects', (c) => c.json(d.projects ? d.projects.list() : []));
  app.post('/projects', async (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    const { slug, path, notes } = await c.req.json();
    try { return c.json(d.projects.create({ slug, path, notes }), 201); }
    catch { return c.json({ error: 'slug taken' }, 409); }
  });
  app.get('/projects/:id/git', async (c) => {
    if (!d.projects || !d.git) return c.json({ error: 'projects unavailable' }, 400);
    const p = d.projects.get(Number(c.req.param('id')));
    if (!p) return c.json({ error: 'project not found' }, 404);
    return c.json(await d.git.read(p.path));
  });

  app.get('/activity', (c) => {
    if (!d.events) return c.json([]);
    const limit = Number(c.req.query('limit')) || undefined;
    const type = c.req.query('type') || undefined;
    return c.json(d.events.list({ limit, type }));
  });

  app.get('/tasks', c => c.json(d.tasks.list()));
  app.post('/tasks', async c => {
    const b = await c.req.json() as { title: string; type?: string; priority?: string; id?: string; description?: string; scheduled_at?: string | null; autostart?: number; deps?: string[] };
    const id = b.id ?? `${basename(d.project.path)}-${randomBytes(4).toString('hex')}`;
    const created = d.tasks.create({ id, project_id: d.project.id, title: b.title, type: b.type, priority: b.priority, description: b.description, scheduled_at: b.scheduled_at, autostart: b.autostart });
    if (Array.isArray(b.deps)) d.tasks.setDeps(created.id, b.deps);
    d.bus.publish({ type: 'task', taskId: created.id, status: created.status });
    return c.json(created, 201);
  });
  app.get('/tasks/ready', c => c.json(d.readiness.ready(1)));
  app.get('/tasks/deps', c => c.json(d.tasks.allDeps()));
  app.patch('/tasks/:id', async c => {
    const b = await c.req.json();
    const id = c.req.param('id');
    if (b.status) {
      if (b.status === 'closed') d.tasks.close(id, { summary: b.result_summary, outcome: b.outcome });
      else d.tasks.setStatus(id, b.status);
      d.bus.publish({ type: 'task', taskId: id, status: b.status });
    }
    if (typeof b.exec === 'string') { d.tasks.setExec(id, b.exec); }
    if (typeof b.title === 'string' || typeof b.type === 'string' || typeof b.priority === 'string' || typeof b.description === 'string' || b.scheduled_at !== undefined || b.autostart !== undefined) {
      d.tasks.update(id, { title: b.title, type: b.type, priority: b.priority, description: b.description, scheduled_at: b.scheduled_at, autostart: b.autostart });
    }
    if (Array.isArray(b.deps)) d.tasks.setDeps(id, b.deps);
    return c.json(d.tasks.get(id));
  });
  app.get('/tasks/:id/deps', c => c.json(d.tasks.depsFor(c.req.param('id'))));
  app.delete('/tasks/:id', c => {
    const id = c.req.param('id');
    d.tasks.delete(id);
    d.bus.publish({ type: 'task', taskId: id, status: 'cancelled' }); // live SSE so open UIs drop the row
    d.events?.deleteForTarget(id); // purge its history — a removed task leaves no dead feed
    return c.json({ ok: true });
  });
  app.post('/tasks/plan', async c => {
    const b = await c.req.json() as { goal?: string; exec?: string; autonomy?: string; maxSessions?: number; engage?: boolean; phases?: { title?: string; type?: string }[]; dryRun?: boolean; prompt?: string };
    const goal = (b.goal ?? '').trim();
    if (!goal) return c.json({ error: 'goal required' }, 400);
    if (b.exec && !d.config.get().allowedExecs.includes(b.exec)) return c.json({ error: 'exec not allowed' }, 400);

    let phases: { title: string; type: string; agent?: string; details?: string }[];
    if (Array.isArray(b.phases) && b.phases.length > 0) {
      // Manual mode: phases supplied by the client — no LLM, no key required.
      phases = b.phases.map((p) => ({ title: (p.title ?? '').trim(), type: VALID_PHASE_TYPES.has(p.type ?? '') ? p.type! : 'task' })).filter((p) => p.title);
      if (phases.length === 0) return c.json({ error: 'phases required' }, 400);
    } else {
      // Autopilot mode: decompose the goal via the configured relay model.
      const cfg = d.config.get();
      const key = d.config.apiKey();
      if (!key) return c.json({ error: 'autopilot_key_missing' }, 400);
      const inf = (d.makeInference ?? ((rc) => new RelayClient(rc)))({ baseUrl: cfg.autopilot.apiUrl, apiKey: key, model: cfg.autopilot.model });
      try {
        // A playground request may pass a prompt override to test an unsaved template.
        phases = await decompose(inf, goal, b.prompt ?? cfg.autopilot.prompt);
      } catch {
        return c.json({ error: 'plan_parse_failed' }, 502);
      }
    }

    // Playground: return the decomposition without persisting anything.
    if (b.dryRun === true) return c.json({ phases });

    const newId = () => `${basename(d.project.path)}-${randomBytes(4).toString('hex')}`;
    const epic = d.tasks.create({ id: newId(), project_id: d.project.id, title: goal, type: 'epic', description: goal });
    d.bus.publish({ type: 'task', taskId: epic.id, status: epic.status });
    const created: typeof epic[] = [];
    for (const ph of phases) {
      // Children carry the phase details (acceptance) plus the overall goal as context.
      const childDesc = ph.details ? `${ph.details}\n\nOverall goal: ${goal}` : `Overall goal: ${goal}`;
      const child = d.tasks.create({ id: newId(), project_id: d.project.id, title: ph.title, type: ph.type, parent_id: epic.id, labels: ph.agent ? [`agent:${ph.agent}`] : [], description: childDesc });
      const prev = created[created.length - 1];
      if (prev) d.tasks.addDep(child.id, prev.id); // sequential: phase n depends on n-1
      if (b.exec) d.tasks.setExec(child.id, b.exec);
      d.bus.publish({ type: 'task', taskId: child.id, status: child.status });
      created.push(child);
    }

    let mission;
    if (b.engage === true) {
      mission = await d.engine.engage({ epicId: epic.id, autonomy: b.autonomy ?? 'L3', maxSessions: b.maxSessions ?? 1, clearedGuardrails: [] });
    }
    return c.json({ epic, phases: created.map((t) => d.tasks.get(t.id)), mission }, 201);
  });

  // Insert phases into an existing epic — a manual list of phases, or `goal` to replan
  // (decompose a residual goal). New phases run AFTER the epic's current chain; an active
  // mission picks up the freshly-ready phase on the next tick (triggered immediately here).
  app.post('/tasks/:epicId/phases', async c => {
    const epicId = c.req.param('epicId');
    const epic = d.tasks.get(epicId);
    if (!epic || epic.type !== 'epic') return c.json({ error: 'epic not found' }, 404);
    const b = await c.req.json() as { phases?: { title?: string; type?: string }[]; goal?: string; prompt?: string; exec?: string };
    if (b.exec && !d.config.get().allowedExecs.includes(b.exec)) return c.json({ error: 'exec not allowed' }, 400);

    let phases: { title: string; type: string; agent?: string; details?: string }[];
    if (Array.isArray(b.phases) && b.phases.length > 0) {
      // Manual insert: explicit phases, no LLM, no key required.
      phases = b.phases.map((p) => ({ title: (p.title ?? '').trim(), type: VALID_PHASE_TYPES.has(p.type ?? '') ? p.type! : 'task' })).filter((p) => p.title);
      if (phases.length === 0) return c.json({ error: 'phases required' }, 400);
    } else if ((b.goal ?? '').trim()) {
      // Replan: decompose the residual goal via the configured relay model.
      const cfg = d.config.get();
      const key = d.config.apiKey();
      if (!key) return c.json({ error: 'autopilot_key_missing' }, 400);
      const inf = (d.makeInference ?? ((rc) => new RelayClient(rc)))({ baseUrl: cfg.autopilot.apiUrl, apiKey: key, model: cfg.autopilot.model });
      try { phases = await decompose(inf, b.goal!.trim(), b.prompt ?? cfg.autopilot.prompt); }
      catch { return c.json({ error: 'plan_parse_failed' }, 502); }
    } else {
      return c.json({ error: 'phases or goal required' }, 400);
    }

    // Chain new phases after the epic's current tail: the first new phase waits on the existing
    // leaf phase(s) (those nothing else depends on), then new phases chain sequentially.
    const existing = d.tasks.descendants(epicId);
    const dependedOn = new Set(d.tasks.depsAmong(existing.map((t) => t.id)).map((e) => e.depends_on_id));
    const leaves = existing.map((t) => t.id).filter((id) => !dependedOn.has(id));
    const overallGoal = epic.description?.trim() || epic.title;
    const newId = () => `${basename(d.project.path)}-${randomBytes(4).toString('hex')}`;
    const created: ReturnType<typeof d.tasks.create>[] = [];
    let prevId: string | null = null;
    for (const ph of phases) {
      const childDesc = ph.details ? `${ph.details}\n\nOverall goal: ${overallGoal}` : `Overall goal: ${overallGoal}`;
      const child = d.tasks.create({ id: newId(), project_id: d.project.id, title: ph.title, type: ph.type, parent_id: epicId, labels: ph.agent ? [`agent:${ph.agent}`] : [], description: childDesc });
      if (prevId) d.tasks.addDep(child.id, prevId);
      else for (const leaf of leaves) d.tasks.addDep(child.id, leaf);
      if (b.exec) d.tasks.setExec(child.id, b.exec);
      d.bus.publish({ type: 'task', taskId: child.id, status: child.status });
      created.push(child);
      prevId = child.id;
    }

    // If a mission is already driving this epic, let it pick up the new ready phase immediately.
    const missionId = `m-${epicId}`;
    if (d.engine && d.engine.isActive(missionId)) await d.engine.tick(missionId);

    return c.json({ epic, phases: created.map((t) => d.tasks.get(t.id)) }, 201);
  });

  // Hermes integration — install the bundled orca plugin into a same-host Hermes instance.
  const hermesHome = (override?: string) => (override?.trim() || process.env.HERMES_HOME || '/var/www/.hermes');
  app.get('/integrations/hermes/status', c => c.json(hermesStatus(hermesHome(c.req.query('home')))));
  app.post('/integrations/hermes/install', async c => {
    const b = await c.req.json() as { home?: string; url?: string; token?: string; timeout?: number };
    const url = (b.url ?? '').trim();
    const token = (b.token ?? '').trim();
    if (!url || !token) return c.json({ error: 'url and token required' }, 400);
    const home = hermesHome(b.home);
    const pluginSrc = join(d.project.path, 'hermes-plugin', 'orca');
    try {
      const result = installHermesPlugin({ home, pluginSrc, url, token, timeout: b.timeout });
      return c.json({ ...result, status: hermesStatus(home) }, 201);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.get('/integrations/cli-status', c => {
    const cfg = d.config.get();
    const ctx = {
      configPersisted: d.config.hasSettings(),
      hasApiKey: cfg.autopilot.apiKeySet,
      hasCustomSetup: cfg.customModels.length > 0 || cfg.hiddenPresets.length > 0,
      userCount: d.users?.count() ?? 0,
      projectCount: d.projects?.list().length ?? 0,
    };
    return c.json(detectClis(ctx));
  });

  app.get('/sessions', async c => c.json((await d.tmux.list()).filter((s) => s.startsWith('orca-'))));
  app.post('/sessions', async (c) => {
    const { taskId, exec } = await c.req.json() as { taskId: string; exec?: string };
    if (exec && !d.config.get().allowedExecs.includes(exec)) return c.json({ error: 'exec not allowed' }, 400);
    const spec = resolveExecutor(exec ? [`exec:${exec}`] : [], d.fallback);
    const task = d.tasks.get(taskId);
    if (exec) d.tasks.setExec(taskId, exec); // remember which model ran it — drives the model icon
    const agentName = uniqueName();
    d.tasks.setAgent(taskId, agentName);     // link task → orca-<agentName> session for run controls
    d.tasks.setStatus(taskId, 'in_progress');
    const { session } = await d.spawn.launch({ projectId: d.project.id, projectPath: d.project.path, taskId, agentName, spec, taskTitle: task?.title, taskDescription: task?.description, epicId: task?.parent_id ?? undefined });
    d.bus.publish({ type: 'task', taskId, status: 'in_progress' });
    return c.json({ session }, 201);
  });
  app.delete('/sessions/:name', async c => { await d.tmux.kill(c.req.param('name')); return c.json({ ok: true }); });
  app.post('/sessions/:name/keys', async c => { const { keys } = await c.req.json(); await d.tmux.sendKeys(c.req.param('name'), keys); return c.json({ ok: true }); });
  app.post('/sessions/:name/resize', async c => {
    const { cols, rows } = await c.req.json() as { cols?: number; rows?: number };
    if (typeof cols !== 'number' || typeof rows !== 'number') return c.json({ error: 'cols and rows required' }, 400);
    await d.tmux.resize(c.req.param('name'), cols, rows);
    return c.json({ ok: true });
  });
  app.get('/sessions/:name/pane', async c => {
    const name = c.req.param('name');
    const pane = c.req.query('ansi') ? await d.tmux.capturePaneAnsi(name, 60) : await d.tmux.capturePane(name, 60);
    return c.json({ pane });
  });

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
