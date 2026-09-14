import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { en } from '../../../lib/i18n/dictionaries/en';

const state = vi.hoisted(() => ({ back: vi.fn(), replace: vi.fn(), mobile: false as boolean | undefined }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ back: state.back, replace: state.replace }) }));
vi.mock('../../../lib/useMobile', () => ({ useMobileViewport: () => state.mobile }));
vi.mock('../../../modules/account/AccountView', () => ({ AccountView: () => <div>Account content</div> }));

import { AccountOverlay } from '../../../modules/account/AccountOverlay';
import { noteAppNavigation } from '../../../lib/pageOverlayReturn';

function Wrapper({ children }: { children: React.ReactNode }) {
  return <LanguageProvider>{children}</LanguageProvider>;
}

/** These assert the close of an overlay the reader OPENED from somewhere — the ordinary case, where a
 *  surface of the app is behind it. The cold-load close, which has none, is pinned in
 *  tests/components/ui/PageOverlay.test.tsx. */
beforeAll(() => { noteAppNavigation(); });

afterEach(() => {
  state.back.mockReset();
  state.replace.mockReset();
  state.mobile = false;
});

describe('AccountOverlay', () => {
  it('uses the centered shared dialog and closes through browser history', () => {
    render(<AccountOverlay />, { wrapper: Wrapper });
    const dialog = screen.getByRole('dialog', { name: en.account.title });
    expect(dialog).toHaveAttribute('data-presentation', 'center');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveTextContent('Account content');
    // It stands in for `/account`, so it ranks below every drawer and dialog raised from inside it
    // rather than on the modal band above them.
    expect(dialog.parentElement).toHaveClass('overlay-layer-page');
    // Opening the page moves focus onto the surface — there is no trigger to anchor on, because the
    // overlay is mounted by the route rather than opened from a control.
    expect(dialog).toHaveFocus();

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(state.back).toHaveBeenCalledOnce();
  });

  it('closes from the header control through the same history step', () => {
    render(<AccountOverlay />, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(state.back).toHaveBeenCalledOnce();
  });

  it('uses the shared fullscreen geometry on a phone', () => {
    state.mobile = true;
    render(<AccountOverlay />, { wrapper: Wrapper });
    const dialog = screen.getByRole('dialog', { name: en.account.title });
    expect(dialog).toHaveAttribute('data-presentation', 'fullscreen');
    expect(dialog).toHaveClass('overlay-surface');
  });

  /** Geometry is part of the contract, so nothing is painted until the viewport is known: a centered
   *  desktop window on a phone, stretched to fullscreen one frame later, is a visible jump. */
  it('paints nothing until the viewport has been measured', () => {
    state.mobile = undefined;
    render(<AccountOverlay />, { wrapper: Wrapper });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
