import type { LucideIcon } from 'lucide-react';
import { Bell, Brain, Cpu, KeyRound, Sparkles, SquareTerminal, UserCog } from 'lucide-react';
import { interpolate } from './i18n';
import type { LocaleDict } from './i18n/types';
import { MODULES } from '../modules/registry';
import { SETTINGS_SECTIONS, type SettingsCategory } from '../modules/settings/categories';
import { PROVIDERS } from '../modules/settings/providers';
import { pluginNavEntries } from './pluginNav';
import type { PluginUiListing } from './types';

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

export interface BuildSearchIndexOptions {
  /** The assistant's display name, substituted into the `{agentName}` placeholders the dictionary
   *  strings carry (the Brain section is titled "{agentName} AI"). Absent, placeholders stay verbatim. */
  agentName?: string;
}

/** One indexed row inside a settings/account section: the dictionary paths the section's component
 *  already renders. `hint` is the row description (searched as a keyword, never shown), `keywords`
 *  carries pragmatic aliases (an English term for a Czech-labelled control). */
interface RowSpec { path: string; hint?: string; keywords?: string[] }

interface SectionSpec {
  id: string;
  titlePath: string;
  hintPath?: string;
  rows: RowSpec[];
}

/** A dictionary path like `brain.retention.title`, resolved against the dictionary at build time. */
function dictAt(t: LocaleDict, path: string): string {
  let node: unknown = t;
  for (const part of path.split('.')) {
    if (typeof node !== 'object' || node === null) return '';
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : '';
}

/** Settings rows, one table per section, keyed by the deck's own category ids. The ids are the exact
 *  dictionary paths each section component renders — updating a label on the page updates the index
 *  with it, because it is the same string. */
const SETTINGS_ROWS: Record<SettingsCategory, RowSpec[]> = {
  system: [
    { path: 'settings.serviceDaemon' },
    { path: 'settings.serviceWeb' },
    { path: 'settings.autoUpdate', keywords: ['update'] },
    { path: 'settings.skins.label', hint: 'settings.skins.hint' },
    { path: 'settings.pushContact', hint: 'help.pushContact' },
    { path: 'settings.tokenTtl', hint: 'help.tokenTtl' },
    { path: 'settings.retention.label', hint: 'settings.retention.hint' },
    { path: 'settings.systemDiagnostics', hint: 'settings.systemSectionHint' },
  ],
  brain: [
    // The provider groups' rows are the live account/provider listings — their static group titles are
    // what gets indexed, exactly as the spec asks for dynamic sections.
    { path: 'brain.accounts' },
    { path: 'brain.providers' },
    { path: 'brain.agentName' },
    { path: 'brain.maxSteps', hint: 'brain.maxStepsHint' },
    { path: 'brain.limits.title', hint: 'brain.limits.hint' },
    { path: 'brain.runtime.title', hint: 'brain.runtime.hint' },
    { path: 'brain.toolLoading.title', hint: 'brain.toolLoading.hint' },
    { path: 'brain.retention.title', hint: 'brain.retention.hint' },
  ],
  models: [],
  plugins: [],
  memory: [
    { path: 'memory.embeddingProvider', hint: 'help.embeddingProvider' },
    { path: 'memory.embeddingModel', hint: 'help.embeddingIntro' },
    { path: 'memory.embeddingModelCustom', hint: 'help.embeddingModelCustom' },
    { path: 'memory.embeddingDimensions', hint: 'help.embeddingDimensions' },
    { path: 'categorization.providerLabel', hint: 'help.categorizationProvider' },
    { path: 'categorization.modelLabel', hint: 'help.categorizationIntro' },
  ],
  dashboard: [
    { path: 'settings.dashboardSection.recap', hint: 'settings.dashboardSection.recapDesc' },
    { path: 'settings.dashboardSection.digest', hint: 'settings.dashboardSection.digestDesc' },
    { path: 'settings.dashboardSection.perDay', hint: 'settings.dashboardSection.perDayDesc' },
    { path: 'settings.dashboardSection.greeting', hint: 'settings.dashboardSection.greetingDesc' },
    { path: 'settings.dashboardSection.pills', hint: 'settings.dashboardSection.pillsDesc' },
    { path: 'settings.dashboardSection.continue', hint: 'settings.dashboardSection.continueDesc' },
    { path: 'settings.dashboardSection.provider', hint: 'settings.dashboardSection.modelFallback' },
    { path: 'settings.dashboardSection.model', hint: 'settings.dashboardSection.modelDesc' },
  ],
  data: [
    { path: 'settings.conversationDiagnostics.title', hint: 'settings.conversationDiagnostics.description' },
    { path: 'settings.logs' },
  ],
};

/** The Models section's static group titles: the provider catalog is static data, its MODEL rows are
 *  not — so the groups go in and the models stay out. */
const MODEL_GROUPS = PROVIDERS.filter((provider) => provider.embedded).map((provider) => provider.label);

/** Account deck sections, mirroring `AccountView`'s rail. Plugin-contributed sections are dynamic and
 *  are not indexed; the plugin's own pages are. */
const ACCOUNT_SECTIONS: { id: string; icon: LucideIcon; titlePath: string; hintPath?: string; rows: RowSpec[] }[] = [
  {
    id: 'profile', icon: UserCog, titlePath: 'account.tabProfile', hintPath: 'account.profileHint',
    rows: [
      { path: 'account.defaultElowenAi', hint: 'account.defaultElowenAiHint' },
      { path: 'account.name' },
      { path: 'account.email' },
      { path: 'account.uiScale', hint: 'help.accountUiScale' },
      { path: 'account.effectsTitle', hint: 'account.effectsHint' },
      { path: 'account.linkedAccounts' },
    ],
  },
  {
    id: 'cli', icon: Cpu, titlePath: 'account.tabCli', hintPath: 'account.defaultElowenAiHint',
    rows: [
      { path: 'cli.yoloTitle' },
      { path: 'cli.unattendedTitle' },
      { path: 'cli.fastModeTitle' },
      { path: 'cli.autoCompact' },
      { path: 'cli.compactModelLabel' },
      { path: 'cli.visionModelLabel' },
      { path: 'cli.thinkingLabel' },
    ],
  },
  {
    id: 'memory', icon: Brain, titlePath: 'account.tabMemory', hintPath: 'help.memoryRecall',
    rows: [
      { path: 'accountMemory.recallTitle', hint: 'accountMemory.recallToggle' },
      { path: 'accountMemory.liveRecallTitle', hint: 'accountMemory.liveRecallToggle' },
      { path: 'accountMemory.saveTitle', hint: 'accountMemory.saveToggle' },
    ],
  },
  {
    id: 'personality', icon: Sparkles, titlePath: 'account.tabPersonality', hintPath: 'personality.intro',
    rows: [
      { path: 'personality.styleLabel' },
      { path: 'personality.bodyLabel' },
    ],
  },
  {
    id: 'notifications', icon: Bell, titlePath: 'account.tabNotifications', hintPath: 'help.pushEnable',
    rows: [{ path: 'push.title', hint: 'help.pushEnable' }],
  },
  {
    id: 'security', icon: KeyRound, titlePath: 'account.tabSecurity', hintPath: 'account.passwordHint',
    rows: [{ path: 'account.password', hint: 'account.passwordHint' }],
  },
  {
    id: 'terminal', icon: SquareTerminal, titlePath: 'account.tabTerminal', hintPath: 'terminal.colorsHelp',
    rows: [
      { path: 'terminal.colorsTitle' },
      { path: 'terminal.cursorTitle' },
      { path: 'terminal.fontTitle' },
      { path: 'terminal.historyTitle' },
    ],
  },
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

/** cmdk's custom `filter`: 1 keeps the item, 0 drops it. Matches over the item's VALUE plus its
 *  keywords (the same concatenation cmdk's own default filter applies), both normalized above — so
 *  "retenc" (no diacritics) scores the "Retence paměti" row. */
export function searchFilter(value: string, search: string, keywords?: string[]): number {
  const q = normalizeText(search);
  if (!q) return 1;
  const haystack = keywords && keywords.length > 0 ? `${value} ${keywords.join(' ')}` : value;
  return normalizeText(haystack).includes(q) ? 1 : 0;
}

/** The palette's rows, from data that already exists. Pure — unit-tested in `tests/lib/siteSearch.test.ts`. */
export function buildSearchIndex(t: LocaleDict, pluginEntries: PluginUiListing[], options: BuildSearchIndexOptions = {}): SearchEntry[] {
  const { agentName } = options;
  // Read the string the component renders and substitute its one live placeholder. Nothing here holds
  // a second copy of any label.
  const loc = (path: string): string => {
    const raw = dictAt(t, path);
    return agentName !== undefined ? interpolate(raw, { agentName }) : raw;
  };

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
        href: `/settings?cat=${section.id}`,
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
    for (const row of section.rows) {
      entries.push({
        id: `account:${section.id}:${row.path}`,
        group: 'account',
        title: loc(row.path),
        subtitle: loc(section.titlePath),
        keywords: [row.hint ? loc(row.hint) : '', ...(row.keywords ?? [])].filter((keyword) => keyword !== ''),
        href: `/account?cat=${section.id}`,
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