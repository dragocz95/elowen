'use client';

import { useEffect, useId, useRef } from 'react';
import { Search, type LucideIcon } from 'lucide-react';
import { revealHorizontalItem } from '../../components/ui/horizontalScroll';
import type { LocaleDict } from '../../lib/i18n/types';
import type { PluginUiListing } from '../../lib/types';
import { HelpTip } from '../../components/ui/HelpTip';
import { interpolate } from '../../lib/i18n';
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
  /** Two shapes of ONE list. `sidebar` is the searchable secondary column beside the content where there
   *  is width for it; `tabs` is the single line of sections above the content on a phone. See the
   *  component doc for why the phone answer is a strip rather than a pane switch. */
  layout: 'sidebar' | 'tabs';
  onQueryChange: (query: string) => void;
  onNavigate: (href: string, category: SettingsCategory) => void;
  onOpenPlugin: (href: string) => void;
  className?: string;
}

/** ONE navigation record: the leading glyph, the name and the shared help affordance.
 *
 *  DENSITY. The record is a 2rem row — the height this app's own primary sidebar row uses, and the one
 *  the reference secondary navigation uses — and grows to the `--touch-target` floor for a COARSE
 *  POINTER. Pointer capability, not a viewport width: a tablet with a finger is wide enough for the
 *  column and still reaches it by touch, so a `md:` breakpoint would have handed exactly that device the
 *  compact mouse rhythm. This is the app's established idiom, stated the same way `Pager`,
 *  `RegisterSearch` and `.sidebar-nav__sub-item` state it.
 *
 *  The icon is a plain 1rem glyph held at half opacity, exactly as `.sidebar-nav__icon` holds one: the
 *  boxed 2rem badge that used to lead each record made the column read as a list of buttons and cost the
 *  list a third of its height. The trailing chevron went with it — it pointed at nothing a vertical
 *  navigation does not already say, and the record's own fill is what marks which section is open.
 *
 *  The section's own sentence used to be printed UNDER the name, where an 18rem column truncated every
 *  one of them mid-word ("Spravujte identitu asistenta, pr…") and doubled the height of the list for text
 *  nobody could read. It lives behind the shared `HelpTip` now — the same question mark a settings record
 *  and a section header already carry — so it is available on hover, focus and tap, and the row is one
 *  line again.
 *
 *  The activating control is a button STRETCHED over the record rather than one wrapping it (the idiom
 *  `.data-table-row-open` uses for the same reason). A HelpTip is itself a button, and a button inside a
 *  button is markup no browser treats as two controls: the help would be unreachable from the keyboard
 *  and pressing it would navigate. Stretched, the record keeps one tab stop, the help keeps its own, and
 *  the help — positioned, and after the stretched control in DOM — takes its own pointer events, so
 *  revealing it never navigates. The help carries its OWN 24x24 hit area (see `HelpTip`), because a 16px
 *  mark floating over a full-width navigation control turns every near miss into a navigation, and it is
 *  named after the record it belongs to rather than being the twelfth button called "Help". */
function SettingsNavRow({ t, label, hint, icon: Icon, active = false, onActivate }: {
  t: LocaleDict;
  label: string;
  hint?: string;
  icon: LucideIcon;
  active?: boolean;
  onActivate: () => void;
}) {
  const labelId = useId();
  return (
    <div className={`relative flex h-8 items-center gap-2.5 rounded-lg px-2 transition-colors hover:bg-accent pointer-coarse:min-h-[var(--touch-target)] ${active ? 'bg-accent' : ''}`}>
      <button
        type="button"
        aria-labelledby={labelId}
        aria-current={active ? 'page' : undefined}
        onClick={onActivate}
        className="absolute inset-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      />
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-foreground opacity-50" aria-hidden>
        <Icon size={16} strokeWidth={1.75} />
      </span>
      <span id={labelId} className="min-w-0 truncate text-sm font-medium text-foreground">{label}</span>
      {hint ? <HelpTip align="left" label={interpolate(t.common.helpFor, { label })}>{hint}</HelpTip> : null}
    </div>
  );
}

/** The overlay's section navigation, in the two shapes the two viewports have room for.
 *
 *  It exists only in the overlay presentation: the shell's menu — the single place these sections are
 *  listed from — is inert while an overlay is up, so a page presented over another surface has to carry
 *  the way between its own sections.
 *
 *  `sidebar` is the searchable secondary column. Labels come from the same static index as the command
 *  palette, so typed field values, fetched secrets and transient status text are never searchable here.
 *
 *  `tabs` is the phone's answer, and it is the SAME strip `/account` already uses: one line of sections
 *  above the content, scrolled sideways with a thumb. It replaced a master/detail pane switch, which hid
 *  the section the reader had just opened behind a "back" step and made moving between two sections a
 *  four-tap round trip. The strip carries no search field: it is a way BETWEEN places, and a filter box
 *  belongs with the column that has room to show what it filtered. Core sections and plugin decks share
 *  the one line, in the order the column lists them. */
export function SettingsNavigation({ t, sections, pluginEntries, active, query, layout, onQueryChange, onNavigate, onOpenPlugin, className = '' }: SettingsNavigationProps) {
  const tabs = layout === 'tabs';
  const trackRef = useRef<HTMLElement>(null);
  const activeTabRef = useRef<HTMLButtonElement>(null);
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

  /** Keep the section on screen visible on the phone's one line.
   *
   *  The strip is narrower than its own contents, so a section near the end — Data, or whatever a plugin
   *  contributes — is off to the right until it is scrolled to. Arriving on it through a deep link, the
   *  command palette or a remembered category would otherwise show a tab row with nothing marked in it.
   *
   *  `revealHorizontalItem` is the shared idiom (components/ui/horizontalScroll.ts): it moves the track's
   *  own `scrollLeft` by the measured shortfall, so no ancestor scroller is asked to move the page
   *  vertically and there is no animation for a reduced-motion preference to have an opinion about.
   *
   *  Keyed on what the strip SHOWS rather than on the arrays it was handed: both are rebuilt on every
   *  render, while a plugin's deck arrives from a live query a commit later. */
  const stripKey = [...visibleSections.map((section) => section.id), ...visiblePlugins.map((plugin) => plugin.id)].join('\u0001');
  useEffect(() => {
    if (!tabs) return;
    const track = trackRef.current;
    const item = activeTabRef.current;
    if (!track || !item) return;
    revealHorizontalItem(track, item);
  }, [active, stripKey, tabs]);

  if (tabs) {
    const strip = [
      ...visibleSections.map((section) => ({
        key: section.id,
        label: section.label,
        Icon: section.icon,
        current: active === section.id,
        activate: () => onNavigate(settingsSectionHref(section.id), section.id),
      })),
      // A plugin deck is a page of that plugin's own world rather than a peer category, exactly as in the
      // column; it is reachable from the same line because the phone has no second way to reach it.
      ...visiblePlugins.map(({ id, label, href, Icon }) => ({
        key: `plugin:${id}`,
        label,
        Icon,
        current: false,
        activate: () => onOpenPlugin(href),
      })),
    ];
    return (
      <nav
        ref={trackRef}
        aria-label={t.settings.navigationLabel}
        data-testid="settings-navigation-tabs"
        className={`settings-section-strip flex shrink-0 items-center gap-1 overflow-x-auto overscroll-x-contain whitespace-nowrap pb-2 ${className}`}
      >
        {strip.map(({ key, label, Icon, current, activate }) => (
          <button
            key={key}
            ref={current ? activeTabRef : undefined}
            type="button"
            aria-current={current ? 'page' : undefined}
            onClick={activate}
            className={`settings-section-strip__tab flex h-8 shrink-0 select-none items-center gap-2 rounded-full px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
              current ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            }`}
          >
            <Icon size={14} strokeWidth={1.75} aria-hidden className={current ? 'text-primary' : undefined} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    );
  }

  return (
    <div className={`flex min-h-0 flex-1 flex-col ${className}`}>
      <label className="relative block shrink-0 p-3">
        <span className="sr-only">{t.settings.navigationSearch}</span>
        <Search className="pointer-events-none absolute left-6 top-1/2 -translate-y-1/2 text-muted-foreground" size={15} aria-hidden />
        <input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t.settings.navigationSearch}
          className="h-8 w-full rounded-md border border-border bg-background pl-9 pr-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20 pointer-coarse:h-[var(--touch-target)]"
        />
      </label>
      {/* The column's own inset is 0.75rem and a record's is 0.5rem, so a label starts 1.25rem from the
          column edge — the inset the reference navigation uses, and the one that keeps a record's fill
          reading as a pill inside the column rather than as a full-bleed band. */}
      <nav aria-label={t.settings.navigationLabel} data-testid="settings-navigation-sidebar" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3">
        <div className="flex flex-col gap-0.5">
          {/* Named groups, not rules: the core sections and the plugin decks are two lists, and spacing
              plus a quiet caption is what separates them. A horizontal rule made the second one read as
              a footnote under the first. */}
          {visibleSections.length > 0 ? <p className="px-2 pb-1 text-xs text-muted-foreground">{t.page.settings}</p> : null}
          {visibleSections.map((section) => {
            const Icon = section.icon;
            const matches = matchesByCategory.get(section.id) ?? [];
            const labels = normalizedQuery
              ? matches.filter((entry) => entry.id !== `settings:${section.id}`).slice(0, 3)
              : [];
            return (
              <div key={section.id}>
                <SettingsNavRow
                  t={t}
                  label={section.label}
                  hint={section.description}
                  icon={Icon}
                  active={active === section.id}
                  onActivate={() => onNavigate(settingsSectionHref(section.id), section.id)}
                />
                {labels.length > 0 ? (
                  <div className="mb-2 ml-4 flex flex-col border-l border-border pl-3">
                    {labels.map((entry) => (
                      <button
                        key={entry.id}
                        type="button"
                        onClick={() => onNavigate(entry.href, section.id)}
                        className="rounded px-2 py-1 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                      >
                        {entry.title}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
          {visiblePlugins.length > 0 ? (
            <div className="mt-3">
              <p className="px-2 pb-1 text-xs text-muted-foreground">{t.settings.plugins}</p>
              {visiblePlugins.map(({ id, label, href, Icon, matchedSections }) => (
                <div key={id}>
                  {/* A plugin deck has no sentence of its own in the listing, so this record carries no
                      help mark — the same row anatomy with one optional part left out. */}
                  <SettingsNavRow t={t} label={label} icon={Icon} onActivate={() => onOpenPlugin(href)} />
                  {matchedSections.length > 0 ? (
                    <p className="mb-2 ml-4 border-l border-border px-3 py-1 text-xs leading-5 text-muted-foreground">
                      {matchedSections.slice(0, 3).map((setting) => setting.label).join(' · ')}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          {visibleSections.length === 0 && visiblePlugins.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">{t.settings.navigationNoMatches}</p>
          ) : null}
        </div>
      </nav>
    </div>
  );
}
