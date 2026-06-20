import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SESSION_MATCH_SKEW_MS, type TokenUsage } from './types.js';

interface OcSessionRow {
  tokens_input: number;
  tokens_output: number;
  tokens_reasoning: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  cost: number;
}

/** opencode (≥1.x) keeps sessions in a SQLite db at ~/.local/share/opencode/opencode.db, each row
 *  carrying its own aggregated token + cost columns and the model it ran. Pick the root session
 *  opened in `dir` at/after the spawn time; `model` (the task's `provider/model` exec) selects the
 *  right session when several ran concurrently in that dir (e.g. an executor next to the overseer),
 *  and `nth` disambiguates same-model peers by start order. Returns null when none match. */
export function opencodeUsage(home: string, dir: string, sinceMs: number, model?: string, nth = 0): TokenUsage | null {
  const dbPath = join(home, '.local', 'share', 'opencode', 'opencode.db');
  if (!existsSync(dbPath)) return null;

  let db: Database.Database;
  try { db = new Database(dbPath, { readonly: true, fileMustExist: true }); }
  catch { return null; }
  try {
    // Root sessions opened in this dir within the run window, ordered by real start time. opencode
    // stores the model as JSON ({id, providerID}); its `providerID/id` round-trips to the exec spec.
    const rows = db.prepare(
      `SELECT tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, cost,
              json_extract(model, '$.providerID') || '/' || json_extract(model, '$.id') AS spec
         FROM session
        WHERE directory = ? AND parent_id IS NULL AND time_created >= ?
        ORDER BY time_created ASC, id ASC`
    ).all(dir, sinceMs - SESSION_MATCH_SKEW_MS) as (OcSessionRow & { spec: string | null })[];
    if (rows.length === 0) return null;

    // Prefer rows whose model matches the task's exec; fall back to all rows when the model can't be
    // matched (older db without the column, or an alias mismatch) so usage never silently regresses.
    const matched = model ? rows.filter((r) => r.spec === model) : rows;
    const r = (matched.length ? matched : rows)[nth];
    if (!r) return null;

    const u: TokenUsage = {
      input: r.tokens_input ?? 0,
      output: (r.tokens_output ?? 0) + (r.tokens_reasoning ?? 0),
      cacheRead: r.tokens_cache_read ?? 0,
      cacheWrite: r.tokens_cache_write ?? 0,
      total: 0,
      costUsd: r.cost ?? 0,
    };
    u.total = u.input + u.output + u.cacheRead + u.cacheWrite;
    return u;
  } finally {
    db.close();
  }
}
