import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../msw';
let pathname = '/dash';
vi.mock('next/navigation', () => ({ usePathname: () => pathname, useRouter: () => ({ push: () => {}, replace: () => {} }), useSearchParams: () => new URLSearchParams() }));
import { Shell, resolveNav } from '../../components/shell/Shell';
import { MOBILE_MAX_WIDTH } from '../../lib/useMobile';

class FakeES { onmessage = null; addEventListener() {} close() {} constructor(public url: string) {} }
(globalThis as unknown as { EventSource: typeof FakeES }).EventSource = FakeES;
const server = setupServer(
  http.get('*/api/health', () => HttpResponse.json({ ok: true })),
  // A valid session: LoginGate's me() probe resolves → the shell chrome renders.
  // The rail stays inert until it knows the arrangement, so an unanswered read leaves it empty.
  http.get('*/api/auth/me/nav-settings', () => HttpResponse.json({ hidden: [], order: [] })),
  http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, username: 'admin' } })),
  // /chat mounts the chat provider, which reaches for these on open.
  http.get('*/api/brain/sessions', () => HttpResponse.json([])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
);
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

// Width sets a floor on how compact the chrome may be; the user's pin may only go compacter than the
// floor, never roomier. The handle is therefore offered exactly when the pin is what decides — anywhere
// else it would be a control that cannot change anything.
describe('resolveNav', () => {
  it('hands a roomy window to the user: their pin decides, and they get the handle to set it', () => {
    expect(resolveNav(1600, 'full')).toEqual({ mode: 'full', pinnable: true });
    expect(resolveNav(1600, 'rail')).toEqual({ mode: 'rail', pinnable: true });
  });

  it('forces the icon rail when the window is too narrow for the full one, offering no dead handle', () => {
    expect(resolveNav(1000, 'full')).toEqual({ mode: 'rail', pinnable: false });
    expect(resolveNav(1000, 'rail')).toEqual({ mode: 'rail', pinnable: false });
  });

  it('falls back to the hamburger drawer on a phone-narrow region', () => {
    expect(resolveNav(600, 'rail')).toEqual({ mode: 'drawer', pinnable: false });
  });

  it('shows no handle before the region has been measured, so none flashes on first paint', () => {
    expect(resolveNav(0, 'rail')).toEqual({ mode: 'full', pinnable: false });
  });

  it('gives the command profile an expanded first paint and 1024px drawer boundary', () => {
    expect(resolveNav(0, 'rail', 'command')).toEqual({ mode: 'full', pinnable: false });
    expect(resolveNav(1023, 'rail', 'command')).toEqual({ mode: 'drawer', pinnable: false });
    expect(resolveNav(1024, 'full', 'command')).toEqual({ mode: 'full', pinnable: true });
    expect(resolveNav(1024, 'rail', 'command')).toEqual({ mode: 'rail', pinnable: true });
    expect(resolveNav(1600, 'rail', 'command')).toEqual({ mode: 'rail', pinnable: true });
    expect(resolveNav(1600, 'full', 'command')).toEqual({ mode: 'full', pinnable: true });
  });
});

// An unseeded Shell is what a document with nothing chosen gets, and that is DEFAULT_SKIN — a command
// profile. It is no longer a way to reach the frameless masthead and orbital rail: those belong to the
// ambient design this build stopped shipping, so what these cases describe is the only chrome there is.
describe('Shell', () => {
  it('renders the Studio navigation, ruled app bar and content slot', async () => {
    render(<Shell><span>page-body</span></Shell>);
    // The navigation and Home world appear after the async gate opens.
    expect(await screen.findByTestId('studio-navigation')).toBeInTheDocument();
    expect(screen.queryByTestId('future-navigation'), 'the orbital rail belongs to no design this build ships').toBeNull();
    expect(screen.getByRole('link', { name: 'Home' })).toBeInTheDocument();
    expect(screen.getByText('page-body')).toBeInTheDocument();
    // The ruled bar, not the floating cluster: sticky and separated from the content it scrolls over.
    expect(screen.getByTestId('future-page-header')).toHaveClass('sticky');
    expect(screen.getByTestId('future-page-header')).toHaveClass('border-b');
  });

  it('keeps the ruled bar at every width, on /chat as much as off it', async () => {
    // The phone suppression was the FRAMELESS masthead's: that cluster has no slot for a page's own
    // controls, so on /chat it only crowded the conversation's local bar. The ruled bar does have one —
    // the conversation portals its toolbar into it — so suppressing it on a phone would take those
    // controls away with it, along with the hamburger that is the way off /chat.
    //
    // Asserted on the HEADER and not on a wrapper around it. The suppression used to be a <div> holding
    // nothing but the bar, which is fatal to this variant: it is `position: sticky`, and a sticky box is
    // clamped to its containing block — a wrapper whose only child is the header is exactly the header's
    // height, so the sticky range was zero and the bar scrolled away.
    //
    // The width is spelled in PIXELS on purpose: Tailwind's `md` is 48rem, which drifts away from the
    // hook's pixel media query as soon as the browser font is not 16px.
    for (const path of ['/chat', '/dash']) {
      pathname = path;
      const view = render(<Shell><span>page-body</span></Shell>);
      const bar = await screen.findByTestId('future-page-header');
      expect(bar, `the bar is withheld on ${path}`).not.toHaveClass(`max-[${MOBILE_MAX_WIDTH}px]:hidden`);
      expect(bar.parentElement, 'no wrapper may clamp the sticky bar').not.toHaveClass(`max-[${MOBILE_MAX_WIDTH}px]:hidden`);
      view.unmount();
    }
  });
});
