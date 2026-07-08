import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Server-side logger for the Next.js process — the web counterpart of the daemon's `src/shared/logger`.
 * It writes the SAME human-readable, column-aligned format into the SAME `logs/` directory so a single
 * folder tells the whole story (daemon + web). Kept as a small standalone copy because the web is a
 * separate TS package (it can't import the daemon's module graph).
 *
 * Server-only: it touches the filesystem, so never import it from a `'use client'` module.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const MIN: LogLevel = (() => {
  const v = (process.env.ELOWEN_LOG_LEVEL ?? '').toLowerCase();
  return v in ORDER ? (v as LogLevel) : 'info';
})();

// Default to the shared repo-root `logs/` (web cwd is `<repo>/web`, so `../logs`). Overridable via
// ELOWEN_LOG_DIR — set it in the web systemd unit so daemon and web write to exactly the same folder.
const DIR = process.env.ELOWEN_LOG_DIR || join(process.cwd(), '..', 'logs');
let dirReady = false;

function stamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** One file per local day, scoped to the web process: `logs/web-2026-06-20.log` — kept separate from
 *  the daemon's `daemon-<date>.log` in the same folder. */
function fileFor(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return join(DIR, `web-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.log`);
}

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
  const line = `${stamp(now)}  ${level.toUpperCase().padEnd(5)}  [${scope}]  ${message}${fmtExtra(extra)}`;
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
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

export function logger(scope: string): Logger {
  return {
    debug: (m, e) => emit('debug', scope, m, e),
    info: (m, e) => emit('info', scope, m, e),
    warn: (m, e) => emit('warn', scope, m, e),
    error: (m, e) => emit('error', scope, m, e),
  };
}

export const LOG_DIR = DIR;
