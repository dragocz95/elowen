import type { LucideIcon } from 'lucide-react';
import { Bell, Brain, Cpu, KeyRound, Sparkles, SquareTerminal, UserCog } from 'lucide-react';
import type { LocaleDict } from '../../lib/i18n/types';
import { MODULES } from '../../modules/registry';
import { SETTINGS_SECTIONS, type SettingsCategory } from '../../modules/settings/categories';
import { PROVIDERS } from '../../modules/settings/providers';
import { pluginNavEntries } from '../../lib/pluginNav';
import { ACCOUNT_ROW_SPECS, ROW_ANCHOR_PARAM, SETTINGS_ROW_SPECS, type RowSpec } from '../../lib/rowAnchors';
import type { PluginUiListing } from '../../lib/types';

/** Where the site-wide search's rows come from. Every string below is DERIVED — a title is read out of
 *  the dictionary path the owning component already renders, a route out of the registry that owns it —
 *  so the index is a fourth view over data that already exists, not a second copy of it.
 *
 *  What is deliberately NOT indexed (and why):
 *  - Settings → Plugins and Settings → Models rows: the plugin and model lists arrive at runtime, so
 *    there is no static label to read; only their static GROUP titles are registered here.
 *  - Plugin account sections and per-user plugin config sections on /account: they exist only while
 *    their plugin is enabled; the plugin's own pages below cover the way in.
 *  - Dynamic values inside rows (counts, statuses, per-provider model lists): a search index over live
 *    data would go stale between the listing and the palette render.
 */

/** The fixed group order of the palette: a calm launcher on the empty query (pages + the settings and
 *  account decks), with rows revealed by typing. `actions` exists for app actions folded elsewhere —
 *  today the old "Go to …" commands ARE the page entries, so nothing is filed here. */
export type SearchGroup = 'pages' | 'settings' | 'account' | 'plugins' | 'actions';

export const SEARCH_GROUP_ORDER: readonly SearchGroup[] = ['pages', 'settings', 'account', 'plugins', 'actions'];

export interface SearchEntry {
  id: string;
  group: SearchGroup;
  title: string;
  subtitle?: string;
  keywords: string[];
  href: string;
  icon?: LucideIcon;
}

/** A dictionary path like `brain.retention.title`, resolved against the dictionary at build time. The
 *  dictionary arriving here is already brand-resolved — `useTranslation` substitutes `{agentName}` and
 *  `{productName}` into every string — so a path yields final, display-ready text. */
function dictAt(t: LocaleDict, path: string): string {
  let node: unknown = t;
  for (const part of path.split('.')) {
    if (typeof node !== 'object' || node === null) return '';
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : '';
}

/** The settings rows, from the shared anchor tables (`lib/rowAnchors.ts`) the SECTIONS mark their rows
 *  with. Restating the type here is what keeps the deck exhaustive: a new settings category that forgot
 *  its row table fails to compile rather than quietly indexing nothing. */
const SETTINGS_ROWS: Record<SettingsCategory, readonly RowSpec[]> = SETTINGS_ROW_SPECS;

/** The Models section's static group titles: the provider catalog is static data, its MODEL rows are
 *  not — so the groups go in and the models stay out. */
const MODEL_GROUPS = PROVIDERS.filter((provider) => provider.embedded).map((provider) => provider.label);

/** Account deck sections, mirroring `AccountView`'s rail: the presentation the palette needs (icon and
 *  the section's own dictionary paths), with the ROWS read from the shared anchor tables. Naming the
 *  table's keys as this list's `id` keeps the two in step — a section id with no row table, or a table
 *  no section lists, fails to compile. Plugin-contributed sections are dynamic and are not indexed; the
 *  plugin's own pages are. The other direction — a table whose section is missing from this list — is
 *  pinned by `tests/components/shell/siteSearch.test.ts`. */
const ACCOUNT_SECTIONS: { id: keyof typeof ACCOUNT_ROW_SPECS; icon: LucideIcon; titlePath: string; hintPath?: string }[] = [
  { id: 'profile', icon: UserCog, titlePath: 'account.tabProfile', hintPath: 'account.profileHint' },
  { id: 'cli', icon: Cpu, titlePath: 'account.tabCli', hintPath: 'cli.modelRolesHint' },
  { id: 'memory', icon: Brain, titlePath: 'account.tabMemory', hintPath: 'help.memoryRecall' },
  { id: 'personality', icon: Sparkles, titlePath: 'account.tabPersonality', hintPath: 'personality.intro' },
  { id: 'notifications', icon: Bell, titlePath: 'account.tabNotifications', hintPath: 'help.pushEnable' },
  { id: 'security', icon: KeyRound, titlePath: 'account.tabSecurity', hintPath: 'account.passwordHint' },
  { id: 'terminal', icon: SquareTerminal, titlePath: 'account.tabTerminal', hintPath: 'terminal.colorsHelp' },
];

/** Case- and diacritics-insensitive text used for BOTH matching and highlighting: `retence` finds
 *  "Retence", `pamet` finds "Paměť". cmdk's built-in filter is not diacritics-aware, which is why the
 *  palette supplies this normalization instead. */
export function normalizeText(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

interface NormalizedText { normalized: string; /** For each normalized char, the ORIGINAL index it came from. */ sources: number[] }

function normalizeWithMap(text: string): NormalizedText {
  let normalized = '';
  const sources: number[] = [];
  let i = 0;
  for (const ch of text) {
    const piece = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    for (const mapped of piece) { normalized += mapped; sources.push(i); }
    i += ch.length;
  }
  return { normalized, sources };
}

/** Where `query` occurs inside `text`, compared diacritics-insensitively — returned as a range into the
 *  ORIGINAL string, so the palette can highlight the real (accented) substring. */
export function findNormalizedRange(text: string, query: string): [number, number] | null {
  const q = normalizeText(query);
  if (!q) return null;
  const { normalized, sources } = normalizeWithMap(text);
  const at = normalized.indexOf(q);
  if (at < 0) return null;
  return [sources[at]!, sources[at + q.length - 1]! + 1];
}

/** One match test, shared by the palette's pre-filter: 1 keeps the item, 0 drops it. Matches over the
 *  item's VALUE plus its keywords (the same concatenation cmdk's own default filter applies), both
 *  normalized above — so "retenc" (no diacritics typed) keeps the "Retence paměti" row. */
export function searchFilter(value: string, search: string, keywords?: string[]): number {
  const q = normalizeText(search);
  if (!q) return 1;
  const haystack = keywords && keywords.length > 0 ? `${value} ${keywords.join(' ')}` : value;
  return normalizeText(haystack).includes(q) ? 1 : 0;
}

/** The palette's rows for one query, pre-filtered. cmdk is given `shouldFilter={false}` — its own
 *  filter pipeline re-scores items in a store React cannot observe (its snapshot is one mutable
 *  object), so visibility after a keystroke is left to unrelated re-renders; filtering HERE keeps the
 *  rendered list a pure function of the query. */
export function filterEntries(entries: SearchEntry[], query: string): SearchEntry[] {
  const q = query.trim();
  if (!q) return entries;
  return entries.filter((entry) => searchFilter(entry.id, q, [entry.title, entry.subtitle ?? '', ...entry.keywords]) === 1);
}

/** Bounds the daemon's search schemas enforce (`src/api/schemas/search.ts`); mirrored here because the
 *  web may not import daemon source at runtime, and an over-limit request is refused rather than
 *  truncated server-side. Truncating HERE keeps a long query or an unusually long label a shorter
 *  suggestion instead of no suggestion at all. */
const SEARCH_MAX_CANDIDATES = 400;
const SEARCH_MAX_TEXT_CHARS = 200;
export const SEARCH_MAX_QUERY_CHARS = 200;

const clamp = (text: string, max = SEARCH_MAX_TEXT_CHARS): string => text.slice(0, max);

/** What the semantic pass compares against: one line per row carrying everything the lexical filter
 *  already searches — the title, its section, and the aliases/hints in `keywords`. It is deliberately the
 *  same material, because the two passes must agree about what a row IS and differ only in how they
 *  match it. */
/** A row entry's href: the section deep link plus the anchor of the row itself. The two travel together
 *  in the URL rather than in a second channel, so every way of choosing a row — the lexical list, a
 *  semantic suggestion, an "Ask AI" answer, a copied link — lands the same way. */
function rowHref(sectionHref: string, path: string): string {
  return `${sectionHref}&${ROW_ANCHOR_PARAM}=${encodeURIComponent(path)}`;
}

/** What the palette PRINTS in its hint column: the destination without the row anchor. The anchor is
 *  machinery — a dictionary path is not an address a reader recognizes — and it would push the readable
 *  part of the route out of a one-line column. */
export function displayHref(href: string): string {
  const [route, query] = href.split('?');
  if (!query) return href;
  const rest = query.split('&').filter((pair) => !pair.startsWith(`${ROW_ANCHOR_PARAM}=`)).join('&');
  return rest ? `${route}?${rest}` : route!;
}

export function rankCandidates(entries: SearchEntry[]): { id: string; text: string }[] {
  return entries.slice(0, SEARCH_MAX_CANDIDATES).map((entry) => ({
    id: clamp(entry.id),
    text: clamp([entry.title, entry.subtitle ?? '', ...entry.keywords].filter(Boolean).join(' · ')),
  })).filter((candidate) => candidate.text !== '');
}

/** What the assistant reads: exactly the title and subtitle the palette RENDERS, so the model is choosing
 *  between the same rows the user was looking at rather than an internal representation of them. */
export function askCandidates(entries: SearchEntry[]): { id: string; title: string; subtitle?: string }[] {
  return entries.slice(0, SEARCH_MAX_CANDIDATES)
    .filter((entry) => entry.title !== '')
    .map((entry) => ({
      id: clamp(entry.id),
      title: clamp(entry.title),
      ...(entry.subtitle ? { subtitle: clamp(entry.subtitle) } : {}),
    }));
}

/** The palette's rows, from data that already exists. Pure — unit-tested in `tests/lib/siteSearch.test.ts`. */
export function buildSearchIndex(t: LocaleDict, pluginEntries: PluginUiListing[]): SearchEntry[] {
  // Read the string the component renders. Nothing here holds a second copy of any label.
  const loc = (path: string): string => dictAt(t, path);

  const entries: SearchEntry[] = [];

  // PAGES — every core module route, with the old "Go to …" semantics folded in: the title is the page
  // itself, Enter navigates, the route rides in the shortcut column. `m.label` (the registry's
  // language-neutral fallback) stays a keyword, so an English term still finds a localized page.
  for (const m of MODULES) {
    entries.push({
      id: `page:${m.id}`,
      group: 'pages',
      title: loc(`page.${m.id}`),
      keywords: [m.label],
      href: m.route,
      icon: m.icon,
    });
  }

  // SETTINGS — the deck's sections, then each section's static rows via the declarative tables above.
  const sectionById = new Map(SETTINGS_SECTIONS.map((section) => [section.id, section]));
  for (const section of SETTINGS_SECTIONS) {
    entries.push({
      id: `settings:${section.id}`,
      group: 'settings',
      title: loc(`settings.${section.id}`),
      subtitle: loc('page.settings'),
      keywords: [dictAt(t, `settings.${section.id}SectionHint`)],
      href: `/settings?cat=${section.id}`,
      icon: section.icon,
    });
    const rows = SETTINGS_ROWS[section.id];
    if (!rows) continue;
    for (const row of rows) {
      entries.push({
        id: `settings:${section.id}:${row.path}`,
        group: 'settings',
        title: loc(row.path),
        subtitle: loc(`settings.${section.id}`),
        keywords: [
          row.hint ? loc(row.hint) : '',
          ...(row.keywords ?? []),
        ].filter((keyword) => keyword !== ''),
        href: rowHref(`/settings?cat=${section.id}`, row.path),
        icon: sectionById.get(section.id)?.icon,
      });
    }
  }
  // Models: static provider groups only (its model rows are runtime data).
  for (const label of MODEL_GROUPS) {
    entries.push({
      id: `settings:models:provider:${label}`,
      group: 'settings',
      title: label,
      subtitle: loc('settings.models'),
      keywords: [],
      href: '/settings?cat=models',
    });
  }

  // ACCOUNT — the account deck and its sections, using the account page's `?cat=` deep-link form.
  for (const section of ACCOUNT_SECTIONS) {
    entries.push({
      id: `account:${section.id}`,
      group: 'account',
      title: loc(section.titlePath),
      subtitle: loc('account.title'),
      keywords: [section.hintPath ? loc(section.hintPath) : ''].filter(Boolean),
      href: `/account?cat=${section.id}`,
      icon: section.icon,
    });
    const accountRows: readonly RowSpec[] = ACCOUNT_ROW_SPECS[section.id];
    for (const row of accountRows) {
      entries.push({
        id: `account:${section.id}:${row.path}`,
        group: 'account',
        title: loc(row.path),
        subtitle: loc(section.titlePath),
        keywords: [row.hint ? loc(row.hint) : '', ...(row.keywords ?? [])].filter((keyword) => keyword !== ''),
        href: rowHref(`/account?cat=${section.id}`, row.path),
        icon: section.icon,
      });
    }
  }

  // PLUGINS — one entry per plugin PAGE (a world with sub-items contributes each of them), already
  // localized by the daemon's listing. Plugin account/config sections stay out: they exist only while
  // the plugin is enabled, and the plugin's pages are the way in.
  const pluginPages = pluginNavEntries(pluginEntries)
    .flatMap<{ href?: string; label: string; icon?: LucideIcon }>((world) => world.subItems ?? [world])
    .filter((entry) => entry.href && entry.icon);
  for (const page of pluginPages) {
    entries.push({
      id: `plugin:${page.href}`,
      group: 'plugins',
      title: page.label,
      keywords: [],
      href: page.href!,
      icon: page.icon,
    });
  }

  return entries;
}