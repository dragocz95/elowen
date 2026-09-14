import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { en } from '../../../lib/i18n/dictionaries/en';

const state = vi.hoisted(() => ({ back: vi.fn(), replace: vi.fn(), mobile: false as boolean | undefined }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ back: state.back, replace: state.replace }) }));
vi.mock('../../../lib/useMobile', () => ({ useMobileViewport: () => state.mobile }));
vi.mock('../../../modules/settings/SettingsView', () => ({ SettingsView: () => <div>Settings content</div> }));
vi.mock('../../../modules/account/AccountView', () => ({ AccountView: () => <div>Account content</div> }));

import { AccountOverlay } from '../../../modules/account/AccountOverlay';
import { SettingsOverlay } from '../../../modules/settings/SettingsOverlay';
import { PAGE_OVERLAY_FALLBACK_ROUTE, noteAppNavigation } from '../../../lib/pageOverlayReturn';

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
  state.replace.mockReset();
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

  /** Both intercepted settings pages are one reading surface. A different width makes Account feel like a
   *  separate application and moves the same row grammar between two unrelated measures. The width is the
   *  shared `--content-max` token rather than a repeated number, so a skin still owns its reading measure. */
  it('gives Settings and Account the same reading measure', () => {
    for (const [overlay, name] of [[<SettingsOverlay key="s" />, 'Settings'], [<AccountOverlay key="a" />, en.account.title]] as const) {
      const { unmount } = render(overlay, { wrapper: Wrapper });
      const dialog = screen.getByRole('dialog', { name });
      expect(dialog).toHaveClass('max-w-[var(--content-max)]', 'h-[min(88dvh,50rem)]');
      expect(dialog).not.toHaveClass('max-w-[90rem]', 'h-[88dvh]');
      unmount();
    }
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

  /** THE COLD-LOAD CLOSE. This document has not navigated anywhere: the overlay IS the arrival, so there
   *  is no entry of this app's to step back to. `history.back()` would either do nothing — leaving the
   *  close control looking broken with the reader stuck on a page that draws nothing but the overlay — or
   *  hand them whatever the tab held before the app. So the close goes to a real page of the app instead.
   *
   *  This case runs FIRST because the navigation count belongs to the document: once a navigation has been
   *  noted, this module cannot un-note it. */
  it('closes to a real page when nothing of the app is behind the overlay', () => {
    for (const [overlay, name] of [[<SettingsOverlay key="s" />, en.page.settings], [<AccountOverlay key="a" />, en.account.title]] as const) {
      state.back.mockReset();
      state.replace.mockReset();
      const { unmount } = render(overlay, { wrapper: Wrapper });
      fireEvent.keyDown(screen.getByRole('dialog', { name }), { key: 'Escape' });
      expect(state.back, `${name} stepped back out of the app`).not.toHaveBeenCalled();
      expect(state.replace, `${name} did not land anywhere`).toHaveBeenCalledWith(PAGE_OVERLAY_FALLBACK_ROUTE);
      unmount();
    }
  });

  it('closes both by walking back through history once the app has a surface behind them', () => {
    noteAppNavigation();
    for (const [overlay, name] of [[<SettingsOverlay key="s" />, en.page.settings], [<AccountOverlay key="a" />, en.account.title]] as const) {
      state.back.mockReset();
      state.replace.mockReset();
      const { unmount } = render(overlay, { wrapper: Wrapper });
      fireEvent.keyDown(screen.getByRole('dialog', { name }), { key: 'Escape' });
      expect(state.back, `${name} does not close through history`).toHaveBeenCalledOnce();
      expect(state.replace, `${name} dropped the route instead of stepping back`).not.toHaveBeenCalled();
      unmount();
    }
  });
});
