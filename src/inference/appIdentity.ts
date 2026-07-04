/** App-identity headers sent on every outbound provider request. OpenRouter (and compatible relays)
 *  surface these on their activity dashboards: `X-Title` names the app and `HTTP-Referer` links to it —
 *  so calls show up as "Orca" instead of "unknown", and OpenRouter renders the referer's favicon.
 *  Harmless to providers that don't read them (they ignore unknown headers). */
const APP_URL = 'https://github.com/dragocz1995/orcasynth';
const APP_TITLE = 'Orca';

/** Spread into any provider request's headers. Lower-case keys so they merge predictably with the
 *  `authorization`/`content-type` already set at each call site. */
export const APP_IDENTITY_HEADERS: Readonly<Record<string, string>> = {
  'http-referer': APP_URL,
  'x-title': APP_TITLE,
};
