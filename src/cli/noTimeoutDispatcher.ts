/**
 * Node's fetch (undici) aborts a request after headersTimeout/bodyTimeout, both 300 s by default — a
 * real `elowen api POST /brain/compact` that the daemon answered in 62 s still died with
 * `fetch failed`. `elowen api` is the operator escape hatch for arbitrarily long routes, so it waits
 * as long as the daemon takes: undici reads 0 as "no timeout".
 *
 * The dispatcher has to ride on undici's own `fetch`: Node's global fetch ignores a `dispatcher` from
 * the npm undici package (a 100 ms headersTimeout agent let an 800 ms response through untouched),
 * while the package's fetch honours it — so `runApiCommand` passes both through the `CallOpts`
 * opt-in.
 */
import { Agent, fetch as undiciFetch } from 'undici';

let cached: Agent | undefined;

export function noTimeoutDispatcher(): Agent {
  cached ??= new Agent({ headersTimeout: 0, bodyTimeout: 0 });
  return cached;
}

/** The `fetchImpl` for the api command — undici's fetch is the only one that honours the dispatcher
 *  above. Every other CLI call keeps the default `globalThis.fetch` and its 300 s timeouts. */
export const noTimeoutFetch = undiciFetch as unknown as typeof fetch;