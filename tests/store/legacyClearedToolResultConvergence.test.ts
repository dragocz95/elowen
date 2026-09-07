import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../../src/store/db.js';
import {
  CLEARED_TOOL_RESULT_DETAIL,
  clearedToolResultPlaceholder,
  isClearedToolResult,
} from '../../src/brain/session/toolResultClearing.js';

/** v19: the runtime latch is gone, so the two things only it could still do are done once, here.
 *
 *  A latch row written before occurrence keying (`occurred_at = 0`) could only ever be matched to its
 *  occurrence by the runtime's created-at heuristic; this pass makes that judgement once and writes the
 *  result into the row. And a row the runtime already converged carries the placeholder but no structural
 *  marker, which is what stops a multi-byte preview placeholder from being spilled a second time and
 *  nested inside another placeholder.
 *
 *  RED BEFORE THE CHANGE: v19 did not exist, so the legacy row's transcript still held the full output
 *  and the converged rows carried no marker at all. */

const OUTPUT = 'y'.repeat(9_000);

describe('converging legacy cleared tool-result rows', () => {
  let dir = '';
  let home = '';
  let path = '';
  let spillDir = '';
  let spillPath = '';

  const message = (toolCallId: string, timestamp: number, text: string): string => JSON.stringify({
    role: 'toolResult', toolCallId, toolName: 'Bash', isError: false, timestamp,
    content: [{ type: 'text', text }], details: { exitCode: 0 },
  });

  const storedMessage = (db: Db, id: string): { content: { text?: string }[]; details?: Record<string, unknown> } => {
    const row = db.prepare('SELECT content FROM brain_messages WHERE id = ?').get(id) as { content: string };
    return JSON.parse(row.content);
  };

  /** Re-arm only v19, so reopening runs it against whatever was seeded meanwhile. */
  const rearm = (db: Db): void => { db.pragma('user_version = 18'); };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'elowen-v19-'));
    home = join(dir, 'home');
    process.env.HOME = home;
    spillDir = join(home, '.config', 'elowen', 'tool-results', 's-1');
    mkdirSync(spillDir, { recursive: true });
    spillPath = join(spillDir, 'call-1.v1-time-9000.txt');
    path = join(dir, 'elowen.db');
    const db = openDb(path);
    db.prepare("INSERT INTO brain_sessions (id, user_id, model) VALUES ('s-1', 1, 'm')").run();
    db.close();
  });

  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  /** One latch row plus the transcript row it describes, seeded the way the deployed build left them. */
  function seed(opts: {
    occurredAt: number;
    rowTimestamp: number;
    id?: string;
    content?: string;
    withFile?: boolean;
    latchCreatedAt?: string;
  }): string {
    const placeholder = clearedToolResultPlaceholder(spillPath, 9_000);
    const db = openDb(path);
    db.prepare('INSERT INTO brain_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)')
      .run(opts.id ?? 'm1', 's-1', 'toolResult', opts.content ?? message('call-1', opts.rowTimestamp, OUTPUT));
    db.prepare(
      `INSERT INTO brain_tool_result_spills (session_id, tool_call_id, occurred_at, mode, bytes, preview, path, placeholder, created_at)
       VALUES ('s-1', 'call-1', ?, 'time', 9000, NULL, ?, ?, ?)`
    ).run(opts.occurredAt, spillPath, placeholder, opts.latchCreatedAt ?? '2026-01-01 00:00:00');
    if (opts.withFile !== false) writeFileSync(spillPath, OUTPUT);
    rearm(db);
    db.close();
    return placeholder;
  }

  it('converges a legacy row onto the occurrence it was written for, with the marker', () => {
    // Stamped before the latch row was written, so this is the occurrence that row meant.
    const placeholder = seed({ occurredAt: 0, rowTimestamp: Date.parse('2025-12-31T23:59:00Z') });
    const db = openDb(path);
    const stored = storedMessage(db, 'm1');
    expect(stored.content).toEqual([{ type: 'text', text: placeholder }]);
    expect(isClearedToolResult(stored)).toBe(true);
    expect(stored.details?.[CLEARED_TOOL_RESULT_DETAIL]).toEqual({ mode: 'time', bytes: 9_000, path: spillPath });
    // The tool's own details survive.
    expect(stored.details?.exitCode).toBe(0);
    db.close();
  });

  it('never captures an occurrence minted after the latch row itself', () => {
    // A reused tool call id after a compaction: the result is younger than the row, so it is a different
    // result and must keep its own output.
    seed({ occurredAt: 0, rowTimestamp: Date.parse('2026-06-01T00:00:00Z') });
    const db = openDb(path);
    expect(storedMessage(db, 'm1').content[0]?.text).toBe(OUTPUT);
    db.close();
  });

  it('leaves the row alone when the spill file the placeholder names is gone', () => {
    seed({ occurredAt: 0, rowTimestamp: Date.parse('2025-12-31T23:59:00Z'), withFile: false });
    const db = openDb(path);
    expect(storedMessage(db, 'm1').content[0]?.text).toBe(OUTPUT);
    db.close();
  });

  it('stamps the marker on a row the runtime already converged', () => {
    const placeholder = clearedToolResultPlaceholder(spillPath, 9_000);
    seed({
      occurredAt: 2_200, rowTimestamp: 2_200,
      content: message('call-1', 2_200, placeholder),
    });
    const db = openDb(path);
    const stored = storedMessage(db, 'm1');
    expect(stored.content).toEqual([{ type: 'text', text: placeholder }]);
    expect(isClearedToolResult(stored)).toBe(true);
    db.close();
  });

  it('is safe to run twice', () => {
    const placeholder = seed({ occurredAt: 0, rowTimestamp: Date.parse('2025-12-31T23:59:00Z') });
    const first = openDb(path);
    rearm(first);
    first.close();
    const second = openDb(path);
    expect(storedMessage(second, 'm1').content).toEqual([{ type: 'text', text: placeholder }]);
    expect(isClearedToolResult(storedMessage(second, 'm1'))).toBe(true);
    second.close();
  });

  it('leaves the table in place, because the previous build still restores from it', () => {
    seed({ occurredAt: 0, rowTimestamp: Date.parse('2025-12-31T23:59:00Z') });
    const db = openDb(path);
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'brain_tool_result_spills'").get();
    expect(table).toBeDefined();
    db.close();
  });

  it('runs on a fresh database, where the table exists but holds nothing', () => {
    const fresh = join(dir, 'fresh.db');
    const db = openDb(fresh);
    expect(db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(19);
    expect(db.prepare('SELECT COUNT(*) AS n FROM brain_tool_result_spills').get()).toEqual({ n: 0 });
    db.close();
  });
});
