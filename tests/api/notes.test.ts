import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { NoteStore } from '../../plugins/agents/src/store/noteStore.js';
import { Readiness } from '../../src/store/readiness.js';
import { MissionStore } from '../../plugins/agents/src/store/missionStore.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';

// Two projects; bob is assigned to #1 only. An agent token is confined to its live working set, so we
// seed an in_progress agent task in project 1 to put project 1 (and its epic e1) in the agent's reach.
function setup(withNotes = true) {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'home','/o')").run();
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (2,'other','/p2')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw');
  const bob = users.create('bob', 'pw');
  const userProjects = new UserProjectStore(db);
  userProjects.assign(bob.id, 1);
  const tasks = new TaskStore(db);
  tasks.create({ id: 'e1', project_id: 1, title: 'E1', type: 'epic' });
  tasks.create({ id: 'e2', project_id: 2, title: 'E2', type: 'epic' });
  tasks.create({ id: 'w1', project_id: 1, title: 'W1', parent_id: 'e1' });
  tasks.setAgent('w1', 'Nova'); tasks.setStatus('w1', 'in_progress'); // puts project 1 in the agent working set
  const notes = withNotes ? new NoteStore(db) : undefined;
  const app = createServer({
    tasks, readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux: null as never,
    notes,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db),
    users, projects: new ProjectStore(db), userProjects,
  });
  return { app, tasks, notes, adminTok: users.issueToken(admin.id), bobTok: users.issueToken(bob.id), agentTok: users.issueToken(admin.id, 'agent') };
}
const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const post = (t: string, body: unknown) => ({ method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('handoff notes API', () => {
  it('an agent in the working set can post and read a mission note', async () => {
    const { app, agentTok } = setup();
    const created = await app.request('/notes', post(agentTok, { target: 'e1', body: 'set up X' }));
    expect(created.status).toBe(201);
    const list = await (await app.request('/notes?scope=mission&target=e1', auth(agentTok))).json() as { body: string }[];
    expect(list.map((n) => n.body)).toEqual(['set up X']);
  });

  it('strips a leading m- so mission-id and epic-id targets converge', async () => {
    const { app, agentTok } = setup();
    await app.request('/notes', post(agentTok, { target: 'm-e1', body: 'note' }));
    const list = await (await app.request('/notes?scope=mission&target=e1', auth(agentTok))).json() as { body: string }[];
    expect(list.map((n) => n.body)).toEqual(['note']);
  });

  it('rejects a note for an epic outside the agent working set', async () => {
    const { app, agentTok } = setup();
    expect((await app.request('/notes', post(agentTok, { target: 'e2', body: 'x' }))).status).toBe(403);
  });

  it('rejects an empty body (400) and an unknown target (404)', async () => {
    const { app, agentTok, adminTok } = setup();
    expect((await app.request('/notes', post(agentTok, { target: 'e1', body: '  ' }))).status).toBe(400);
    expect((await app.request('/notes', post(adminTok, { target: 'nope', body: 'x' }))).status).toBe(404);
  });

  it('gates reads by the target epic project: bob sees #1, not #2; admin sees both', async () => {
    const { app, adminTok, bobTok } = setup();
    await app.request('/notes', post(adminTok, { target: 'e2', body: 'secret' }));
    expect((await app.request('/notes?scope=mission&target=e2', auth(bobTok))).status).toBe(403);
    expect((await app.request('/notes?scope=mission&target=e2', auth(adminTok))).status).toBe(200);
  });

  it('degrades to [] when the notes store is absent', async () => {
    const { app, adminTok } = setup(false);
    expect(await (await app.request('/notes?scope=mission&target=e1', auth(adminTok))).json()).toEqual([]);
  });

  it('GET fails closed on an unknown target (404) — never lists notes for an unresolved target', async () => {
    const { app, adminTok } = setup();
    expect((await app.request('/notes?scope=mission&target=nope', auth(adminTok))).status).toBe(404);
  });

  it('does not fail open on orphaned notes whose epic was deleted (cross-tenant safe)', async () => {
    const { app, adminTok, agentTok, notes } = setup();
    // A note written under a non-default scope would survive a scope-specific purge — write one, then
    // delete the epic. The reader must still refuse it (target no longer resolves), and the purge is
    // scope-wide so nothing lingers in storage either.
    await app.request('/notes', post(agentTok, { target: 'e1', body: 'set up X' }));
    notes!.add({ scope: 'custom', target: 'e1', body: 'orphan secret' });
    await app.request('/tasks/e1?subtree=1', { method: 'DELETE', headers: { authorization: `Bearer ${adminTok}` } });
    expect((await app.request('/notes?scope=custom&target=e1', auth(adminTok))).status).toBe(404);
    expect(notes!.list('custom', 'e1')).toEqual([]); // purged across all scopes, not just 'mission'
  });

  it('rejects an over-long note body (400)', async () => {
    const { app, agentTok } = setup();
    const huge = 'x'.repeat(8001);
    expect((await app.request('/notes', post(agentTok, { target: 'e1', body: huge }))).status).toBe(400);
  });

  it('caps the number of notes per target (429)', async () => {
    const { app, agentTok, notes } = setup();
    for (let i = 0; i < 200; i++) notes!.add({ scope: 'mission', target: 'e1', body: `n${i}` });
    expect((await app.request('/notes', post(agentTok, { target: 'e1', body: 'one too many' }))).status).toBe(429);
  });

  it('does not strip m- when the remainder is not an epic (guards a project whose basename is m)', async () => {
    const { app, adminTok, tasks } = setup();
    tasks.create({ id: 'm-abc', project_id: 1, title: 'M', type: 'epic' }); // epic literally 'm-<hex>'
    await app.request('/notes', post(adminTok, { target: 'm-abc', body: 'kept' }));
    const list = await (await app.request('/notes?scope=mission&target=m-abc', auth(adminTok))).json() as { body: string }[];
    expect(list.map((n) => n.body)).toEqual(['kept']); // a blind m- strip would have missed this
  });
});
