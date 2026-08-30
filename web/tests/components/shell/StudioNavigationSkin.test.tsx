import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
const currentPath = vi.hoisted(() => ({ value: '/dash' }));
vi.mock('next/navigation', () => ({ usePathname: () => currentPath.value, useRouter: () => ({ push: vi.fn() }) }));
import { StudioNavigation } from '../../../components/shell/StudioNavigation';
import { SkinProvider } from '../../../lib/skinContext';
import { DEFAULT_SKIN } from '../../../lib/skins';
import { createWrapper } from '../../test-utils';

const server = setupServer(
  http.get('*/api/health', () => HttpResponse.json({ ok: true, version: '0.26.0' })),
  http.get('*/api/config', () => HttpResponse.json({ allowedSkins: ['studio-light', 'studio-oled'] })),
);
beforeAll(() => server.listen({ onUnhandledRequest }));
afterAll(() => server.close());
beforeEach(() => { localStorage.clear(); currentPath.value = '/dash'; });
afterEach(() => {
  server.resetHandlers();
  document.documentElement.removeAttribute('data-skin');
  document.cookie = 'elowen-skin=; path=/; max-age=0';
});

/** The navigation as a phone actually mounts it: `drawer`, opened. */
function mount(props: Parameters<typeof StudioNavigation>[0] = {}, allowedSkins = ['studio-light', 'studio-oled']) {
  const { wrapper: Wrapper, client } = createWrapper();
  client.setQueryData(['me'], { user: { id: 1, username: 'admin', is_admin: true } });
  client.setQueryData(['health'], { ok: true, version: '0.26.0' });
  client.setQueryData(['my-nav-settings'], { hidden: [], order: [] });
  client.setQueryData(['plugin-ui', 'en'], []);
  return render(
    <Wrapper>
      <SkinProvider allowedSkins={allowedSkins} initialChoice="studio-light" fallback={null}>
        <StudioNavigation {...props} />
      </SkinProvider>
    </Wrapper>,
  );
}

/** The interface's light/dark choice is a SKIN in this app (`studio-light` / `studio-oled`), not a CSS
 *  theme — `lib/useTheme.tsx` is a compatibility facade pinned to dark. So the control a phone needs is
 *  the same `SkinSwitcher` the desktop TopBar mounts, and the defect was that the drawer, which is the
 *  whole of the navigation on a phone, never offered one. */
describe('mobile navigation drawer — appearance control', () => {
  it('exposes an accessible light/dark switch in the drawer', () => {
    mount({ drawer: true, drawerOpen: true });
    // Named, not a bare glyph: the control has to be reachable and announceable on a touch screen.
    const control = screen.getByRole('button', { name: /skin|vzhled/i });
    expect(control).toBeInTheDocument();
    expect(control).toHaveAccessibleName();
  });

  it('actually switches the document skin from the drawer', () => {
    mount({ drawer: true, drawerOpen: true });
    expect(document.documentElement.getAttribute('data-skin')).toBe(DEFAULT_SKIN);
    fireEvent.click(screen.getByRole('button', { name: /skin|vzhled/i }));
    // Every skin's CSS is already in the page, scoped under its own [data-skin]; the attribute IS the
    // mechanism, so asserting on it asserts on the feature.
    expect(document.documentElement.getAttribute('data-skin')).toBe('studio-oled');
  });

  it('keeps the desktop column free of a second copy, which the TopBar already carries', () => {
    mount({ drawer: false });
    expect(screen.queryByRole('button', { name: /skin|vzhled/i })).toBeNull();
  });

  it('offers no dead control when the instance allows a single skin', () => {
    mount({ drawer: true, drawerOpen: true }, ['studio-oled']);
    expect(screen.queryByRole('button', { name: /skin|vzhled/i })).toBeNull();
  });
});
