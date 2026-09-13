import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';

const state = vi.hoisted(() => ({ back: vi.fn(), mobile: false }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ back: state.back }) }));
vi.mock('../../../lib/useMobile', () => ({ useMobileViewport: () => state.mobile }));
vi.mock('../../../modules/settings/SettingsView', () => ({ SettingsView: () => <div>Settings content</div> }));

import { SettingsOverlay } from '../../../modules/settings/SettingsOverlay';

function Wrapper({ children }: { children: React.ReactNode }) {
  return <LanguageProvider>{children}</LanguageProvider>;
}

afterEach(() => {
  state.back.mockReset();
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
