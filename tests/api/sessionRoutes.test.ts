import { describe, it, expect } from 'vitest';
import { makeTestApp } from '../helpers/testApp.js';

const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const post = (t: string, body: unknown) => ({ method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** Launch a worker on a fresh open task and return its live session name. */
async function launch(app: Awaited<ReturnType<typeof makeTestApp>>['app'], token: string, deps: Awaited<ReturnType<typeof makeTestApp>>['deps'], id: string) {
  deps.tasks.create({ id, project_id: 1, title: 'T', type: 'task', description: 'work' });
  const res = await app.request('/sessions', post(token, { taskId: id }));
  expect(res.status).toBe(201);
  return (await res.json() as { session: string }).session;
}

describe('session control routes', () => {
  it('POST /sessions/:name/keys forwards validated tokens to tmux', async () => {
    const { app, token, deps } = await makeTestApp({});
    const session = await launch(app, token, deps, 'orca-k');
    const res = await app.request(`/sessions/${session}/keys`, post(token, { keys: ['C-c', 'Enter'] }));
    expect(res.status).toBe(200);
    expect(deps.tmux.sentKeys(session)).toContainEqual(['C-c', 'Enter']);
  });

  it('POST /sessions/:name/input forwards raw bytes to the pane', async () => {
    const { app, token, deps } = await makeTestApp({});
    const session = await launch(app, token, deps, 'orca-i');
    const res = await app.request(`/sessions/${session}/input`, post(token, { data: 'ls -la\n' }));
    expect(res.status).toBe(200);
    expect(deps.tmux.sentRaw(session)).toContain('ls -la\n');
  });

  it('POST /sessions/:name/resize records the new dimensions', async () => {
    const { app, token, deps } = await makeTestApp({});
    const session = await launch(app, token, deps, 'orca-r');
    const res = await app.request(`/sessions/${session}/resize`, post(token, { cols: 120, rows: 40 }));
    expect(res.status).toBe(200);
    expect(deps.tmux.sizeFor(session)).toEqual({ cols: 120, rows: 40 });
    // A non-numeric dimension is rejected by the schema.
    expect((await app.request(`/sessions/${session}/resize`, post(token, { cols: '120' }))).status).toBe(400);
  });

  it('GET /sessions/:name/pane captures the current pane', async () => {
    const { app, token, deps } = await makeTestApp({});
    const session = await launch(app, token, deps, 'orca-p');
    deps.tmux.setPane(session, 'hello from the pane');
    const res = await app.request(`/sessions/${session}/pane`, auth(token));
    expect(res.status).toBe(200);
    expect((await res.json()).pane).toBe('hello from the pane');
  });

  it('DELETE /sessions/:name kills a live agent session', async () => {
    const { app, token, deps } = await makeTestApp({});
    const session = await launch(app, token, deps, 'orca-d');
    expect(await deps.tmux.list()).toContain(session);
    const res = await app.request(`/sessions/${session}`, { method: 'DELETE', ...auth(token) });
    expect(res.status).toBe(200);
    expect(await deps.tmux.list()).not.toContain(session);
  });

  it('rejects flag-injection keys with a 400 and sends nothing', async () => {
    const { app, token, deps } = await makeTestApp({});
    const session = await launch(app, token, deps, 'orca-f');
    expect((await app.request(`/sessions/${session}/keys`, post(token, { keys: ['-t', 'other', 'C-c'] }))).status).toBe(400);
    expect((await app.request(`/sessions/${session}/keys`, post(token, { keys: [] }))).status).toBe(400);
    expect(deps.tmux.sentKeys(session)).toEqual([]);
  });
});
