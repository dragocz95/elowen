import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../src/daemon/bootstrap.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { openDb } from '../../src/store/db.js';
import { ConfigStore } from '../../src/store/configStore.js';

/** Activity-log retention (Elowen AI → Runtime). The hourly purge used to call `purgeOlderThan()` with no
 *  argument, so the 30-day window was hardcoded at the call site and no setting could reach it. The boot
 *  runs one purge immediately, which is what these drive. */
const dirs: string[] = [];
const allDirs = new Set<string>();
afterEach(() => {
  const created = dirs.splice(0);
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
  expect(created.filter(existsSync), 'event-retention tests left temporary directories behind').toEqual([]);
});
afterAll(async () => {
  // Bootstrap used to race teardown: its unawaited marketplace clone recreated removed paths shortly later.
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect([...allDirs].filter(existsSync), 'event-retention suite recreated temporary directories after cleanup').toEqual([]);
});

/** A database holding one event aged `ageDays` days, with the retention window set to `retentionDays`
 *  (omitted → the stored default). Returns the db path so bootstrap can open the same file. */
function seedDb(ageDays: number, retentionDays?: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'elowen-event-retention-'));
  dirs.push(dir);
  allDirs.add(dir);
  const dbPath = join(dir, 'elowen.db');
  const db = openDb(dbPath);
  const config = new ConfigStore(db);
  // This test exercises the event sweep only. Leaving the default enabled plugins in place starts an
  // asynchronous marketplace reconcile, which can recreate this directory after the test removes it.
  config.update({ plugins: { enabled: [] } });
  if (retentionDays !== undefined) {
    config.update({ runtime: { limits: { eventRetentionDays: retentionDays } } });
  }
  db.prepare(`INSERT INTO events (type, target, detail, ts) VALUES ('task', 't-1', 'done', datetime('now', '-${ageDays} days'))`).run();
  db.close();
  return dbPath;
}

/** Boot the daemon and run its startup sweeps (the purge fires once immediately), then stop every loop
 *  again so no interval outlives the test. */
async function bootAndCountEvents(dbPath: string): Promise<number> {
  const built = await buildApp({ dbPath, tmux: new FakeTmuxDriver(), project: { id: 1, slug: 'elowen', path: '/o' }, relay: null, allowOpen: true, pluginDirs: [join(process.cwd(), 'plugins')] });
  const stopLoops = built.startLoops();
  stopLoops();
  const db = openDb(dbPath);
  try { return (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n; }
  finally { db.close(); }
}

describe('activity-log retention', () => {
  it('purges an event older than the CONFIGURED window', async () => {
    expect(await bootAndCountEvents(seedDb(10, 7))).toBe(0);
  });

  it('keeps an event inside the configured window that the 30-day default would also have kept', async () => {
    expect(await bootAndCountEvents(seedDb(3, 7))).toBe(1);
  });

  // The discriminating pair: 20 days is INSIDE the hardcoded 30-day window but OUTSIDE a configured 7-day
  // one, and 60 days is outside both — so only a purge that actually reads the setting passes both.
  it('purges at 20 days when the operator shortened the window to 7', async () => {
    expect(await bootAndCountEvents(seedDb(20, 7))).toBe(0);
  });

  it('keeps a 60-day-old event once the operator widened the window to 365', async () => {
    expect(await bootAndCountEvents(seedDb(60, 365))).toBe(1);
  });

  it('unconfigured, the default window still drops a 60-day-old event and keeps a 10-day-old one', async () => {
    expect(await bootAndCountEvents(seedDb(60))).toBe(0);
    expect(await bootAndCountEvents(seedDb(10))).toBe(1);
  });
});
