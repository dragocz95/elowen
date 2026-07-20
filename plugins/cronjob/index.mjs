// Cronjob plugin: recurring prompts for the brain, sized for Elowen.
// Jobs persist in the plugin's data dir; a lightweight scheduler (platform adapter) ticks every 30 s
// and feeds due prompts back into the brain via the host's channel handler — with `admin: true`,
// because only an admin session can create jobs in the first place.
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

// `exec` runs the command through the PLATFORM default shell (/bin/sh -c on POSIX, cmd.exe /d /s /c on
// Windows), so a job's check collector works cross-platform — hardcoding /bin/sh broke every cron on
// Windows, which has no /bin/sh. Jobs are admin-only, so the shell command is trusted (as it always was).
const execAsync = promisify(exec);
// Scheduler defaults — user-overridable via configSchema (see register()); these are the values used
// when a key is unset, and stay the source of truth the existing tests rely on.
const DEFAULT_TICK_MS = 30_000;
const DEFAULT_CHECK_TIMEOUT_MS = 60_000; // a guard shell must finish fast; a hung check never blocks the tick loop
const CHECK_MAX_BUFFER = 1024 * 1024; // 1 MB of stdout is plenty of "what's new" to hand the brain
// How much of a guard's stdout is fed into the brain turn. A collector that aggregates real data (a full
// debtor list, a daily digest) easily runs past a few KB, so the cap is generous; it only trims runaway output.
const DEFAULT_CHECK_OUTPUT_CHARS = 32_000;
const DEFAULT_CRON_TURN_ATTEMPTS = 2; // one retry on a request-time failure (a transient relay/gateway/network blip)
const DEFAULT_CRON_RETRY_BACKOFF_MS = 3_000; // brief pause before the retry so the transient condition can clear
// The per-turn idle rollover forwarded to the host as access.sessionIdleMs. It is OPT-IN, not defaulted:
// leaving the config key unset means the job's channel session rolls over under the host's own shared
// default (SESSION_IDLE_ROLLOVER_MS, Discord's 30 min) — the same as every other channel — so an
// existing recurring job never silently loses its cross-run context after an upgrade. See resolveSessionIdleMs.
const SESSION_IDLE_MIN_MS = 60_000; // an explicit value is clamped UP to a 1-min floor; there is no upper clamp
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Read a number config field, falling back to `def` when unset/invalid, then clamp to [min, max]. */
const clampConfig = (value, def, min, max) => Math.min(Math.max(Number(value) || def, min), max);

// ── Wall-clock time, in the OPERATOR's timezone ──────────────────────────────
// Every schedule here is a statement about the user's wall clock: "daily 07:30" means 07:30 where THEY
// live, not wherever the server happens to be hosted. So none of this may use the process's local time —
// it resolves each instant's fields in the configured zone via Intl (no dependency, same mechanism the
// injected date/time context uses). The host default is the machine's own zone, which reproduces exactly
// the behaviour these schedules had before the setting existed.
const systemZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

// Constructing a DateTimeFormat is FAR more expensive than using one, and the catch-up scan below can ask
// for up to a day of minutes per job per tick. Build one formatter per zone and keep it.
const formatters = new Map();
const formatterFor = (timezone) => {
  let fmt = formatters.get(timezone);
  if (!fmt) {
    const options = {
      hour12: false, weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    };
    // A timezone the operator typed by hand can be nonsense, and Intl THROWS on an unknown zone. Every
    // schedule flows through here, so letting that escape would take the whole scheduler down over a typo.
    // Fall back to the machine's zone — jobs keep running, an hour or two off, rather than not at all.
    try {
      fmt = new Intl.DateTimeFormat('en-US', { ...options, timeZone: timezone });
    } catch {
      fmt = new Intl.DateTimeFormat('en-US', options);
    }
    formatters.set(timezone, fmt);
  }
  return fmt;
};

/** The wall-clock fields of instant `ms` as seen in `timezone`. */
export function zonedParts(ms, timezone) {
  const parts = formatterFor(timezone)
    .formatToParts(new Date(ms))
    .reduce((acc, p) => ((acc[p.type] = p.value), acc), {});
  return {
    year: Number(parts.year),
    month: Number(parts.month),         // 1-12, like cron
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,      // some ICU builds render midnight as "24"
    minute: Number(parts.minute),
    weekday: WEEKDAYS.indexOf(String(parts.weekday).toLowerCase().slice(0, 3)), // 0 = Sunday
  };
}

/** The instant at which a given wall clock occurs in `timezone`. Guess UTC, measure how far off the zone
 *  renders it, correct — twice, so a guess that lands on the far side of a DST change still converges. */
export function zonedTimeToMs(timezone, year, month, day, hour, minute) {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let ms = target;
  for (let i = 0; i < 2; i += 1) {
    const p = zonedParts(ms, timezone);
    const rendered = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    ms = target - (rendered - ms);
  }
  return ms;
}

/** The wall-clock MINUTE an instant falls in ("2026-10-25T02:30"), in `timezone`. Two different instants
 *  share one key exactly when they are the same time on the clock — which is what makes it the right
 *  identity for "has this scheduled slot already run". */
export function slotKey(ms, timezone) {
  const p = zonedParts(ms, timezone);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** Resolve the optional per-job session-idle knob into what the host expects as access.sessionIdleMs:
 *   - unset / blank / invalid → undefined: the override is OMITTED, so the host applies its shared
 *     SESSION_IDLE_ROLLOVER_MS default (same rollover behavior as Discord — never wipes context per tick).
 *   - explicit 0 → Infinity: rollover DISABLED for this job's channel, so a slow job that must keep
 *     continuity across runs is never rotated.
 *   - explicit > 0 → clamped UP to a 1-min floor (SESSION_IDLE_MIN_MS), with NO upper clamp, so an
 *     operator can set an arbitrarily long window to opt back into keep-continuity behavior. */
export function resolveSessionIdleMs(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return undefined; // garbage → treat as unset (host default)
  if (n === 0) return Infinity; // explicit off
  return Math.max(n, SESSION_IDLE_MIN_MS);
}

/** Run a job's optional cheap guard command and classify the outcome, so the scheduler can decide
 *  whether the (expensive) brain turn is even worth running. Admin-authored (jobs are admin-only), run
 *  through the platform default shell like the brain's own Bash. Returns:
 *   - { skip:true }  → nothing to do (empty stdout) or the check errored → DON'T spend an LLM turn.
 *   - { skip:false, output } → fresh data on stdout → run the brain turn and feed it this output. */
export async function runCheck(command, logger, timeoutMs = DEFAULT_CHECK_TIMEOUT_MS) {
  try {
    const { stdout } = await execAsync(command, {
      timeout: timeoutMs, maxBuffer: CHECK_MAX_BUFFER, encoding: 'utf-8',
    });
    const output = String(stdout ?? '').trim();
    if (!output) return { skip: true, reason: 'nothing new' };
    return { skip: false, output };
  } catch (e) {
    // A non-zero exit or timeout means the guard couldn't confirm new work — skip rather than run the
    // brain on a broken signal (and never crash the tick loop).
    logger?.warn?.(`cron check failed: ${e?.message ?? e}`);
    return { skip: true, reason: `check failed: ${e?.message ?? e}` };
  }
}
const ok = (text) => ({ content: [{ type: 'text', text }], details: {} });
const fail = (e) => ok(`Error: ${e instanceof Error ? e.message : String(e)}`);

/** Runtime footer for a delivered cron result — `-# model · 42 %` (Discord subtext), built from the
 *  turn's idle event (model id + context fill). Empty when the turn reported no usable numbers. Mirrors
 *  the streaming reply's footer in the discord plugin so proactive cron pushes read the same. */
export function cronFooter(idle) {
  const parts = [];
  const model = typeof idle?.model === 'string' ? idle.model.split('/').pop() : '';
  if (model) parts.push(model);
  const pct = idle?.usage?.percent;
  if (typeof pct === 'number' && pct >= 0) parts.push(`${Math.round(pct)} %`);
  return parts.length ? `-# ${parts.join(' · ')}` : '';
}

/** Resolve a one-shot spec — "in 20s", "in 20m", "in 2h", "at 18:30" (today, or tomorrow when past) —
 *  to an absolute run time in ms, relative to `now`. "at HH:MM" is the USER's wall clock, so it resolves in
 *  their timezone. Returns null when the spec isn't a one-shot. */
export function parseOneShot(spec, now, timezone = systemZone()) {
  let m = /^in\s+(\d+)\s*(s|m|h)$/i.exec(spec.trim());
  if (m) {
    const unit = m[2].toLowerCase();
    const ms = Number(m[1]) * (unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 1_000);
    // Seconds are allowed from 5 s (the 30 s tick quantizes anyway); minutes/hours keep the 1 min floor.
    return ms >= (unit === 's' ? 5_000 : 60_000) ? now + ms : null;
  }
  m = /^at\s+([01]?\d|2[0-3]):([0-5]\d)$/i.exec(spec.trim());
  if (m) {
    const today = zonedParts(now, timezone);
    let at = zonedTimeToMs(timezone, today.year, today.month, today.day, Number(m[1]), Number(m[2]));
    // "at 20:31" asked at 20:31:02 means NOW, not tomorrow — a time up to 5 min in the past fires ASAP
    // (the model often echoes the current wall-clock minute, which has just slipped past).
    if (at <= now && now - at <= 300_000) return now + 1_000;
    // Further past today → the same wall-clock time tomorrow. Stepping the DATE (not adding 24h) is what
    // keeps "at 07:30" at 07:30 across a DST change, instead of drifting to 06:30 or 08:30.
    if (at <= now) {
      const tomorrow = zonedParts(now + 86_400_000, timezone);
      at = zonedTimeToMs(timezone, tomorrow.year, tomorrow.month, tomorrow.day, Number(m[1]), Number(m[2]));
    }
    return at;
  }
  return null;
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// How far back a cron schedule may catch up after downtime. The human-readable "daily 07:30" form already
// fires late (isDue only checks that today's slot has passed), and a cron job must not be the one form that
// silently skips its run because the daemon happened to be restarting at 09:00. Bounded at a day so a
// long outage replays at most one occurrence, never a backlog.
const CRON_LOOKBACK_MS = 24 * 3_600_000;

/** Parse ONE cron field into the set of values it matches: a wildcard, a single value, a range, any of
 *  those with a step suffix (e.g. a wildcard every 15), and comma-separated lists of them. `names`
 *  (weekday/month abbreviations) are folded to their numbers. Returns null on anything malformed — the
 *  caller then rejects the whole expression rather than silently matching a field it did not understand. */
export function parseCronField(spec, min, max, names, wrapValue) {
  const text = String(spec ?? '').trim().toLowerCase();
  if (!text) return null;
  const values = new Set();
  // One extra accepted value above `max` that folds back to `min` — cron's Sunday, which is both 0 and 7.
  const ceiling = wrapValue === undefined ? max : wrapValue;
  const wrap = (v) => (v === wrapValue ? min : v);
  // `names` is indexed FROM the field's own minimum: weekdays start at sun=0 (min 0), months at jan=1
  // (min 1). Using the raw array index would put every month one too low — "feb" would fire in January and
  // "jan" would be rejected outright for falling below the minimum.
  const num = (token) => {
    const named = names ? names.indexOf(token) : -1;
    const n = named >= 0 ? named + min : (/^\d+$/.test(token) ? Number(token) : NaN);
    return Number.isInteger(n) ? n : NaN;
  };
  for (const part of text.split(',')) {
    const slices = part.split('/');
    if (slices.length > 2) return null; // "1-5/2/3" is not a thing
    const [range, stepText] = slices;
    if (stepText !== undefined && !/^\d+$/.test(stepText)) return null;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (step < 1) return null;
    let lo;
    let hi;
    if (range === '*') {
      lo = min; hi = max;
    } else if (range.includes('-')) {
      const bounds = range.split('-');
      if (bounds.length !== 2) return null; // "1-3-5" is malformed, not silently "1-3"
      const [a, b] = bounds;
      lo = num(a); hi = num(b);
    } else {
      lo = num(range);
      // A bare value with a step means "from here to the end" (`5/15` = 5,20,35,50) — standard cron.
      hi = stepText === undefined ? lo : max;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo > hi) return null;
    if (lo < min || hi > ceiling) return null;
    for (let v = lo; v <= hi; v += step) values.add(wrap(v));
  }
  return values.size ? values : null;
}

/** Parse a standard 5-field cron expression (minute hour day-of-month month day-of-week, e.g. "0 9 * * 1-5"
 *  or "0 0 1 * *"). Null when it is not five fields or any field is malformed — so the caller can fall
 *  through to the human-readable forms. */
export function parseCron(spec) {
  const fields = String(spec ?? '').trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minute = parseCronField(fields[0], 0, 59);
  const hour = parseCronField(fields[1], 0, 23);
  const dayOfMonth = parseCronField(fields[2], 1, 31);
  const month = parseCronField(fields[3], 1, 12, MONTHS);
  const dayOfWeek = parseCronField(fields[4], 0, 6, WEEKDAYS, 7); // 7 is cron's other name for Sunday
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return null;
  return {
    kind: 'cron', minute, hour, dayOfMonth, month, dayOfWeek,
    // Cron's one famous quirk: when BOTH day-of-month and day-of-week are restricted, a date matches if
    // EITHER does (not both). A field is "restricted" only when it does not START with a wildcard — Vixie
    // counts `*/2` as unrestricted too, so pairing it with a weekday must AND, not OR (an OR there would
    // fire the job on days it was never asked for).
    domRestricted: !fields[2].trim().startsWith('*'),
    dowRestricted: !fields[4].trim().startsWith('*'),
  };
}

/** Whether a cron schedule fires in the minute instant `ms` falls in, read on the USER's wall clock. */
export function cronMatches(sched, ms, timezone = systemZone()) {
  const at = zonedParts(ms, timezone);
  if (!sched.minute.has(at.minute)) return false;
  if (!sched.hour.has(at.hour)) return false;
  if (!sched.month.has(at.month)) return false;
  const dom = sched.dayOfMonth.has(at.day);
  const dow = sched.dayOfWeek.has(at.weekday);
  // Both restricted → OR (the cron quirk). Otherwise the restricted one alone decides; an unrestricted
  // field always matches, so a plain AND is correct there.
  if (sched.domRestricted && sched.dowRestricted) return dom || dow;
  return dom && dow;
}

/** The most recent minute at or before `now` at which `sched` fired, provided it is strictly newer than
 *  `after` (the job's last run). Null when the job already ran its latest occurrence — i.e. not due. The
 *  scan walks back one REAL minute at a time and reads each one on the user's wall clock, so a DST shift
 *  simply moves which instants carry which clock time — no arithmetic to get wrong. It stops at `after` or
 *  the lookback bound, so it costs at most one day of minutes and gives a cron job the same
 *  catch-up-after-downtime behavior the daily form has. */
export function lastCronOccurrence(sched, now, after, timezone = systemZone()) {
  const floor = Math.max(after, now - CRON_LOOKBACK_MS);
  let cursor = now - (now % 60_000); // truncate to the minute
  while (cursor > floor) {
    if (cronMatches(sched, cursor, timezone)) return cursor;
    cursor -= 60_000;
  }
  return null;
}

/** Parse "every 15m" / "every 2h" / "daily 07:30" / "weekly sun 20:00", or a standard 5-field cron
 *  expression, into a matcher. Null = invalid.
 *
 *  The two formats are told apart structurally, not by a flag: every human-readable form starts with a
 *  keyword and none of them has five whitespace-separated fields, so a 5-field spec can only be cron. That
 *  keeps auto-detection unambiguous and means an existing job's schedule string still parses exactly as
 *  it did before. */
export function parseSchedule(spec) {
  let m = /^every\s+(\d+)\s*(m|h)$/i.exec(spec.trim());
  if (m) {
    const ms = Number(m[1]) * (m[2].toLowerCase() === 'h' ? 3_600_000 : 60_000);
    if (ms < 60_000) return null;
    return { kind: 'interval', ms };
  }
  m = /^daily\s+([01]?\d|2[0-3]):([0-5]\d)$/i.exec(spec.trim());
  if (m) return { kind: 'daily', hour: Number(m[1]), minute: Number(m[2]) };
  m = /^weekly\s+(sun|mon|tue|wed|thu|fri|sat)\s+([01]?\d|2[0-3]):([0-5]\d)$/i.exec(spec.trim());
  if (m) return { kind: 'weekly', day: WEEKDAYS.indexOf(m[1].toLowerCase()), hour: Number(m[2]), minute: Number(m[3]) };
  return parseCron(spec);
}

/** Whether a job reply means "nothing to say". Older prompts answer `[SILENT]`, ours say
 *  `NOTHING_TO_REPORT` — and models love wrapping either in backticks/bold, so match leniently. */
export function isQuietReply(reply) {
  return /^[`*_\s]*(NOTHING_TO_REPORT|\[SILENT\])[`*_\s]*$/i.test(String(reply ?? '').trim());
}

/** Whether `now` falls inside a job's optional "H-H" active-hours window (e.g. '5-21') — on the user's
 *  clock, so "quiet outside 5-21" means quiet outside THEIR evening, not the server's. */
export function inHours(hours, now, timezone = systemZone()) {
  if (!hours) return true;
  const m = /^([01]?\d|2[0-3])\s*-\s*([01]?\d|2[0-3])$/.exec(String(hours).trim());
  if (!m) return true; // malformed guard never blocks the job
  const h = zonedParts(now, timezone).hour;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a <= b ? h >= a && h <= b : h >= a || h <= b; // supports overnight windows like 22-5
}

/** The scheduled SLOT this job is due for at `now`, or null when it is not due. The slot is a wall-clock
 *  minute key ("2026-10-25T02:30"); the tick records it, and a job never runs the same slot twice.
 *
 *  That identity is what makes the autumn DST change behave: the hour that repeats produces two different
 *  INSTANTS carrying the same clock time, so comparing instants alone would fire "daily 02:30" twice that
 *  night. Comparing the slot fires it once, which is what the user asked for. (In spring that clock time
 *  does not exist at all and the job is skipped for the day — standard cron behaviour.) */
export function dueSlot(job, now, timezone = systemZone()) {
  if (job.enabled === false) return null;
  // One-shots are consumed by deletion, not by a slot — they fire exactly once, at an absolute instant.
  if (job.runAt) return (!job.lastRun && now >= Date.parse(job.runAt)) ? slotKey(now, timezone) : null;
  if (!inHours(job.hours, now, timezone)) return null;
  const sched = parseSchedule(job.schedule);
  if (!sched) return null;
  const last = job.lastRun ? Date.parse(job.lastRun) : 0;

  // An interval is a duration, not a wall-clock time — "every 15m" means every 15 minutes, through a DST
  // change and everywhere on earth. It is deliberately the one kind that ignores the calendar entirely.
  if (sched.kind === 'interval') return now - last >= sched.ms ? slotKey(now, timezone) : null;

  const fire = (at) => {
    const slot = slotKey(at, timezone);
    return job.lastSlot === slot ? null : slot;
  };

  if (sched.kind === 'cron') {
    const at = lastCronOccurrence(sched, now, last, timezone);
    return at === null ? null : fire(at);
  }

  // daily / weekly: today's HH:MM on the user's clock. `lastSlot` is absent on jobs created before it
  // existed, so the instant comparison stays as the fallback — an upgrade must not re-fire today's slot.
  const today = zonedParts(now, timezone);
  if (sched.kind === 'weekly' && today.weekday !== sched.day) return null;
  const at = zonedTimeToMs(timezone, today.year, today.month, today.day, sched.hour, sched.minute);
  if (now < at) return null;
  if (job.lastSlot === undefined && last >= at) return null;
  return fire(at);
}

/** Whether a job is due at `now`. See {@link dueSlot} — this is the boolean view of it. */
export function isDue(job, now, timezone = systemZone()) {
  return dueSlot(job, now, timezone) !== null;
}

class CronAdapter {
  name = 'cron';
  // The outbound sink is stored as `deliver`, NOT `notify`: the host broadcasts host-initiated
  // messages to every platform adapter exposing a `notify` method — if this adapter carried one,
  // the broadcast would call back into itself (host → cron → host → …) until the stack blew,
  // multiplying every cron echo into dozens of Discord messages.
  // `timezone` is a LIVE getter, not a captured string: the operator can change the zone in Settings and
  // the very next tick must schedule against it, without a plugin reload.
  constructor(store, logger, deliver, config = {}, timezone = systemZone) {
    this.store = store; this.log = logger; this.deliver = deliver; this.handler = null; this.running = false;
    this.timezone = timezone;
    // Scheduler limits, resolved once from plugin config (see orca-plugin.json's "Scheduler" section) and
    // clamped to sane bounds — unset config reproduces the previous hardcoded defaults exactly.
    this.tickMs = clampConfig(config.tickMs, DEFAULT_TICK_MS, 10_000, 120_000);
    this.turnAttempts = clampConfig(config.retryAttempts, DEFAULT_CRON_TURN_ATTEMPTS, 1, 5);
    this.retryBackoffMs = clampConfig(config.retryBackoffMs, DEFAULT_CRON_RETRY_BACKOFF_MS, 1_000, 30_000);
    this.checkTimeoutMs = clampConfig(config.checkTimeoutMs, DEFAULT_CHECK_TIMEOUT_MS, 10_000, 300_000);
    this.checkOutputMaxChars = clampConfig(config.checkOutputChars, DEFAULT_CHECK_OUTPUT_CHARS, 2_000, 200_000);
    // Idle cutoff forwarded per turn to the host (access.sessionIdleMs). Unset → undefined (host default,
    // like Discord); explicit 0 → Infinity (rollover off); explicit > 0 → clamped up to a 1-min floor,
    // no upper clamp. See resolveSessionIdleMs.
    this.sessionIdleMs = resolveSessionIdleMs(config.sessionIdleMs);
  }
  listen(onMessage) { this.handler = onMessage; }
  async connect() {
    this.timer = setInterval(() => void this.tick().catch((e) => this.log.error(`tick failed: ${e?.message ?? e}`)), this.tickMs);
  }
  disconnect() { clearInterval(this.timer); }
  async send() { /* cron has no outbound channel; results land in the job's conversation */ }

  async tick() {
    // One tick at a time. Jobs run sequentially and each is a (slow) LLM turn, so a due-cluster — e.g. the
    // morning batch of daily reports — can exceed the 30s interval; without this guard the next interval
    // overlaps, double-fires a job and hammers the relay with concurrent turns (a source of transient 400s).
    if (!this.handler || this.running) return;
    this.running = true;
    try {
    const now = Date.now();
    const tz = this.timezone();
    for (const job of this.store.all()) {
      const slot = dueSlot(job, now, tz);
      if (slot === null) continue;
      // One-shot (runAt) jobs are consumed at fire time: remove BEFORE the (long) turn so a daemon crash
      // mid-run can't strand a zombie — a job left with lastRun set but never deleted would neither re-fire
      // (isDue for runAt needs `!lastRun`) nor ever get cleaned up. Deletion IS the dedup, so at-most-once
      // holds even if the turn crashes (a wake-up that starts running is spent — acceptable). Recurring
      // jobs still stamp lastRun before running so a slow turn doesn't re-fire them next tick; they must
      // fire again on their next natural slot. `lastSlot` records WHICH wall-clock slot that was, so the
      // repeated hour of an autumn DST change cannot run the same 02:30 twice.
      if (job.runAt) this.store.save(this.store.all().filter((j) => j.id !== job.id));
      else this.store.patch(job.id, { lastRun: new Date(now).toISOString(), lastSlot: slot });
      // Cheap guard gate: if the job has a `check` command, run it FIRST (no LLM). Only spend a brain
      // turn when the guard surfaces fresh work — an "every 5m" poll that finds nothing costs a shell
      // exec, not a model call. The guard's output is fed into the turn so the brain acts on real data.
      let checkOutput = null;
      if (typeof job.check === 'string' && job.check.trim()) {
        const res = await runCheck(job.check, this.log, this.checkTimeoutMs);
        if (res.skip) {
          this.store.patch(job.id, { lastResult: `⏭️ ${res.reason}` });
          continue; // nothing new (or the guard errored) → skip the brain turn entirely
        }
        checkOutput = res.output;
      }
      this.log.info(`running job ${job.id} (${job.name})`);
      // Capture the turn's idle event (model + context usage) so the proactive push can carry the same
      // runtime footer a streamed reply gets — the handler forwards this onEvent into the brain session.
      let idle = null;
      // Where the host actually ran the turn (its `session` event). When it matches the job's recorded
      // origin, the reply already landed in the originating conversation — no Discord echo needed.
      let deliveredTo = null;
      // Did the turn emit real output (a tool call, assistant text or a diff)? If it did before failing,
      // the run had side effects and must NOT be retried; only a failure that produced nothing is safe.
      let sawWork = false;
      // Hand the brain the guard's fresh output (if any) so it acts on it directly instead of re-running
      // the collector via a tool — the whole point of the gate is one cheap check, not a check + a re-fetch.
      let userText = checkOutput
        ? `${job.prompt}\n\n--- Check output (fresh data to act on) ---\n${checkOutput.slice(0, this.checkOutputMaxChars)}`
        : job.prompt;
      // An origin-bound wake-up replays INTO the user conversation it was scheduled from: frame the
      // prompt so the model knows this is its own earlier schedule firing, not the user speaking now.
      // (The channel fallback keeps its wake-up context via access.prompt; this framing reads fine there too.)
      if (job.originSessionId) userText = `[Scheduled wake-up "${job.name}" fires now — you set it earlier. Do the task and reply now.]\n${userText}`;
      const src = {
        platform: 'cron', userId: 'cron', roleIds: [], channelId: `job-${job.id}`,
        // A wake-up scheduled from a user conversation carries its origin: the host routes it as a
        // bound send into that conversation (ownership-verified host-side, channel path as fallback).
        origin: job.originSessionId && job.originUserId != null ? { sessionId: job.originSessionId, userId: job.originUserId } : undefined,
        access: {
          projectIds: [], admin: true,
          // A timer-driven turn: the host swaps the coding-agent base for the focused `scheduled` system
          // prompt (unattended, channel-only delivery, report the outcome not the progress). Core stays
          // agnostic to which plugin fired it — it keys only off this generic flag.
          scheduled: true,
          // Just identifies THIS job — the `scheduled` prompt carries how to run and report it.
          prompt: `This scheduled ${job.runAt ? 'wake-up' : 'job'} is "${job.name}". Do its task now.`,
          // Optional per-job model — the channel session respawns on it (else the server default runs).
          model: job.model?.provider && job.model?.model ? { provider: job.model.provider, model: job.model.model } : undefined,
          // Per-job idle rollover, forwarded ONLY when configured: unset → key omitted, so the host applies
          // its shared default (like Discord) and cross-run context is preserved; a shorter value rotates a
          // frequent job past the cache window; Infinity (config 0) disables rollover for this job entirely.
          ...(this.sessionIdleMs !== undefined ? { sessionIdleMs: this.sessionIdleMs } : {}),
        },
      };
      const onEvent = (e) => {
        if (e?.type === 'idle') idle = e;
        if (e?.type === 'session') deliveredTo = e.sessionId;
        if (e?.type === 'tool' || e?.type === 'text' || e?.type === 'diff') sawWork = true;
      };
      // Bounded retry: a request-time failure — a transient relay/gateway/network blip that threw before
      // the turn produced any tool or text output — is re-run once after a short backoff, so a momentary
      // upstream hiccup doesn't cost the whole scheduled report. If the turn already did work, deliver the
      // error instead of repeating side effects. Recurring jobs only: a one-shot wake-up is already
      // consumed (deleted) before running, so re-running a spent schedule isn't meaningful. Reset the
      // per-turn accumulators each attempt.
      let reply;
      for (let attempt = 1; ; attempt++) {
        idle = null; deliveredTo = null; sawWork = false;
        try { reply = await this.handler(src, userText, onEvent); break; }
        catch (e) {
          if (attempt < this.turnAttempts && !sawWork && !job.runAt) {
            this.log.warn(`cron job ${job.id} attempt ${attempt} failed (${e?.message ?? e}) — retrying in ${this.retryBackoffMs}ms`);
            await sleep(this.retryBackoffMs);
            continue;
          }
          reply = `Error: ${e?.message ?? e}`;
          break;
        }
      }
      // One-shots were already removed before running; recurring jobs record their last result.
      if (!job.runAt) this.store.patch(job.id, { lastResult: String(reply ?? '').slice(0, 500) });
      const trimmed = String(reply ?? '').trim();
      // Origin-bound delivery: a successful reply already landed (and streamed) in the originating
      // conversation — the conversation IS the delivery, so skip the proactive Discord echo. But a FAILED
      // wake-up (reply starts with "Error:") may have reached no one: the handler can throw AFTER emitting
      // its `session` event, so deliveredTo already matches the origin while nothing actually landed — and
      // if no bound-stream client is attached the user never learns it failed. Echo those to the
      // notification channel so a failed scheduled wake-up is never silently lost.
      if (job.originSessionId && deliveredTo === job.originSessionId && !trimmed.startsWith('Error:')) continue;
      // Echo the outcome to the notification channel (Discord) so it reaches the user proactively.
      // A job with nothing to say answers with a quiet marker (isQuietReply) and stays silent.
      if (trimmed && !isQuietReply(trimmed)) {
        const footer = cronFooter(idle);
        // `plain` jobs deliver the reply as-is (persona messages in a dedicated channel don't want
        // the "⏰ job name" banner); the footer subtext stays — it matches streamed replies.
        const header = job.plain ? '' : `⏰ **${job.name}**\n`;
        // Deliver the full reply: the platform sink chunks anything past one message's limit
        // (Discord splits on line boundaries), so a long report — e.g. a 60-item debtor list —
        // arrives complete across several messages instead of being clipped mid-list.
        const body = `${header}${String(reply)}${footer ? `\n\n${footer}` : ''}`;
        await this.deliver(body, job.notifyChannelId).catch(() => {});
      }
    }
    } finally {
      this.running = false;
    }
  }
}

class JobStore {
  constructor(file) { this.file = file; }
  all() {
    try { return existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf-8')) : []; }
    catch { return []; } // corrupted file → treat as empty, next write repairs it
  }
  save(jobs) { writeFileSync(this.file, JSON.stringify(jobs, null, 2)); }
  patch(id, fields) { this.save(this.all().map((j) => (j.id === id ? { ...j, ...fields } : j))); }
}

export function register(ctx) {
  const store = new JobStore(join(ctx.dataDir(), 'jobs.json'));
  const adminOnly = () => { if (!ctx.isAdminSession()) throw new Error('cron jobs can only be managed from an admin session'); };

  ctx.registerTool(defineTool({
    name: 'CronAdd', label: 'Schedule job',
    description: [
      'Schedule a recurring prompt for yourself — daily summaries, periodic checks, recurring reminders. The prompt fires as a brain turn on the schedule you set, and results go to the default notification channel unless you override it with notifyChannelId. Admin only.',
      'The schedule takes either a plain form — "every 15m", "every 2h", "daily 07:30", "weekly sun 20:00" — or a standard 5-field cron expression ("*/5 * * * *", "0 9 * * 1-5", "0 0 1 * *"). The format is detected automatically; reach for cron only when the plain form cannot express the timing you need.',
      'For polling work, use the `check` guard: a cheap shell command that runs BEFORE the prompt. If it prints nothing (or fails), the scheduled turn is skipped entirely — no model call. If it prints output, the brain runs and receives that output. This is how you poll for new work without paying for a model call on every tick.',
      'Use `hours` ("H-H", e.g. "5-21") to keep a job quiet outside active hours, `enabled: false` to create it paused, and `plain: true` to deliver the reply without the "⏰ job name" header. Returns the job id — pass it to CronRemove to cancel.',
    ].join(' '),
    parameters: Type.Object({
      name: Type.String({ description: 'Short human name for the job, shown in schedules and telemetry' }),
      schedule: Type.String({ description: '"every <N>m", "every <N>h", "daily HH:MM", "weekly <mon..sun> HH:MM", or a 5-field cron expression (e.g. "0 9 * * 1-5")' }),
      prompt: Type.String({ description: 'The prompt to run on schedule' }),
      check: Type.Optional(Type.String({ description: 'Optional cheap shell guard run BEFORE the prompt. If it prints nothing (or fails), the scheduled brain turn is skipped — no LLM call. If it prints output, the brain runs and receives that output. Use it to poll for new work without paying for a model call each tick, e.g. a collector script that only prints when there is something new.' })),
      hours: Type.Optional(Type.String({ description: 'Active-hours window "H-H" (e.g. "5-21") — outside it the job stays quiet' })),
      notifyChannelId: Type.Optional(Type.String({ description: 'Deliver results to this channel/thread instead of the default notification channel' })),
      plain: Type.Optional(Type.Boolean({ description: 'true = deliver the reply as-is, without the "⏰ job name" header line — for persona messages in a dedicated channel' })),
      model: Type.Optional(Type.String({ description: 'Run this job on a specific brain model, as "provider/model" (e.g. "anthropic/claude-sonnet-5"). Empty = the server default.' })),
      enabled: Type.Optional(Type.Boolean({ description: 'false = create the job paused' })),
    }),
    execute: async (_id, p) => {
      try {
        adminOnly();
        if (!parseSchedule(p.schedule)) return ok('Error: invalid schedule — use "every 15m", "every 2h", "daily 07:30", "weekly sun 20:00", or a 5-field cron expression like "0 9 * * 1-5".');
        const jobs = store.all();
        const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        // "provider/model" → {provider, model}; a bare or malformed value is ignored (server default runs).
        const slash = typeof p.model === 'string' ? p.model.indexOf('/') : -1;
        const model = slash > 0 ? { provider: p.model.slice(0, slash), model: p.model.slice(slash + 1) } : undefined;
        // lastRun starts at creation time so a fresh job waits for its NEXT natural slot — a
        // "daily 06:00" created at 15:00 must not fire immediately.
        jobs.push({ id, name: p.name, schedule: p.schedule, prompt: p.prompt, check: p.check, hours: p.hours, notifyChannelId: p.notifyChannelId, plain: p.plain, model, enabled: p.enabled, createdAt: new Date().toISOString(), lastRun: new Date().toISOString() });
        store.save(jobs);
        return ok(`Scheduled "${p.name}" (${p.schedule}) — id ${id}. Results accumulate in its own conversation.`);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'ScheduleWakeup', label: 'Schedule wake-up',
    description: [
      'Schedule a ONE-SHOT wake-up for yourself after a delay ("in 30s", "in 20m", "in 2h") or at a time ("at 18:30") to run a prompt. Strictly one-shot — the job removes itself after firing. Scheduled from a user conversation, the wake-up resumes THAT conversation with its full existing context and replies there, so the follow-up lands where it was promised. Admin only.',
      'Use it to check back on / verify something that changes over time but does not notify you — a CI run, a deploy, an external queue — in the same conversation. Do NOT use it to poll background work you started here: a background sub-agent and a background command both wake you on their own when they finish, so a wake-up on top of them only fires redundantly. If you want a safety net for work that might hang, set a LONG fallback ("in 30m") rather than a short poll.',
      'Pick the delay from how fast the watched thing actually changes, not from round numbers: a CI run that takes ~8 minutes deserves one "in 5m" check, not ten at 30s. For an idle tick with no specific signal, 20-30 minutes is the sane default.',
    ].join(' '),
    parameters: Type.Object({
      name: Type.String({ description: 'Short, specific human name — "check-deploy" beats "wakeup". Shown in schedules and telemetry.' }),
      when: Type.String({ description: '"in <N>s", "in <N>m", "in <N>h" or "at HH:MM"' }),
      prompt: Type.String({ description: 'What to do when you wake up. From a user conversation the wake-up resumes that same thread with its full context, so write a short note to your future self — what to check and what to do with the result ("verify deploy #142 finished; report the outcome"), not a recap of the conversation. Only a wake-up scheduled outside a user conversation runs standalone with just this prompt, so make it self-contained then.' }),
    }),
    execute: async (_id, p) => {
      try {
        adminOnly();
        const runAt = parseOneShot(p.when, Date.now(), ctx.timezone());
        if (!runAt) return ok('Error: invalid time — use "in 30s", "in 20m", "in 2h" or "at 18:30".');
        const jobs = store.all();
        const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        // A wake-up scheduled from a USER conversation records its origin: at fire time the host runs
        // the prompt as a bound send into that conversation, so the reply lands where it was asked for.
        // Channel/cron-originated schedules (session id `brain-ch-…`/`brain-task-…`, or no session at
        // all) keep no origin and deliver through the notification channel as before.
        const sid = ctx.currentSessionId();
        const uid = ctx.currentIdentity()?.elowenUserId;
        const origin = sid && uid != null && !sid.startsWith('brain-ch-') && !sid.startsWith('brain-task-')
          ? { originSessionId: sid, originUserId: uid } : undefined;
        jobs.push({ id, name: p.name, schedule: p.when, prompt: p.prompt, runAt: new Date(runAt).toISOString(), createdAt: new Date().toISOString(), ...origin });
        store.save(jobs);
        return ok(`Wake-up "${p.name}" set for ${new Date(runAt).toISOString()} — id ${id}.${origin ? ' It will reply in this conversation.' : ''}`);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'CronList', label: 'List jobs',
    description: 'List scheduled jobs with their id, name, schedule, last run and last result. Admin only. '
      + 'Use it to see what is active, when each job last fired and what it produced — and to get the id you need for CronRemove.',
    parameters: Type.Object({}),
    execute: async () => {
      try {
        adminOnly();
        const jobs = store.all();
        if (jobs.length === 0) return ok('No scheduled jobs.');
        return ok(jobs.map((j) =>
          `- ${j.id} "${j.name}" ${j.schedule}${j.runAt ? ` (one-shot @ ${j.runAt})` : ''}\n  last run: ${j.lastRun ?? 'never'}\n  last result: ${j.lastResult ?? '—'}`
        ).join('\n'));
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'CronRemove', label: 'Remove job',
    description: 'Remove a scheduled job by id. It stops firing immediately. Admin only. '
      + 'Get the id from CronList, or from what CronAdd returned.',
    parameters: Type.Object({ id: Type.String({ description: 'Job id, from CronList or CronAdd' }) }),
    execute: async (_id, p) => {
      try {
        adminOnly();
        const jobs = store.all();
        if (!jobs.some((j) => j.id === p.id)) return ok(`Error: no job with id ${p.id}.`);
        store.save(jobs.filter((j) => j.id !== p.id));
        return ok(`Removed job ${p.id}.`);
      } catch (e) { return fail(e); }
    },
  }));

  // The retention janitor's seam (the host reads it via registry.control('cron')): which of this user's
  // conversations still have a PENDING wake-up scheduled INTO them. Only ScheduleWakeup ever records an
  // origin, and a one-shot is deleted at fire time (and by CronRemove), so presence in the store IS
  // pendingness. The janitor must not purge these conversations — the wake-up would lose its context
  // and fall back to the notification channel.
  ctx.registerControl('cron', {
    pendingWakeupOriginSessionIds: (userId) => store.all()
      .filter((j) => typeof j.originSessionId === 'string' && j.originUserId === userId)
      .map((j) => j.originSessionId),
  });

  ctx.registerPlatform(new CronAdapter(store, ctx.logger, ctx.notify, ctx.config, () => ctx.timezone()));
  ctx.logger.info('cron tools + scheduler registered');
}
