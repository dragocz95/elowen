import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useEffect, type ComponentType, type ReactNode } from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { createWrapper } from '../test-utils';
import PluginHostPage from '../../app/p/[plugin]/[[...rest]]/page';
import { en } from '../../lib/i18n/dictionaries/en';
import { PageHeaderProvider, usePageHeader } from '../../lib/pageHeader';
import { ensurePluginUiRuntime, type PluginUiRegistration } from '../../lib/pluginUi';

const SHELL_CSS = readFileSync(
  join(import.meta.dirname, '..', '..', 'app', 'styles', 'components', 'workspace-shell.css'),
  'utf8',
);

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

  /** The route wraps a section in its entrance animation, which puts ONE element between the page column
   *  and the hero the section heads itself with. The shell's top breathing room is a child combinator off
   *  `.workspace-page`, so that wrapper silently swallowed it: every plugin settings page opened flush
   *  against the top bar while every core page kept its 2rem. Asserted against the DOM the real route
   *  builds around the real `PluginPageFrame` — a mock `<div>` section has no hero to miss. */
  it('keeps a settings section hero on the page spacing through the route entrance', async () => {
    route.rest = ['settings', 'skills'];
    ensurePluginUiRuntime();
    const PluginPageFrame = window.ElowenUiRuntime!.components.PluginPageFrame as unknown as
      ComponentType<{ surface: 'page' | 'deck'; title: string; children: ReactNode }>;
    registration.value = {
      pages: {},
      settings: {
        skills: () => (
          <PluginPageFrame surface="page" title="Skills"><div data-testid="section">section</div></PluginPageFrame>
        ),
      },
    } as unknown as PluginUiRegistration;
    const { container } = mount();
    await waitFor(() => expect(screen.getByTestId('section')).toBeInTheDocument());

    const hero = container.querySelector('.workspace-hero');
    expect(hero).not.toBeNull();
    expect(hero!.matches('.workspace-page > .workspace-page__lead > .workspace-hero')).toBe(true);
    // …and that exact chain is what the stylesheet pads, at both the wide and the narrow value. Without
    // this half the DOM could keep its shape while the rule that needs it drifts away.
    expect(SHELL_CSS).toContain('.workspace-page > .workspace-page__lead > .workspace-hero { padding-block-start: 2rem; }');
    const narrow = SHELL_CSS.slice(SHELL_CSS.indexOf('@container workspace-shell (width < 34rem)'));
    expect(narrow).toContain('.workspace-page > .workspace-page__lead > .workspace-hero { padding-block-start: 1rem; }');
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

  // A section that draws its own page shell has the page column already. Wrapping it again nested two
  // frames, so the gutter and the bottom padding were spent twice and the page came out narrower than
  // every sibling register — with a zero-height masthead row of margin above it.
  it('adds no second page frame around a section that frames itself', async () => {
    route.rest = ['settings', 'skills'];
    registration.value = {
      pages: {},
      settings: { skills: () => <div className="workspace-shell" data-testid="section">section</div> },
      ownsPageFrame: ['skills'],
    } as unknown as PluginUiRegistration;
    const { container } = mount();
    await waitFor(() => expect(screen.getByTestId('section')).toBeInTheDocument());

    expect(container.querySelectorAll('.workspace-page, .workspace-shell')).toHaveLength(1);
    expect(container.querySelector('.workspace-shell')).toBe(screen.getByTestId('section'));
    expect(container.querySelector('.module-header')).toBeNull();
    // The page is still the host's to name, for the masthead and the browser tab alike.
    await waitFor(() => expect(screen.getByTestId('masthead')).toHaveTextContent('Skills'));
  });

  // Frame ownership is per section id: a bundle that frames one of its sections does not thereby give up
  // the host frame for the others, and a bundle that declares nothing keeps today's behaviour exactly.
  it('keeps the host frame for a section the bundle did not claim', async () => {
    route.rest = ['settings', 'skills'];
    registration.value = {
      pages: {},
      settings: { skills: () => <div data-testid="section">section</div> },
      ownsPageFrame: ['something-else'],
    } as unknown as PluginUiRegistration;
    const { container } = mount();
    await waitFor(() => expect(screen.getByTestId('section')).toBeInTheDocument());
    expect(container.querySelector('.workspace-page')).not.toBeNull();
  });

  // The host draws no header for a frame-owning section, so it displays no save state either — but the
  // channel has to stay open, or such a section could never report one at all.
  it('still hands a frame-owning section the save-state channel', async () => {
    route.rest = ['settings', 'skills'];
    const seen: unknown[] = [];
    const Section = ({ onSaveState }: { onSaveState?: (s: 'error') => void }) => {
      seen.push(onSaveState);
      return <div className="workspace-shell" data-testid="section">section</div>;
    };
    registration.value = { pages: {}, settings: { skills: Section }, ownsPageFrame: ['skills'] } as unknown as PluginUiRegistration;
    mount();
    await waitFor(() => expect(screen.getByTestId('section')).toBeInTheDocument());
    expect(seen.every((fn) => typeof fn === 'function')).toBe(true);
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
