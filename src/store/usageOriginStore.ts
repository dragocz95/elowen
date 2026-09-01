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

/** How long an unconsumed turn pin stays meaningful. Six hours is far past any turn that still has a
 *  requester waiting on it, and short enough that a leaked pin cannot mislabel next week's spend. */
const PIN_MAX_AGE_MS = 6 * 3_600_000;

/** Identifies ONE pin, so the surface that set it can take it back without ever touching a pin somebody
 *  else's turn now holds. Opaque by intent — its only operation is equality. */
export type PinToken = number;

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
  /** sessionId → the origin PINNED to the turn currently in flight there, with the ms it was pinned at.
   *  A pin is set by the first request of a turn and consumed by {@link settleTurn}; a request arriving
   *  while one is in flight is STEERED into that same turn, so it must not repoint the attribution.
   *  The settling turn therefore reads this without touching SQLite at all. */
  private readonly turnOrigins = new Map<string, { origin: ClientOrigin; userId: number; at: number; token: PinToken }>();

  /** Issues {@link PinToken}s. A token, not a timestamp: two writers can pin the same conversation within
   *  one millisecond, and a release that matched on time alone would then drop somebody else's pin. */
  private nextPinToken = 1;

  constructor(private readonly db: Db) {}

  /** Remember that `origin` just spoke into `sessionId`: always into the durable ledger, and into the
   *  in-memory pin only when no turn of that conversation is already in flight.
   *
   *  That asymmetry is the attribution rule. A message sent while a turn streams is steered INTO the
   *  running turn rather than starting a new one, so its tokens belong to the request that ordered that
   *  turn. Overwriting the pin would move a turn's whole spend to whoever spoke into it last.
   *
   *  Returns the token of the pin this call SET, or null when an in-flight turn already held one. The
   *  caller hands that token back to {@link releasePin} once its turn is over — see the class doc on why
   *  a stranded pin is a billing defect rather than a cosmetic leak. */
  recordRequest(sessionId: string, userId: number, origin: ClientOrigin, atMs: number): PinToken | null {
    this.pruneStalePins(atMs);
    let token: PinToken | null = null;
    if (!this.turnOrigins.has(sessionId)) {
      token = this.nextPinToken++;
      this.turnOrigins.set(sessionId, { origin, userId, at: atMs, token });
    }
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
    return token;
  }

  /** Drop a pin whose turn ended without ever settling one — a turn refused during shutdown, aborted
   *  before its first provider request, or rejected by any other pre-prompt guard.
   *
   *  This is not housekeeping. In a SHARED room the next message is usually a different colleague, and a
   *  surviving pin refuses them a pin of their own (see {@link recordRequest}), so their whole turn is
   *  billed to the previous writer under that person's platform origin. It was harmless only while the
   *  pin was owner-only, where one account is both writers.
   *
   *  Keyed on the token the pin was created with, so it can only ever remove THAT pin: a turn whose pin
   *  was already consumed, and a message that was steered into somebody else's running turn (which never
   *  held a pin), both release nothing. */
  releasePin(sessionId: string, token: PinToken): void {
    if (this.turnOrigins.get(sessionId)?.token === token) this.turnOrigins.delete(sessionId);
  }

  /** Follow a turn that changed conversation under way. Owner-chat idle rollover archives the transcript
   *  and mints a FRESH session id (`ConversationLifecycle.maybeRollover`), and the turn then settles under
   *  that new id — so a pin left on the old one is found by nobody and the turn records as `internal`
   *  against the row owner instead of the surface the person actually used.
   *
   *  Token-keyed exactly like {@link releasePin}, and it never overwrites a pin already held at the
   *  destination: that pin belongs to a turn in flight there. */
  repointPin(fromSessionId: string, token: PinToken, toSessionId: string): void {
    const pin = this.turnOrigins.get(fromSessionId);
    if (!pin || pin.token !== token || fromSessionId === toSessionId) return;
    this.turnOrigins.delete(fromSessionId);
    if (!this.turnOrigins.has(toSessionId)) this.turnOrigins.set(toSessionId, pin);
  }

  /** Consume the pin of a settling turn: the origin of the request that ORDERED it, or `internal`, plus
   *  the ACCOUNT that ordered it when one is known.
   *
   *  `internal` is a real answer here, not a placeholder for a lookup that failed. A cron wake-up, an
   *  advisor autostart and a delegation revived at boot all genuinely had no request behind them.
   *  Deliberately NOT backed by a lookup in `brain_session_origins`: that table says which addresses have
   *  EVER spoken into the conversation, which is a different question — using it here would bill a
   *  scheduled job to whichever human last opened the same conversation.
   *
   *  The account is returned alongside because in a shared room it is not the session's owner. A room is
   *  owned by whoever opened it, so attributing the spend to the row would bill the opener for everybody
   *  else's turns. `null` means nobody was identified, and the caller falls back to the row. */
  settleTurn(sessionId: string): { origin: ClientOrigin; userId: number | null } {
    const pinned = this.turnOrigins.get(sessionId);
    this.turnOrigins.delete(sessionId);
    return { origin: pinned?.origin ?? INTERNAL_ORIGIN, userId: pinned?.userId ?? null };
  }

  /** The pin currently held for a conversation, without consuming it. For inspection and tests. */
  pinnedOrigin(sessionId: string): ClientOrigin | null {
    return this.turnOrigins.get(sessionId)?.origin ?? null;
  }

  /** A turn that never settles (an abort that skips persistence, a crash mid-turn) would leave its pin
   *  behind, and the next turn of that conversation would inherit it. Nothing in the map is worth
   *  keeping for longer than a turn can plausibly run, so anything older than the window is dropped —
   *  those conversations fall back to `internal`, which is the honest answer for a turn nobody can still
   *  point at a request. Swept on write, so an idle daemon does nothing.
   *
   *  Deliberately NOT gated on the map being large. It used to skip the sweep below 256 entries, which on
   *  an ordinary instance means always: the map holds turns in FLIGHT, so it is small by construction and
   *  the safety net simply never ran. The sweep costs one pass over that handful of entries. */
  private pruneStalePins(nowMs: number): void {
    for (const [id, pin] of this.turnOrigins) if (nowMs - pin.at > PIN_MAX_AGE_MS) this.turnOrigins.delete(id);
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
    const clear = (): number => {
      const removed = this.db.prepare('DELETE FROM usage_by_origin WHERE user_id = ?').run(userId).changes;
      this.db.prepare('DELETE FROM brain_session_origins WHERE user_id = ?').run(userId);
      return removed;
    };
    return this.db.inTransaction ? clear() : this.db.transaction(clear)();
  }
}

/** Bill ONE settled turn to the account and address that ordered it.
 *
 *  The pin's account wins over the conversation's owner, and that is the whole point in a shared room: a
 *  room belongs to whoever opened it, so falling back to the row would keep billing the opener for every
 *  colleague's turn. The row owner is the answer only where NOBODY was identified — an unlinked platform
 *  sender, an instance cron — which is the same person `/usage/by-day` already reports that spend under.
 *
 *  A function rather than four lines in the daemon wiring, so the fallback rule has one implementation
 *  that a test can drive; `tests/brain/originAttribution.test.ts` drives exactly this one. */
export function billSettledTurn(
  origins: Pick<UsageOriginStore, 'settleTurn' | 'addTurn'>,
  sessionOwnerUserId: (sessionId: string) => number | undefined,
  sessionId: string,
  usage: OriginTurnUsage,
  atMs: number,
): void {
  const pin = origins.settleTurn(sessionId);
  const userId = pin.userId ?? sessionOwnerUserId(sessionId);
  if (typeof userId !== 'number') return; // an unknown session has nobody to bill
  origins.addTurn(userId, pin.origin, usage, atMs);
}

/** Narrow an ISO date/datetime to its UTC day, or undefined when it is not a date at all. */
function isoDay(iso?: string): string | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? dayOf(ms) : undefined;
}
