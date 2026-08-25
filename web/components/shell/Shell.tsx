'use client';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { BRAIN_COMPOSE_EVENT, BRAIN_OPEN_EVENT, advisorOpenTarget } from '../../lib/brainDock';
import { useMobileViewport } from '../../lib/useMobile';
import { Providers, type PluginUiSeed, type MeSeed } from '../../app/providers';
import { LanguageProvider, type Locale } from '../../lib/i18n';
import { BrandProvider, BUILTIN_THEME, type ThemePayload } from '../../lib/brand';
import { ToastProvider, resolveToastDuration } from '../ui/Toast';
import { useConfig } from '../../lib/queries';
import { LoginGate } from '../auth/LoginGate';
import { OrbitalNav } from './OrbitalNav';
import { TopBar } from './TopBar';
import { CommandPalette } from './CommandPalette';
import { AdvisorPanel } from '../../modules/advisor/AdvisorPanel';
import { AdvisorLauncher } from '../../modules/advisor/AdvisorLauncher';
import { BrainChatProvider } from '../../modules/advisor/BrainChatProvider';
import { ImpersonationBanner } from './ImpersonationBanner';
import { useDockState } from '../../lib/useDockState';
import { useElementWidth } from '../../lib/useElementWidth';
import { usePersistentState } from '../../lib/usePersistentState';
import { UiScaleProvider } from '../../lib/useUiScale';
import { ThemeProvider } from '../../lib/useTheme';
import { PageHeaderProvider } from '../../lib/pageHeader';
import { RouteTransition } from './RouteTransition';
import { DocumentTitle } from './DocumentTitle';
import { EffectsProvider } from '../../lib/useEffects';

/** How the rail presents itself, decided by the shell from the measured room it has. */
export type NavMode = 'full' | 'rail' | 'drawer';

/** Below this many px of room for the nav+content region the rail slides in over the content from a
 *  hamburger (real phones, or a dock dragged nearly full-width); below the next it auto-collapses to an
 *  icon rail so the content keeps usable room; above it the user's own pin decides. Driven by the
 *  MEASURED region width (window − dock), not the viewport — so dragging the dock adapts the chrome
 *  just like resizing. */
const DRAWER_MAX = 760;
const RAIL_MAX = 1320;

/** The measure the interface is read at, and it tracks the room available rather than being one frozen
 *  number: the column grows with the window but SLOWER than it (72vw), so a bigger screen buys real
 *  content instead of a wider, emptier table. The two rails are what make it safe — below 90rem a narrow
 *  window would keep the column fluid and hand every extra pixel back to the sprawl the cap exists to
 *  stop, and above 128rem an ultrawide would stretch a table across the whole desk. */
const CONTENT_MAX = 'max-w-[clamp(90rem,72vw,128rem)]';

/** What the user pinned the navigation to, when the window is roomy enough to leave them the choice. */
type NavPin = 'full' | 'rail';
const NAV_PINS: readonly NavPin[] = ['full', 'rail'];

/** The width sets a FLOOR on how compact the chrome is; the user's pin may only go compacter, never
 *  roomier. So the collapse handle is offered exactly when the pin is what decides — in a window already
 *  too narrow for the full rail, a toggle would be a dead control, and before the first measurement
 *  (`regionW === 0`) there is nothing to decide yet. */
export function resolveNav(regionW: number, pin: NavPin): { mode: NavMode; pinnable: boolean } {
  if (regionW === 0) return { mode: 'full', pinnable: false };
  if (regionW < DRAWER_MAX) return { mode: 'drawer', pinnable: false };
  if (regionW < RAIL_MAX) return { mode: 'rail', pinnable: false };
  return { mode: pin, pinnable: true };
}

function ShellLayout({ children }: { children: ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const dock = useDockState();
  const docked = dock.state.open;
  // On /chat the ChatView is the sole chat host: the floating launcher is suppressed (the dock may still
  // open in Terminál mode — see AdvisorPanel). This is a UX guard only; the single controller in
  // BrainChatProvider guarantees one SSE stream regardless of how many surfaces mount.
  const onChat = usePathname() === '/chat';
  const router = useRouter();
  const mobile = useMobileViewport();
  const openAdvisor = useCallback(() => {
    const target = advisorOpenTarget({ onChat, mobile });
    if (target === 'none') return;
    if (target === 'chat-page') { router.push('/chat'); return; }
    dock.setOpen(true);
  }, [onChat, mobile, router, dock]);
  // Open (and reveal the advisor pane of) the dock when another view asks to continue a conversation in
  // web chat (Sessions → open in chat). BrainChat mounts on open and switches to the requested session.
  // On /chat the full-page surface reads the same controller and IS the chat host — the request loads
  // there directly, so popping the dock over it would only duplicate the conversation.
  useEffect(() => {
    window.addEventListener(BRAIN_OPEN_EVENT, openAdvisor);
    window.addEventListener(BRAIN_COMPOSE_EVENT, openAdvisor);
    return () => {
      window.removeEventListener(BRAIN_OPEN_EVENT, openAdvisor);
      window.removeEventListener(BRAIN_COMPOSE_EVENT, openAdvisor);
    };
  }, [openAdvisor]);
  // When the dock takes the left edge, the sidebar moves to the right edge (mirrored) so the two
  // never stack on the same side. Top/bottom docks span the full width above/below the row.
  const dockLeft = docked && dock.state.side === 'left';
  const dockTop = docked && dock.state.side === 'top';
  const dockBottom = docked && dock.state.side === 'bottom';

  // Measure the region the sidebar + content actually share (everything but a left/right dock). The
  // sidebar's mode (full / rail / drawer) and the mobile top bar key off THIS, so the chrome reacts to
  // real available space. Content inside <main> reacts to its own width via CSS container queries.
  const regionRef = useRef<HTMLDivElement>(null);
  const regionW = useElementWidth(regionRef);
  // Collapsing the rail to icons is a per-device display choice, like the UI scale — it belongs to the
  // screen you are on, not to the user record.
  const [pin, setPin] = usePersistentState<NavPin>('elowen.nav.pin', 'full', NAV_PINS);
  const { mode, pinnable } = resolveNav(regionW, pin);
  // Widening past the drawer breakpoint replaces the drawer with a column, but the open flag would
  // survive — so narrowing again, without ever touching the menu, would slide it back out on its own.
  useEffect(() => { if (mode !== 'drawer') setDrawerOpen(false); }, [mode]);

  // One menu at every width. A phone gets the same rail, in its full labelled form, slid in over the
  // content; wider windows give it a column of its own. Collapsing is offered only where the pin is
  // what decides, and never in the drawer, where there is no column to narrow.
  const navigation = (
    <OrbitalNav
      compact={mode === 'rail'}
      side={dockLeft ? 'right' : 'left'}
      drawer={mode === 'drawer'}
      drawerOpen={drawerOpen}
      onDrawerClose={() => setDrawerOpen(false)}
      onToggleCollapse={pinnable ? () => setPin(pin === 'rail' ? 'full' : 'rail') : undefined}
    />
  );
  const content = (
    <div className="flex min-w-0 flex-1 flex-col">
      {/* NOTE: no `container-type` here on purpose — it would make <main> a containing block for
          `position: fixed` descendants and re-anchor any non-portaled overlay (full-screen modals,
          context menus) to it. Content views scope their own `@container` around just the grid/list
          instead, keeping overlays outside it. */}
      <main className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain [scrollbar-gutter:stable]">
        {/* The measure the interface is read at. Without it the content is purely fluid, and every extra
            pixel of room — a wide monitor, or the CSS px the automatic zoom hands the layout when it
            scales down — goes into stretching the same table across a wider, emptier row. Capping it
            keeps a table's density tied to its type size instead of to the window. The heading rides
            inside the cap so it stays aligned with the content beneath it. */}
        {/* /chat opts out of the reading measure. It is not a document but an application layout — a
            conversation column with a telemetry rail docked beside it — and a centred cap leaves the rail
            floating short of the window edge with dead space behind it, which reads as a bug rather than
            as breathing room. Routes that ARE documents keep the cap. */}
        <div className={`mx-auto flex w-full flex-col ${onChat ? '' : CONTENT_MAX}`}>
          {/* Frameless page heading + global actions. In drawer mode it also opens mobile navigation. On
              /chat at phone width the whole global bar is suppressed: the conversation already carries its
              own bar, and stacking a second one above it (avatar, bell, search) crowds the small screen.
              The way back into the rest of the app moves into the history drawer's "← dashboard" link. */}
          {/* Suppressed by a CSS breakpoint rather than by the measured `mode`: `mode` follows the REGION
              (window − dock), so a docked desktop window could fall under DRAWER_MAX while the viewport
              stayed wide. The bar and its hamburger then vanished, while ChatView's replacement "back"
              link — keyed off the VIEWPORT — never appeared, stranding the reader on /chat with no way
              out. Being CSS it also holds from the first paint instead of flashing the bar before the
              first measurement resolves.
              The pixel value is deliberate and must stay in step with MOBILE_MAX_WIDTH (web/lib/useMobile.ts):
              Tailwind's own `md` is 48rem, so a reader whose browser font is not 16px would push the CSS
              boundary away from the pixel media query the hook runs — reopening exactly the gap with no
              bar and no back link that this suppression exists to avoid. */}
          <div className={onChat ? 'max-[767px]:hidden' : undefined}>
            <TopBar
              onMenuClick={mode === 'drawer' ? () => setDrawerOpen(true) : undefined}
              showLocation={false}
            />
          </div>
          <div className="px-2 pb-8"><RouteTransition>{children}</RouteTransition></div>
        </div>
      </main>
    </div>
  );

  // The single brain-chat controller lives here — ONE mount above both the route content and every
  // dock-side AdvisorPanel, so its SSE stream / transcript / draft survive dock open-close, the
  // Chat↔Terminál toggle and route changes. It is inert until the first chat open (lazy ensureAttached).
  // Deliberately inside ShellLayout only, never over ShellBody's chromeless /terminal/* branch.
  return (
    <BrainChatProvider>
      <div className="flex flex-col overflow-hidden" style={{ height: 'calc(100dvh / var(--ui-scale, 1))' }}>
        <ImpersonationBanner />
        {dockTop ? <AdvisorPanel dock={dock} /> : null}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {dockLeft ? <AdvisorPanel dock={dock} /> : null}
          {/* The sidebar + content region — the dock sits OUTSIDE it, so this width = window − dock. */}
          <div ref={regionRef} className="flex min-w-0 flex-1 overflow-hidden">
            {dockLeft ? <>{content}{navigation}</> : <>{navigation}{content}</>}
          </div>
          {docked && dock.state.side === 'right' ? <AdvisorPanel dock={dock} /> : null}
        </div>
        {dockBottom ? <AdvisorPanel dock={dock} /> : null}
      </div>
      <CommandPalette />
      {!docked && !onChat && <AdvisorLauncher onOpen={openAdvisor} />}
    </BrainChatProvider>
  );
}

/** Renders the full app chrome (sidebar + dock) for normal routes, but nothing but the page itself for
 *  the chromeless pop-out terminal window (`/terminal/*`) — still inside the providers + auth gate. */
function ShellBody({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (pathname?.startsWith('/terminal/')) return <>{children}</>;
  return <ShellLayout>{children}</ShellLayout>;
}

/** The toast provider bound to the operator's configured duration (Settings → Elowen AI → Runtime). It
 *  sits above the auth gate, where the config query 401s for a visitor who has not logged in yet — the
 *  same race every other child query runs — so an unresolved config simply leaves the default in force. */
function ConfiguredToastProvider({ children }: { children: ReactNode }) {
  const { data: config } = useConfig();
  return <ToastProvider durationMs={resolveToastDuration(config?.runtime?.limits)}>{children}</ToastProvider>;
}

export function Shell({ children, theme, pluginUiSeed, meSeed, sessionPresent = true, initialLocale }: { children: ReactNode; theme?: ThemePayload; pluginUiSeed?: PluginUiSeed | null; meSeed?: MeSeed | null; sessionPresent?: boolean; initialLocale?: Locale }) {
  return (
    <EffectsProvider>
      <Providers pluginUiSeed={pluginUiSeed} meSeed={meSeed}>
        <ThemeProvider>
        <UiScaleProvider>
        <LanguageProvider initialLocale={initialLocale}>
        <BrandProvider theme={theme ?? BUILTIN_THEME}>
        <ConfiguredToastProvider>
          <PageHeaderProvider>
            {/* One title owner for login and every authenticated route; terminal names itself. */}
            <DocumentTitle />
            <LoginGate initiallyAuthenticated={meSeed != null} sessionPresent={sessionPresent}>
              <ShellBody>{children}</ShellBody>
            </LoginGate>
          </PageHeaderProvider>
        </ConfiguredToastProvider>
        </BrandProvider>
        </LanguageProvider>
        </UiScaleProvider>
        </ThemeProvider>
      </Providers>
    </EffectsProvider>
  );
}
