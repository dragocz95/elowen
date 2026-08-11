import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { Readiness } from '../../src/store/readiness.js';
import { MissionStore } from '../../plugins/agents/src/store/missionStore.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { createTicketStore } from '../../src/terminal/ticketStore.js';

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw'); // id 1, is_admin
  const amy = users.create('amy', 'pw');      // id 2
  const config = new ConfigStore(db);
  const tickets = createTicketStore();
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux: new FakeTmuxDriver() as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config, users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
    tickets,
  });
  return { app, tickets, adminTok: users.issueToken(admin.id), amyTok: users.issueToken(amy.id), amyId: amy.id };
}
const post = (t: string) => ({ method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: '{}' });

describe('POST /sessions/:name/ws-ticket', () => {
  it('issues a ticket for the caller\'s own advisor session', async () => {
    const { app, amyTok, amyId } = setup();
    const res = await app.request(`/sessions/elowen-advisor-${amyId}/ws-ticket`, post(amyTok));
    expect(res.status).toBe(200);
    expect((await res.json() as { ticket: string }).ticket).toMatch(/^[a-f0-9]+$/);
  });

  it('forbids another user\'s advisor session', async () => {
    const { app, amyTok } = setup();
    const res = await app.request('/sessions/elowen-advisor-1/ws-ticket', post(amyTok)); // admin's advisor
    expect(res.status).toBe(403);
  });

  it('binds the ticket to the requested session', async () => {
    const { app, tickets, amyTok, amyId } = setup();
    const res = await app.request(`/sessions/elowen-advisor-${amyId}/ws-ticket`, post(amyTok));
    const { ticket } = await res.json() as { ticket: string };
    expect(tickets.consume(ticket)).toMatchObject({ session: `elowen-advisor-${amyId}`, userId: amyId });
  });

  it('lets an admin open any session (e.g. a worker)', async () => {
    const { app, tickets, adminTok } = setup();
    const res = await app.request('/sessions/elowen-worker1/ws-ticket', post(adminTok));
    expect(res.status).toBe(200);
    const { ticket } = await res.json() as { ticket: string };
    expect(tickets.consume(ticket)).toMatchObject({ session: 'elowen-worker1' });
  });
});
