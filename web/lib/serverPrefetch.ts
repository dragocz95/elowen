// Server-side only (imported from the root layout — never from client components).
import { cache } from 'react';
import { headers } from 'next/headers';
import { daemonUrl, readCookieHeader, COOKIE_NAME } from './proxy';
import { dictionaries, type Locale } from './i18n/dictionaries';
import { DEFAULT_LOCALE } from './i18n';
import { isSkinChoice, type SkinChoice } from './skins';
import type { PluginUiListing, User } from './types';

/** After a failed fetch, requests skip the daemon for this long. Same reasoning as the theme payload
 *  in brandServer.ts: a HANGING daemon would otherwise put the full abort timeout into every
 *  document's TTFB, the login page included. Unlike the theme there is NO last-known-good fallback —
 *  everything prefetched here is per-caller, so serving a cached copy could render one user's data
 *  into another user's HTML. A failure simply means "render without the seed"; the client's own query
 *  fills it in, exactly as before this prefetch existed. */
const FAILURE_BACKOFF_MS = 5_000;
/** Kept PER ENDPOINT, not as one shared flag: a plugin whose listing route is broken would otherwise
 *  suppress the identity prefetch too, and the rail would go back to growing its admin destinations
 *  after first paint — the exact flash the identity seed exists to remove. */
const failedAt = new Map<string, number>();

/** Fetch a per-caller daemon endpoint for the CURRENT request, translating the caller's own session
 *  cookie into the daemon bearer exactly like the BFF proxy route does — never an ambient/admin
 *  credential, or one user's data would leak into another user's document.
 *
 *  Returns null — never throws — for every non-happy path: no session cookie (logged-out visitor),
 *  a 401/403 (a stale session is a NORMAL answer, not an error), a daemon failure, or a body that
 *  fails `accept`. Null means "no server-seeded data": the page renders exactly as it does without
 *  the prefetch and the client query refills it. */
async function fetchForCaller<T>(path: string, accept: (body: unknown) => body is T): Promise<T | null> {
  const token = readCookieHeader((await headers()).get('cookie') ?? '', COOKIE_NAME);
  if (!token) return null; // logged-out: nothing to forward, nothing to fetch
  const endpoint = path.split('?')[0];
  const lastFailure = failedAt.get(endpoint);
  if (lastFailure && Date.now() - lastFailure < FAILURE_BACKOFF_MS) return null;
  try {
    const res = await fetch(`${daemonUrl()}${path}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(2000),
      headers: { authorization: `Bearer ${token}` },
    });
    // A stale/revoked session is a normal "no seed", not a fetch failure — and it must not trip the
    // daemon-down backoff for everyone else.
    if (res.status === 401 || res.status === 403) return null;
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body: unknown = await res.json();
    if (!accept(body)) throw new Error('malformed payload');
    failedAt.delete(endpoint);
    return body;
  } catch {
    failedAt.set(endpoint, Date.now());
    return null;
  }
}

/** The locale THIS document must render in, read from the cookie the client mirrors its choice into.
 *  Without it the server can only ever guess English, and a Czech user watches the whole interface —
 *  every nav label, every heading — get rewritten a moment after it appears. Unknown or absent value
 *  falls back to the default, so a hand-edited cookie cannot render a dictionary that does not exist. */
export const readLocale = cache(async (): Promise<Locale> => {
  const value = readCookieHeader((await headers()).get('cookie') ?? '', 'elowen-locale');
  return value && value in dictionaries ? (value as Locale) : DEFAULT_LOCALE;
});

/** The skin choice THIS document must render in, read from the cookie the client mirrors its choice
 *  into — the same trick, and for the same reason, as the locale above. For a skin the stakes are higher
 *  than a label: without it the document arrives in the operator's design and visibly changes colour once
 *  hydration reads localStorage. An unknown value falls back to null so a hand-edited cookie cannot put an
 *  arbitrary string into a DOM attribute. Whether the choice is still ALLOWED is decided later, against
 *  instance config; this only reports what was asked for. */
export const readSkinChoice = cache(async (): Promise<SkinChoice | null> => {
  const value = readCookieHeader((await headers()).get('cookie') ?? '', 'elowen-skin');
  return isSkinChoice(value) ? value : null;
});

/** The skins the instance allows accounts to choose between. Null — logged out, 401/403, daemon down —
 *  means "no switching offered for this document", so the operator's ELOWEN_SKIN renders unchanged: the
 *  failure mode of not knowing the allow-list is the deployment's own design, never somebody else's. */
export const fetchAllowedSkins = cache(async (): Promise<string[] | null> => {
  const config = await fetchForCaller(
    '/config',
    (body): body is { allowedSkins: string[] } =>
      Array.isArray((body as { allowedSkins?: unknown } | null)?.allowedSkins),
  );
  return config ? config.allowedSkins : null;
});

/** Cookie presence is not authentication, but absence is authoritative: a browser with no session must
 * render the login route on its first frame instead of briefly painting authenticated shell chrome. */
export const hasSessionCookie = cache(async (): Promise<boolean> =>
  readCookieHeader((await headers()).get('cookie') ?? '', COOKIE_NAME) != null);

/** Prefetch the caller's /plugins/ui listing so the navigation rail arrives complete in the HTML
 *  (no first-paint pop-in of plugin worlds). Deduped per request via React cache. */
export const fetchPluginUiListing = cache((locale: string): Promise<PluginUiListing[] | null> =>
  fetchForCaller(
    `/plugins/ui?lang=${encodeURIComponent(locale)}`,
    (body): body is PluginUiListing[] => Array.isArray(body),
  ));

/** Prefetch the caller's /auth/me for the same reason, and it is the OTHER half of the same flash: the
 *  system group renders admin destinations only once `is_admin` is known, so without this the rail
 *  paints with Account alone and grows Settings/Users a round-trip later — the pop-in stayed visible
 *  after the plugin worlds stopped causing it. Deduped per request via React cache. */
export const fetchMe = cache((): Promise<{ user: User } | null> =>
  fetchForCaller(
    '/auth/me',
    // One condition, and every part of it earns its place: optional chaining covers a null or
    // primitive body, and the object check covers a missing or null user. A longer shape check reads
    // safer but is dead weight — the extra branches cannot change the outcome, since anything they
    // would reject already lands in the same rejection path.
    (body): body is { user: User } => {
      const user = (body as { user?: unknown } | null)?.user;
      return typeof user === 'object' && user !== null;
    },
  ));
