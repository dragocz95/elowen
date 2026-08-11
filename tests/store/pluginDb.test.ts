import { describe, it, expect, vi } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { makePluginDb } from '../../src/store/pluginDb.js';
import { PluginRegistry } from '../../src/plugins/registry.js';

const noopLog = { info() {}, warn() {}, error() {} };

describe('makePluginDb', () => {
  it('applies ordered migrations exactly once and records bookkeeping', () => {
    const db = openDb(':memory:');
    const pdb = makePluginDb(db, 'demo', { canMigrate: true });
    expect(pdb.appliedVersion()).toBe(0);
    const steps = [
      { version: 2, up: (h: { exec(sql: string): void }) => h.exec('ALTER TABLE p_demo_items ADD COLUMN note TEXT') },
      { version: 1, up: (h: { exec(sql: string): void }) => h.exec('CREATE TABLE p_demo_items (id INTEGER PRIMARY KEY, name TEXT)') },
    ];
    pdb.migrate(steps); // out-of-order input must apply sorted (v1 creates the table v2 alters)
    expect(pdb.appliedVersion()).toBe(2);
    pdb.prepare('INSERT INTO p_demo_items (name, note) VALUES (?, ?)').run('a', 'n');
    expect(pdb.prepare('SELECT COUNT(*) AS c FROM p_demo_items').get()).toEqual({ c: 1 });
    // Re-running the same steps is a no-op — a second application of v1 would throw (table exists).
    pdb.migrate(steps);
    expect(pdb.appliedVersion()).toBe(2);
  });

  it('a failing step applies NEITHER the step nor its bookkeeping row (one transaction)', () => {
    const db = openDb(':memory:');
    const pdb = makePluginDb(db, 'demo', { canMigrate: true });
    expect(() => pdb.migrate([{
      version: 1,
      up: (h) => { h.exec('CREATE TABLE p_demo_x (id INTEGER)'); throw new Error('boom mid-step'); },
    }])).toThrow('boom mid-step');
    expect(pdb.appliedVersion()).toBe(0);
    // The half-done DDL rolled back with the transaction, so a fixed v1 can re-create the table.
    pdb.migrate([{ version: 1, up: (h) => h.exec('CREATE TABLE p_demo_x (id INTEGER)') }]);
    expect(pdb.appliedVersion()).toBe(1);
  });

  it('bookkeeping is namespaced per plugin', () => {
    const db = openDb(':memory:');
    const a = makePluginDb(db, 'a', { canMigrate: true });
    const b = makePluginDb(db, 'b', { canMigrate: true });
    a.migrate([{ version: 3, up: () => {} }]);
    expect(a.appliedVersion()).toBe(3);
    expect(b.appliedVersion()).toBe(0);
  });

  it('refuses a non-positive version and skips migrations in a non-daemon process', () => {
    const db = openDb(':memory:');
    const pdb = makePluginDb(db, 'demo', { canMigrate: true });
    expect(() => pdb.migrate([{ version: 0, up: () => {} }])).toThrow('positive integer');
    const runnerDb = makePluginDb(db, 'demo', { canMigrate: false });
    runnerDb.migrate([{ version: 1, up: () => { throw new Error('must not run'); } }]);
    expect(runnerDb.appliedVersion()).toBe(0);
  });
});

describe('ctx.db() capability gate', () => {
  it('throws without reads:[db] and resolves the namespaced handle with it', () => {
    const db = openDb(':memory:');
    const reg = new PluginRegistry();
    const wire = (caps?: { reads?: string[] }) => reg.contextFor(
      'demo', {}, noopLog, undefined, undefined, undefined, undefined, caps, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined,
      (plugin) => makePluginDb(db, plugin, { canMigrate: true }),
    );
    expect(() => wire().db()).toThrow("reads:['db']");
    expect(() => wire({ reads: ['db'] }).db().appliedVersion()).not.toThrow();
  });

  it('without a wired factory the grant still refuses cleanly', () => {
    const reg = new PluginRegistry();
    const ctx = reg.contextFor('demo', {}, noopLog, undefined, undefined, undefined, undefined, { reads: ['db'] });
    expect(() => ctx.db()).toThrow('no database wired');
    vi.restoreAllMocks();
  });
});
