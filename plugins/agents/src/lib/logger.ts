/** Scoped logging for the agents subsystem, routed through the HOST's plugin logger.
 *
 *  This used to be a full copy of src/shared/logger.ts (console + daily file), which left a gap: the
 *  copy was a separate module instance, so the daemon's process-wide log sink (setLogSink → the
 *  PluginLogBuffer behind the admin per-plugin log/health views) never saw a subsystem line. Routing
 *  through ctx.logger closes it — every line reaches the core logger's single emit() choke point as
 *  `[plugin:agents] [scope] message`, so it lands in the console, the daily file, AND the plugin log
 *  ring, while the `[scope]` tag (deriver/overseer/scheduler/…) keeps the subsystem granularity.
 *
 *  The base is injected once from register() (setBaseLogger(ctx.logger)); until then — a unit test
 *  importing a module directly, never registering the plugin — lines fall back to the console so
 *  nothing is silently swallowed. The host logger has no debug channel and the daemon's default min
 *  level drops debug anyway, so debug() is a no-op here (the subsystem has no debug call sites).
 */

/** The host-provided sink (PluginContext['logger']): message-only, plugin-prefixed by the registry. */
interface BaseLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

let base: BaseLogger | undefined;

/** Install the plugin-scoped host logger. Called first thing in register(); a reload simply
 *  overwrites with the new generation's context logger. */
export function setBaseLogger(l: BaseLogger): void {
  base = l;
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

export interface Logger {
  debug(message: string, extra?: unknown): void;
  info(message: string, extra?: unknown): void;
  warn(message: string, extra?: unknown): void;
  error(message: string, extra?: unknown): void;
}

/** A scoped logger — the `[scope]` tag keeps the subsystem's per-component granularity inside the
 *  host's `[plugin:agents]` prefix. */
export function logger(scope: string): Logger {
  const line = (message: string, extra?: unknown) => `[${scope}] ${message}${fmtExtra(extra)}`;
  return {
    debug: () => { /* no debug channel on the host logger; the subsystem has no debug call sites */ },
    info: (m, e) => { if (base) base.info(line(m, e)); else console.log(line(m, e)); },
    warn: (m, e) => { if (base) base.warn(line(m, e)); else console.warn(line(m, e)); },
    error: (m, e) => { if (base) base.error(line(m, e)); else console.error(line(m, e)); },
  };
}
