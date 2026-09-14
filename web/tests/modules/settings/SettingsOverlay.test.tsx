import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';

const state = vi.hoisted(() => ({ back: vi.fn(), replace: vi.fn(), mobile: false }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ back: state.back, replace: state.replace }) }));
vi.mock('../../../lib/useMobile', () => ({ useMobileViewport: () => state.mobile }));
vi.mock('../../../modules/settings/SettingsView', () => ({ SettingsView: () => <div>Settings content</div> }));

import { SettingsOverlay } from '../../../modules/settings/SettingsOverlay';
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

describe('SettingsOverlay', () => {
  it('uses the centered shared dialog and closes through browser history', () => {
    render(<SettingsOverlay />, { wrapper: Wrapper });
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(dialog).toHaveAttribute('data-presentation', 'center');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveTextContent('Settings content');
    // It stands in for `/settings`, so it ranks below every drawer and dialog raised from inside it
    // rather than on the modal band above them.
    expect(dialog.parentElement).toHaveClass('overlay-layer-page');

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(state.back).toHaveBeenCalledOnce();
  });

  it('uses the shared fullscreen geometry on a phone', () => {
    state.mobile = true;
    render(<SettingsOverlay />, { wrapper: Wrapper });
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(dialog).toHaveAttribute('data-presentation', 'fullscreen');
    expect(dialog).toHaveClass('overlay-surface');
  });
});
