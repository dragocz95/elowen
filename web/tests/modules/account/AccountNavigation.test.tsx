import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { Blocks } from 'lucide-react';
import { AccountNavigation } from '../../../modules/account/AccountNavigation';
import { accountSectionHref, accountSections, type AccountSectionDescriptor } from '../../../modules/account/sections';
import { pluginAccountSectionId } from '../../../modules/account/pluginSections';
import { en } from '../../../lib/i18n/dictionaries/en';

/** THE PHONE'S ONE LINE OF TABS.
 *
 *  The strip is narrower than its own contents: the sections near its end — the terminal, or whatever a
 *  plugin contributes — sit off to the right until something scrolls to them. Arriving on one of those
 *  through a deep link or through the shell's menu has to bring it into view, on the HORIZONTAL axis
 *  only: `scrollIntoView` would also ask the overlay's scroller to move, which on a phone means the page
 *  jumping under the reader's thumb. */

/** A CONTRIBUTED section, which is the case the reach matters for: it arrives from a live query a commit
 *  after the core list, and it is drawn after every one of them, so it is the section most likely to sit
 *  off the end of the strip. Its id is the plugin's own, spelled by the shared registry helper. */
const CONTRIBUTED: AccountSectionDescriptor = {
  id: pluginAccountSectionId('github', 'connection'),
  icon: Blocks,
  label: 'GitHub',
  description: 'Your GitHub identity.',
};
const SECTIONS = accountSections(en, [CONTRIBUTED]);
const LAST = SECTIONS[SECTIONS.length - 1]!;
const rect = (left: number, right: number, top: number): DOMRect => ({
  left, right, top, bottom: top + 40, width: right - left, height: 40, x: left, y: top, toJSON: () => ({}),
} as DOMRect);

/** Give the strip a real geometry: 100px of room over 400px of tabs, with the tab named by `label` out
 *  beyond its right edge and moving with the track, exactly as a scrolled box does.
 *
 *  Measured through the prototype rather than through the element, because a tab that has not been
 *  rendered yet is precisely the case the second test is about. */
function measure(nav: HTMLElement, label: string): void {
  Object.defineProperties(nav, {
    clientWidth: { configurable: true, value: 100 },
    scrollWidth: { configurable: true, value: 400 },
    scrollLeft: { configurable: true, writable: true, value: 0 },
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this === nav) return rect(0, 100, 300);
    if (this.tagName === 'BUTTON' && this.textContent === label) return rect(250 - nav.scrollLeft, 320 - nav.scrollLeft, 900);
    return rect(0, 0, 0);
  });
}

const tabs = (props: { active: string; sections?: readonly AccountSectionDescriptor[] }) => (
  <AccountNavigation
    label={en.account.title}
    sections={props.sections ?? SECTIONS}
    active={props.active}
    layout="tabs"
    onNavigate={() => {}}
  />
);

afterEach(() => { vi.restoreAllMocks(); document.documentElement.scrollTop = 0; });

describe('AccountNavigation tab strip', () => {
  it('scrolls the section that becomes active into view without moving the page', () => {
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    const { rerender } = render(tabs({ active: 'profile' }));
    const nav = screen.getByTestId('account-navigation-tabs');
    measure(nav, LAST.label);
    document.documentElement.scrollTop = 75;

    rerender(tabs({ active: LAST.id }));

    // 320 (the tab's right edge) − 100 (the strip's) = the shortfall the track scrolls by.
    expect(nav.scrollLeft).toBe(220);
    expect(document.documentElement.scrollTop).toBe(75);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  /** The deep-link case: a plugin's section — or any section at all — arrives from a live query one
   *  commit after the strip first painted, so the reveal has to follow the CONTENT, not just the id. */
  it('reveals the active section when it only appears later', () => {
    const { rerender } = render(tabs({ active: LAST.id, sections: SECTIONS.slice(0, 2) }));
    const nav = screen.getByTestId('account-navigation-tabs');
    expect(within(nav).queryByRole('button', { name: LAST.label })).toBeNull();
    measure(nav, LAST.label);

    rerender(tabs({ active: LAST.id, sections: SECTIONS }));

    expect(within(nav).getByRole('button', { name: LAST.label })).toBeInTheDocument();
    expect(nav.scrollLeft).toBe(220);
  });

  it('keeps every section a tab stop of its own, with the active one marked', () => {
    render(tabs({ active: LAST.id }));
    const nav = screen.getByTestId('account-navigation-tabs');
    const buttons = within(nav).getAllByRole('button');
    expect(buttons).toHaveLength(SECTIONS.length);
    expect(buttons.every((button) => !button.hasAttribute('tabindex'))).toBe(true);
    expect(within(nav).getByRole('button', { name: LAST.label })).toHaveAttribute('aria-current', 'page');
  });

  /** The column is a vertical list in a pane of its own; the horizontal reveal belongs to the strip. */
  it('leaves the desktop column alone', () => {
    render(
      <AccountNavigation label={en.account.title} sections={SECTIONS} active={LAST.id} layout="sidebar" onNavigate={() => {}} />,
    );
    const nav = screen.getByTestId('account-navigation-sidebar');
    expect(nav.scrollLeft).toBe(0);
  });

  /** A section an installed plugin contributes is a section of this deck like any other, in both shapes
   *  of the navigation and reached by the SAME address grammar. It used to be a row of the shell's menu,
   *  which is where the way to it was tested; the deck owns that now, so the deck is what has to carry it
   *  — including the id's own spelling, which is the plugin's and has to survive into the link. */
  it('carries a contributed section as a row of its own, in both shapes', () => {
    const onNavigate = vi.fn();
    const { unmount } = render(
      <AccountNavigation label={en.account.title} sections={SECTIONS} active={CONTRIBUTED.id} layout="tabs" onNavigate={onNavigate} />,
    );
    const tabs = screen.getByTestId('account-navigation-tabs');
    const tab = within(tabs).getByRole('button', { name: CONTRIBUTED.label });
    expect(tab).toHaveAttribute('aria-current', 'page');
    expect(within(tabs).getAllByRole('button')).toHaveLength(SECTIONS.length);
    unmount();

    render(
      <AccountNavigation label={en.account.title} sections={SECTIONS} active={CONTRIBUTED.id} layout="sidebar" onNavigate={onNavigate} />,
    );
    const column = screen.getByTestId('account-navigation-sidebar');
    const row = within(column).getByRole('button', { name: CONTRIBUTED.label });
    expect(row).toHaveAttribute('aria-current', 'page');
    // The canonical href, from the one helper: a plugin id carries colons, and the page writes the same
    // address back with `URLSearchParams`.
    fireEvent.click(row);
    expect(onNavigate).toHaveBeenCalledWith(accountSectionHref(CONTRIBUTED.id), CONTRIBUTED.id);
  });
});
