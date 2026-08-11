import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SESSION_MATCH_SKEW_MS, type TokenUsage } from './types.js';

interface OcSessionRow {
  tokens_input: number;
  tokens_output: number;
  tokens_reasoning: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  cost: number;
}

/** Select the opencode session row for a spawn: the nth root session (by start order) opened in
 *  `dir` at/after the spawn time, preferring rows whose model matches `model`. Returns the raw row
 *  (token columns + `id` + `spec`), or null. Single session-select step shared by `opencodeUsage`
 *  (which maps its token columns) and the resume detector (which reads its `id`, the `ses_…` handle).
 *  opencode (≥1.x) keeps sessions in a SQLite db at ~/.local/share/opencode/opencode.db. */
function selectOpencodeRow(home: string, dir: string, sinceMs: number, model?: string, nth = 0): (OcSessionRow & { id: string; spec: string | null }) | null {
  const dbPath = join(home, '.local', 'share', 'opencode', 'opencode.db');
  if (!existsSync(dbPath)) return null;

  let db: Database.Database;
  try { db = new Database(dbPath, { readonly: true, fileMustExist: true }); }
  catch { return null; }
  try {
    // Root sessions opened in this dir within the run window, ordered by real start time. opencode
    // stores the model as JSON ({id, providerID}); its `providerID/id` round-trips to the exec spec.
    const rows = db.prepare(
      `SELECT id, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, cost,
              json_extract(model, '$.providerID') || '/' || json_extract(model, '$.id') AS spec
         FROM session
        WHERE directory = ? AND parent_id IS NULL AND time_created >= ?
        ORDER BY time_created ASC, id ASC`
    // opencode stores `directory` as the resolved absolute path; normalize ours (e.g. strip a
    // trailing slash) so the exact-match WHERE doesn't silently miss every session.
    ).all(resolve(dir), sinceMs - SESSION_MATCH_SKEW_MS) as (OcSessionRow & { id: string; spec: string | null })[];
    if (rows.length === 0) return null;

    // Prefer rows whose model matches the task's exec; fall back to all rows when the model can't be
    // matched (older db without the column, or an alias mismatch) so usage never silently regresses.
    const matched = model ? rows.filter((r) => r.spec === model) : rows;
    return (matched.length ? matched : rows)[nth] ?? null;
  } finally {
    db.close();
  }
}

/** The opencode session id (`ses_…`) for a spawn, or null — the resume detector's handle. */
export function locateOpencodeSession(home: string, dir: string, sinceMs: number, model?: string, nth = 0): string | null {
  return selectOpencodeRow(home, dir, sinceMs, model, nth)?.id ?? null;
}

/** Pick the root session opened in `dir` at/after the spawn time; `model` (the task's
 *  `provider/model` exec) selects the right session when several ran concurrently in that dir
 *  (e.g. an executor next to the overseer), and `nth` disambiguates same-model peers by start
 *  order. Returns null when none match. */
export function opencodeUsage(home: string, dir: string, sinceMs: number, model?: string, nth = 0): TokenUsage | null {
  const r = selectOpencodeRow(home, dir, sinceMs, model, nth);
  if (!r) return null;

  // opencode records the provider's actual cost per session, so it's a real reported figure (not a
  // price-sheet estimate) — even when it's 0 (a free model). Only "unavailable" if the column is null.
  const reported = r.cost != null;
  const u: TokenUsage = {
    input: r.tokens_input ?? 0,
    output: (r.tokens_output ?? 0) + (r.tokens_reasoning ?? 0),
    cacheRead: r.tokens_cache_read ?? 0,
    cacheWrite: r.tokens_cache_write ?? 0,
    total: 0,
    reasoning: r.tokens_reasoning ?? 0,
    costUsd: reported ? r.cost : null,
    currency: reported ? 'USD' : null,
    costSource: reported ? 'provider_reported' : 'unavailable',
  };
  u.total = u.input + u.output + u.cacheRead + u.cacheWrite;
  return u;
}
