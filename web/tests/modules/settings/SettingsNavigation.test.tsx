import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { SettingsNavigation } from '../../../modules/settings/SettingsNavigation';
import { settingsSections, type SettingsCategory } from '../../../modules/settings/categories';
import { LanguageProvider } from '../../../lib/i18n';
import { en } from '../../../lib/i18n/dictionaries/en';
import type { PluginUiListing } from '../../../lib/types';

function W({ children }: { children: ReactNode }) {
  return <LanguageProvider initialLocale="en">{children}</LanguageProvider>;
}

const sandbox: PluginUiListing = {
  name: 'sandbox',
  label: 'Sandbox',
  url: '/plugins/sandbox/web/hash.js',
  apiVersion: 16,
  nav: [],
  settings: [
    { id: 'host-runtime', label: 'Host runtime', icon: 'Server', placement: 'pluginDetail' },
  ],
};

function Harness({ plugins = [] }: { plugins?: PluginUiListing[] }) {
  const [query, setQuery] = useState('');
  return (
    <SettingsNavigation
      t={en}
      sections={settingsSections(en, 'Elowen AI')}
      pluginEntries={plugins}
      active="system"
      query={query}
      layout="sidebar"
      onQueryChange={setQuery}
      onNavigate={vi.fn()}
      onOpenPlugin={vi.fn()}
    />
  );
}

describe('SettingsNavigation', () => {
  it('filters categories by the shared static row index and links matching rows', () => {
    const onNavigate = vi.fn();
    function SearchHarness() {
      const [query, setQuery] = useState('');
      return (
        <SettingsNavigation
          t={en}
          sections={settingsSections(en, 'Elowen AI')}
          pluginEntries={[]}
          active="system"
          query={query}
          layout="sidebar"
          onQueryChange={setQuery}
          onNavigate={onNavigate}
          onOpenPlugin={vi.fn()}
        />
      );
    }
    render(<SearchHarness />, { wrapper: W });

    expect(screen.getByRole('button', { name: /^System/ })).toHaveAttribute('aria-current', 'page');
    fireEvent.change(screen.getByRole('searchbox', { name: en.settings.navigationSearch }), { target: { value: 'retention' } });
    expect(screen.getByRole('button', { name: /^System/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Models/ })).toBeNull();

    const row = screen.getByRole('button', { name: en.settings.retention.label });
    fireEvent.click(row);
    expect(onNavigate).toHaveBeenCalledWith(
      `/settings?cat=system&row=settings.retention.label`,
      'system',
    );
  });

  it('keeps plugin sub-sections inside one plugin result', () => {
    const onOpenPlugin = vi.fn();
    function PluginHarness() {
      const [query, setQuery] = useState('');
      return (
        <SettingsNavigation
          t={en}
          sections={settingsSections(en, 'Elowen AI')}
          pluginEntries={[sandbox]}
          active="system"
          query={query}
          layout="sidebar"
          onQueryChange={setQuery}
          onNavigate={vi.fn()}
          onOpenPlugin={onOpenPlugin}
        />
      );
    }
    render(<PluginHarness />, { wrapper: W });

    expect(screen.getByRole('button', { name: 'Sandbox' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Host runtime' })).toBeNull();

    fireEvent.change(screen.getByRole('searchbox', { name: en.settings.navigationSearch }), { target: { value: 'Host runtime' } });
    expect(screen.getByRole('button', { name: 'Sandbox' })).toBeInTheDocument();
    expect(screen.getByText('Host runtime')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Host runtime' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Sandbox' }));
    expect(onOpenPlugin).toHaveBeenCalledWith('/settings?cat=plugins&plugin=sandbox#plugin-section:host-runtime');
  });

  it('does not index arbitrary loaded values', () => {
    render(<Harness plugins={[sandbox]} />, { wrapper: W });
    fireEvent.change(screen.getByRole('searchbox', { name: en.settings.navigationSearch }), { target: { value: 'sk-secret-value' } });
    expect(screen.getByText(en.settings.navigationNoMatches)).toBeInTheDocument();
  });

  it('renders one control per section without navigation hints', () => {
    render(<Harness />, { wrapper: W });

    const controls = within(screen.getByTestId('settings-navigation-sidebar')).getAllByRole('button');
    expect(controls).toHaveLength(settingsSections(en, 'Elowen AI').length);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  /** THE RECORD'S DENSITY, pinned because it is the whole point of this column. A record is a 2rem row —
   *  the height this app's primary sidebar row already uses — and rises to the touch floor for a COARSE
   *  POINTER rather than below a viewport width. A `md:` breakpoint would have handed a tablet reached by
   *  finger exactly the compact mouse rhythm, since it is wide enough for the column and still touched.
   *  The two decorations that cost the old column a third of its height are gone with it: the boxed badge
   *  that led every record, and the trailing chevron, which pointed at nothing a vertical navigation does
   *  not already say. */
  it('keeps a record to one compact line and raises it to the touch floor for a coarse pointer', () => {
    render(<Harness />, { wrapper: W });

    const row = screen.getByRole('button', { name: /^System/ }).parentElement!;
    expect(row).toHaveClass('h-8', 'pointer-coarse:min-h-[var(--touch-target)]');
    expect(row.className).not.toMatch(/\bmd:h-/);
    expect(row.querySelectorAll('svg')).toHaveLength(1);
    // The leading mark is a plain glyph rather than a bordered 2rem badge.
    const glyph = row.querySelector('span[aria-hidden]')!;
    expect(glyph).toHaveClass('h-4', 'w-4');
    expect(glyph.className).not.toMatch(/\bborder\b|\bbg-muted\b/);
  });

  /** Two lists, separated by a caption and spacing rather than by a rule: the core sections, and the
   *  plugin decks that are pages of their own worlds. The horizontal rule that used to divide them made
   *  the second list read as a footnote under the first. */
  it('captions the core sections and the plugin decks as two named groups', () => {
    render(<Harness plugins={[sandbox]} />, { wrapper: W });

    // The two captions, in order. `Plugins` is also a core section NAME, so the assertion reads the
    // captions themselves rather than the first element that happens to carry the word.
    const captions = Array.from(document.querySelectorAll('nav p')).map((p) => p.textContent);
    expect(captions).toEqual([en.page.settings, en.settings.plugins]);
    expect(document.querySelector('.border-t')).toBeNull();
  });

});

/** THE PHONE'S ONE LINE. It replaced a master/detail pane switch, so these pin what the strip has to keep
 *  doing that the pane switch used to: reach every section, say which one is open, and be operable by a
 *  keyboard and a thumb alike. */
describe('SettingsNavigation, section strip', () => {
  function StripHarness({ plugins = [], active = 'system', onNavigate = vi.fn(), onOpenPlugin = vi.fn() }: {
    plugins?: PluginUiListing[];
    active?: string;
    onNavigate?: (href: string, category: SettingsCategory) => void;
    onOpenPlugin?: (href: string) => void;
  }) {
    return (
      <SettingsNavigation
        t={en}
        sections={settingsSections(en, 'Elowen AI')}
        pluginEntries={plugins}
        active={active}
        query=""
        layout="tabs"
        onQueryChange={vi.fn()}
        onNavigate={onNavigate}
        onOpenPlugin={onOpenPlugin}
      />
    );
  }

  it('puts every core section and every plugin deck on one scrollable line', () => {
    render(<StripHarness plugins={[sandbox]} />, { wrapper: W });

    const strip = screen.getByTestId('settings-navigation-tabs');
    expect(strip).toHaveClass('section-deck-strip', 'overflow-x-auto', 'whitespace-nowrap');
    // The named region survives the shape change, so the overlay still announces one navigation.
    expect(strip).toHaveAccessibleName(en.settings.navigationLabel);

    const labels = [...settingsSections(en, 'Elowen AI').map((section) => section.label), 'Sandbox'];
    expect(within(strip).getAllByRole('button').map((tab) => tab.textContent)).toEqual(labels);
  });

  it('marks the open section and navigates from the strip', () => {
    const onNavigate = vi.fn();
    render(<StripHarness active="models" onNavigate={onNavigate} />, { wrapper: W });

    const strip = screen.getByTestId('settings-navigation-tabs');
    const current = within(strip).getAllByRole('button').filter((tab) => tab.getAttribute('aria-current') === 'page');
    expect(current.map((tab) => tab.textContent)).toEqual(['Models']);

    fireEvent.click(within(strip).getByRole('button', { name: 'System' }));
    expect(onNavigate).toHaveBeenCalledWith('/settings?cat=system', 'system');
  });

  it('opens a plugin deck through its own handler rather than as a category', () => {
    const onOpenPlugin = vi.fn();
    const onNavigate = vi.fn();
    render(<StripHarness plugins={[sandbox]} onNavigate={onNavigate} onOpenPlugin={onOpenPlugin} />, { wrapper: W });

    fireEvent.click(within(screen.getByTestId('settings-navigation-tabs')).getByRole('button', { name: 'Sandbox' }));
    expect(onOpenPlugin).toHaveBeenCalledWith('/settings?cat=plugins&plugin=sandbox#plugin-section:host-runtime');
    expect(onNavigate).not.toHaveBeenCalled();
  });

  /** A tab is a real button, so the keyboard reaches it by tabbing and activates it with Enter or Space —
   *  nothing here re-implements that. What IS stated: the tab carries the touch class the stylesheet
   *  raises to `--touch-target`, and the line never becomes a text selection under a dragging thumb. */
  it('keeps each tab a keyboard control and a thumb target', () => {
    render(<StripHarness />, { wrapper: W });

    for (const tab of within(screen.getByTestId('settings-navigation-tabs')).getAllByRole('button')) {
      expect(tab).toHaveAttribute('type', 'button');
      expect(tab).toHaveClass('section-deck-strip__tab', 'select-none');
      expect(tab).toHaveClass('focus-visible:ring-2');
    }
  });

  /** The strip is the way BETWEEN sections; the filter box belongs to the column that has room to show
   *  what it filtered. A search field on a line this narrow would leave the sections nowhere to go. */
  it('carries no search field', () => {
    render(<StripHarness />, { wrapper: W });
    expect(screen.queryByRole('searchbox')).toBeNull();
  });
});
