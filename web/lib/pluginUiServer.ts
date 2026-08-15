// Server-side only (imported from the root layout — never from client components).
import { cache } from 'react';
import { headers } from 'next/headers';
import { daemonUrl, readCookieHeader, COOKIE_NAME } from './proxy';
import type { PluginUiListing } from './types';

/** After a failed fetch, requests skip the daemon for this long. Same reasoning as the theme payload
 *  in brandServer.ts: a HANGING daemon would otherwise put the full abort timeout into every
 *  document's TTFB, the login page included. Unlike the theme there is NO last-known-good fallback —
 *  the listing is per-user (per-user plugin grants), so serving a cached copy could render one user's
 *  plugins into another user's HTML. A failure simply means "render without plugin worlds"; the
 *  client's own /plugins/ui query fills them in, exactly as before this prefetch existed. */
const FAILURE_BACKOFF_MS = 5_000;
let failedAt = 0;

/** Prefetch the CALLER's /plugins/ui listing so the navigation rail arrives complete in the HTML
 *  (no first-paint pop-in of plugin worlds). The endpoint is per-user, so the caller's own session
 *  cookie is translated into the daemon bearer exactly like the BFF proxy route does — never an
 *  ambient/admin credential, or one user's plugin list would leak into another user's document.
 *
 *  Returns null — never throws — for every non-happy path: no session cookie (logged-out visitor),
 *  a 401/403 (stale or plugin-less session is a NORMAL answer, not an error), a daemon failure, or
 *  a malformed body. Null means "no server-seeded data"; the page renders exactly as it does today
 *  and the client query refills the listing. Deduped per request via React cache. */
export const fetchPluginUiListing = cache(async (locale: string): Promise<PluginUiListing[] | null> => {
  const token = readCookieHeader((await headers()).get('cookie') ?? '', COOKIE_NAME);
  if (!token) return null; // logged-out: nothing to forward, nothing to fetch
  if (failedAt && Date.now() - failedAt < FAILURE_BACKOFF_MS) return null;
  try {
    const res = await fetch(`${daemonUrl()}/plugins/ui?lang=${encodeURIComponent(locale)}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(2000),
      headers: { authorization: `Bearer ${token}` },
    });
    // A stale/revoked session or a plugin-less grant is a normal "no plugin nav", not a fetch
    // failure — and it must not trip the daemon-down backoff for everyone else.
    if (res.status === 401 || res.status === 403) return null;
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body: unknown = await res.json();
    if (!Array.isArray(body)) throw new Error('malformed payload');
    failedAt = 0;
    return body as PluginUiListing[];
  } catch {
    failedAt = Date.now();
    return null;
  }
});
