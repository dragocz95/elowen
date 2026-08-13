import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { buildApp } from '../../src/daemon/bootstrap.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { dbWithPlugins } from '../helpers/bootstrapDb.js';

describe('bootstrap reasoning wiring', () => {
  it('constructs with the pilot/overseer reasoning backends and exposes startLoops', async () => {
    const tmux = new FakeTmuxDriver();
    const built = await buildApp({ dbPath: ':memory:', project: { id: 1, slug: 'p', path: '/tmp' }, relay: null, tmux, bootstrap: { username: 'a', password: 'b' } });
    expect(typeof built.startLoops).toBe('function');
  });

  it('serves the new plan-job and overseer routes (relay path, no agent backends configured)', async () => {
    const tmux = new FakeTmuxDriver();
    // These are the agents plugin's root mounts, and a fresh install no longer enables it — so this
    // boots against a database whose owner installed it (plus `work`, which the mission subsystem
    // stands on), which is the state the routes exist in at all.
    const { dbPath, cleanup } = dbWithPlugins(['agents', 'work']);
    try {
      const { app } = await buildApp({ dbPath, project: { id: 1, slug: 'p', path: '/tmp' }, relay: null, tmux, allowOpen: true, pluginDirs: [join(process.cwd(), 'plugins')] });
      // Overseer long-poll heartbeat: nothing pending → {} (short timeout so the test doesn't block).
      const next = await app.request('/missions/m-x/overseer/next?timeoutMs=20');
      expect(next.status).toBe(200);
      expect(await next.json()).toEqual({});
      // An unknown plan job is a 404 (the route exists and is wired to the job store).
      expect((await app.request('/plan/pj-nope')).status).toBe(404);
    } finally { cleanup(); }
  });
});
