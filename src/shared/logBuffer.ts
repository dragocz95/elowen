import type { LogLevel, LogSink } from './logger.js';

/** One captured log line, trimmed to what a per-plugin log view needs (the scope is dropped since
 *  the view is already plugin-scoped). Newest-last ordering is preserved by the ring. */
export interface PluginLogEntry {
  ts: number;
  level: LogLevel;
  message: string;
}

interface RawEntry {
  ts: number;
  level: LogLevel;
  scope: string;
  message: string;
}

/** Health of a plugin as derived purely from its recent log tail. */
export type PluginHealth = 'ok' | 'error';

/** A bounded, in-memory ring of the most recent emitted log lines, tapped at the logger's single
 *  emit() choke point via {@link LogSink}. It exists so the admin plugins API can surface a plugin's
 *  recent output and a coarse health signal without any new logging plumbing inside plugins.
 *
 *  Plugin lines reach the base `daemon` logger already prefixed by the registry: `[plugin:<name>] …`
 *  for a plugin's own output, and `plugin skipped: <name>: …` for a load failure. So a plugin's
 *  entries are matched either by an exact scope (a plugin that logs under its own scope) OR by those
 *  message prefixes. The ring is total (all lines, all scopes) so a single cap bounds memory. */
export class PluginLogBuffer implements LogSink {
  private readonly ring: RawEntry[] = [];
  private readonly cap: number;

  constructor(cap = 1000) {
    this.cap = Math.max(1, cap);
  }

  /** Sink tap: append newest-last, evicting the oldest once the cap is exceeded. */
  push(entry: RawEntry): void {
    this.ring.push(entry);
    if (this.ring.length > this.cap) this.ring.shift();
  }

  /** True when a captured line belongs to the named plugin — by scope or by the registry prefixes. */
  private belongsTo(e: RawEntry, name: string): boolean {
    if (e.scope === name) return true;
    return e.message.startsWith(`[plugin:${name}] `) || e.message.startsWith(`plugin skipped: ${name}:`);
  }

  /** The named plugin's recent log lines, oldest-first (newest-last), scope stripped. `limit` bounds
   *  the tail returned (default 200), never exceeding what's retained in the ring. */
  forPlugin(name: string, limit = 200): PluginLogEntry[] {
    const out: PluginLogEntry[] = [];
    for (const e of this.ring) {
      if (this.belongsTo(e, name)) out.push({ ts: e.ts, level: e.level, message: e.message });
    }
    return limit >= out.length ? out : out.slice(out.length - limit);
  }

  /** Coarse health from the retained tail: `error` if the plugin has any error-level line still in
   *  the ring (which includes a `plugin skipped: <name>` load failure — logged at error level), else
   *  `ok`. Once the failing line ages out of the bounded ring, health returns to `ok`. */
  health(name: string): PluginHealth {
    for (const e of this.ring) {
      if (e.level === 'error' && this.belongsTo(e, name)) return 'error';
    }
    return 'ok';
  }
}
