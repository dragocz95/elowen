import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { openDb, withWriteLock, type Db } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { makePluginDb } from '../../src/store/pluginDb.js';

const sqlite = createRequire(import.meta.url).resolve('better-sqlite3');
const cleanup: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) close(); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'elowen-request-lock-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'test.db');
  const db = openDb(path);
  cleanup.push(() => db.close());
  db.exec('CREATE TABLE contention (n INTEGER); INSERT INTO contention VALUES (0)');
  const brain = new BrainStore(db);
  brain.createSession({ id: 's1', userId: 1, model: 'm' });
  const start = () => brain.providerRequests.start({
    sessionId: 's1', turnId: 'turn:1', kind: 'chat', configuredProvider: 'p',
    wireProvider: 'p', api: 'a', model: 'm', payload: { messages: [{ role: 'user', content: 'hello' }] },
  });
  return { db, path, requests: brain.providerRequests, start };
}

// A real second process tries to commit exactly AFTER the first read. In the deferred mutation it
// succeeds, invalidating our snapshot; with IMMEDIATE it cannot pass the already-owned writer lock.
function commitAfterRead(db: Db, path: string, match: RegExp, method: 'get' | 'all' = 'get') {
  const prepare = db.prepare.bind(db);
  let attempted = false;
  let result = '';
  vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
    const stmt = prepare(sql);
    if (!attempted && match.test(sql)) {
      const read = stmt[method].bind(stmt);
      vi.spyOn(stmt, method).mockImplementation((...args: unknown[]) => {
        const row = read(...args);
        if (!attempted) {
          attempted = true;
          const child = spawnSync(process.execPath, ['-e', `
            const Database = require(${JSON.stringify(sqlite)});
            const db = new Database(process.argv[1], { timeout: 0 });
            try { db.exec('UPDATE contention SET n = n + 1'); console.log('committed'); }
            catch (e) { console.log(e.code); }
            finally { db.close(); }
          `, path], { encoding: 'utf8', timeout: 3000 });
          expect(child.error).toBeUndefined();
          expect(child.status).toBe(0);
          result = child.stdout.trim();
        }
        return row;
      });
    }
    return stmt;
  });
  return () => { expect(attempted).toBe(true); expect(result).toBe('SQLITE_BUSY'); };
}

describe('cross-process provider request writes', () => {
  it.each(['start', 'finish', 'attachResponse', 'interruptPending', 'pruneDiagnostics'] as const)(
    '%s owns the writer lock before reading', (operation) => {
      const { db, path, requests, start } = fixture();
      const request = operation === 'start' ? undefined : start();
      if (operation === 'pruneDiagnostics') requests.finish({ requestId: request!.requestId, status: 'succeeded' });
      const pattern = operation === 'start' ? /SELECT request_id FROM brain_provider_requests/
        : operation === 'finish' ? /SELECT r.request_id/
          : operation === 'attachResponse' ? /SELECT session_id, response_segment/
            : operation === 'interruptPending' ? /SELECT request_id FROM brain_provider_requests/
              : /SELECT summary.session_id/;
      const check = commitAfterRead(db, path, pattern,
        operation === 'interruptPending' || operation === 'pruneDiagnostics' ? 'all' : 'get');
      if (operation === 'start') expect(start().seq).toBe(1);
      else if (operation === 'finish') expect(requests.finish({ requestId: request!.requestId, status: 'succeeded' })).toBe(true);
      else if (operation === 'attachResponse') requests.attachResponse(request!.requestId, { text: 'done' });
      else if (operation === 'interruptPending') expect(requests.interruptPending({ errorCode: 'test', errorMessage: 'test' })).toEqual([request!.requestId]);
      else expect(requests.pruneDiagnostics(Date.now() + 1000, 0).sessions).toBe(1);
      check();
    },
  );

  it('plugin transactions share the same immediate write discipline, including nested calls', () => {
    const { db, path } = fixture();
    const plugin = makePluginDb(db, 'test', { canMigrate: false });
    const check = commitAfterRead(db, path, /SELECT n FROM contention/);
    plugin.transaction(() => {
      const row = plugin.prepare('SELECT n FROM contention').get() as { n: number };
      plugin.transaction(() => plugin.prepare('UPDATE contention SET n = ?').run(row.n + 1));
    });
    check();
    expect(db.prepare('SELECT n FROM contention').get()).toEqual({ n: 1 });
  });

  it('proves a deferred snapshot upgrade ignores a five-second timeout', () => {
    const { db, path } = fixture();
    const other = openDb(path, { migrate: false });
    try {
      db.exec('BEGIN');
      db.prepare('SELECT n FROM contention').get();
      other.exec('UPDATE contention SET n = n + 1');
      const began = performance.now();
      expect(() => db.exec('UPDATE contention SET n = n + 1')).toThrowError(expect.objectContaining({ code: 'SQLITE_BUSY_SNAPSHOT' }));
      expect(performance.now() - began).toBeLessThan(1000);
    } finally { db.exec('ROLLBACK'); other.close(); }
  });

  it('waits for an independently released writer with timeout, but zero timeout fails', async () => {
    const { db, path } = fixture();
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    const child = spawn(process.execPath, ['-e', `
      const Database = require(${JSON.stringify(sqlite)});
      const db = new Database(process.argv[1]);
      db.exec('BEGIN IMMEDIATE; UPDATE contention SET n = n + 1');
      console.log('locked');
      setTimeout(() => { db.exec('COMMIT'); db.close(); }, 350);
    `, path], { stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = once(child, 'close');
    try {
      const [ready] = await once(child.stdout!, 'data');
      expect(String(ready).trim()).toBe('locked');
      db.pragma('busy_timeout = 0');
      expect(() => db.exec('BEGIN IMMEDIATE')).toThrowError(expect.objectContaining({ code: 'SQLITE_BUSY' }));
      db.pragma('busy_timeout = 5000');
      withWriteLock(db, () => db.exec('UPDATE contention SET n = n + 1'));
      expect(db.prepare('SELECT n FROM contention').get()).toEqual({ n: 2 });
      expect((await closed)[0]).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill();
      await closed;
    }
  });
});
