import { describe, it, expect } from 'vitest';
import { buildApp } from '../../src/daemon/bootstrap.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';

describe('bootstrap reasoning wiring', () => {
  it('constructs with the pilot/overseer reasoning backends and exposes startLoops', () => {
    const tmux = new FakeTmuxDriver();
    const built = buildApp({ dbPath: ':memory:', project: { id: 1, slug: 'p', path: '/tmp' }, relay: null, tmux, bootstrap: { username: 'a', password: 'b' } });
    expect(typeof built.startLoops).toBe('function');
  });

  it('serves the new plan-job and overseer routes (relay path, no agent backends configured)', async () => {
    const tmux = new FakeTmuxDriver();
    const { app } = buildApp({ dbPath: ':memory:', project: { id: 1, slug: 'p', path: '/tmp' }, relay: null, tmux, allowOpen: true });
    // Overseer long-poll heartbeat: nothing pending → {} (short timeout so the test doesn't block).
    const next = await app.request('/missions/m-x/overseer/next?timeoutMs=20');
    expect(next.status).toBe(200);
    expect(await next.json()).toEqual({});
    // An unknown plan job is a 404 (the route exists and is wired to the job store).
    expect((await app.request('/plan/pj-nope')).status).toBe(404);
  });
});
