import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { en } from '../../../lib/i18n/dictionaries/en';

const state = vi.hoisted(() => ({ back: vi.fn(), mobile: false as boolean | undefined }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ back: state.back }) }));
vi.mock('../../../lib/useMobile', () => ({ useMobileViewport: () => state.mobile }));
vi.mock('../../../modules/settings/SettingsView', () => ({ SettingsView: () => <div>Settings content</div> }));
vi.mock('../../../modules/account/AccountView', () => ({ AccountView: () => <div>Account content</div> }));

import { AccountOverlay } from '../../../modules/account/AccountOverlay';
import { SettingsOverlay } from '../../../modules/settings/SettingsOverlay';

function Wrapper({ children }: { children: React.ReactNode }) {
  return <LanguageProvider>{children}</LanguageProvider>;
}

/** Everything about the frame that a call site does NOT get to decide. Read off the rendered surface so a
 *  divergence shows up as two different objects rather than as a subtly different-looking page. */
const frameOf = (dialog: HTMLElement) => ({
  presentation: dialog.getAttribute('data-presentation'),
  modal: dialog.getAttribute('aria-modal'),
  layer: dialog.parentElement?.className,
  surface: dialog.className,
});

afterEach(() => {
  state.back.mockReset();
  state.mobile = false;
});

/** `/settings` and `/account` are both pages presented over whatever linked to them, and the whole point
 *  of the shared frame is that there is ONE answer to how that looks and behaves. These assert the two
 *  overlays are indistinguishable apart from their title, icon and content — the divergence a second
 *  hand-written frame would reintroduce one prop at a time. */
describe('PageOverlay', () => {
  it('frames Settings and Account identically on the desktop', () => {
    const settings = render(<SettingsOverlay />, { wrapper: Wrapper });
    const settingsFrame = frameOf(screen.getByRole('dialog', { name: 'Settings' }));
    settings.unmount();

    render(<AccountOverlay />, { wrapper: Wrapper });
    expect(frameOf(screen.getByRole('dialog', { name: en.account.title }))).toEqual(settingsFrame);
    expect(settingsFrame.presentation).toBe('center');
    // Both are page stand-ins, so both rank below the drawers they open.
    expect(settingsFrame.layer).toContain('overlay-layer-page');
  });

  it('frames Settings and Account identically on a phone', () => {
    state.mobile = true;
    const settings = render(<SettingsOverlay />, { wrapper: Wrapper });
    const settingsFrame = frameOf(screen.getByRole('dialog', { name: 'Settings' }));
    settings.unmount();

    render(<AccountOverlay />, { wrapper: Wrapper });
    expect(frameOf(screen.getByRole('dialog', { name: en.account.title }))).toEqual(settingsFrame);
    expect(settingsFrame.presentation).toBe('fullscreen');
  });

  /** An intercepted PAGE is a reading surface with a fixed measure, not a data window that wants every
   *  pixel the monitor has. `size="lg"` grows to 90rem × 88dvh, which on a wide screen left a settings
   *  record's label and its control a whole screen apart; the page frame caps both axes instead. */
  it('frames the intercepted page at the reading measure rather than at the data-window size', () => {
    render(<SettingsOverlay />, { wrapper: Wrapper });
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(dialog).toHaveClass('max-w-[72rem]', 'h-[min(88dvh,50rem)]');
    expect(dialog).not.toHaveClass('max-w-[90rem]');
  });

  it('closes both by walking back through history rather than by dropping the route', () => {
    for (const [overlay, name] of [[<SettingsOverlay key="s" />, en.page.settings], [<AccountOverlay key="a" />, en.account.title]] as const) {
      state.back.mockReset();
      const { unmount } = render(overlay, { wrapper: Wrapper });
      fireEvent.keyDown(screen.getByRole('dialog', { name }), { key: 'Escape' });
      expect(state.back, `${name} does not close through history`).toHaveBeenCalledOnce();
      unmount();
    }
  });
});
