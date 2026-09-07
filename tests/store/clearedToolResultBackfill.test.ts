import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../../src/store/db.js';
import { clearedToolResultPlaceholder, SPILL_PREVIEW_CHARS } from '../../src/brain/session/toolResultClearing.js';

/** v18 backfill: a tool result cleared BEFORE the store became the wire truth still holds the full output
 *  in its transcript row, while the latch row (or the spill file) says it was cleared. Every store-derived
 *  rebuild therefore reconstructs a context the conversation no longer sends — a respawn, an export, and
 *  above all a FORK seed, which reads exactly this history.
 *
 *  RED BEFORE THE FIX: without the migration every assertion below finds the full output still in the row.
 *  The runtime cannot converge those rows on its own — restore merely re-latches them in memory, and the
 *  selection pass then skips them as already latched.
 *
 *  The frozen v1 wording in db.ts is compared against the LIVE renderer here on purpose: the two must
 *  agree today, and this is the test that fails if the wording is changed without minting v2. */

const OUTPUT = 'y'.repeat(9_000);

describe('backfilling cleared tool-result rows', () => {
  let dir = '';
  let home = '';
  let path = '';
  let spillDir = '';

  const message = (toolCallId: string, timestamp: number, text: string): string => JSON.stringify({
    role: 'toolResult', toolCallId, toolName: 'Bash', isError: false, timestamp,
    content: [{ type: 'text', text }], details: {},
  });

  const contentOf = (db: Db, id: string): { text?: string }[] => {
    const row = db.prepare('SELECT content FROM brain_messages WHERE id = ?').get(id) as { content: string };
    return (JSON.parse(row.content) as { content: { text?: string }[] }).content;
  };

  /** Re-arm every migration above 17, so reopening runs v18 against the state seeded meanwhile. */
  const rearm = (db: Db): void => { db.pragma('user_version = 17'); };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'elowen-clear-backfill-'));
    home = join(dir, 'home');
    process.env.HOME = home;
    spillDir = join(home, '.config', 'elowen', 'tool-results', 's-1');
    mkdirSync(spillDir, { recursive: true });
    path = join(dir, 'elowen.db');
    const db = openDb(path);
    db.prepare("INSERT INTO brain_sessions (id, user_id, model) VALUES ('s-1', 1, 'm')").run();
    db.close();
  });

  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  /** Seed one already-cleared result the OLD way: a latch row that says cleared, a row that still holds
   *  the whole output, and the spill file the placeholder points at. */
  function seedLatched(opts: { withFile?: boolean; occurredAt?: number } = {}): string {
    const spillPath = join(spillDir, 'call-1.v1-time-9000.txt');
    const placeholder = clearedToolResultPlaceholder(spillPath, 9_000);
    const db = openDb(path);
    db.prepare('INSERT INTO brain_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)')
      .run('m1', 's-1', 'toolResult', message('call-1', 2_200, OUTPUT));
    db.prepare(
      `INSERT INTO brain_tool_result_spills (session_id, tool_call_id, occurred_at, mode, bytes, preview, path, placeholder)
       VALUES ('s-1', 'call-1', ?, 'time', 9000, NULL, ?, ?)`
    ).run(opts.occurredAt ?? 2_200, spillPath, placeholder);
    if (opts.withFile !== false) writeFileSync(spillPath, OUTPUT);
    rearm(db);
    db.close();
    return placeholder;
  }

  it('rewrites the row of a latch row that already says cleared', () => {
    const placeholder = seedLatched();
    const db = openDb(path);
    expect(contentOf(db, 'm1')).toEqual([{ type: 'text', text: placeholder }]);
    db.close();
  });

  it('leaves the row alone when the spill file the placeholder names is gone', () => {
    seedLatched({ withFile: false });
    const db = openDb(path);
    expect(contentOf(db, 'm1')[0]?.text).toBe(OUTPUT);
    db.close();
  });

  it('matches by occurrence, not by tool call id alone', () => {
    // The latch belongs to an occurrence this history no longer holds: after a compaction the same id came
    // back on a completely different result, which must not inherit that placeholder. The spill file holds
    // the OLD occurrence's output, so the file half refuses it too and only the occurrence key decides.
    const spillPath = join(spillDir, 'call-1.v1-time-9000.txt');
    const placeholder = clearedToolResultPlaceholder(spillPath, 9_000);
    const seed = (occurredAt: number, id: string): void => {
      const db = openDb(path);
      db.prepare('INSERT INTO brain_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)')
        .run(id, 's-1', 'toolResult', message('call-1', 2_200, OUTPUT));
      db.prepare(
        `INSERT INTO brain_tool_result_spills (session_id, tool_call_id, occurred_at, mode, bytes, preview, path, placeholder)
         VALUES ('s-1', 'call-1', ?, 'time', 9000, NULL, ?, ?)`
      ).run(occurredAt, spillPath, placeholder);
      writeFileSync(spillPath, 'the output of the occurrence that was compacted away');
      rearm(db);
      db.close();
    };

    seed(1_000, 'm-other');
    const stale = openDb(path);
    expect(contentOf(stale, 'm-other')[0]?.text).toBe(OUTPUT);
    stale.prepare("DELETE FROM brain_tool_result_spills WHERE session_id = 's-1'").run();
    stale.prepare("DELETE FROM brain_messages WHERE id = 'm-other'").run();
    stale.close();

    seed(2_200, 'm-own');
    const exact = openDb(path);
    expect(contentOf(exact, 'm-own')).toEqual([{ type: 'text', text: placeholder }]);
    exact.close();
  });

  it('rewrites a pre-table result from its spill file, once the file proves it is the same output', () => {
    const spillPath = join(spillDir, 'call-2.v1-preview-9000.txt');
    writeFileSync(spillPath, OUTPUT);
    const db = openDb(path);
    db.prepare('INSERT INTO brain_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)')
      .run('m2', 's-1', 'toolResult', message('call-2', 3_000, OUTPUT));
    rearm(db);
    db.close();

    const reopened = openDb(path);
    expect(contentOf(reopened, 'm2')).toEqual([{
      type: 'text',
      text: clearedToolResultPlaceholder(spillPath, 9_000, OUTPUT.slice(0, SPILL_PREVIEW_CHARS)),
    }]);
    reopened.close();
  });

  it('refuses a spill file whose content is not what the row holds', () => {
    writeFileSync(join(spillDir, 'call-3.v1-time-9000.txt'), 'something a session wrote into its own dir');
    const db = openDb(path);
    db.prepare('INSERT INTO brain_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)')
      .run('m3', 's-1', 'toolResult', message('call-3', 4_000, OUTPUT));
    rearm(db);
    db.close();

    const reopened = openDb(path);
    expect(contentOf(reopened, 'm3')[0]?.text).toBe(OUTPUT);
    reopened.close();
  });

  it('is safe to run twice', () => {
    const placeholder = seedLatched();
    const first = openDb(path);
    rearm(first);
    first.close();
    const second = openDb(path);
    expect(contentOf(second, 'm1')).toEqual([{ type: 'text', text: placeholder }]);
    second.close();
  });
});
