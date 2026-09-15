'use client';

import { DeckNavigation, type DeckNavGroup } from '../../components/ui/SectionDeck';
import { buildAccountSearchEntries, filterEntries, normalizeText } from '../../components/shell/siteSearch';
import type { LocaleDict } from '../../lib/i18n/types';
import type { AccountSection, AccountSectionDescriptor } from './sections';
import { accountSectionHref } from './sections';

/** WHAT THE ACCOUNT DECK PUTS IN ITS NAVIGATION. The shape of it — the searchable column, the phone's one
 *  line, a record's anatomy — is the shared `DeckNavigation` that `/settings` draws too.
 *
 *  Every arrival carries it: the shell's menu lists the deck as ONE row and nothing inside it, so a
 *  `/account?cat=security` reached by a deep link, a refresh or the menu would otherwise have no way to
 *  any other section.
 *
 *  The search reads the same static index as the command palette (`components/shell/siteSearch.ts`), so a
 *  reader who knows the name of a record — "push", "passkey", "compaction" — reaches it without knowing
 *  which section it lives in, and nothing typed into a field on the page is ever searchable. A section a
 *  plugin contributes is not in that index (it exists only while its plugin is enabled), so it matches on
 *  its own label. */
export function AccountNavigation({ t, sections, active, query, layout, onQueryChange, onNavigate, className = '' }: {
  t: LocaleDict;
  sections: readonly AccountSectionDescriptor[];
  active: string;
  query: string;
  layout: 'sidebar' | 'tabs';
  onQueryChange: (query: string) => void;
  onNavigate: (href: string, section: AccountSection) => void;
  className?: string;
}) {
  const normalizedQuery = query.trim();
  const needle = normalizeText(normalizedQuery);
  const entries = filterEntries(buildAccountSearchEntries(t), normalizedQuery);
  const matchesFor = (id: string) => entries.filter((entry) => entry.id === `account:${id}` || entry.id.startsWith(`account:${id}:`));
  const visibleSections = normalizedQuery
    ? sections.filter((section) => matchesFor(section.id).length > 0 || normalizeText(section.label).includes(needle))
    : sections;

  const groups: DeckNavGroup[] = [{
    id: 'sections',
    caption: t.account.title,
    items: visibleSections.map((section) => ({
      id: section.id,
      label: section.label,
      icon: section.icon,
      current: section.id === active,
      onActivate: () => onNavigate(accountSectionHref(section.id), section.id),
      // The records a query found inside the section, each addressable on its own: the href carries the
      // row anchor, so choosing one opens the section AND blinks the record, exactly as the palette does.
      matches: normalizedQuery
        ? matchesFor(section.id)
          .filter((entry) => entry.id !== `account:${section.id}`)
          .slice(0, 3)
          .map((entry) => ({ id: entry.id, label: entry.title, onActivate: () => onNavigate(entry.href, section.id) }))
        : [],
    })),
  }];

  return (
    <DeckNavigation
      label={t.account.navigationLabel}
      groups={groups}
      layout={layout}
      testId="account-navigation"
      search={{ value: query, onChange: onQueryChange, label: t.account.navigationSearch }}
      emptyLabel={t.account.navigationNoMatches}
      className={className}
    />
  );
}
