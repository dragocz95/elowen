import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { createWrapper } from '../test-utils';
import PluginHostPage from '../../app/p/[plugin]/[[...rest]]/page';
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

const mount = () => {
  const { wrapper: Wrapper, client } = createWrapper();
  client.setQueryData(['plugin-ui', 'en'], [
    { name: 'skills', url: '/plugins/skills/web/index.js', apiVersion: 1, nav: [], settings: [{ id: 'skills', label: 'Skills' }] },
  ]);
  return render(<Wrapper><PluginHostPage /></Wrapper>);
};

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

  it('leaves a plugin page unwrapped — it brings its own layout', async () => {
    const { container } = mount();
    await waitFor(() => expect(screen.getByTestId('page')).toBeInTheDocument());
    expect(container.querySelector('.workspace-page')).toBeNull();
  });

  // The deck page around a section supplies the page column and names the page; standalone, the route
  // owes the section the column and the masthead/tab title, and tells it that it is on a page so it can
  // head itself. Without that it renders as a fragment on an empty screen.
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
    expect(global.document.title).toContain('Skills');
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
