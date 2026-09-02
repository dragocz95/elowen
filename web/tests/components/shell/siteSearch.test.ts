import { describe, it, expect } from 'vitest';
import { dictionaries } from '../../../lib/i18n/dictionaries';
import { MODULES } from '../../../modules/registry';
import { SETTINGS_SECTIONS } from '../../../modules/settings/categories';
import { buildSearchIndex, filterEntries, findNormalizedRange, normalizeText, searchFilter } from '../../../components/shell/siteSearch';
import type { PluginUiListing } from '../../../lib/types';

const t = dictionaries.en;

const PLUGIN_LISTING = [
  {
    name: 'work',
    label: 'Work',
    nav: [
      { label: 'Tasks', icon: 'ListChecks', route: 'tasks' },
      { label: 'Kanban', icon: 'KanbanSquare', route: 'kanban' },
    ],
    settings: [{ id: 'prefs', label: 'Preferences', icon: 'Settings' }],
  },
] as unknown as PluginUiListing[];

describe('buildSearchIndex', () => {
  const entries = buildSearchIndex(t, PLUGIN_LISTING);

  it('indexes every core module route', () => {
    for (const m of MODULES) {
      const entry = entries.find((e) => e.group === 'pages' && e.href === m.route);
      expect(entry, `module ${m.id} must be reachable at ${m.route}`).toBeDefined();
      expect(entry!.title).not.toBe('');
    }
  });

  it('indexes every settings category as a ?cat= deep link', () => {
    for (const section of SETTINGS_SECTIONS) {
      const entry = entries.find((e) => e.href === `/settings?cat=${section.id}`);
      expect(entry, `settings section ${section.id} must be indexed`).toBeDefined();
      expect(entry!.title).not.toBe('');
    }
  });

  it('indexes the settings sections\' rows, each pointing at its own section', () => {
    // One row per indexed dictionary path, grouped under the section the row actually lives in.
    const rows = entries.filter((e) => e.group === 'settings' && e.id.split(':').length > 2);
    expect(rows.length).toBeGreaterThan(10);
    for (const row of rows) {
      const section = row.id.split(':')[1]!;
      expect(row.href, `${row.id} must deep-link its own section`).toBe(`/settings?cat=${section}`);
      expect(row.subtitle).not.toBe('');
      expect(row.title).not.toBe('');
    }
    // The retention row is found where the deck renders it (Settings → {agentName} AI).
    expect(entries.find((e) => e.title === t.brain.retention.title)?.href).toBe('/settings?cat=brain');
  });

  it('indexes the account sections as ?cat= deep links', () => {
    for (const id of ['profile', 'cli', 'memory', 'personality', 'notifications', 'security', 'terminal']) {
      const entry = entries.find((e) => e.href === `/account?cat=${id}`);
      expect(entry, `account section ${id} must be indexed`).toBeDefined();
      expect(entry!.title).not.toBe('');
    }
  });

  it('indexes one entry per plugin page', () => {
    const hrefs = entries.filter((e) => e.group === 'plugins').map((e) => e.href);
    expect(hrefs).toContain('/p/work/tasks');
    expect(hrefs).toContain('/p/work/kanban');
    // A plugin's settings section is a page of its world (a single-section plugin lives at /p/<name>).
    expect(hrefs).toContain('/p/work/settings/prefs');
  });

  it('mints no duplicate ids', () => {
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('resolves every dictionary path it references — an empty title would be a typo', () => {
    for (const entry of entries) {
      expect(entry.title, `${entry.id} resolved to an empty title`).not.toBe('');
      for (const keyword of entry.keywords) expect(keyword, `${entry.id} carries an empty keyword`).not.toBe('');
    }
  });
});

describe('diacritics-insensitive matching', () => {
  it('normalizes case and diacritics', () => {
    expect(normalizeText('Paměť')).toBe(normalizeText('pamet'));
    expect(normalizeText('Retence')).toBe(normalizeText('retence'));
  });

  it('maps a match back onto the original accented string', () => {
    expect(findNormalizedRange('Retence paměti', 'retenc')).toEqual([0, 6]);
    expect(findNormalizedRange('Retence paměti', 'PAMET')).toEqual([8, 13]);
    expect(findNormalizedRange('Retence paměti', 'xyz')).toBeNull();
    expect(findNormalizedRange('Retence paměti', '')).toBeNull();
  });

  it('scores items over value plus keywords', () => {
    const value = 'settings:brain:brain.retention.title';
    const keywords = ['Retence paměti', 'Elowen AI', 'Jak dlouho si nepoužívaná paměť zachová vitalitu'];
    expect(searchFilter(value, 'retence', keywords)).toBe(1);
    expect(searchFilter(value, 'RETENC', keywords)).toBe(1);
    expect(searchFilter(value, 'retenc', keywords)).toBe(1);
    // …and over the value itself, so an id-shaped query finds its row too.
    expect(searchFilter(value, 'retention.title', keywords)).toBe(1);
    expect(searchFilter(value, 'nonsense', keywords)).toBe(0);
  });

  it('pre-filters the palette rows over title, subtitle and keywords', () => {
    // "retence" is a Czech query: against the Czech dictionary it reaches the Brain-runtime retention row.
    const entries = buildSearchIndex(dictionaries.cs, PLUGIN_LISTING);
    const found = filterEntries(entries, 'retence').map((entry) => entry.id);
    // The Brain-runtime retention row and the runtime record whose hint mentions retence protokolu.
    expect(found).toContain('settings:brain:brain.retention.title');
    expect(filterEntries(entries, 'retence')).toContainEqual(expect.objectContaining({ href: '/settings?cat=brain' }));
    // The launcher (empty query) hands back everything it was given, in index order.
    expect(filterEntries(entries, '  ')).toEqual(entries);
    expect(filterEntries(buildSearchIndex(t, []), '')).toHaveLength(buildSearchIndex(t, []).length);
  });
});