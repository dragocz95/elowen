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
 *  divergence shows up as two different objects rather than as a subtly different-looking page.
 *
 *  The MEASURE is deliberately not in here: it is the one axis `frame` opens to the call site, and it has
 *  assertions of its own below. Everything else — the presentation, the modal semantics, the z-band and
 *  the material the surface is made of — stays one answer for every intercepted page. */
const SIZE_CLASSES = /^(?:h|w|max-w|max-h)-\[/;
const frameOf = (dialog: HTMLElement) => ({
  presentation: dialog.getAttribute('data-presentation'),
  modal: dialog.getAttribute('aria-modal'),
  layer: dialog.parentElement?.className,
  surface: dialog.className.split(/\s+/).filter((name) => !SIZE_CLASSES.test(name)).join(' '),
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

  /** THE ONE AXIS THE TWO PAGES DIFFER ON, pinned from both sides so neither drifts into the other.
   *
   *  Settings asks for the reading measure: its records read as a label at one edge of the frame and a
   *  control at the other, and the data-window size grows to 90rem by 88dvh, which on a wide screen puts
   *  most of a desk between them. Account did not ask, so it keeps the frame it has always had — the
   *  point of making the measure opt-in rather than a property of "being an intercepted page".
   *
   *  The width is asserted as the shared `--content-max` token rather than as a length: a cap restated
   *  as a number here is exactly what that token exists to prevent, and a skin is allowed to move it. */
  it('gives Settings the reading measure and leaves Account on the shared window', () => {
    const settings = render(<SettingsOverlay />, { wrapper: Wrapper });
    const settingsDialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(settingsDialog).toHaveClass('max-w-[var(--content-max)]', 'h-[min(88dvh,50rem)]');
    expect(settingsDialog).not.toHaveClass('max-w-[90rem]');
    settings.unmount();

    render(<AccountOverlay />, { wrapper: Wrapper });
    const accountDialog = screen.getByRole('dialog', { name: en.account.title });
    expect(accountDialog).toHaveClass('max-w-[90rem]', 'h-[88dvh]');
    expect(accountDialog).not.toHaveClass('max-w-[var(--content-max)]');
  });

  /** A phone takes the whole screen either way, so the measure has nothing to say there. Stated because
   *  the opt-in would otherwise look like it could leak into the presentation that ignores it. */
  it('drops the measure entirely on a phone, for both pages', () => {
    state.mobile = true;
    const settings = render(<SettingsOverlay />, { wrapper: Wrapper });
    const settingsDialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(settingsDialog).not.toHaveClass('max-w-[var(--content-max)]');
    expect(settingsDialog).not.toHaveClass('max-w-[90rem]');
    settings.unmount();

    render(<AccountOverlay />, { wrapper: Wrapper });
    expect(screen.getByRole('dialog', { name: en.account.title })).not.toHaveClass('max-w-[90rem]');
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
