import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../src/daemon/bootstrap.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { openDb } from '../../src/store/db.js';
import { dbWithPlugins } from '../helpers/bootstrapDb.js';

describe('buildApp', () => {
  it('wires a healthy app with an injected tmux fake', async () => {
    // /sessions lives on the agents plugin's root mount now, and a fresh install no longer enables that
    // plugin — so boot against a database whose owner installed it (with `work`, since the mission
    // subsystem stands on task tracking), and point the loader at the repo plugins. /health is core.
    const { dbPath, cleanup } = dbWithPlugins(['agents', 'work']);
    try {
      const { app } = await buildApp({ dbPath, tmux: new FakeTmuxDriver(), project: { id: 1, slug: 'elowen', path: '/o' }, relay: null, allowOpen: true, pluginDirs: [join(process.cwd(), 'plugins')] });
      expect((await app.request('/health')).status).toBe(200);
      expect((await app.request('/sessions')).status).toBe(200);
    } finally { cleanup(); }
  });

  it('a fresh install serves core but answers 503 on a domain plugin\'s root mount (nothing 404s)', async () => {
    // The bare-assistant default: /sessions is still MOUNTED (the daemon knows the route belongs to a
    // plugin) and reports the plugin as inactive, rather than looking like a missing endpoint.
    const { app } = await buildApp({ dbPath: ':memory:', tmux: new FakeTmuxDriver(), project: { id: 1, slug: 'elowen', path: '/o' }, relay: null, allowOpen: true, pluginDirs: [join(process.cwd(), 'plugins')] });
    expect((await app.request('/health')).status).toBe(200);
    expect((await app.request('/sessions')).status).toBe(503);
  });

  it('resolves the daemon home project by path instead of locking id 1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elowen-home-project-'));
    const dbPath = join(dir, 'elowen.db');
    try {
      const db = openDb(dbPath);
      db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/var/www/orca')").run();
      db.prepare("INSERT INTO projects (id,slug,path) VALUES (9,'Elowen','/var/www/elowen')").run();
      db.close();

      const { app } = await buildApp({
        dbPath,
        tmux: new FakeTmuxDriver(),
        project: { id: 1, slug: 'elowen', path: '/var/www/elowen' },
        relay: null,
        bootstrap: { username: 'admin', password: 'pass' },
        allowOpen: true,
      });
      const login = await (await app.request('/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'pass' }),
      })).json() as { token: string };
      const auth = { headers: { authorization: `Bearer ${login.token}` } };

      expect((await app.request('/projects/1', { method: 'DELETE', ...auth })).status).toBe(200);
      expect((await app.request('/projects/9', { method: 'DELETE', ...auth })).status).toBe(400);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
