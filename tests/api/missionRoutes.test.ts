import { describe, it, expect } from 'vitest';
import { makeTestApp } from '../helpers/testApp.js';

const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const post = (t: string, body: unknown) => ({ method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('mission lifecycle routes', () => {
  it('POST /missions engages an epic and it shows up active; DELETE disengages it', async () => {
    const { app, token, deps } = await makeTestApp({});
    // An epic with a single open phase, but no mission yet — the route must create one.
    const epic = deps.tasks.create({ id: 'orca-E', project_id: 1, title: 'Epic', type: 'epic', description: 'do the thing' });
    deps.tasks.create({ id: 'orca-E1', project_id: 1, title: 'Phase 1', type: 'task', parent_id: epic.id, description: 'p1' });

    const engaged = await app.request('/missions', post(token, { epicId: epic.id, autonomy: 'L3', maxSessions: 1 }));
    expect(engaged.status).toBe(201);
    expect(deps.missions.get(`m-${epic.id}`)?.state).toBe('active');

    const listed = await (await app.request('/missions', auth(token))).json() as { id: string }[];
    expect(listed.map((m) => m.id)).toContain(`m-${epic.id}`);

    const gone = await app.request(`/missions/m-${epic.id}`, { method: 'DELETE', ...auth(token) });
    expect(gone.status).toBe(200);
    const after = await (await app.request('/missions', auth(token))).json() as { id: string }[];
    expect(after.map((m) => m.id)).not.toContain(`m-${epic.id}`);
  });

  it('POST /missions rejects a missing epicId (400) and an unknown epic (404)', async () => {
    const { app, token } = await makeTestApp({});
    expect((await app.request('/missions', post(token, {}))).status).toBe(400);
    expect((await app.request('/missions', post(token, { epicId: 'nope' }))).status).toBe(404);
  });

  it('PATCH /missions/:id pause/resume drives the engine; GET /missions/:id returns detail', async () => {
    const { app, token, deps } = await makeTestApp({});
    const { missionId, epicId } = deps.seedMissionWithChild();

    const detail = await app.request(`/missions/${missionId}`, auth(token));
    expect(detail.status).toBe(200);
    expect((await detail.json()).epic.id).toBe(epicId);

    const paused = await app.request(`/missions/${missionId}`, { method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'pause' }) });
    expect(paused.status).toBe(200);
    expect(deps.missions.get(missionId)?.state).toBe('paused');

    await app.request(`/missions/${missionId}`, { method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'resume' }) });
    expect(deps.missions.get(missionId)?.state).toBe('active');
  });

  it('GET /missions/:id is 404 for an unknown mission', async () => {
    const { app, token } = await makeTestApp({});
    expect((await app.request('/missions/m-nope', auth(token))).status).toBe(404);
  });
});
