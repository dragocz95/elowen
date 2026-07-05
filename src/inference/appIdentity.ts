/** App-identity headers sent on every outbound provider request. OpenRouter (and compatible relays)
 *  surface these on their activity dashboards: `X-OpenRouter-Title`/`X-Title` names the app and
 *  `HTTP-Referer` links to it — so calls show up as "Orca" instead of "unknown", and OpenRouter
 *  renders the referer's favicon.
 *  Harmless to providers that don't read them (they ignore unknown headers).
 *
 *  Centralized here and overridable per-deployment via env so the public URL/title aren't hardcoded:
 *  - `ORCA_APP_URL`   — the public primary URL (referer). Prod overrides it; dev keeps the default.
 *  - `ORCA_APP_TITLE` — the app name shown on the ranking page.
 *  Note: OpenRouter's canonical title header is `X-OpenRouter-Title`; `X-Title` remains supported for
 *  older compatible relays. There is no categories header, so we send none. */
const DEFAULT_APP_URL = 'https://orca.dragocz.dev';
const DEFAULT_APP_TITLE = 'Orca';

/** The configured public app URL (referer). Trailing slash trimmed so `${APP_URL}/favicon.ico` is clean. */
export const APP_URL = (process.env.ORCA_APP_URL?.trim() || DEFAULT_APP_URL).replace(/\/$/, '');
/** The configured app title shown on provider dashboards / ranking pages. */
export const APP_TITLE = process.env.ORCA_APP_TITLE?.trim() || DEFAULT_APP_TITLE;

/** Spread into any provider request's headers. Lower-case keys so they merge predictably with the
 *  `authorization`/`content-type` already set at each call site. */
export const APP_IDENTITY_HEADERS: Readonly<Record<string, string>> = {
  'http-referer': APP_URL,
  'x-openrouter-title': APP_TITLE,
  'x-title': APP_TITLE,
};
