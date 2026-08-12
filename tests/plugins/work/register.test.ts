import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { openDb } from '../../../src/store/db.js';
import { makePluginDb } from '../../../src/store/pluginDb.js';
import { loadPlugins } from '../../../src/plugins/loader.js';

/** Load the REAL on-disk work plugin (plugins/work → dist/index.js, so `npx tsc -p
 *  tsconfig.plugins.work.json` must have built it) against a bare host. The point of this test is that
 *  the task domain exists ONLY because a plugin registered it: nothing here wires a task store. */
async function loadWorkPlugin(enabled: string[]) {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const registry = await loadPlugins({
    dirs: [join(process.cwd(), 'plugins')],
    enabled,
    delegatedTurnsOutOfProcess: () => false,
    pluginDb: (plugin) => makePluginDb(db, plugin, { canMigrate: true }),
    publishEvent: () => { /* unused here */ },
    subscribeEvents: () => { /* unused here */ },
    host: {} as never,
    logger: { info() {}, warn() {}, error() {} },
  });
  return { registry, db };
}

describe('work plugin registration', () => {
  it('owns the task domain: the `tasks` control serves rows the daemon never constructed a store for', async () => {
    const { registry, db } = await loadWorkPlugin(['work']);
    try {
      const tasks = registry.control('tasks');
      expect(tasks).toBeDefined();
      const store = tasks!.store();
      const created = store.create({ id: 'w-reg-1', project_id: 1, title: 'From the plugin' });
      expect(created.title).toBe('From the plugin');
      // It really is the shared main database — the row is visible to the daemon's own SQL.
      const row = db.prepare('SELECT title FROM tasks WHERE id = ?').get('w-reg-1') as { title: string };
      expect(row.title).toBe('From the plugin');
      expect(tasks!.readiness().ready(1).map((t) => t.id)).toEqual(['w-reg-1']);
      expect(tasks!.usage().get('w-reg-1')).toBeNull();
      // Its migrations ran under its own bookkeeping namespace, not core's.
      const applied = db.prepare("SELECT MAX(version) v FROM plugin_migrations WHERE plugin = 'work'").get() as { v: number };
      expect(applied.v).toBe(2);
    } finally { db.close(); }
  });

  it('leaves the domain unowned when it is disabled — no other plugin claims `tasks`', async () => {
    const { registry, db } = await loadWorkPlugin(['files', 'terminal', 'skills']);
    try {
      expect(registry.tools.length).toBeGreaterThan(0); // the generation really loaded plugins
      expect(registry.control('tasks')).toBeUndefined();
    } finally { db.close(); }
  });
});
