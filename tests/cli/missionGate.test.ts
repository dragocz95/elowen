import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { hasLiveMission } from '../../src/cli/missionGate.js';
import { openDb } from '../../src/store/db.js';

// The gate runs in a separate CLI process against the daemon's real DB file, so these tests use real
// tmp files, not :memory:. It guards the self-update restart from killing a running mission — the
// broken-schema case is the one that matters: an unreadable live set must fail CLOSED (true).
const dirs: string[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'elowen-gate-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const envFor = (dbFile: string): NodeJS.ProcessEnv => ({ ELOWEN_DB: dbFile });

describe('hasLiveMission (self-update / setup gate)', () => {
  it('no DB file → false, and the gate does not create one', () => {
    const file = join(tmp(), 'elowen.db');
    expect(hasLiveMission(envFor(file))).toBe(false);
    expect(existsSync(file)).toBe(false); // a wrongly-owned DB left behind would break the daemon's boot
  });

  it('DB without a missions table → false', () => {
    // A raw SQLite file (no daemon schema): the table genuinely does not exist, which is the one
    // error that PROVES no mission has ever run.
    const file = join(tmp(), 'elowen.db');
    new Database(file).close();
    expect(hasLiveMission(envFor(file))).toBe(false);
  });

  it('missions table with no live rows → false; a live mission → true', () => {
    const file = join(tmp(), 'elowen.db');
    const db = openDb(file); // real daemon schema
    db.prepare("INSERT INTO missions (id, epic_id, autonomy, state) VALUES ('m-done', 'e0', 'L1', 'completed')").run();
    db.close();
    expect(hasLiveMission(envFor(file))).toBe(false);

    const db2 = new Database(file);
    db2.prepare("INSERT INTO missions (id, epic_id, autonomy, state) VALUES ('m-live', 'e1', 'L1', 'active')").run();
    db2.close();
    expect(hasLiveMission(envFor(file))).toBe(true);
  });

  it('BROKEN schema (missions exists but the query fails) → true, fail closed', () => {
    // A `missions` table without the `state` column: the count query throws "no such column", which is
    // NOT proof that no mission is live. The old blanket catch returned false here — the one path in
    // the audit that could let a restart kill a running mission.
    const file = join(tmp(), 'elowen.db');
    const db = new Database(file);
    db.exec('CREATE TABLE missions (id TEXT PRIMARY KEY)');
    db.close();
    expect(hasLiveMission(envFor(file))).toBe(true);
  });
});
