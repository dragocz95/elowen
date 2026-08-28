import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../msw';
vi.mock('next/navigation', () => ({ usePathname: () => '/dash', useRouter: () => ({ push: () => {}, replace: () => {} }), useSearchParams: () => new URLSearchParams() }));
import { Shell } from '../../components/shell/Shell';
import type { SkinChoice } from '../../lib/skins';

class FakeES { onmessage = null; addEventListener() {} close() {} constructor(public url: string) {} }
(globalThis as unknown as { EventSource: typeof FakeES }).EventSource = FakeES;

const ALLOWED: SkinChoice[] = ['midnight', 'studio-light'];
const server = setupServer(
  http.get('*/api/health', () => HttpResponse.json({ ok: true })),
  http.get('*/api/config', () => HttpResponse.json({ allowedSkins: ALLOWED })),
  http.get('*/api/auth/me/nav-settings', () => HttpResponse.json({ hidden: [], order: [] })),
  http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, username: 'admin' } })),
  http.get('*/api/brain/sessions', () => HttpResponse.json([])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
);
beforeAll(() => server.listen({ onUnhandledRequest }));
afterEach(() => {
  server.resetHandlers();
  localStorage.clear();
  document.documentElement.removeAttribute('data-skin');
  document.cookie = 'elowen-skin=; path=/; max-age=0';
});
afterAll(() => server.close());

/** A page that can PROVE it was not remounted: it counts its own mounts and holds state nothing outside
 *  it can restore. It sits where every route's content sits — under RouteTransition, under <main>, under
 *  BrainChatProvider — so its identity surviving is the whole subtree's identity surviving, including the
 *  one brain-chat controller whose SSE stream and composer draft a remount would silently drop. */
let mounts = 0;
function Probe() {
  const [typed, setTyped] = useState('');
  useEffect(() => { mounts += 1; }, []);
  return <input aria-label="probe" value={typed} onChange={(event) => setTyped(event.target.value)} />;
}

// Switching the design swaps the NAVIGATION and nothing else. The seam is one expression inside
// ShellLayout for exactly this reason: branching a component type higher up would make React unmount the
// whole shell — <main>'s scroll position, every open modal and in-flight form on the page, the command
// palette's query, and the brain-chat stream with it. The assertion that matters here is not that the
// Studio sidebar appeared; it is that nothing else went away while it did.
describe('switching to a command-profile skin', () => {
  it('swaps the navigation in place, without remounting the shell or the page under it', async () => {
    mounts = 0;
    render(
      <Shell skinSeed={{ choice: 'midnight', allowed: ALLOWED, fallback: 'midnight' }}><Probe /></Shell>,
    );

    // The spatial rail is what a `spatial` profile mounts.
    expect(await screen.findByTestId('future-navigation')).toBeInTheDocument();
    expect(screen.queryByTestId('studio-navigation')).toBeNull();

    const probe = await screen.findByLabelText('probe');
    fireEvent.change(probe, { target: { value: 'unsaved draft' } });
    expect(mounts).toBe(1);

    // The switcher is the real way a reader changes design: one button, no reload.
    fireEvent.click(await screen.findByRole('button', { name: 'Skin: Midnight' }));

    expect(await screen.findByTestId('studio-navigation')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('future-navigation')).toBeNull());
    expect(document.documentElement.getAttribute('data-skin')).toBe('studio-light');

    // Same node, same state, same single mount — the page never went away and came back.
    expect(screen.getByLabelText('probe')).toBe(probe);
    expect((probe as HTMLInputElement).value).toBe('unsaved draft');
    expect(mounts).toBe(1);
  });

  it('mounts the Studio navigation for a document already wearing the skin', async () => {
    // localStorage stays the client's source of truth for the choice, so a reader who picked Studio
    // arrives with it stored and the document already rendered in it.
    localStorage.setItem('elowen-skin', 'studio-light');
    render(
      <Shell skinSeed={{ choice: 'studio-light', allowed: ALLOWED, fallback: 'midnight' }}><span>page-body</span></Shell>,
    );
    expect(await screen.findByTestId('studio-navigation')).toBeInTheDocument();
    expect(screen.queryByTestId('future-navigation')).toBeNull();
  });

  it('follows the skin the DOCUMENT wears, not the account choice, when the operator set a default nobody picked', async () => {
    // An operator who sets ELOWEN_SKIN without offering it in the allow-list gives everyone that design
    // with nothing chosen: the choice is null while the document carries the attribute. Reading the
    // choice here would mount the spatial rail inside the Studio stylesheet.
    server.use(http.get('*/api/config', () => HttpResponse.json({ allowedSkins: [] })));
    render(
      <Shell skinSeed={{ choice: null, allowed: [], fallback: 'studio-light' }}><span>page-body</span></Shell>,
    );
    expect(await screen.findByTestId('studio-navigation')).toBeInTheDocument();
  });
});
