import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/store/db.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function hashRows(db: Db, sql: string): { count: number; digest: string } {
  const hash = createHash('sha256');
  let count = 0;
  for (const row of db.prepare(sql).iterate() as Iterable<Record<string, unknown>>) {
    count += 1;
    hash.update(JSON.stringify(row));
    hash.update('\n');
  }
  return { count, digest: hash.digest('hex') };
}

describe('usage reset performance guard', () => {
  it('stays bounded with tens of thousands of large provider rows and writes only a small WAL', () => {
    const home = mkdtempSync(join(tmpdir(), 'elowen-usage-reset-perf-'));
    homes.push(home);
    const path = join(home, 'elowen.db');
    const db = openDb(path);
    db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'admin', 'x')").run();
    db.prepare("INSERT INTO brain_sessions (id, user_id, model, provider) VALUES ('s1', 1, 'm', 'p')").run();
    db.prepare(`INSERT INTO brain_messages (id, session_id, role, content)
      VALUES ('m1', 's1', 'assistant', ?)`).run(JSON.stringify({
      role: 'assistant', provider: 'p', model: 'm', timestamp: Date.now(),
      text: 'historical transcript payload'.repeat(8_000), usage: { input: 1, output: 2, totalTokens: 3 },
    }));

    const insert = db.prepare(`INSERT INTO brain_provider_requests
      (request_id, session_id, seq, turn_id, kind, configured_provider, wire_provider, api, model,
       started_at, finished_at, status, canonicalization_version, manifest, response_segment,
       input_tokens, output_tokens, total_tokens, cost_usd, duration_ms)
      VALUES (?, 's1', ?, ?, 'chat', 'p', 'p', 'a', 'm', ?, ?, 'succeeded', 1, ?, ?, 10, 5, 15, 0.01, 20)`);
    const pad = 'x'.repeat(2_048);
    db.transaction(() => {
      for (let i = 1; i <= 30_000; i += 1) {
        insert.run(`r${i}`, i, `turn:${i}`, i, i + 20, JSON.stringify({ version: 1, sequence: i, payload: pad }), JSON.stringify({ digest: pad, sequence: i }));
      }
    })();
    db.prepare(`INSERT INTO brain_request_session_summary
      (session_id, capture_started_at, request_count, error_count, first_request_at, last_request_at,
       input_tokens, output_tokens, total_tokens, cost_usd, costed_request_count)
      VALUES ('s1', 1, 30000, 17, 1, 30020, 300000, 150000, 450000, 300, 30000)`).run();
    db.prepare(`INSERT INTO usage_by_origin
      (day, user_id, origin, origin_kind, trusted, turns, input, output, total, first_at, last_at)
      VALUES ('2026-08-31', 1, '203.0.113.1', 'ip', 1, 1, 1, 2, 3, 1, 2)`).run();
    db.prepare(`INSERT INTO brain_session_origins
      (session_id, origin, user_id, trusted, requests, first_at, last_at)
      VALUES ('s1', '203.0.113.1', 1, 1, 1, 1, 2)`).run();
    db.pragma('wal_checkpoint(TRUNCATE)');

    const requestsBefore = hashRows(db, `SELECT request_id, manifest, response_segment, input_tokens,
      output_tokens, total_tokens, cost_usd, usage_epoch FROM brain_provider_requests ORDER BY seq`);
    const messagesBefore = hashRows(db, 'SELECT id, content, usage_epoch FROM brain_messages ORDER BY rowid');
    const projectionBefore = hashRows(db, 'SELECT * FROM brain_usage_rows ORDER BY source_message_id, bucket_index');
    db.close();

    const childTest = fileURLToPath(new URL('./usageResetPerformanceChild.test.ts', import.meta.url));
    const samplePath = join(home, 'sample.json');
    const vitest = fileURLToPath(new URL('../../node_modules/vitest/vitest.mjs', import.meta.url));
    const run = spawnSync(process.execPath, [vitest, 'run', childTest, '--config', 'vitest.config.ts'], {
      encoding: 'utf8', timeout: 10_000,
      env: {
        ...process.env,
        ELOWEN_USAGE_RESET_PERF_DB: path,
        ELOWEN_USAGE_RESET_PERF_SAMPLE: samplePath,
      },
    });
    if (run.error || run.signal || run.status !== 0) {
      throw new Error(`usage reset child failed: error=${String(run.error)} signal=${String(run.signal)} status=${String(run.status)} stderr=${run.stderr}`);
    }
    if (!existsSync(samplePath)) throw new Error(`usage reset child returned no sample: ${run.stdout}`);
    let sample: { durationMs?: unknown; walBytes?: unknown; chatCleared?: unknown; originsCleared?: unknown };
    try { sample = JSON.parse(readFileSync(samplePath, 'utf8')) as typeof sample; }
    catch { throw new Error(`usage reset child returned invalid sample: ${run.stdout}`); }
    if (typeof sample.durationMs !== 'number' || !Number.isFinite(sample.durationMs)
        || typeof sample.walBytes !== 'number' || !Number.isFinite(sample.walBytes)) {
      throw new Error(`usage reset child returned non-finite sample: ${JSON.stringify(sample)}`);
    }
    expect(sample).toMatchObject({ chatCleared: 1, originsCleared: 1 });
    expect(sample.durationMs).toBeLessThan(250);
    expect(sample.walBytes).toBeLessThanOrEqual(512 * 1_024);

    const after = openDb(path, { migrate: false });
    expect(hashRows(after, `SELECT request_id, manifest, response_segment, input_tokens,
      output_tokens, total_tokens, cost_usd, usage_epoch FROM brain_provider_requests ORDER BY seq`)).toEqual(requestsBefore);
    expect(hashRows(after, 'SELECT id, content, usage_epoch FROM brain_messages ORDER BY rowid')).toEqual(messagesBefore);
    expect(hashRows(after, 'SELECT * FROM brain_usage_rows ORDER BY source_message_id, bucket_index')).toEqual(projectionBefore);
    expect(after.prepare('SELECT usage_epoch FROM brain_usage_reset_state WHERE user_id = 1').get()).toEqual({ usage_epoch: 1 });
    expect(after.prepare(`SELECT request_count, error_count, first_request_at, last_request_at,
      input_tokens, output_tokens, total_tokens, cost_usd, costed_request_count
      FROM brain_request_session_summary WHERE session_id = 's1'`).get()).toEqual({
      request_count: 30_000, error_count: 17, first_request_at: 1, last_request_at: 30_020,
      input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: 0, costed_request_count: 0,
    });
    expect(after.prepare('SELECT COUNT(*) AS count FROM usage_by_origin WHERE user_id = 1').get()).toEqual({ count: 0 });
    expect(after.prepare('SELECT COUNT(*) AS count FROM brain_session_origins WHERE user_id = 1').get()).toEqual({ count: 0 });
    after.close();
  }, 30_000);
});
