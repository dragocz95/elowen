import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../msw';
vi.mock('next/navigation', () => ({ usePathname: () => '/dash', useRouter: () => ({ push: () => {}, replace: () => {} }), useSearchParams: () => new URLSearchParams() }));
import { Shell } from '../../components/shell/Shell';
import { useSkin } from '../../lib/skinContext';
import type { SkinChoice, SkinName } from '../../lib/skins';

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
  document.documentElement.style.removeProperty('background-color');
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
    const { container } = render(
      <Shell skinSeed={{ choice: 'studio-light', allowed: ALLOWED, fallback: 'midnight' }}><span>page-body</span></Shell>,
    );
    expect(await screen.findByTestId('studio-navigation')).toBeInTheDocument();
    expect(screen.queryByTestId('future-navigation')).toBeNull();
    expect(container.querySelector('.top-bar__context-nav')).toBeNull();
    expect(screen.getByTestId('page-top-bar-host')).toBeInTheDocument();
    expect(screen.getByTestId('page-top-bar-host')).toBeEmptyDOMElement();
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

/** Reports the skin the CONTEXT resolved, so the assertions below can compare it against the attribute
 *  and the navigation instead of inferring it from them. `builtin` stands for null, which is a value here
 *  and not an absence: it is how "the plain design" is expressed. */
function SkinReadout() {
  const { skin } = useSkin();
  return <span data-testid="skin-readout">{skin ?? 'builtin'}</span>;
}

/** The four signals that describe the visible design — the `data-skin` attribute, the context's resolved
 *  skin, the canvas, and the mounted navigation — have to agree at every moment, including the moments
 *  nobody pressed anything. They are driven by one resolution, so a change to the inputs of that
 *  resolution must move all four together.
 *
 *  The defect these cover: the document write was made conditionally, only for a truthy skin, so the
 *  built-in design could never be written back. The context flipped to null and the shell swapped the
 *  navigation back, while <html> kept `data-skin='studio-light'` and the whole Studio stylesheet with it —
 *  Studio CSS painting an Ember shell, with the sidebar rules aimed at markup that was no longer there. */
describe('a design the reader did not switch away from', () => {
  // With no `allowedSkins` in the config payload the provider reads the seed, which is what lets these
  // cases change the allow-list and the operator default on a LIVE tree instead of on a fresh mount.
  const seedOnly = () => server.use(http.get('*/api/config', () => HttpResponse.json({})));
  const seed = (choice: SkinChoice | null, allowed: SkinChoice[], fallback: SkinName | null) => ({ choice, allowed, fallback });

  it('hands the document back to the built-in design when an admin revokes the active skin', async () => {
    seedOnly();
    mounts = 0;
    localStorage.setItem('elowen-skin', 'studio-light');
    // What the server served: the attribute, plus the anti-FOUC canvas inline on <html>.
    document.documentElement.setAttribute('data-skin', 'studio-light');
    document.documentElement.style.backgroundColor = '#fafafa';

    const { rerender } = render(
      <Shell skinSeed={seed('studio-light', ALLOWED, null)}><Probe /><SkinReadout /></Shell>,
    );
    expect(await screen.findByTestId('studio-navigation')).toBeInTheDocument();
    expect(document.documentElement.getAttribute('data-skin')).toBe('studio-light');
    expect(screen.getByTestId('skin-readout').textContent).toBe('studio-light');

    const probe = await screen.findByLabelText('probe');
    fireEvent.change(probe, { target: { value: 'unsaved draft' } });
    expect(mounts).toBe(1);

    // The admin drops studio-light from the instance allow-list. No reload: the new list reaches the
    // live provider, and the design the reader is looking at is no longer on offer.
    rerender(<Shell skinSeed={seed('studio-light', ['midnight'], null)}><Probe /><SkinReadout /></Shell>);

    expect(await screen.findByTestId('future-navigation')).toBeInTheDocument();
    await waitFor(() => expect(document.documentElement.hasAttribute('data-skin')).toBe(false));
    expect(screen.queryByTestId('studio-navigation')).toBeNull();
    expect(screen.getByTestId('skin-readout').textContent).toBe('builtin');
    // The canvas goes back to the cascade rather than staying frozen at the design the document arrived in.
    expect(document.documentElement.style.backgroundColor).toBe('');
    // ...and it all happened in place, exactly as a switch does.
    expect(screen.getByLabelText('probe')).toBe(probe);
    expect((probe as HTMLInputElement).value).toBe('unsaved draft');
    expect(mounts).toBe(1);

    // Re-allowing it restores the design: the removal must not be a one-way door, and the stored choice
    // was never destroyed — only ignored while it was not on offer.
    rerender(<Shell skinSeed={seed('studio-light', ALLOWED, null)}><Probe /><SkinReadout /></Shell>);
    expect(await screen.findByTestId('studio-navigation')).toBeInTheDocument();
    await waitFor(() => expect(document.documentElement.getAttribute('data-skin')).toBe('studio-light'));
    expect(screen.getByTestId('skin-readout').textContent).toBe('studio-light');
    expect(screen.queryByTestId('future-navigation')).toBeNull();
    expect(mounts).toBe(1);
  });

  it('follows the operator default when it moves under a reader who has nothing resolvable chosen', async () => {
    seedOnly();
    mounts = 0;
    // Nothing is on offer, so the stored choice cannot resolve and the deployment's default is the floor.
    localStorage.setItem('elowen-skin', 'studio-light');
    document.documentElement.setAttribute('data-skin', 'studio-light');

    const { rerender } = render(
      <Shell skinSeed={seed(null, [], 'studio-light')}><Probe /><SkinReadout /></Shell>,
    );
    expect(await screen.findByTestId('studio-navigation')).toBeInTheDocument();
    expect(screen.getByTestId('skin-readout').textContent).toBe('studio-light');

    // ELOWEN_SKIN moves to a spatial design.
    rerender(<Shell skinSeed={seed(null, [], 'midnight')}><Probe /><SkinReadout /></Shell>);

    expect(await screen.findByTestId('future-navigation')).toBeInTheDocument();
    await waitFor(() => expect(document.documentElement.getAttribute('data-skin')).toBe('midnight'));
    expect(screen.getByTestId('skin-readout').textContent).toBe('midnight');
    expect(screen.queryByTestId('studio-navigation')).toBeNull();
    expect(mounts).toBe(1);

    // ...and away entirely, which is the built-in design and therefore no attribute at all.
    rerender(<Shell skinSeed={seed(null, [], null)}><Probe /><SkinReadout /></Shell>);
    await waitFor(() => expect(document.documentElement.hasAttribute('data-skin')).toBe(false));
    expect(screen.getByTestId('skin-readout').textContent).toBe('builtin');
    expect(await screen.findByTestId('future-navigation')).toBeInTheDocument();
    expect(mounts).toBe(1);
  });
});
