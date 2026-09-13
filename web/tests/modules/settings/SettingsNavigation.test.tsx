import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { SettingsNavigation } from '../../../modules/settings/SettingsNavigation';
import { settingsSections } from '../../../modules/settings/categories';
import { interpolate, LanguageProvider } from '../../../lib/i18n';
import { en } from '../../../lib/i18n/dictionaries/en';
import type { PluginUiListing } from '../../../lib/types';

/** The records carry the shared HelpTip, which reads the dictionary through `useTranslation`. */
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

  /** An 18rem column truncated every section sentence mid-word and cost the list twice its height for
   *  text nobody could finish reading. The sentence moves behind the shared help affordance — the same
   *  question mark a settings record carries — and the record goes back to one line. */
  it('keeps each section sentence behind the shared help affordance instead of a truncated subtitle', async () => {
    const onNavigate = vi.fn();
    function HelpHarness() {
      const [query, setQuery] = useState('');
      return (
        <SettingsNavigation
          t={en}
          sections={settingsSections(en, 'Elowen AI')}
          pluginEntries={[]}
          active="system"
          query={query}
          onQueryChange={setQuery}
          onNavigate={onNavigate}
          onOpenPlugin={vi.fn()}
        />
      );
    }
    render(<HelpHarness />, { wrapper: W });

    for (const section of settingsSections(en, 'Elowen AI')) {
      expect(screen.queryByText(section.description)).toBeNull();
    }

    const system = settingsSections(en, 'Elowen AI').find((section) => section.id === 'system')!;
    const row = screen.getByRole('button', { name: /^System/ }).parentElement!;
    const help = within(row).getByRole('button', { name: interpolate(en.common.helpFor, { label: system.label }) });
    fireEvent.click(help);

    expect(await screen.findByRole('tooltip')).toHaveTextContent(en.settings.systemSectionHint);
    // Revealing the help is not navigating: the record's own control is a separate button, and the help
    // stops the click it handles.
    expect(onNavigate).not.toHaveBeenCalled();
  });

  /** The record's control is a button stretched over the row rather than one wrapping it, because a
   *  HelpTip is itself a button and nesting the two would leave the help unreachable from the keyboard. */
  it('activates the record from a single stretched control that the help sits above', () => {
    const onNavigate = vi.fn();
    function NavHarness() {
      const [query, setQuery] = useState('');
      return (
        <SettingsNavigation
          t={en}
          sections={settingsSections(en, 'Elowen AI')}
          pluginEntries={[]}
          active="system"
          query={query}
          onQueryChange={setQuery}
          onNavigate={onNavigate}
          onOpenPlugin={vi.fn()}
        />
      );
    }
    render(<NavHarness />, { wrapper: W });

    const control = screen.getByRole('button', { name: /^Models/ });
    expect(control).toHaveClass('absolute', 'inset-0');
    expect(within(control).queryByRole('button')).toBeNull();

    fireEvent.click(control);
    expect(onNavigate).toHaveBeenCalledWith('/settings?cat=models', 'models');
  });

  /** The mark floats OVER a control stretched across the whole record, so 16px of glyph was the entire
   *  target a pointer had to hit and everything around it navigated. It carries its own 24x24 hit area
   *  now — and a name of its own, or the column reads as a dozen buttons called "Help" in a screen
   *  reader's element list and to voice control. */
  it('names every help mark after its record and gives each one a target of its own', () => {
    const onNavigate = vi.fn();
    function HelpTargetHarness() {
      const [query, setQuery] = useState('');
      return (
        <SettingsNavigation
          t={en}
          sections={settingsSections(en, 'Elowen AI')}
          pluginEntries={[]}
          active="system"
          query={query}
          onQueryChange={setQuery}
          onNavigate={onNavigate}
          onOpenPlugin={vi.fn()}
        />
      );
    }
    render(<HelpTargetHarness />, { wrapper: W });

    const sections = settingsSections(en, 'Elowen AI');
    const names = sections.map((section) => interpolate(en.common.helpFor, { label: section.label }));
    expect(new Set(names).size, 'two sections would share one accessible name').toBe(sections.length);
    // `getByRole` is exact and rejects a duplicate, so this also proves no two marks answer to one name.
    expect(screen.queryByRole('button', { name: en.common.help })).toBeNull();

    for (const name of names) {
      const help = screen.getByRole('button', { name });
      // jsdom computes no Tailwind geometry; the inset pseudo-element IS the enlarged target (HelpTip).
      expect(help).toHaveClass('before:-inset-1', "before:content-['']");
      fireEvent.click(help);
    }
    // Every one of them revealed its hint, and not one of them navigated.
    expect(onNavigate).not.toHaveBeenCalled();
  });
});
