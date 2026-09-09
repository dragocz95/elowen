/**
 * Node's fetch (undici) aborts a request after headersTimeout/bodyTimeout, both 300 s by default — a
 * real `elowen api POST /brain/compact` that the daemon answered in 62 s still died with
 * `fetch failed`. `elowen api` is the operator escape hatch for arbitrarily long routes, so it waits
 * as long as the daemon takes: undici reads 0 as "no timeout".
 *
 * undici is not a package dependency here — it is Node's built-in fetch implementation — so the Agent
 * class is taken from the global dispatcher instance, which constructing a `Request` forces Node to
 * create. If that internal shape ever changes, `api` silently keeps the default timeouts rather than
 * failing outright.
 */
let cached: { value: unknown } | undefined;

export function noTimeoutDispatcher(): unknown {
  if (!cached) {
    let value: unknown;
    try {
      new Request('http://localhost/');
      const globalDispatcher = (globalThis as unknown as Record<symbol, { constructor: new (opts: unknown) => unknown } | undefined>)[
        Symbol.for('undici.globalDispatcher.1')
      ];
      value = globalDispatcher ? new globalDispatcher.constructor({ headersTimeout: 0, bodyTimeout: 0 }) : undefined;
    } catch { value = undefined; }
    cached = { value };
  }
  return cached.value;
}
