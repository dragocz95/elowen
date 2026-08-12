import { describe, it, expect } from 'vitest';
import { TaskStore } from '../../src/store/taskStore.js';
import { Readiness } from '../../src/store/readiness.js';
import { MissionStore } from '../../plugins/agents/src/store/missionStore.js';
import { EventBus } from '../../src/api/sse.js';
import type { ElowenEvent } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { openAgentsDb } from '../helpers/agentsDb.js';

// The live SSE channel broadcasts every bus event; without per-subscriber scoping a tenant would see
// cross-project task statuses in real time. Each subscriber must receive only its projects' events.
function setup(eventProjectResolvers?: () => readonly ((e: ElowenEvent) => number | null)[]) {
  const db = openAgentsDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'home','/o')").run();
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (2,'other','/p2')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw');
  const bob = users.create('bob', 'pw');
  const userProjects = new UserProjectStore(db);
  userProjects.assign(bob.id, 1);
  const tasks = new TaskStore(db);
  tasks.create({ id: 't1', project_id: 1, title: 'home task' });
  tasks.create({ id: 't2', project_id: 2, title: 'foreign task' });
  const bus = new EventBus();
  const app = createServer({
    tasks, readiness: new Readiness(db), missions: new MissionStore(db), bus,
    engine: null as never, spawn: null as never, tmux: null as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db),
    users, projects: new ProjectStore(db), userProjects,
    ...(eventProjectResolvers ? { eventProjectResolvers } : {}),
  });
  return {
    app, bus, admin, bob,
    adminTok: users.issueToken(admin.id), bobTok: users.issueToken(bob.id),
  };
}
const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });

// Open the stream, wait for the ': connected' preamble (proves the subscriber is registered), publish,
// then drain whatever was written within a short window and return the accumulated SSE text.
async function streamAfter(app: ReturnType<typeof setup>['app'], tok: string, publish: () => void): Promise<string> {
  const res = await app.request('/events', auth(tok));
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  await reader.read(); // ': connected' — handler has run past d.bus.subscribe
  publish();
  let buf = '';
  for (let i = 0; i < 4; i++) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: boolean }>((r) => setTimeout(() => r({ value: undefined, done: true }), 60)),
    ]);
    if (chunk.done) break;
    if (chunk.value) buf += dec.decode(chunk.value);
  }
  await reader.cancel();
  return buf;
}

describe('GET /events tenancy filtering', () => {
  const home: ElowenEvent = { type: 'task', taskId: 't1', status: 'in_progress' };
  const foreign: ElowenEvent = { type: 'task', taskId: 't2', status: 'in_progress' };

  it('streams a non-admin only their projects\' events', async () => {
    const { app, bus, bobTok } = setup();
    const out = await streamAfter(app, bobTok, () => { bus.publish(foreign); bus.publish(home); });
    expect(out).toContain('"taskId":"t1"');
    expect(out).not.toContain('"taskId":"t2"');
  });

  it('streams an admin every event', async () => {
    const { app, bus, adminTok } = setup();
    const out = await streamAfter(app, adminTok, () => { bus.publish(foreign); bus.publish(home); });
    expect(out).toContain('"taskId":"t1"');
    expect(out).toContain('"taskId":"t2"');
  });

  // `signal`/`plan` tenancy has NO core lookup — the agents plugin's registered event resolver is the
  // sole source. The SSE gate consults the resolvers through RouteContext.eventDeps (the same deps the
  // activity recorder uses), so the two surfaces can never scope differently.
  describe('plugin-resolved events (signal/plan)', () => {
    const signal: ElowenEvent = { type: 'signal', session: 'elowen-Nova', kind: 'waiting_input' } as ElowenEvent;

    it('reach a tenant when the plugin resolver places them in their project', async () => {
      const resolver = (e: ElowenEvent) => (e.type === 'signal' ? 1 : null);
      const { app, bus, bobTok } = setup(() => [resolver]);
      const out = await streamAfter(app, bobTok, () => { bus.publish(signal); });
      expect(out).toContain('"type":"signal"');
    });

    it('are withheld from the tenant when the resolver scopes them elsewhere', async () => {
      const resolver = (e: ElowenEvent) => (e.type === 'signal' ? 2 : null);
      const { app, bus, bobTok } = setup(() => [resolver]);
      const out = await streamAfter(app, bobTok, () => { bus.publish(signal); });
      expect(out).not.toContain('"type":"signal"');
    });

    it('fail CLOSED without the plugin: unresolved signal/plan events are admin-only', async () => {
      const { app, bus, bobTok, adminTok } = setup();
      const forBob = await streamAfter(app, bobTok, () => { bus.publish(signal); bus.publish({ type: 'plan', jobId: 'pj-1', status: 'planning' } as ElowenEvent); });
      expect(forBob).not.toContain('"type":"signal"');
      expect(forBob).not.toContain('"type":"plan"');
      const forAdmin = await streamAfter(app, adminTok, () => { bus.publish(signal); });
      expect(forAdmin).toContain('"type":"signal"');
    });
  });

  // A memory nudge is scoped by OWNER, not by project — memories are private per user, and the project
  // gate would either withhold it from every tenant (it resolves to no project) or hand it to any admin.
  describe('memory recall nudges', () => {
    it('reaches the owner even though the event has no project', async () => {
      const { app, bus, bob, bobTok } = setup();
      const out = await streamAfter(app, bobTok, () => { bus.publish({ type: 'memory', userId: bob.id }); });
      expect(out).toContain('"type":"memory"');
    });

    it('is withheld from everyone else, admin included', async () => {
      const { app, bus, bob, adminTok } = setup();
      const out = await streamAfter(app, adminTok, () => { bus.publish({ type: 'memory', userId: bob.id }); });
      expect(out).not.toContain('"type":"memory"');
    });
  });
});
