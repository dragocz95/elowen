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

describe('Shell', () => {
  it('renders the orbital desktop navigation, frameless masthead and content slot', async () => {
    render(<Shell><span>page-body</span></Shell>);
    // The orbital navigation and Home world appear after the async gate opens.
    expect(await screen.findByTestId('future-navigation')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Home' })).toBeInTheDocument();
    expect(screen.getByText('page-body')).toBeInTheDocument();
    expect(screen.getByTestId('future-page-header')).not.toHaveClass('sticky');
    expect(screen.getByTestId('future-page-header')).not.toHaveClass('border-b');
  });

  it('suppresses the global bar on /chat by breakpoint, never by the measured region', async () => {
    // The region is window − dock, so keying the bar off it let a docked desktop window drop the bar AND
    // its hamburger while ChatView's replacement link (keyed off the viewport) stayed away — no way off
    // /chat at all. A CSS breakpoint reads the same viewport ChatView does, and needs no measurement.
    // The value is asserted in PIXELS on purpose: Tailwind's `md` is 48rem, which drifts away from the
    // hook's pixel media query as soon as the browser font is not 16px, reopening that same gap.
    //
    // Asserted on the HEADER and not on a wrapper around it. The suppression used to be a <div> holding
    // nothing but the bar, which is fatal to the `bar` variant: that one is `position: sticky`, and a
    // sticky box is clamped to its containing block — a wrapper whose only child is the header is
    // exactly the header's height, so the sticky range was zero and the bar scrolled away.
    pathname = '/chat';
    render(<Shell><span>page-body</span></Shell>);
    const bar = await screen.findByTestId('future-page-header');
    expect(bar).toHaveClass(`max-[${MOBILE_MAX_WIDTH}px]:hidden`);
    expect(bar.parentElement, 'no wrapper may clamp the sticky bar').not.toHaveClass(`max-[${MOBILE_MAX_WIDTH}px]:hidden`);
  });

  it('leaves the global bar unconditional off /chat', async () => {
    pathname = '/dash';
    render(<Shell><span>page-body</span></Shell>);
    const bar = await screen.findByTestId('future-page-header');
    expect(bar).not.toHaveClass(`max-[${MOBILE_MAX_WIDTH}px]:hidden`);
  });
});
