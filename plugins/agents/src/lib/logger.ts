import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Inlined from src/shared/paths.ts (logDir): the plugin compile unit cannot runtime-import core
// modules, and pulling the whole paths helper in for one resolver would drag planSlug along. Same
// rule, same fallbacks — both module instances append to the SAME daily file (O_APPEND is safe).
function logDir(env: NodeJS.ProcessEnv): string {
  return env.ELOWEN_LOG_DIR || join(env.HOME || homedir() || '/', '.config', 'elowen', 'logs');
}

/**
 * Global structured logger — single source of truth for everything the daemon prints. Every line is
 * both echoed to the console (so `journalctl -u elowen-daemon` still works) AND appended to a daily
 * file under `logs/` in a fixed, human-readable, column-aligned format:
 *
 *   2026-06-20 21:45:03.123  INFO   [overseer]  mission m-elowen-ab12 ticked
 *   2026-06-20 21:45:04.001  ERROR  [deriver]   tick failed for elowen-Iris — Error: tmux down
 *
 * File logging is best-effort: a write failure (read-only FS, full disk) never throws into the
 * caller — the console line is the durable channel of record.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** A structural tap on the emit() choke point. A sink sees every line the logger actually emits
 *  (i.e. already above the min level), so it can mirror them into a bounded ring, a metrics probe,
 *  etc. Console + file behaviour is unaffected — the sink is a pure side-observer, best-effort. */
export interface LogSink {
  push(entry: { ts: number; level: LogLevel; scope: string; message: string }): void;
}

let sink: LogSink | undefined;

/** Install (or clear with `undefined`) the single process-wide log sink. Wired once at boot so an
 *  in-memory ring buffer can back per-subsystem log views without the logger importing it. */
export function setLogSink(s: LogSink | undefined): void {
  sink = s;
}

let scopePrefix = '';

/** Prefix every scope THIS process emits (`[runner:1234 daemon]` instead of `[daemon]`). A forked
 *  sub-agent runner appends to the SAME daily log file as the daemon and builds the same brain core, so
 *  without this its `[daemon] plugin loaded: …` lines are indistinguishable from the daemon's own — an
 *  incident spent real time on 36 identical `plugin loaded:` lines that nothing attributed to a process.
 *  Process-wide and set once at startup by whoever is NOT the daemon; the daemon leaves it empty. */
export function setLogScopePrefix(prefix: string): void {
  scopePrefix = prefix;
}

const MIN: LogLevel = ((): LogLevel => {
  const v = ((process.env.ELOWEN_LOG_LEVEL) ?? '').toLowerCase();
  return v in ORDER ? (v as LogLevel) : 'info';
})();

// Resolved by the shared paths helper — the ONE rule for where persistent state lives (`~/.config/elowen`,
// or ELOWEN_LOG_DIR when set). Deliberately not a `<cwd>/logs` default: the daemon's WorkingDirectory is
// the repo root, so that wrote logs INTO the checkout whenever the env var was absent (a plain dev run),
// leaving two rival log folders — the installed one and a stale one npm update would blow away.
const DIR = logDir(process.env);
let dirReady = false;

/** Local wall-clock `YYYY-MM-DD HH:MM:SS.mmm` — readable at a glance, sortable, no timezone noise. */
function stamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** One file per local day, scoped to the backend: `logs/daemon-2026-06-20.log`. The web process
 *  writes its own `web-<date>.log` in the same folder, so the two streams stay cleanly separated. */
function fileFor(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return join(DIR, `daemon-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.log`);
}

/** Render an optional extra payload: an Error shows its stack, anything else its JSON — on the same
 *  line so a log stays one grep-able record (the stack's own newlines are the only exception). */
function fmtExtra(extra: unknown): string {
  if (extra == null) return '';
  if (extra instanceof Error) return ` — ${extra.stack ?? `${extra.name}: ${extra.message}`}`;
  try {
    return ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`;
  } catch {
    return ` ${String(extra)}`;
  }
}

function emit(level: LogLevel, scope: string, message: string, extra?: unknown): void {
  if (ORDER[level] < ORDER[MIN]) return;
  const now = new Date();
  // Read live rather than baked into the logger: every module-level `logger('daemon')` already exists by
  // the time a runner can announce itself, so a prefix captured at creation would miss exactly the lines
  // (plugin loading, brain construction) that motivated it.
  const tag = `${scopePrefix}${scope}`;
  const line = `${stamp(now)}  ${level.toUpperCase().padEnd(5)}  [${tag}]  ${message}${fmtExtra(extra)}`;
  // Console first — the durable channel (systemd journal). Match severity to the right stream.
  // Guarded like the file sink below: a closed/broken pipe makes this throw, and since the daemon's
  // uncaughtException handler logs, an unguarded throw here turns one dead pipe into an endless
  // log→EPIPE→log loop. The file sink underneath still records the line.
  try {
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
  } catch {
    /* console is gone (EPIPE on a detached parent) — the file sink below is still the record */
  }
  // Mirror into the optional sink (bounded ring buffer, …). Best-effort: a sink fault must never
  // break logging. Fed the logical message + extra so downstream matching sees the full record.
  if (sink) {
    try {
      sink.push({ ts: now.getTime(), level, scope: tag, message: `${message}${fmtExtra(extra)}` });
    } catch {
      /* sink is a pure side-observer — the console line already carried the record */
    }
  }
  // Under vitest, skip the file sink so a test run doesn't litter the repo with a logs/ directory.
  if (process.env.VITEST) return;
  try {
    if (!dirReady) { mkdirSync(DIR, { recursive: true }); dirReady = true; }
    appendFileSync(fileFor(now), line + '\n');
  } catch {
    /* file logging is best-effort — the console line already carried the record */
  }
}

export interface Logger {
  debug(message: string, extra?: unknown): void;
  info(message: string, extra?: unknown): void;
  warn(message: string, extra?: unknown): void;
  error(message: string, extra?: unknown): void;
}

/** A scoped logger — the `scope` tags every line so the source subsystem is obvious at a glance. */
export function logger(scope: string): Logger {
  return {
    debug: (m, e) => emit('debug', scope, m, e),
    info: (m, e) => emit('info', scope, m, e),
    warn: (m, e) => emit('warn', scope, m, e),
    error: (m, e) => emit('error', scope, m, e),
  };
}

/** Where logs are being written — surfaced once at boot so an operator knows where to look. */
export const LOG_DIR = DIR;
