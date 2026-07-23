/** Localized action labels for the "authoring a tool call" hint.
 *
 * While the model WRITES a long-duration tool call, the CLI upgrades the generic `working` spinner hint
 * to a short, localized phrase naming the action and its salient argument — `⠋ Píšu soubor readme.md…` /
 * `⠋ Writing file readme.md…`. The daemon streams the raw fact (tool name + arg detail via
 * `tool_authoring`); this module owns the localization and the ALLOW-LIST gate. Quick tools (Read, Search,
 * ListDir…) are deliberately absent, so they fall back to today's exact output — the CLI renders them
 * byte-identically.
 *
 * Hard rules the phrase tables obey (both locales):
 *  - the whole label is at most FOUR whitespace-separated words, detail slot included — so the streamed
 *    detail is clamped to at most two words (every fixed part here is one or two words);
 *  - every label ends with the ellipsis character `…` (U+2026), including the name-only fallback.
 */

/** The locales the composing label speaks. Also the persisted `CliPrefs.language` domain and the value
 *  threaded to the renderer, so it is defined once here and imported where the locale is carried. */
export type ComposeLocale = 'en' | 'cs' | 'sk';

interface LocalePhrase {
  /** The label with the (already reduced + clamped) detail slotted in. Ends with `…`. */
  readonly withDetail: (detail: string) => string;
  /** Detail not streamed yet: the name-only form, no dangling slot. Ends with `…`. */
  readonly nameOnly: string;
}
interface Phrase {
  /** Reduce the raw detail to the salient token before it is word-clamped (host for a URL, basename for a
   *  long path). Absent → the detail is used as-is. */
  readonly reduce?: (detail: string) => string;
  readonly en: LocalePhrase;
  readonly cs: LocalePhrase;
  readonly sk: LocalePhrase;
}

/** At most this many whitespace-separated words survive from the streamed detail, so a phrase whose fixed
 *  part is two words still totals four. */
const MAX_DETAIL_WORDS = 2;

/** The host of a URL detail (`https://example.com/a` → `example.com`), for WebFetch. Falls back to the
 *  leading path-free token, then the raw string, so a malformed URL still shows something readable. */
function hostOf(url: string): string {
  const s = url.trim();
  try { return new URL(s).host || s; } catch { /* not a full URL */ }
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?([^/\s?#]+)/i.exec(s);
  return m?.[1] ?? s;
}

/** A path detail reduced to keep its basename visible: short paths pass through; a long one is
 *  left-truncated to `…/basename`, so the renderer's right-truncation never eats the meaningful tail. */
function fileOf(detail: string): string {
  const s = detail.trim();
  if (s.length <= 40) return s;
  const slash = s.lastIndexOf('/');
  const base = slash >= 0 ? s.slice(slash + 1) : s;
  return base.length + 2 <= 40 ? `…/${base}` : `…${base.slice(-(40 - 1))}`;
}

/** Trim a reduced detail to `MAX_DETAIL_WORDS` and strip any trailing ellipsis/space so the template's own
 *  `…` is never doubled. Empty → empty (caller then uses the name-only form). */
function clampDetail(detail: string): string {
  const words = detail.trim().split(/\s+/).filter(Boolean).slice(0, MAX_DETAIL_WORDS).join(' ');
  return words.replace(/[…\s]+$/u, '');
}

/** The long-duration tools that earn a localized action label. Keyed on canonical TitleCase names — see
 *  src/store/toolRenames.ts (`TOOL_RENAMES` + `REGISTRY_TOOL_RENAMES`). Anything not listed here returns
 *  undefined from {@link composeLabel} and keeps the generic hint. */
const LONG_TOOLS: Readonly<Record<string, Phrase>> = {
  Write: { reduce: fileOf,
    en: { withDetail: (d) => `Writing file ${d}…`, nameOnly: 'Writing file…' },
    cs: { withDetail: (d) => `Píšu soubor ${d}…`, nameOnly: 'Píšu soubor…' },
    sk: { withDetail: (d) => `Píšem súbor ${d}…`, nameOnly: 'Píšem súbor…' } },
  Edit: { reduce: fileOf,
    en: { withDetail: (d) => `Editing file ${d}…`, nameOnly: 'Editing file…' },
    cs: { withDetail: (d) => `Upravuji soubor ${d}…`, nameOnly: 'Upravuji soubor…' },
    sk: { withDetail: (d) => `Upravujem súbor ${d}…`, nameOnly: 'Upravujem súbor…' } },
  Bash: {
    en: { withDetail: (d) => `Running command ${d}…`, nameOnly: 'Running command…' },
    cs: { withDetail: (d) => `Spouštím příkaz ${d}…`, nameOnly: 'Spouštím příkaz…' },
    sk: { withDetail: (d) => `Spúšťam príkaz ${d}…`, nameOnly: 'Spúšťam príkaz…' } },
  Delegate: {
    en: { withDetail: () => 'Starting sub-agent…', nameOnly: 'Starting sub-agent…' },
    cs: { withDetail: () => 'Spouštím sub-agenta…', nameOnly: 'Spouštím sub-agenta…' },
    sk: { withDetail: () => 'Spúšťam sub-agenta…', nameOnly: 'Spúšťam sub-agenta…' } },
  WorkflowStart: {
    en: { withDetail: () => 'Starting workflow…', nameOnly: 'Starting workflow…' },
    cs: { withDetail: () => 'Spouštím workflow…', nameOnly: 'Spouštím workflow…' },
    sk: { withDetail: () => 'Spúšťam workflow…', nameOnly: 'Spúšťam workflow…' } },
  WorkflowAddNodes: {
    en: { withDetail: () => 'Adding nodes…', nameOnly: 'Adding nodes…' },
    cs: { withDetail: () => 'Přidávám uzly…', nameOnly: 'Přidávám uzly…' },
    sk: { withDetail: () => 'Pridávam uzly…', nameOnly: 'Pridávam uzly…' } },
  CodebaseSearch: {
    en: { withDetail: (d) => `Searching codebase ${d}…`, nameOnly: 'Searching codebase…' },
    cs: { withDetail: (d) => `Prohledávám kód ${d}…`, nameOnly: 'Prohledávám kód…' },
    sk: { withDetail: (d) => `Prehľadávam kód ${d}…`, nameOnly: 'Prehľadávam kód…' } },
  CodebaseReindex: {
    en: { withDetail: () => 'Reindexing codebase…', nameOnly: 'Reindexing codebase…' },
    cs: { withDetail: () => 'Přeindexovávám kód…', nameOnly: 'Přeindexovávám kód…' },
    sk: { withDetail: () => 'Preindexovávam kód…', nameOnly: 'Preindexovávam kód…' } },
  GenerateImage: {
    en: { withDetail: () => 'Generating image…', nameOnly: 'Generating image…' },
    cs: { withDetail: () => 'Generuji obrázek…', nameOnly: 'Generuji obrázek…' },
    sk: { withDetail: () => 'Generujem obrázok…', nameOnly: 'Generujem obrázok…' } },
  EditImage: {
    en: { withDetail: () => 'Generating image…', nameOnly: 'Generating image…' },
    cs: { withDetail: () => 'Generuji obrázek…', nameOnly: 'Generuji obrázek…' },
    sk: { withDetail: () => 'Generujem obrázok…', nameOnly: 'Generujem obrázok…' } },
  CreateSkill: { reduce: fileOf,
    en: { withDetail: (d) => `Creating skill ${d}…`, nameOnly: 'Creating skill…' },
    cs: { withDetail: (d) => `Vytvářím dovednost ${d}…`, nameOnly: 'Vytvářím dovednost…' },
    sk: { withDetail: (d) => `Vytváram zručnosť ${d}…`, nameOnly: 'Vytváram zručnosť…' } },
  ScanCode: { reduce: fileOf,
    en: { withDetail: (d) => `Scanning code ${d}…`, nameOnly: 'Scanning code…' },
    cs: { withDetail: (d) => `Kontroluji kód ${d}…`, nameOnly: 'Kontroluji kód…' },
    sk: { withDetail: (d) => `Kontrolujem kód ${d}…`, nameOnly: 'Kontrolujem kód…' } },
  WebFetch: { reduce: hostOf,
    en: { withDetail: (d) => `Fetching ${d}…`, nameOnly: 'Fetching…' },
    cs: { withDetail: (d) => `Načítám ${d}…`, nameOnly: 'Načítám…' },
    sk: { withDetail: (d) => `Načítavam ${d}…`, nameOnly: 'Načítavam…' } },
  WebSearch: {
    en: { withDetail: (d) => `Searching ${d}…`, nameOnly: 'Searching…' },
    cs: { withDetail: (d) => `Hledám ${d}…`, nameOnly: 'Hledám…' },
    sk: { withDetail: (d) => `Hľadám ${d}…`, nameOnly: 'Hľadám…' } },
};

/** The set of tool names that carry a localized composing label — the frame loop's gate for the shorter
 *  "long tool" authoring-hint threshold. */
export const LONG_COMPOSE_TOOLS: ReadonlySet<string> = new Set(Object.keys(LONG_TOOLS));

/** The localized action label for an in-progress tool authoring, or undefined when the tool is not one of
 *  the long-duration tools (the caller then keeps today's exact `working`/`toolRowSpec` output). When the
 *  tool IS listed but its detail has not streamed yet, the name-only phrase is returned. */
export function composeLabel(name: string | undefined, detail: string | undefined, locale: ComposeLocale): string | undefined {
  if (!name) return undefined;
  const phrase = LONG_TOOLS[name];
  if (!phrase) return undefined;
  const loc = phrase[locale];
  const raw = detail?.trim();
  if (!raw) return loc.nameOnly;
  const reduced = clampDetail(phrase.reduce ? phrase.reduce(raw) : raw);
  return reduced ? loc.withDetail(reduced) : loc.nameOnly;
}

/** The spinner label for a tool being authored, in precedence order: the model's own streamed `reason`
 *  (verbatim, already in the user's language) → the canned localized {@link composeLabel} → undefined (the
 *  caller then falls back to the tool name / a neutral hint). This is the ONE place the `reason`-over-label
 *  choice lives, so the renderer stays a thin call. */
export function composingLabel(
  reason: string | undefined, name: string | undefined, detail: string | undefined, locale: ComposeLocale,
): string | undefined {
  const r = reason?.trim();
  if (r) return r;
  return composeLabel(name, detail, locale);
}
