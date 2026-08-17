import type { Db } from './db.js';
import { INTERNAL_ORIGIN, type ClientOrigin } from '../api/clientIp.js';

/** Token totals of ONE settled turn, as the persistence layer already holds them in memory. `cost` is
 *  null when the provider reported none — it is never coerced to 0, so "free" and "unknown" stay apart. */
export interface OriginTurnUsage {
  input: number; output: number; cacheRead: number; cacheWrite: number; total: number;
  cost: number | null;
}

/** How the admin view slices the rollup. `pair` is the raw grain of the table. */
export type OriginGroup = 'user' | 'origin' | 'pair';

/** One aggregated row of the admin origin view. `origin`/`originKind` are null when grouping by user,
 *  `userId` is null when grouping by origin — the axis that was collapsed has no single value. */
export interface OriginUsageRow {
  userId: number | null;
  origin: string | null;
  originKind: string | null;
  /** 0 when ANY contributing bucket was unverifiable. */
  trusted: boolean;
  /** Distinct origins folded into this row (only meaningful when grouping by user). */
  origins: number;
  turns: number;
  input: number; output: number; cacheRead: number; cacheWrite: number; tokens: number;
  /** Null when no contributing turn carried a cost — the UI must render that as "—", not "$0". */
  cost: number | null;
  costedTurns: number;
  firstAt: number;
  lastAt: number;
}

/** UTC day key, the same basis `BrainUsageStore.usageByDay` groups on (`date(ts/1000,'unixepoch')`), so
 *  a day in this table and a day in that view mean the same 24 hours even though the two counters are
 *  independent of each other. */
const dayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Origin attribution for brain spend: which request origin ordered a turn, and how many tokens each
 *  (day, user, origin) bucket has burned since tracking began.
 *
 *  This is deliberately a WRITE-TIME rollup rather than a query over `brain_messages`. The message table
 *  is the largest in the database and the existing `/usage/*` views already scan it with per-row
 *  `json_extract`; answering "who, from where" the same way would add a second such scan to the daemon's
 *  synchronous event loop. Attribution also cannot be recovered from messages at all — a message carries
 *  no origin — so the number has to be accumulated as turns settle.
 *
 *  The consequence, which callers must not paper over: these totals are a SEPARATE counter from
 *  `/usage/by-day` and `/usage/by-model`. They begin at deployment, they do not follow a hand-edit of a
 *  message row, and only `/usage/reset` clears both. They answer "how was the spend distributed across
 *  people and addresses", never "what is the exact bill". */
export class UsageOriginStore {
  /** sessionId → the origin of the request that most recently spoke into it. The hot path: a settling
   *  turn reads it without touching SQLite. Rebuilt lazily from `brain_session_origins` after a restart,
   *  so a conversation that survives a daemon restart keeps its attribution. */
  private readonly liveOrigins = new Map<string, ClientOrigin>();

  constructor(private readonly db: Db) {}

  /** Remember that `origin` just spoke into `sessionId`. Called once per turn-starting request, before
   *  the turn runs, so the settle later attributes to the request that ORDERED the turn rather than to
   *  whatever address happens to be current when it finishes. One UPSERT into a small table. */
  recordRequest(sessionId: string, userId: number, origin: ClientOrigin, atMs: number): void {
    this.liveOrigins.set(sessionId, origin);
    this.db.prepare(
      `INSERT INTO brain_session_origins (session_id, origin, user_id, trusted, requests, first_at, last_at)
            VALUES (?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT (session_id, origin) DO UPDATE SET
            requests = requests + 1,
            user_id  = excluded.user_id,
            -- Downgrade only: once an unverifiable claim arrived under this origin, the pairing stays marked.
            trusted  = MIN(trusted, excluded.trusted),
            last_at  = excluded.last_at`
    ).run(sessionId, origin.value, userId, origin.trusted ? 1 : 0, atMs, atMs);
  }

  /** The origin a turn of `sessionId` should be attributed to. In-memory first, then the newest ledger
   *  row (a conversation resumed after a restart), then `internal`.
   *
   *  `internal` is a real answer, not a fallback placeholder: a cron wake-up, a channel message or a
   *  boot-recovered delegation genuinely had no HTTP request behind it. Guessing the last human IP for
   *  those would put spend on an address that did not order it. */
  originForSession(sessionId: string): ClientOrigin {
    const live = this.liveOrigins.get(sessionId);
    if (live) return live;
    const row = this.db.prepare(
      `SELECT origin, trusted FROM brain_session_origins WHERE session_id = ? ORDER BY last_at DESC LIMIT 1`
    ).get(sessionId) as { origin: string; trusted: number } | undefined;
    if (!row) return INTERNAL_ORIGIN;
    const origin = restoreOrigin(row.origin, row.trusted === 1);
    this.liveOrigins.set(sessionId, origin);
    return origin;
  }

  /** Forget the in-memory attribution for a conversation (it was deleted, or its turn tree is gone).
   *  The ledger row stays until retention takes it — this only bounds the map. */
  forgetSession(sessionId: string): void {
    this.liveOrigins.delete(sessionId);
  }

  /** Add ONE settled turn's usage to its (day, user, origin) bucket. Idempotency is NOT claimed: the
   *  caller must invoke this exactly once per settled turn. Compaction must never call it — those tokens
   *  were already counted on the day they were produced, and re-adding a rollup would double the spend. */
  addTurn(userId: number, origin: ClientOrigin, usage: OriginTurnUsage, atMs: number): void {
    const cost = typeof usage.cost === 'number' && Number.isFinite(usage.cost) ? usage.cost : null;
    this.db.prepare(
      `INSERT INTO usage_by_origin (day, user_id, origin, origin_kind, trusted, turns,
                                    input, output, cache_read, cache_write, total,
                                    cost, costed_turns, first_at, last_at)
            VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (day, user_id, origin) DO UPDATE SET
            turns       = turns + 1,
            trusted     = MIN(trusted, excluded.trusted),
            input       = input + excluded.input,
            output      = output + excluded.output,
            cache_read  = cache_read + excluded.cache_read,
            cache_write = cache_write + excluded.cache_write,
            total       = total + excluded.total,
            -- An uncosted turn must leave an uncosted bucket uncosted rather than turn it into $0.
            cost        = CASE WHEN excluded.cost IS NULL THEN cost
                               WHEN cost IS NULL THEN excluded.cost
                               ELSE cost + excluded.cost END,
            costed_turns = costed_turns + excluded.costed_turns,
            first_at    = MIN(first_at, excluded.first_at),
            last_at     = MAX(last_at, excluded.last_at)`
    ).run(
      dayOf(atMs), userId, origin.value, origin.kind, origin.trusted ? 1 : 0,
      num(usage.input), num(usage.output), num(usage.cacheRead), num(usage.cacheWrite), num(usage.total),
      cost, cost != null ? 1 : 0, atMs, atMs,
    );
  }

  /** The admin view's aggregate. Reads `usage_by_origin` ALONE — see the class doc: no join back to
   *  `brain_messages` may ever be added here, whatever breakdown is asked for next.
   *  `tests/store/usageOriginPlan.test.ts` asserts that mechanically through EXPLAIN QUERY PLAN. */
  topOrigins(opts: { fromIso?: string; toIso?: string; group?: OriginGroup; limit?: number } = {}): OriginUsageRow[] {
    const group = opts.group ?? 'pair';
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    // Filtering on the `day` text column keeps the index usable and stays on the same UTC basis rows are
    // written with; a bound mid-day therefore includes that whole day, which the view labels accordingly.
    const from = isoDay(opts.fromIso);
    const to = isoDay(opts.toIso);
    if (from) { clauses.push('day >= ?'); params.push(from); }
    if (to) { clauses.push('day <= ?'); params.push(to); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const keyed = group === 'user'
      ? { select: 'user_id AS user_id, NULL AS origin, NULL AS origin_kind', by: 'user_id' }
      : group === 'origin'
        ? { select: 'NULL AS user_id, origin AS origin, MIN(origin_kind) AS origin_kind', by: 'origin' }
        : { select: 'user_id AS user_id, origin AS origin, MIN(origin_kind) AS origin_kind', by: 'user_id, origin' };
    const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 50)));
    interface Row {
      user_id: number | null; origin: string | null; origin_kind: string | null; trusted: number;
      origins: number; turns: number; input: number; output: number; cache_read: number;
      cache_write: number; total: number; cost: number | null; costed_turns: number;
      first_at: number; last_at: number;
    }
    const rows = this.db.prepare(
      `SELECT ${keyed.select},
              MIN(trusted) AS trusted,
              COUNT(DISTINCT origin) AS origins,
              SUM(turns) AS turns,
              SUM(input) AS input, SUM(output) AS output,
              SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write,
              SUM(total) AS total,
              CASE WHEN COUNT(cost) = 0 THEN NULL ELSE SUM(cost) END AS cost,
              SUM(costed_turns) AS costed_turns,
              MIN(first_at) AS first_at, MAX(last_at) AS last_at
         FROM usage_by_origin
         ${where}
        GROUP BY ${keyed.by}
        ORDER BY total DESC
        LIMIT ${limit}`
    ).all(...params) as Row[];
    return rows.map((r) => ({
      userId: r.user_id, origin: r.origin, originKind: r.origin_kind,
      trusted: r.trusted === 1, origins: r.origins, turns: r.turns,
      input: r.input, output: r.output, cacheRead: r.cache_read, cacheWrite: r.cache_write,
      tokens: r.total, cost: r.cost, costedTurns: r.costed_turns,
      firstAt: r.first_at, lastAt: r.last_at,
    }));
  }

  /** Oldest day the rollup holds, or null when it holds nothing. The UI states it as "tracked since", so
   *  nobody reads a view that starts at deployment as the instance's whole history. */
  trackingSince(): string | null {
    const row = this.db.prepare('SELECT MIN(day) AS day FROM usage_by_origin').get() as { day: string | null };
    return row.day ?? null;
  }

  /** Privacy step one: an IP older than the cutoff is replaced by the constant `redacted` and its bucket
   *  is merged into that day's redacted bucket. The spend survives, the address does not.
   *
   *  Only `ip` rows are touched — `local`, `internal` and `platform:*` name no person, and blurring them
   *  would destroy the very distinction the view exists to draw. Ledger rows older than the cutoff go
   *  with them: their only job is live attribution, which by then is over.
   *  Returns how many rollup rows were folded away. */
  redactOlderThan(cutoffMs: number): number {
    interface Merged {
      day: string; user_id: number; trusted: number; turns: number; input: number; output: number;
      cache_read: number; cache_write: number; total: number; cost: number | null;
      costed_turns: number; first_at: number; last_at: number;
    }
    return this.db.transaction(() => {
      // Aggregate in JS rather than INSERT…SELECT over the same table: the target of the upsert is also
      // the source, and reading a table the same statement is writing is exactly the kind of ordering
      // SQLite leaves unspecified. The row count here is days × users × addresses, not messages.
      const merged = this.db.prepare(
        `SELECT day, user_id, MIN(trusted) AS trusted, SUM(turns) AS turns,
                SUM(input) AS input, SUM(output) AS output,
                SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write,
                SUM(total) AS total,
                CASE WHEN COUNT(cost) = 0 THEN NULL ELSE SUM(cost) END AS cost,
                SUM(costed_turns) AS costed_turns,
                MIN(first_at) AS first_at, MAX(last_at) AS last_at
           FROM usage_by_origin
          WHERE origin_kind = 'ip' AND last_at < ?
          GROUP BY day, user_id`
      ).all(cutoffMs) as Merged[];
      const removed = this.db.prepare(`DELETE FROM usage_by_origin WHERE origin_kind = 'ip' AND last_at < ?`).run(cutoffMs).changes;
      const upsert = this.db.prepare(
        `INSERT INTO usage_by_origin (day, user_id, origin, origin_kind, trusted, turns,
                                      input, output, cache_read, cache_write, total,
                                      cost, costed_turns, first_at, last_at)
              VALUES (?, ?, 'redacted', 'redacted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (day, user_id, origin) DO UPDATE SET
              trusted      = MIN(trusted, excluded.trusted),
              turns        = turns + excluded.turns,
              input        = input + excluded.input,
              output       = output + excluded.output,
              cache_read   = cache_read + excluded.cache_read,
              cache_write  = cache_write + excluded.cache_write,
              total        = total + excluded.total,
              cost         = CASE WHEN excluded.cost IS NULL THEN cost
                                  WHEN cost IS NULL THEN excluded.cost
                                  ELSE cost + excluded.cost END,
              costed_turns = costed_turns + excluded.costed_turns,
              first_at     = MIN(first_at, excluded.first_at),
              last_at      = MAX(last_at, excluded.last_at)`
      );
      for (const m of merged) {
        upsert.run(m.day, m.user_id, m.trusted, m.turns, m.input, m.output, m.cache_read,
          m.cache_write, m.total, m.cost, m.costed_turns, m.first_at, m.last_at);
      }
      this.db.prepare('DELETE FROM brain_session_origins WHERE last_at < ?').run(cutoffMs);
      return removed;
    })();
  }

  /** Privacy step two: past the operator's overall retention window the row goes entirely, address and
   *  totals alike — the same horizon the activity log is pruned on. */
  purgeOlderThan(cutoffMs: number): number {
    return this.db.prepare('DELETE FROM usage_by_origin WHERE last_at < ?').run(cutoffMs).changes;
  }

  /** Drop one user's origin accounting, for `POST /usage/reset`. Without it the origin view would keep
   *  reporting spend the rest of Stats has just forgotten. */
  clearForUser(userId: number): number {
    return this.db.transaction(() => {
      const removed = this.db.prepare('DELETE FROM usage_by_origin WHERE user_id = ?').run(userId).changes;
      this.db.prepare('DELETE FROM brain_session_origins WHERE user_id = ?').run(userId);
      return removed;
    })();
  }
}

/** Rebuild a `ClientOrigin` from a persisted ledger row. The stored VALUE carries the kind: `local` and
 *  `internal` are reserved words, `platform:*` a reserved prefix, and anything else is an address. Kept
 *  next to the store rather than in clientIp.ts because it is a persistence concern — clientIp.ts
 *  classifies a live request, this classifies a string that came back out of SQLite. */
function restoreOrigin(value: string, trusted: boolean): ClientOrigin {
  if (value === 'local') return { value, kind: 'local', trusted };
  if (value === 'internal') return { value, kind: 'internal', trusted };
  if (value.startsWith('platform:')) return { value, kind: 'platform', trusted };
  return { value, kind: 'ip', trusted };
}

/** Narrow an ISO date/datetime to its UTC day, or undefined when it is not a date at all. */
function isoDay(iso?: string): string | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? dayOf(ms) : undefined;
}
