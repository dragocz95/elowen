import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { createWrapper } from '../test-utils';
import PluginHostPage from '../../app/p/[plugin]/[[...rest]]/page';
import { en } from '../../lib/i18n/dictionaries/en';
import { PageHeaderProvider, usePageHeader } from '../../lib/pageHeader';
import type { PluginUiRegistration } from '../../lib/pluginUi';

const route = vi.hoisted(() => ({ plugin: 'skills', rest: [] as string[] }));
vi.mock('next/navigation', () => ({
  useParams: () => route,
  useRouter: () => ({ push: vi.fn() }),
}));

// The bundle load is a network fetch of the plugin's own JS; the registration it produces is what this
// route branches on, so it is supplied directly.
const registration = vi.hoisted(() => ({
  value: {
    pages: { '': () => <div data-testid="page">page</div> },
    settings: { skills: () => <div data-testid="section">section</div> },
  } as unknown as PluginUiRegistration,
}));
vi.mock('../../lib/pluginUi', async (orig) => ({
  ...(await orig<typeof import('../../lib/pluginUi')>()),
  loadPluginUi: () => Promise.resolve(registration.value),
}));

const mount = (opts: { listing?: unknown[]; admin?: boolean } = {}) => {
  const { wrapper: Wrapper, client } = createWrapper();
  client.setQueryData(['plugin-ui', 'en'], opts.listing ?? [
    { name: 'skills', url: '/plugins/skills/web/index.js', apiVersion: 1, nav: [], settings: [{ id: 'skills', label: 'Skills' }] },
  ]);
  client.setQueryData(['me'], { user: { id: 7, username: 'amy', is_admin: opts.admin ?? true } });
  return render(<Wrapper><PageHeaderProvider><PluginHostPage /><MastheadProbe /></PageHeaderProvider></Wrapper>);
};

/** Stands in for the shell's masthead: the page name the route publishes is what both the heading and
 *  the browser tab (components/shell/DocumentTitle) read. */
function MastheadProbe() {
  return <div data-testid="masthead">{usePageHeader()?.header.title ?? ''}</div>;
}

const fullRegistration = registration.value;
beforeEach(() => { route.rest = []; registration.value = fullRegistration; });

describe('plugin host route', () => {
  // The route hands a settings section the page column and the page's identity, and nothing else: the
  // header and the document surface come from the section itself (components.PluginPageFrame), because
  // the header has to sit ABOVE that surface and only the section knows its own subtitle and actions.
  it('wraps a settings section in the page column without dictating its inner surface', async () => {
    route.rest = ['settings', 'skills'];
    const { container } = mount();
    await waitFor(() => expect(screen.getByTestId('section')).toBeInTheDocument());
    const page = container.querySelector('.workspace-page');
    expect(page).not.toBeNull();
    expect(page!.contains(screen.getByTestId('section'))).toBe(true);
    expect(container.querySelector('[data-settings-document]')).toBeNull(); // the mock section renders none
  });

  // Landing on the address of a plugin that is not in YOUR listing means two different things. An admin
  // is looking at something switched off and can go switch it on; anybody else is looking at something
  // that is probably running fine and simply not theirs — and the settings page is admin-only, so
  // offering them that button would send them somewhere they may not go.
  it('tells a missing plugin apart from one this account was never granted', async () => {
    mount({ listing: [], admin: false });
    expect(await screen.findByText(en.pluginUi.notGranted)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.pluginUi.manage })).toBeNull();
  });

  it('offers an admin the switch, because for them it really is off', async () => {
    mount({ listing: [], admin: true });
    expect(await screen.findByText(en.pluginUi.unavailable)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.pluginUi.manage })).toBeInTheDocument();
  });

  it('leaves a plugin page unwrapped — it brings its own layout', async () => {
    const { container } = mount();
    await waitFor(() => expect(screen.getByTestId('page')).toBeInTheDocument());
    expect(container.querySelector('.workspace-page')).toBeNull();
  });

  // The deck page around a section supplies the page column and names the page; standalone, the route
  // owes the section the column and the masthead title, and tells it that it is on a page so it can
  // head itself. Without that it renders as a fragment on an empty screen. The browser tab reads the
  // same published name — see tests/components/shell/DocumentTitle.test.tsx.
  it('gives a standalone settings section the page column, the page name and its surface', async () => {
    route.rest = ['settings', 'skills'];
    const seen: string[] = [];
    registration.value = {
      pages: {},
      settings: { skills: ({ surface }: { surface: string }) => { seen.push(surface); return <div data-testid="section">section</div>; } },
    } as unknown as PluginUiRegistration;
    const { container } = mount();
    await waitFor(() => expect(screen.getByTestId('section')).toBeInTheDocument());
    const page = container.querySelector('.workspace-page');
    expect(page).not.toBeNull();
    expect(page!.contains(screen.getByTestId('section'))).toBe(true);
    expect(seen).toContain('page');
    await waitFor(() => expect(screen.getByTestId('masthead')).toHaveTextContent('Skills'));
  });

  // Settings is core-only, so a page IS where a section lives now — and a section autosaves. The
  // indicator (with the Retry a failed save needs) used to come from the Settings deck header; on a page
  // the route owes it, or a failed save is invisible and unretryable. An orbital section has no header
  // of its own to fall back on, which is what makes this the only channel.
  it('renders a section\'s reported save state, retry included', async () => {
    route.rest = ['settings', 'skills'];
    const retry = vi.fn();
    const FailingSection = ({ onSaveState }: { onSaveState?: (s: 'error', r?: () => void) => void }) => {
      useEffect(() => { onSaveState?.('error', retry); }, [onSaveState]);
      return <div data-testid="section">section</div>;
    };
    registration.value = { pages: {}, settings: { skills: FailingSection } } as unknown as PluginUiRegistration;
    mount();
    await waitFor(() => expect(screen.getByTestId('section')).toBeInTheDocument());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(en.common.saveFailed);
    fireEvent.click(screen.getByRole('button', { name: en.common.retry }));
    expect(retry).toHaveBeenCalled();
  });

  it('tells a declared section with no registered component apart from an unknown page', async () => {
    // The menu offered "Skills" by name, so the miss is a section that failed to register — not a page
    // the reader guessed wrong. Answering "page missing" would explain the wrong thing.
    route.rest = ['settings', 'skills'];
    registration.value = { pages: {}, settings: {} } as unknown as PluginUiRegistration;
    mount();
    expect(await screen.findByText(en.pluginUi.settingsUnavailable)).toBeInTheDocument();
    expect(screen.queryByText(en.pluginUi.pageMissing)).toBeNull();
  });

  // `/p/skills/settings/skills` repeats the plugin's name back at the reader, so the bare route resolves
  // to the section when that section is the plugin's whole UI.
  it('serves the only settings section at the bare plugin route', async () => {
    registration.value = { pages: {}, settings: { skills: () => <div data-testid="section">section</div> } } as unknown as PluginUiRegistration;
    const { container } = mount();
    await waitFor(() => expect(screen.getByTestId('section')).toBeInTheDocument());
    expect(container.querySelector('.workspace-page')).not.toBeNull();
  });
});
