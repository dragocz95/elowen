import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';

const currentPath = vi.hoisted(() => ({ value: '/dash' }));
vi.mock('next/navigation', () => ({ usePathname: () => currentPath.value, useRouter: () => ({ push: vi.fn() }) }));

import { DocumentTitle } from '../../../components/shell/DocumentTitle';
import { ModuleHeader } from '../../../components/ui/ModuleHeader';
import { PageHeaderProvider } from '../../../lib/pageHeader';
import { BrandProvider, BUILTIN_THEME, type ThemePayload } from '../../../lib/brand';
import { createWrapper } from '../../test-utils';

const server = setupServer(http.get('*/api/health', () => HttpResponse.json({ ok: true })));
beforeAll(() => server.listen({ onUnhandledRequest }));
afterAll(() => server.close());

beforeEach(() => {
  currentPath.value = '/dash';
  localStorage.clear();
  document.head.querySelectorAll('title').forEach((node) => node.remove());
});
afterEach(() => { document.head.querySelectorAll('title').forEach((node) => node.remove()); });

const PLUGIN_LISTING = [
  {
    name: 'work',
    label: 'Práce',
    nav: [{ label: 'Úkoly', icon: 'ListChecks', route: 'tasks' }, { label: 'Kanban', icon: 'KanbanSquare', route: 'kanban' }],
    settings: [],
  },
];

function mount({ locale = 'en', theme, children }: { locale?: string; theme?: ThemePayload; children?: React.ReactNode } = {}) {
  if (locale !== 'en') localStorage.setItem('elowen-locale', locale);
  const { wrapper: Wrapper, client } = createWrapper();
  client.setQueryData(['me'], { user: { id: 1, username: 'admin', is_admin: true } });
  client.setQueryData(['my-nav-settings'], { hidden: [], order: [] });
  // The listing is fetched per locale; the daemon has already translated the plugin's own labels, so the
  // same content is seeded under whichever locale is active.
  client.setQueryData(['plugin-ui', locale], PLUGIN_LISTING);
  const tree = () => (
    <Wrapper>
      <BrandProvider theme={theme ?? BUILTIN_THEME}>
        <PageHeaderProvider>
          <DocumentTitle />
          {children}
        </PageHeaderProvider>
      </BrandProvider>
    </Wrapper>
  );
  const view = render(tree());
  // Re-rendering the same tree is what a client-side navigation looks like from here: nothing about the
  // app changes except the pathname the mocked router reports.
  return { ...view, renavigate: () => view.rerender(tree()) };
}

describe('DocumentTitle — one mechanism names every tab', () => {
  it('keeps one non-empty title after the initial render and a later React commit', async () => {
    const { renavigate } = mount({ locale: 'cs' });
    expect(document.title).toBe('Elowen — Domů');

    await act(async () => {
      await Promise.resolve();
      renavigate();
      await Promise.resolve();
    });

    expect(document.title).toBe('Elowen — Domů');
    expect([...document.head.querySelectorAll('title')].map((node) => node.textContent)).toEqual(['Elowen — Domů']);
  });

  it('titles a core page with the navigation label, in the active locale', () => {
    mount({ locale: 'cs' });
    expect(document.title).toBe('Elowen — Domů');
  });

  it('titles the same page in English when that is the active locale', () => {
    mount();
    expect(document.title).toBe('Elowen — Home');
  });

  // The whole app navigates client-side: the pathname changes with no document load, so a title written
  // once on first render would be stale from the second page onwards. This is the failure the product
  // owner reported, and it is silent — nothing in the UI shows it.
  it('follows a client-side navigation', () => {
    const { renavigate } = mount({ locale: 'cs' });
    expect(document.title).toBe('Elowen — Domů');

    currentPath.value = '/memory';
    renavigate();
    expect(document.title).toBe('Elowen — Paměť');
  });

  it("titles a plugin page from the plugin's own declared label", () => {
    currentPath.value = '/p/work/kanban';
    mount();
    expect(document.title).toBe('Elowen — Kanban');
  });

  it('titles a plugin world by its own label on the base route', () => {
    currentPath.value = '/p/work';
    mount();
    expect(document.title).toBe('Elowen — Práce');
  });

  it('leaves the chromeless terminal title to the pop-out route', () => {
    currentPath.value = '/terminal/elowen-advisor-1';
    document.title = 'Elowen — advisor-1';
    mount();
    expect(document.title).toBe('Elowen — advisor-1');
  });

  it('carries the white-label product name, never a hardcoded "Elowen"', () => {
    const theme: ThemePayload = {
      ...BUILTIN_THEME,
      brand: { ...BUILTIN_THEME.brand, productName: 'Sarah Hair' },
      text: { en: { appName: 'Sarah Hair' } },
    };
    mount({ theme });
    expect(document.title).toBe('Sarah Hair — Home');
  });

  it('falls back to the title the page published when the navigation names the address nowhere', () => {
    currentPath.value = '/p/ghost';
    mount({ children: <ModuleHeader title="Ghost" /> });
    expect(document.title).toBe('Elowen — Ghost');
  });

  it('falls back to the bare product name rather than a blank tab', () => {
    currentPath.value = '/p/ghost';
    mount();
    expect(document.title).toBe('Elowen');
  });
});
