import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../msw';
import { SkinSwitcher } from '../../components/ui/SkinSwitcher';
import { SkinProvider, useSkin } from '../../lib/skinContext';
import { QUERY_KEYS } from '../../lib/queries';
import { DEFAULT_SKIN, type SkinName } from '../../lib/skins';
import { createWrapper } from '../test-utils';

// The instance config is what the provider reads to learn which skins are allowed. Empty by default, so
// the cases below that pass an explicit seed are testing the seed and nothing else.
const server = setupServer(http.get('*/api/config', () => HttpResponse.json({ allowedSkins: [] })));
beforeAll(() => server.listen({ onUnhandledRequest }));
afterAll(() => server.close());

afterEach(() => {
  server.resetHandlers();
  localStorage.clear();
  document.documentElement.removeAttribute('data-skin');
  document.cookie = 'elowen-skin=; path=/; max-age=0';
});

const mount = (allowedSkins: string[], initialChoice: SkinName | null = null, collapsed = false) => {
  const { wrapper: Wrapper } = createWrapper();
  return render(
    <Wrapper>
      <SkinProvider allowedSkins={allowedSkins} initialChoice={initialChoice} fallback={null}>
        <SkinSwitcher collapsed={collapsed} />
      </SkinProvider>
    </Wrapper>,
  );
};

describe('SkinSwitcher', () => {
  it('does not render at all when the instance has not enabled switching', () => {
    // The default for every existing instance. A control with nothing to switch to is not a choice, and
    // the top bar must look exactly as it did before skins became switchable.
    mount([]);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('does not render for a single allowed skin either', () => {
    mount(['studio-oled']);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('uses the same compact ghost geometry as the other top-bar actions', () => {
    mount(['studio-light', 'studio-oled'], 'studio-light', true);
    const button = screen.getByRole('button', { name: 'Skin: Light' });
    expect(button).toHaveClass('h-8', 'w-8', 'rounded-md', 'hover:bg-accent', 'hover:text-foreground');
    expect(button).not.toHaveClass('min-h-[var(--touch-target)]', 'rounded-full');
    expect(button).toHaveClass('pointer-coarse:h-[var(--touch-target)]', 'pointer-coarse:w-[var(--touch-target)]');
  });

  it('cycles the live document attribute, which is the entire mechanism', () => {
    // Every skin's CSS is already in the page, scoped under its own [data-skin]. Switching is this
    // attribute and nothing else — no fetch, no reload — so asserting on it IS asserting on the feature.
    mount(['studio-light', 'studio-oled'], 'studio-light');
    expect(document.documentElement.getAttribute('data-skin')).toBe(DEFAULT_SKIN);

    fireEvent.click(screen.getByRole('button'));
    expect(document.documentElement.getAttribute('data-skin')).toBe('studio-oled');

    fireEvent.click(screen.getByRole('button'));
    expect(document.documentElement.getAttribute('data-skin')).toBe(DEFAULT_SKIN);
  });

  it('appears after signing in, without waiting for a full page reload', () => {
    // The document a visitor logs in ON was rendered while they had no session, so the server prefetch
    // had no cookie to forward and seeded an EMPTY allow-list. Logging in only opens the shell gate — it
    // does not re-render the layout. Without the live config query the switcher would stay missing until
    // the user happened to reload, which looks exactly like the feature not existing.
    server.use(http.get('*/api/config', () => HttpResponse.json({ allowedSkins: ['studio-light', 'studio-oled'] })));
    mount([]);
    return waitFor(() => expect(screen.getByRole('button')).toBeTruthy());
  });

  it('shows the skin its human name, never its id', () => {
    // The id is a directory name and a `data-skin` value. Rendering it verbatim put "studio-oled" — and
    // would have put "studio-oled" — in the top bar as if it were a product name.
    mount(['studio-light', 'studio-oled'], 'studio-light');
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Skin: Dark');
    expect(screen.getByText('Dark')).toBeTruthy();
  });

  it('remembers the choice where both the client and the next server render can find it', () => {
    mount(['studio-light', 'studio-oled'], 'studio-light');
    fireEvent.click(screen.getByRole('button'));

    expect(localStorage.getItem('elowen-skin')).toBe('studio-oled');
    // The cookie is the half the SERVER reads, and it is what stops the next document arriving in the
    // old design and visibly changing colour once hydration catches up.
    expect(document.cookie).toContain('elowen-skin=studio-oled');
  });
});

/** The provider's own contract, independent of the switcher: whatever the document ends up wearing, the
 *  attribute and the context's resolved skin say the same thing — and there is always something to wear,
 *  because every route through the resolution ends at a compiled skin. */
describe('SkinProvider', () => {
  function Readout() {
    const { skin, choice } = useSkin();
    return <span data-testid="readout">{`${skin}/${choice ?? 'none'}`}</span>;
  }

  it('falls back to the default skin when the live allow-list drops the one the reader is wearing', async () => {
    // The mechanism from the blocker: an admin revokes the skin and the config QUERY pushes the narrowed
    // list into a mounted provider. Nothing reloads, so if the document write were skipped the page would
    // keep wearing a stylesheet nothing else believes in any more — and if it removed the attribute the
    // page would land on no design at all, which is the third look this app is not allowed to have.
    const { wrapper: Wrapper, client } = createWrapper();
    server.use(http.get('*/api/config', () => HttpResponse.json({ allowedSkins: ['studio-light', 'studio-oled'] })));
    localStorage.setItem('elowen-skin', 'studio-oled');
    render(
      <Wrapper>
        <SkinProvider allowedSkins={['studio-light', 'studio-oled']} initialChoice="studio-oled" fallback={null}>
          <Readout />
        </SkinProvider>
      </Wrapper>,
    );
    await waitFor(() => expect(document.documentElement.getAttribute('data-skin')).toBe('studio-oled'));
    expect(screen.getByTestId('readout').textContent).toBe('studio-oled/studio-oled');

    client.setQueryData(QUERY_KEYS.config, { allowedSkins: [] });

    await waitFor(() => expect(document.documentElement.getAttribute('data-skin')).toBe(DEFAULT_SKIN));
    expect(screen.getByTestId('readout').textContent).toBe(`${DEFAULT_SKIN}/none`);
  });
});
