import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../msw';
import { SkinSwitcher } from '../../components/ui/SkinSwitcher';
import { SkinProvider, useSkin } from '../../lib/skinContext';
import { QUERY_KEYS } from '../../lib/queries';
import { BUILTIN_SKIN, type SkinChoice } from '../../lib/skins';
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

const mount = (allowedSkins: string[], initialChoice: SkinChoice | null = null) => {
  const { wrapper: Wrapper } = createWrapper();
  return render(
    <Wrapper>
      <SkinProvider allowedSkins={allowedSkins} initialChoice={initialChoice} fallback={null}>
        <SkinSwitcher />
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
    mount(['midnight']);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('cycles the live document attribute, which is the entire mechanism', () => {
    // Every skin's CSS is already in the page, scoped under its own [data-skin]. Switching is this
    // attribute and nothing else — no fetch, no reload — so asserting on it IS asserting on the feature.
    mount([BUILTIN_SKIN, 'midnight'], BUILTIN_SKIN);
    expect(document.documentElement.hasAttribute('data-skin')).toBe(false);

    fireEvent.click(screen.getByRole('button'));
    expect(document.documentElement.getAttribute('data-skin')).toBe('midnight');

    // ...and wraps back to the built-in design, which is the ABSENCE of the attribute rather than a
    // value. Getting this wrong would leave `data-skin="default"` behind, matching no stylesheet.
    fireEvent.click(screen.getByRole('button'));
    expect(document.documentElement.hasAttribute('data-skin')).toBe(false);
  });

  it('appears after signing in, without waiting for a full page reload', () => {
    // The document a visitor logs in ON was rendered while they had no session, so the server prefetch
    // had no cookie to forward and seeded an EMPTY allow-list. Logging in only opens the shell gate — it
    // does not re-render the layout. Without the live config query the switcher would stay missing until
    // the user happened to reload, which looks exactly like the feature not existing.
    server.use(http.get('*/api/config', () => HttpResponse.json({ allowedSkins: [BUILTIN_SKIN, 'midnight'] })));
    mount([]);
    return waitFor(() => expect(screen.getByRole('button')).toBeTruthy());
  });

  it('shows the skin its human name, never its id', () => {
    // The id is a directory name and a `data-skin` value. Rendering it verbatim put "midnight" — and
    // would have put "studio-oled" — in the top bar as if it were a product name.
    mount([BUILTIN_SKIN, 'midnight'], BUILTIN_SKIN);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Skin: Midnight');
    expect(screen.getByText('Midnight')).toBeTruthy();
  });

  it('remembers the choice where both the client and the next server render can find it', () => {
    mount([BUILTIN_SKIN, 'midnight'], BUILTIN_SKIN);
    fireEvent.click(screen.getByRole('button'));

    expect(localStorage.getItem('elowen-skin')).toBe('midnight');
    // The cookie is the half the SERVER reads, and it is what stops the next document arriving in the
    // old design and visibly changing colour once hydration catches up.
    expect(document.cookie).toContain('elowen-skin=midnight');
  });
});

/** The provider's own contract, independent of the switcher: whatever the document ends up wearing, the
 *  attribute and the context's resolved skin say the same thing. Null is a value in that resolution — the
 *  built-in design — and reaching it while the page is open is ordinary, not an error. */
describe('SkinProvider', () => {
  function Readout() {
    const { skin, choice } = useSkin();
    return <span data-testid="readout">{`${skin ?? 'builtin'}/${choice ?? 'none'}`}</span>;
  }

  it('removes the attribute when the live allow-list drops the skin the reader is wearing', async () => {
    // The mechanism from the blocker: an admin revokes the skin and the config QUERY pushes the narrowed
    // list into a mounted provider. Nothing reloads, so if the document write is skipped for the built-in
    // design the page keeps wearing a stylesheet nothing else believes in any more.
    const { wrapper: Wrapper, client } = createWrapper();
    server.use(http.get('*/api/config', () => HttpResponse.json({ allowedSkins: [BUILTIN_SKIN, 'midnight'] })));
    localStorage.setItem('elowen-skin', 'midnight');
    render(
      <Wrapper>
        <SkinProvider allowedSkins={[BUILTIN_SKIN, 'midnight']} initialChoice="midnight" fallback={null}>
          <Readout />
        </SkinProvider>
      </Wrapper>,
    );
    await waitFor(() => expect(document.documentElement.getAttribute('data-skin')).toBe('midnight'));
    expect(screen.getByTestId('readout').textContent).toBe('midnight/midnight');

    client.setQueryData(QUERY_KEYS.config, { allowedSkins: [] });

    await waitFor(() => expect(document.documentElement.hasAttribute('data-skin')).toBe(false));
    expect(screen.getByTestId('readout').textContent).toBe('builtin/none');
  });
});
