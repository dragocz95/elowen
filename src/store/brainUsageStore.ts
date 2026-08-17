import type { Db } from './db.js';
import type { TokenUsage, CostSource, ModelUsage } from '../integrations/usage/types.js';
import { TASK_PREFIX } from '../brain/sessionId.js';
import { BRAIN_REGISTRY_PROVIDER_PREFIX, execRefSpec } from '../shared/execs.js';

// Read a numeric JSON field ONLY when it really holds a number. `json_extract` alone also yields a string
// that merely looks numeric ("100"), which SQLite's SUM() silently coerces — whereas
// {@link rollupDroppedUsage}, the JS side that re-folds these exact fields when a compaction drops the
// rows, counts only real finite numbers. Without the type check the two disagree, so compacting a session
// would CHANGE its historical totals. `absent` is 0 for the summed columns, but NULL for cost and ts: a
// missing cost must stay "unavailable" rather than become a real $0, and an undated row is excluded by
// `ts IS NOT NULL`. Exported because every SQL sum over these fields must read them the SAME way —
// {@link BrainStore.tokenTotals} sums `$.usage.totalTokens` outside this file and would otherwise drift.
export const numeric = (src: string, path: string, absent = '0'): string =>
  `CASE WHEN json_type(${src}, '${path}') IN ('integer', 'real') THEN json_extract(${src}, '${path}') ELSE ${absent} END`;

/** Current rows mark their persisted configured provider id explicitly. Older PI rows instead carry a
 * registry name: custom endpoints used the internal `elowen-<config id>` namespace, while OAuth rows used
 * PI's built-in name. Normalize only that historical custom prefix before grouping; a marked id stays
 * verbatim, and only a missing/empty row field falls back to the session's configured provider id. */
const markedProvider = (src: string, path: string): string => `NULLIF(CASE WHEN json_type(${src}, '${path}') = 'text' THEN
    CASE WHEN json_extract(${src}, '$.providerIdentity') = 'config'
      THEN json_extract(${src}, '${path}')
      WHEN json_extract(${src}, '${path}') LIKE '${BRAIN_REGISTRY_PROVIDER_PREFIX}%'
      THEN substr(json_extract(${src}, '${path}'), ${BRAIN_REGISTRY_PROVIDER_PREFIX.length + 1})
      ELSE json_extract(${src}, '${path}') END
  END, '')`;

// Sessions that ran exactly ONE provider for a given model, so a row of that model in that session can be
// attributed without guessing. A compaction rollup bucket names its model but never its provider, and the
// live assistant messages it was summarized FROM are still in the same session — this recovers the pair
// that actually produced the tokens instead of inventing one. `HAVING COUNT(DISTINCT …) = 1` is the whole
// safety property: a session that served the same model through two providers stays ambiguous and is left
// unresolved rather than attributed to the alphabetically-first one. Normalization must be IDENTICAL to
// the marked-provider branch below, hence the shared helper: a lookup that normalized differently would
// split one model into two rows again, which is the bug this is fixing.
const SAME_MODEL_PROVIDER = `SELECT a.session_id AS session_id,
         NULLIF(json_extract(a.content, '$.model'), '') AS model,
         MIN(${markedProvider('a.content', '$.provider')}) AS provider
    FROM brain_messages a
   WHERE a.role = 'assistant' AND json_valid(a.content) AND json_type(a.content) = 'object'
     AND NULLIF(json_extract(a.content, '$.model'), '') IS NOT NULL
     AND ${markedProvider('a.content', '$.provider')} IS NOT NULL
   GROUP BY a.session_id, NULLIF(json_extract(a.content, '$.model'), '')
  HAVING COUNT(DISTINCT ${markedProvider('a.content', '$.provider')}) = 1`;

const producingProvider = (src: string, path: string, modelPath: string, fallback: string): string => `COALESCE(
  ${markedProvider(src, path)},
  -- Recovered from the live messages of the same session that ran the same model (see SAME_MODEL_PROVIDER).
  -- This is a lookup, not a guess: the row it reads is one the same session actually produced.
  sm.provider,
  -- The session fallback applies ONLY to a row that carries no model of its own. Provider and model must
  -- come from the SAME source: a row that names its model but not its provider (every compaction-rollup
  -- bucket) would otherwise be stamped with whatever provider the session happens to run NOW, inventing
  -- pairs that never existed — measured on live data, that put 157M claude-opus-5 tokens under 'alibaba'.
  -- Left NULL, such a row stays an explicit legacy 'elowen:<model>' bucket, which is what the aggregate
  -- already knows how to show as unresolved.
  CASE WHEN NULLIF(json_extract(${src}, '${modelPath}'), '') IS NULL THEN NULLIF(${fallback}, '') END)`;

// Normalized usage rows shared by usageByDay + usageByModel. One row per LIVE assistant message (its
// `$.usage`, attributed to the model it recorded in `$.model`) UNIONed with one row per per-model
// compaction-rollup bucket (`$.usageRollup[]` fanned out with json_each — a divider with no rollup
// contributes nothing). `ts` is the ms-epoch attribution point: a live row's own `$.timestamp`, or a
// rolled-up bucket's `at` (newest dropped row of that model) — so compaction NEVER moves spend to the
// compaction moment. `model` is the row's own producing model, falling back to the session's model only
// for legacy rows that predate per-message model capture. `measured_output` is the slice of `output` that
// `duration_ms` actually timed (see {@link UsageRollupBucket}) — the tok/s numerator, kept separate so
// untimed history can never be read as measured. Purely static SQL (no user input) → safe to
// interpolate. Callers add the user/window/day filters + GROUP BY.
//
// The `json_valid` guards are load-bearing: `json_extract` and `json_each` THROW on malformed JSON, so a
// SINGLE corrupt `content` row (a truncated write, a hand-edited DB) would otherwise fail EVERY usage view
// for that user instead of costing just its own numbers. A bad row is dropped from the rows CTE and
// contributes nothing. The rollup side needs the guard on the json_each ARGUMENT, not only in WHERE: the
// table-valued function is evaluated per outer row, before the filter can exclude it — hence the nested
// CASE (an inner condition is never evaluated when the outer one fails) plus the `array` type check, so a
// `usageRollup` that is not an array of buckets is skipped too.
//
// Validity is not enough, though: a row must also be the RIGHT SHAPE, not merely parseable. `json_type`
// keeps a JSON scalar (a row that is just `null` or a number) out of the assistant side, and `je.type`
// keeps a bucket element that is a scalar — including a DOUBLE-SERIALIZED bucket, a JSON string whose
// text happens to be an object — out of the fan-out. Every numeric field goes through {@link numeric}.
const USAGE_ROWS = `
  SELECT s.user_id AS user_id, s.id AS session_id,
         ${producingProvider('m.content', '$.provider', '$.model', 's.provider')} AS provider,
         COALESCE(NULLIF(json_extract(m.content, '$.model'), ''), s.model) AS model,
         ${numeric('m.content', '$.timestamp', 'NULL')} AS ts,
         ${numeric('m.content', '$.usage.input')} AS input,
         ${numeric('m.content', '$.usage.output')} AS output,
         ${numeric('m.content', '$.usage.cacheRead')} AS cache_read,
         ${numeric('m.content', '$.usage.cacheWrite')} AS cache_write,
         ${numeric('m.content', '$.usage.totalTokens')} AS total,
         ${numeric('m.content', '$.usage.reasoning')} AS reasoning,
         ${numeric('m.content', '$.durationMs')} AS duration_ms,
         CASE WHEN ${numeric('m.content', '$.durationMs')} > 0
               AND ${numeric('m.content', '$.usage.output')} > 0
              THEN ${numeric('m.content', '$.usage.output')} ELSE 0 END AS measured_output,
         ${numeric('m.content', '$.usage.cost.total', 'NULL')} AS cost
    FROM brain_messages m JOIN brain_sessions s ON s.id = m.session_id
         LEFT JOIN (${SAME_MODEL_PROVIDER}) sm
           ON sm.session_id = m.session_id AND sm.model = NULLIF(json_extract(m.content, '$.model'), '')
   WHERE m.role = 'assistant' AND json_valid(m.content) AND json_type(m.content) = 'object'
  UNION ALL
  SELECT s.user_id AS user_id, s.id AS session_id,
         ${producingProvider('je.value', '$.provider', '$.model', 's.provider')} AS provider,
         COALESCE(NULLIF(json_extract(je.value, '$.model'), ''), s.model) AS model,
         ${numeric('je.value', '$.at', 'NULL')} AS ts,
         ${numeric('je.value', '$.input')} AS input,
         ${numeric('je.value', '$.output')} AS output,
         ${numeric('je.value', '$.cacheRead')} AS cache_read,
         ${numeric('je.value', '$.cacheWrite')} AS cache_write,
         ${numeric('je.value', '$.totalTokens')} AS total,
         ${numeric('je.value', '$.reasoning')} AS reasoning,
         ${numeric('je.value', '$.durationMs')} AS duration_ms,
         ${numeric('je.value', '$.measuredOutput')} AS measured_output,
         ${numeric('je.value', '$.cost.total', 'NULL')} AS cost
    FROM brain_messages m JOIN brain_sessions s ON s.id = m.session_id,
         json_each(CASE WHEN json_valid(m.content)
                        THEN (CASE WHEN json_type(m.content, '$.usageRollup') = 'array'
                                   THEN json_extract(m.content, '$.usageRollup') END)
                   END) je
         LEFT JOIN (${SAME_MODEL_PROVIDER}) sm
           ON sm.session_id = m.session_id AND sm.model = NULLIF(json_extract(je.value, '$.model'), '')
   WHERE m.role = 'compaction' AND je.type = 'object'`;

// A `brain-task-<id>` worker session is EXCLUDED from the brain aggregates ONLY when its spend is
// already snapshotted in task_usage (merged separately by /usage/by-model & /usage/by-day) — excluding
// it here too would double-count a task creator's spend. A worker that crashed BEFORE snapshotting
// (task then failed/cancelled, never relaunched) has NO task_usage row, so its persisted spend is KEPT
// here instead of vanishing from every stat. Non-task chat sessions always pass.
// `substr(id, TASK_PREFIX.length + 1)` recovers the task id (SQLite substr is 1-indexed) — derived from
// the prefix so a rename can't leave the old magic offset behind.
// `task_usage` is a WORK-PLUGIN table: a fresh install with that plugin disabled has none at all, and
// then nothing is snapshotted anywhere — so the clause degrades to "keep every row", which is exactly
// what an existing-but-empty task_usage already evaluates to. Chat usage stays intact either way.
const taskSnapshotExclusion = (hasTaskUsage: boolean) => hasTaskUsage
  ? `NOT (session_id LIKE '${TASK_PREFIX}%' AND EXISTS (SELECT 1 FROM task_usage tu WHERE tu.task_id = substr(session_id, ${TASK_PREFIX.length + 1})))`
  : '1 = 1';

/** How long a usage view may be served from memory. Both /usage/by-* views run TWO full scans of
 *  brain_messages (the largest table) behind a UNION ALL with per-row json_extract/json_each — yet the
 *  numbers they produce move on the scale of a settled turn, so the dashboard's 30 s/60 s pollers (and
 *  every extra open tab) would otherwise re-pay the scan for an answer that did not change. Mirrors the
 *  TTL used for the provider-usage upstream cache (brain/providerUsage.ts). */
const USAGE_VIEW_TTL_MS = 60_000;

/** Cheap freshness probe compared before a cached view is served: all four reads are b-tree descents
 *  (or a MAX over a short datetime column), not scans. An append/compaction grows a rowid, a model
 *  switch bumps updated_at, a settled task lands a task_usage row (which flips the snapshot exclusion)
 *  — so a real write invalidates the cache immediately and the TTL is only the backstop for the rare
 *  mid-table delete/update that leaves every MAX untouched (deleteMessage, reassignSession); such a
 *  change is served stale until the TTL lapses. The probe runs before EVERY read, cached or not, so the
 *  stored sentinel always describes the data the value was computed from. */
const usageSentinelSql = (hasTaskUsage: boolean) => `SELECT
  (SELECT MAX(rowid) FROM brain_messages) AS m,
  (SELECT MAX(rowid) FROM brain_sessions) AS s,
  (SELECT MAX(updated_at) FROM brain_sessions) AS su,
  ${hasTaskUsage ? '(SELECT MAX(rowid) FROM task_usage)' : 'NULL'} AS tu`;

interface UsageSentinel { m: number | null; s: number | null; su: string | null; tu: number | null }
interface ViewCacheEntry { at: number; sentinel: UsageSentinel; value: unknown }

/** Bound on distinct (user × window) keys held at once; a flood of distinct windows clears and starts
 *  over rather than growing without limit (same posture as the git-branch cache). */
const VIEW_CACHE_LIMIT = 64;

/** Persisted usage of a delegated session tree. Unlike live context usage, these are cumulative token
 *  and cost totals only; callers must keep the root session's own context-window fill unchanged. */
export interface BrainDescendantUsage {
  input: number; output: number; cacheRead: number; cacheWrite: number;
  totalTokens: number; reasoning: number; cost: number;
}

/** One per-model bucket of usage rolled up from the assistant rows a compaction DROPS, folded onto the
 *  `compaction` divider so historical spend survives (compaction deletes those rows). Stored as an ARRAY
 *  under `$.usageRollup` — one bucket per model that produced dropped spend — under a key that is NEVER
 *  `usage`, so PI's live session and `usageOf` (statusline) never double-count it after rehydrate.
 *  `model` preserves per-model attribution across compaction; `at` is the ms-epoch of the newest dropped
 *  row of that model (the day/window attribution basis, standing in for a live row's `$.timestamp`) and
 *  is ABSENT when nothing dropped into the bucket carried a date — see {@link rollupDroppedUsage}.
 *  `durationMs` and `measuredOutput` are the MEASURED pair — wall time and output tokens of the dropped
 *  generations that carried both — so their tokens/sec survives compaction. They are a subset of `output`:
 *  untimed rows (predating the timing stamp) and aborts (a duration with an empty `usage`) contribute to
 *  neither, and a bucket written before `measuredOutput` existed reads as unmeasured rather than having a
 *  speed invented for it. */
export interface UsageRollupBucket {
  provider?: string;
  providerIdentity?: 'config';
  model: string;
  input: number; output: number; cacheRead: number; cacheWrite: number;
  totalTokens: number; reasoning: number; at?: number;
  durationMs?: number; measuredOutput?: number; cost?: { total: number };
}

/** Fold the usage of the rows a compaction is about to delete into PER-MODEL rollup buckets: assistant
 *  rows via `$.usage`, attributed to their own `$.model`; and any earlier compaction dividers via their
 *  own `$.usageRollup` buckets, so multiple compactions chain without losing spend OR its per-model
 *  breakdown. Each bucket's `at` is the ms-epoch of the newest dropped row of THAT model, so rolled-up
 *  spend keeps its ORIGINAL date instead of jumping to the compaction moment. Returns null when nothing
 *  dropped carried usage (keeps the divider clean). */
export function rollupDroppedUsage(dropped: readonly { content: string }[]): UsageRollupBucket[] | null {
  const byIdentity = new Map<string, UsageRollupBucket>();
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const bucketFor = (provider: string, model: string, providerIdentity = false): UsageRollupBucket => {
    const key = JSON.stringify([provider, model, providerIdentity]);
    let b = byIdentity.get(key);
    if (!b) {
      b = {
        ...(provider ? { provider } : {}), ...(providerIdentity ? { providerIdentity: 'config' as const } : {}), model,
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, reasoning: 0,
        at: 0, durationMs: 0, measuredOutput: 0,
      };
      byIdentity.set(key, b);
    }
    return b;
  };
  const fold = (b: UsageRollupBucket, u: Record<string, unknown>, at: number, measured: { durationMs: number; output: number }): void => {
    b.input += num(u.input); b.output += num(u.output);
    b.cacheRead += num(u.cacheRead); b.cacheWrite += num(u.cacheWrite);
    b.reasoning += num(u.reasoning); b.totalTokens += num(u.totalTokens);
    // Only a generation with BOTH wall time and output tokens carries a speed, so both sides of the
    // tok/s fraction move together — an untimed legacy row would otherwise inflate it and an abort
    // (duration, empty `usage`) would deflate it, permanently, since compaction drops the per-row
    // timings. The caller resolves the pair: an assistant row keeps its timing on the MESSAGE next to
    // `usage`, while a prior bucket already carries its own measured slice.
    if (measured.durationMs > 0 && measured.output > 0) {
      b.durationMs = (b.durationMs ?? 0) + measured.durationMs;
      b.measuredOutput = (b.measuredOutput ?? 0) + measured.output;
    }
    const cost = (u as { cost?: { total?: unknown } }).cost;
    if (cost && typeof cost === 'object' && typeof cost.total === 'number') b.cost = { total: (b.cost?.total ?? 0) + cost.total };
    if (at > (b.at ?? 0)) b.at = at; // newest dropped row of this model wins as its attribution point
  };
  for (const row of dropped) {
    let content: unknown;
    try { content = JSON.parse(row.content); } catch { continue; }
    if (typeof content !== 'object' || content === null) continue;
    const c = content as { usage?: Record<string, unknown>; usageRollup?: unknown; provider?: unknown; providerIdentity?: unknown; model?: unknown; timestamp?: unknown; durationMs?: unknown };
    if (Array.isArray(c.usageRollup)) {
      // A prior divider — merge each of its per-identity buckets (chained compaction). Legacy buckets have
      // no provider, so they remain separate and unresolved rather than being guessed from newer state.
      for (const raw of c.usageRollup) {
        if (!raw || typeof raw !== 'object') continue;
        const pb = raw as Record<string, unknown>;
        fold(bucketFor(
          typeof pb.provider === 'string' ? pb.provider : '',
          typeof pb.model === 'string' ? pb.model : '',
          pb.providerIdentity === 'config',
        ), pb, num(pb.at), { durationMs: num(pb.durationMs), output: num(pb.measuredOutput) });
      }
    } else if (c.usage && typeof c.usage === 'object') {
      // An assistant message — attribute to the identity it recorded. Empty fields are resolved from the
      // session only by the SQL reader, which still has that session row; the persisted rollup never guesses.
      fold(bucketFor(
        typeof c.provider === 'string' ? c.provider : '',
        typeof c.model === 'string' ? c.model : '',
        c.providerIdentity === 'config',
      ), c.usage, typeof c.timestamp === 'number' ? c.timestamp : 0, { durationMs: num(c.durationMs), output: num(c.usage.output) });
    }
  }
  const buckets = [...byIdentity.values()].filter((b) => b.totalTokens !== 0 || b.cost != null);
  if (buckets.length === 0) return null;
  // A legacy row with no numeric `$.timestamp` is already invisible to the day/model views (`ts IS NOT
  // NULL`), so its bucket must stay undated too: dating it — to the compaction moment or anything else —
  // would make compaction ADD spend to a day the session never spent it on. Undated stays undated, on
  // both sides of a compaction; the tokens still count wherever no date is required (descendantUsage).
  for (const b of buckets) if (b.at === 0) delete b.at;
  return buckets;
}

/** Persisted usage-accounting views over the brain message store: per-day and per-model spend for the
 *  Stats dashboard, and per-tree descendant totals. Extracted from {@link BrainStore} (which delegates to
 *  it) — it shares only the {@link Db} handle. Reads the normalized {@link USAGE_ROWS} (live assistant
 *  `$.usage` + per-model compaction rollups), so a compacted session's history keeps its spend. */
export class BrainUsageStore {
  private readonly viewCache = new Map<string, ViewCacheEntry>();

  constructor(
    private db: Db,
    private readonly now: () => number = Date.now,
    /** Does the task domain currently have an OWNER, i.e. does /usage/* merge task snapshots at all?
     *  Supplied by the daemon (which alone knows the live plugin registry); a process that has no such
     *  notion — a unit test, a store opened on its own — omits it and the answer falls back to the table
     *  itself. Read per query, never cached: enabling the plugin swaps the owner inside a LIVE process. */
    private readonly taskDomainOwned?: () => boolean,
  ) {}

  /** Is a `brain-task-*` worker's spend accounted for SOMEWHERE ELSE — i.e. may these views hide it?
   *  Two conditions, both required. The table must exist (a fresh install with the work plugin disabled
   *  never created it), and the domain must have an OWNER: the snapshots are merged into /usage/* by the
   *  owner's aggregate, so with no owner nothing reports them and hiding the worker's rows here would
   *  delete real spend from every statistic instead of deduplicating it. Keying on the table alone was
   *  exactly that bug — disabling the plugin drops no table, so the money vanished from both halves.
   *  The sqlite_master read is a lookup, nothing beside the full brain_messages scans these views run. */
  private hasTaskUsage(): boolean {
    if (this.taskDomainOwned && !this.taskDomainOwned()) return false;
    return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_usage'").get();
  }

  /** Strip this user's recorded spend from the rows the Stats charts are derived from. Chat spend has no
   *  separate snapshot to delete — it is read back out of the conversation itself — so clearing it means
   *  rewriting those rows. Only the accounting is removed; message text, model and timestamp stay, so
   *  conversations stay readable and compaction summaries keep their content. NOT reversible: the
   *  per-message token counts and costs are gone afterwards.
   *
   *  Both halves of {@link USAGE_ROWS} have to be cleared — live assistant `$.usage` AND the
   *  `$.usageRollup` array a compaction carries — or a compacted session keeps reporting the spend it
   *  rolled up and the charts only look half-reset.
   *
   *  The cache clear is load-bearing: every sentinel is a MAX(rowid)/MAX(updated_at), and rewriting a
   *  column in place moves none of them, so a cached view would serve the old totals until the TTL
   *  lapsed — the reset would appear to do nothing, which is the complaint it exists to answer. */
  clearUsage(userId: number): number {
    const scope = `session_id IN (SELECT id FROM brain_sessions WHERE user_id = ?)`;
    const live = this.db.prepare(
      `UPDATE brain_messages SET content = json_remove(content, '$.usage')
        WHERE ${scope} AND role = 'assistant' AND json_valid(content)
          AND json_type(content) = 'object' AND json_type(content, '$.usage') IS NOT NULL`
    ).run(userId);
    const rollups = this.db.prepare(
      `UPDATE brain_messages SET content = json_remove(content, '$.usageRollup')
        WHERE ${scope} AND role = 'compaction' AND json_valid(content)
          AND json_type(content, '$.usageRollup') = 'array'`
    ).run(userId);
    this.viewCache.clear();
    return live.changes + rollups.changes;
  }

  /** Serve a usage view from the TTL cache when the sentinel proves nothing changed, else compute and
   *  remember it. No single-flight coalescing on top: better-sqlite3 is synchronous, so concurrent HTTP
   *  requests serialize on the event loop anyway and there is no parallel computation to deduplicate —
   *  the cache itself is the whole win. No stale-on-error either: unlike the upstream-fetch cache this
   *  pattern is borrowed from, a local SQL read has no transient failure mode worth riding out, and a
   *  genuinely broken database should surface errors, not hide behind last-known numbers. */
  private cachedView<T>(key: string, compute: () => T): T {
    const sentinel = this.db.prepare(usageSentinelSql(this.hasTaskUsage())).get() as UsageSentinel;
    const hit = this.viewCache.get(key);
    if (hit && this.now() - hit.at < USAGE_VIEW_TTL_MS
        && hit.sentinel.m === sentinel.m && hit.sentinel.s === sentinel.s
        && hit.sentinel.su === sentinel.su && hit.sentinel.tu === sentinel.tu) {
      return hit.value as T;
    }
    const value = compute();
    if (this.viewCache.size >= VIEW_CACHE_LIMIT && !this.viewCache.has(key)) this.viewCache.clear();
    this.viewCache.set(key, { at: this.now(), sentinel, value });
    return value;
  }

  /** Per-day token/cost totals of the user's OWN brain chat sessions (NOT task worker or channel-anchor
   *  sessions) over the last `days` days, for the dashboard spend tiles — task_usage only covers task
   *  workers, so without this a paid chat model burned money invisibly. `brain-task-%` sessions are
   *  excluded only when already snapshotted in task_usage (see {@link taskSnapshotExclusion}). */
  usageByDay(userId: number, days = 7): { day: string; tokens: number; cost: number | null }[] {
    const daysArg = `-${Math.max(0, Math.floor(days) - 1)} days`;
    return this.cachedView(`byDay${userId}${daysArg}`, () => this.db.prepare(
      `WITH usage_rows AS (${USAGE_ROWS})
       SELECT date(ts / 1000, 'unixepoch') AS day,
              COALESCE(SUM(total), 0) AS tokens,
              CASE WHEN COUNT(cost) = 0 THEN NULL ELSE SUM(cost) END AS cost
         FROM usage_rows
        WHERE user_id = ?
          AND ts IS NOT NULL
          AND ${taskSnapshotExclusion(this.hasTaskUsage())}
          AND date(ts / 1000, 'unixepoch') >= date('now', ?)
        GROUP BY day ORDER BY day`
    ).all(userId, daysArg) as { day: string; tokens: number; cost: number | null }[]);
  }

  /** Total token/cost usage of the user's OWN brain CHAT sessions aggregated per executor identity, for
   *  the web Stats page's /usage/by-model view — the analogue of usageByDay, so chat spend on a paid
   *  model is no longer invisible there. Groups the normalized USAGE_ROWS by the provider + model that
   *  ACTUALLY produced each assistant row (its own fields, or a rollup bucket's) — NOT the session's
   *  current selection, so switching a conversation's model never retroactively re-attributes its history.
   *  A missing provider remains an explicit legacy `elowen:<model>` bucket; it is neither discarded nor
   *  merged into any canonical `<provider>/<model>` identity. `brain-task-%` sessions are excluded only
   *  when already snapshotted in
   *  task_usage (taskSnapshotExclusion); platform channel sessions (Discord) ARE included — the operator
   *  anchors them, so their spend counts as the operator's. Brain chat cost is OpenRouter provider-reported, so a costed
   *  bucket is `provider_reported`; an uncosted one is `unavailable` (costUsd null), matching usageByDay's
   *  null-vs-real-$0 distinction. Optional `window` narrows by each row's own attribution timestamp (ms
   *  epoch), same basis as usageByDay; undated rows are excluded from BOTH the windowed and unwindowed
   *  view (`ts IS NOT NULL`) so windowed totals always sum to the unwindowed total. A bucket comes back
   *  if it has any tokens OR any cost (a provider that reports cost with zero tokens still counts). */
  usageByModel(userId: number, window?: { fromIso?: string; toIso?: string }): ModelUsage[] {
    const clauses = [`user_id = ?`, `ts IS NOT NULL`, `model != ''`, taskSnapshotExclusion(this.hasTaskUsage())];
    const params: (string | number)[] = [userId];
    const fromMs = window?.fromIso ? Date.parse(window.fromIso) : NaN;
    const toMs = window?.toIso ? Date.parse(window.toIso) : NaN;
    if (Number.isFinite(fromMs)) { clauses.push(`ts >= ?`); params.push(fromMs); }
    if (Number.isFinite(toMs)) { clauses.push(`ts <= ?`); params.push(toMs); }
    // Key on the PARSED bounds so two ISO spellings of the same instant share one entry.
    return this.cachedView(`byModel${userId}${fromMs}${toMs}`, () => {
      interface Row { provider: string | null; model: string; input: number; output: number; cache_read: number; cache_write: number; total: number; reasoning: number; measured_output: number; duration_ms: number; cost: number | null }
      const rows = this.db.prepare(
        `WITH usage_rows AS (${USAGE_ROWS})
         SELECT provider AS provider, model AS model,
                COALESCE(SUM(input), 0) AS input,
                COALESCE(SUM(output), 0) AS output,
                COALESCE(SUM(cache_read), 0) AS cache_read,
                COALESCE(SUM(cache_write), 0) AS cache_write,
                COALESCE(SUM(total), 0) AS total,
                COALESCE(SUM(reasoning), 0) AS reasoning,
                COALESCE(SUM(measured_output), 0) AS measured_output,
                COALESCE(SUM(CASE WHEN measured_output > 0 THEN duration_ms ELSE 0 END), 0) AS duration_ms,
                CASE WHEN COUNT(cost) = 0 THEN NULL ELSE SUM(cost) END AS cost
           FROM usage_rows
          WHERE ${clauses.join(' AND ')}
          GROUP BY provider, model`
      ).all(...params) as Row[];
      return rows
        .filter((r) => r.total > 0 || (r.cost ?? 0) > 0)
        .map((r) => {
          const costSource: CostSource = r.cost != null ? 'provider_reported' : 'unavailable';
          const usage: TokenUsage = {
            input: r.input, output: r.output, cacheRead: r.cache_read, cacheWrite: r.cache_write,
            total: r.total, reasoning: r.reasoning, costUsd: r.cost, currency: r.cost != null ? 'USD' : null, costSource,
            // Weighted average over ONLY the generations that carried BOTH timing and output — untimed
            // legacy rows and aborts contribute to neither side, so they can neither inflate nor dilute it
            // (and a bucket with nothing measured reports null, not a bogus figure). `measuredOutput` ships
            // with the rate because `output` is the WRONG weight for it: a consumer averaging across buckets
            // needs the measured seconds, which are measuredOutput / outputTps.
            measuredOutput: r.measured_output,
            outputTps: r.duration_ms > 0 ? (r.measured_output / (r.duration_ms / 1000)) : null,
          };
          const exec = r.provider
            ? execRefSpec({ program: 'elowen', provider: r.provider, model: r.model })
            : `elowen:${r.model}`;
          return { id: exec, exec, program: 'elowen', provider: r.provider, model: r.model, usage };
        });
    });
  }

  /** Sum every persisted descendant of `sessionId` (direct child + arbitrary nested delegates) from
   *  the SAME normalized rows used by the global usage views. This includes compaction `usageRollup`
   *  buckets, so archiving old child context never makes its spend disappear. The root itself is
   *  intentionally excluded: its live PI session remains authoritative for its own statusline usage.
   *  No task-snapshot exclusion applies here — this is one conversation tree, not the global task/chat
   *  merge. The owner predicate is defensive against a manually-corrupted cross-user relation. */
  descendantUsage(sessionId: string): BrainDescendantUsage {
    interface Row {
      input: number; output: number; cache_read: number; cache_write: number;
      total: number; reasoning: number; cost: number;
    }
    const row = this.db.prepare(
      `WITH RECURSIVE descendants(id, user_id) AS (
         SELECT child.id, child.user_id
           FROM brain_sessions child
           JOIN brain_sessions root ON root.id = ?
          WHERE child.parent_session_id = root.id AND child.user_id = root.user_id
         UNION
         SELECT child.id, child.user_id
           FROM brain_sessions child JOIN descendants parent ON child.parent_session_id = parent.id
          WHERE child.user_id = parent.user_id
       ), usage_rows AS (${USAGE_ROWS})
       SELECT COALESCE(SUM(u.input), 0) AS input,
              COALESCE(SUM(u.output), 0) AS output,
              COALESCE(SUM(u.cache_read), 0) AS cache_read,
              COALESCE(SUM(u.cache_write), 0) AS cache_write,
              COALESCE(SUM(u.total), 0) AS total,
              COALESCE(SUM(u.reasoning), 0) AS reasoning,
              COALESCE(SUM(u.cost), 0) AS cost
         FROM usage_rows u JOIN descendants d ON d.id = u.session_id`
    ).get(sessionId) as Row;
    return {
      input: row.input, output: row.output, cacheRead: row.cache_read, cacheWrite: row.cache_write,
      totalTokens: row.total, reasoning: row.reasoning, cost: row.cost,
    };
  }
}
