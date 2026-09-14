'use client';

import type { LocaleDict } from '../../lib/i18n/types';
import type { PluginUiListing } from '../../lib/types';
import { DeckNavigation, type DeckNavGroup } from '../../components/ui/SectionDeck';
import { pluginLucideIcon } from '../../lib/pluginIcons';
import { pluginDetailSectionHref, pluginSectionHref } from '../../lib/pluginNav';
import { settingsSectionHref, type SettingsCategory, type SettingsSectionDescriptor } from './categories';
import { buildSettingsSearchEntries, filterEntries, normalizeText } from '../../components/shell/siteSearch';

interface SettingsNavigationProps {
  t: LocaleDict;
  sections: SettingsSectionDescriptor[];
  pluginEntries: PluginUiListing[];
  active: string;
  query: string;
  /** Two shapes of ONE list — see `DeckNavigation`, which draws both. */
  layout: 'sidebar' | 'tabs';
  onQueryChange: (query: string) => void;
  onNavigate: (href: string, category: SettingsCategory) => void;
  onOpenPlugin: (href: string) => void;
  className?: string;
}

/** WHAT THE SETTINGS DECK PUTS IN ITS NAVIGATION. The shape of that navigation — the searchable column,
 *  the phone's one line, a record's anatomy — belongs to the shared `DeckNavigation`, which `/account`
 *  draws too; this module decides which destinations go into it and where each one leads.
 *
 *  Labels come from the same static index as the command palette (`components/shell/siteSearch.ts`), so
 *  typed field values, fetched secrets and transient status text are never searchable here. */
export function SettingsNavigation({ t, sections, pluginEntries, active, query, layout, onQueryChange, onNavigate, onOpenPlugin, className = '' }: SettingsNavigationProps) {
  const normalizedQuery = query.trim();
  const normalizedNeedle = normalizeText(normalizedQuery);
  const entries = filterEntries(buildSettingsSearchEntries(t), normalizedQuery);
  const matchesByCategory = new Map<SettingsCategory, typeof entries>();
  for (const section of sections) {
    const prefix = `settings:${section.id}`;
    matchesByCategory.set(section.id, entries.filter((entry) => entry.id === prefix || entry.id.startsWith(`${prefix}:`)));
  }
  const visibleSections = normalizedQuery
    ? sections.filter((section) => (matchesByCategory.get(section.id)?.length ?? 0) > 0)
    : sections;
  // One result per plugin settings DECK. Its internal sections enrich matching and may be shown as context,
  // but never become peer categories beside System, Models or the plugin itself.
  const visiblePlugins = pluginEntries.flatMap((plugin) => {
    const settings = plugin.settings;
    const first = settings[0];
    if (!first) return [];
    const label = plugin.label ?? plugin.name;
    const matchedSections = normalizedNeedle
      ? settings.filter((setting) => normalizeText(setting.label).includes(normalizedNeedle))
      : [];
    const matches = !normalizedNeedle
      || normalizeText(label).includes(normalizedNeedle)
      || matchedSections.length > 0;
    if (!matches) return [];
    return [{
      id: plugin.name,
      label,
      href: first.placement === 'pluginDetail'
        ? pluginDetailSectionHref(plugin.name, first.id)
        : pluginSectionHref(plugin, first.id),
      Icon: pluginLucideIcon(first.icon),
      matchedSections,
    }];
  });

  // Named groups, not rules: the core sections and the plugin decks are two lists, and spacing plus a
  // quiet caption is what separates them. A horizontal rule made the second one read as a footnote.
  const groups: DeckNavGroup[] = [
    {
      id: 'sections',
      caption: t.page.settings,
      items: visibleSections.map((section) => ({
        id: section.id,
        label: section.label,
        hint: section.description,
        icon: section.icon,
        current: active === section.id,
        onActivate: () => onNavigate(settingsSectionHref(section.id), section.id),
        matches: normalizedQuery
          ? (matchesByCategory.get(section.id) ?? [])
            .filter((entry) => entry.id !== `settings:${section.id}`)
            .slice(0, 3)
            .map((entry) => ({ id: entry.id, label: entry.title, onActivate: () => onNavigate(entry.href, section.id) }))
          : [],
      })),
    },
    {
      id: 'plugins',
      caption: t.settings.plugins,
      // A plugin deck is a page of that plugin's own world rather than a peer category, so it is never
      // marked current — and it has no sentence of its own in the listing, so it carries no help mark.
      items: visiblePlugins.map(({ id, label, href, Icon, matchedSections }) => ({
        id: `plugin:${id}`,
        label,
        icon: Icon,
        onActivate: () => onOpenPlugin(href),
        matchSummary: matchedSections.length > 0
          ? matchedSections.slice(0, 3).map((setting) => setting.label).join(' · ')
          : undefined,
      })),
    },
  ];

  return (
    <DeckNavigation
      label={t.settings.navigationLabel}
      groups={groups}
      layout={layout}
      testId="settings-navigation"
      search={{ value: query, onChange: onQueryChange, label: t.settings.navigationSearch }}
      emptyLabel={t.settings.navigationNoMatches}
      className={className}
    />
  );
}
