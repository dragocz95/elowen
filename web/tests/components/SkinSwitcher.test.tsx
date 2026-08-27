import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SkinSwitcher } from '../../components/ui/SkinSwitcher';
import { SkinProvider } from '../../lib/skinContext';
import { BUILTIN_SKIN, type SkinChoice } from '../../lib/skins';
import { createWrapper } from '../test-utils';

afterEach(() => {
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

  it('remembers the choice where both the client and the next server render can find it', () => {
    mount([BUILTIN_SKIN, 'midnight'], BUILTIN_SKIN);
    fireEvent.click(screen.getByRole('button'));

    expect(localStorage.getItem('elowen-skin')).toBe('midnight');
    // The cookie is the half the SERVER reads, and it is what stops the next document arriving in the
    // old design and visibly changing colour once hydration catches up.
    expect(document.cookie).toContain('elowen-skin=midnight');
  });
});
