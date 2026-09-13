'use client';

import type { AccountSection, AccountSectionDescriptor } from './sections';
import { accountSectionHref } from './sections';

/** The account overlay's own section navigation.
 *
 *  It exists only in the overlay presentation, for the same reason Settings' does: the shell's menu — the
 *  single place the sections are listed from — is inert while an overlay is up, so a page presented over
 *  another surface has to carry the way between its own sections. The canonical `/account` page keeps no
 *  navigation of its own (tests/modules/account/AccountView.test.tsx pins that).
 *
 *  Two shapes of ONE list, because the two viewports have room for different things and neither answer
 *  fits the other: a quiet secondary column beside the content where there is width for it, and a single
 *  line of tabs above the content on a phone, which scrolls sideways instead of hiding the section the
 *  reader just opened behind a pane switch.
 *
 *  There is no search field. Settings has one because it holds six dense decks plus every plugin's
 *  settings, and its rows are indexed for the command palette; the account's sections are a handful of
 *  named places, and a box that filters seven rows is a control that costs more than it saves. */
export function AccountNavigation({ label, sections, active, layout, onNavigate, className = '' }: {
  /** Accessible name of the navigation region. */
  label: string;
  sections: readonly AccountSectionDescriptor[];
  active: string;
  layout: 'sidebar' | 'tabs';
  onNavigate: (href: string, section: AccountSection) => void;
  className?: string;
}) {
  const tabs = layout === 'tabs';
  return (
    <nav
      aria-label={label}
      data-testid={tabs ? 'account-navigation-tabs' : 'account-navigation-sidebar'}
      className={tabs
        ? `flex shrink-0 items-center gap-1 overflow-x-auto overscroll-x-contain whitespace-nowrap pb-2 ${className}`
        : `flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain p-3 ${className}`}
    >
      {sections.map((section) => {
        const Icon = section.icon;
        const current = section.id === active;
        return (
          <button
            key={section.id}
            type="button"
            aria-current={current ? 'page' : undefined}
            onClick={() => onNavigate(accountSectionHref(section.id), section.id)}
            title={tabs ? undefined : section.description}
            className={[
              'flex shrink-0 items-center gap-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
              tabs ? 'h-8 rounded-full px-3 text-xs' : 'h-9 rounded-lg px-2.5 text-left text-sm',
              current
                ? 'bg-accent font-medium text-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            ].join(' ')}
          >
            <Icon size={tabs ? 14 : 16} strokeWidth={1.75} aria-hidden className={current ? 'text-primary' : undefined} />
            <span className={tabs ? undefined : 'min-w-0 truncate'}>{section.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
