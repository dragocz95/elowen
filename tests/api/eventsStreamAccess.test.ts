import { describe, it, expect } from 'vitest';
import { EventBus, type ElowenEvent } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { openDb } from '../../src/store/db.js';

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'home','/o')").run();
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (2,'other','/p2')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw');
  const bob = users.create('bob', 'pw');
  const userProjects = new UserProjectStore(db);
  userProjects.assign(bob.id, 1);
  const bus = new EventBus();
  const app = createServer({
    bus, project: { id: 1, path: '/o' }, clock: new FakeClock(0), config: new ConfigStore(db),
    users, projects: new ProjectStore(db), userProjects,
  });
  return { app, bus, admin, bob, adminTok: users.issueToken(admin.id), bobTok: users.issueToken(bob.id) };
}
const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });

async function streamAfter(app: ReturnType<typeof setup>['app'], tok: string, publish: () => void): Promise<string> {
  const res = await app.request('/events', auth(tok));
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  await reader.read();
  publish();
  let buf = '';
  for (let i = 0; i < 4; i++) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: boolean }>((resolve) => setTimeout(() => resolve({ value: undefined, done: true }), 60)),
    ]);
    if (chunk.done) break;
    if (chunk.value) buf += dec.decode(chunk.value);
  }
  await reader.cancel();
  return buf;
}

describe('GET /events tenancy filtering', () => {
  const home: ElowenEvent = { type: 'plugin', plugin: 'demo', kind: 'home', projectId: 1, data: null };
  const foreign: ElowenEvent = { type: 'plugin', plugin: 'demo', kind: 'foreign', projectId: 2, data: null };

  it('streams a non-admin only their projects\' events', async () => {
    const { app, bus, bobTok } = setup();
    const out = await streamAfter(app, bobTok, () => { bus.publish(foreign); bus.publish(home); });
    expect(out).toContain('"kind":"home"');
    expect(out).not.toContain('"kind":"foreign"');
  });

  it('streams an admin every event', async () => {
    const { app, bus, adminTok } = setup();
    const out = await streamAfter(app, adminTok, () => { bus.publish(foreign); bus.publish(home); });
    expect(out).toContain('"kind":"home"');
    expect(out).toContain('"kind":"foreign"');
  });

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
