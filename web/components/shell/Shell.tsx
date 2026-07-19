'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { BRAIN_COMPOSE_EVENT, BRAIN_OPEN_EVENT } from '../../lib/brainDock';
import { Providers } from '../../app/providers';
import { LanguageProvider } from '../../lib/i18n';
import { ToastProvider } from '../ui/Toast';
import { LoginGate } from '../auth/LoginGate';
import { Sidebar, type SidebarMode } from './Sidebar';
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
import { EffectsProvider } from '../../lib/useEffects';

/** Below this many px of room for the sidebar+content region the sidebar becomes a hamburger drawer
 *  (real phones, or a dock dragged nearly full-width); below the next it auto-collapses to an icon rail
 *  so the content keeps usable room; above it the user's own pin decides. Driven by the MEASURED region
 *  width (window − dock), not the viewport — so dragging the dock adapts the chrome just like resizing. */
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
export function resolveNav(regionW: number, pin: NavPin): { mode: SidebarMode; pinnable: boolean } {
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
  // Open (and reveal the advisor pane of) the dock when another view asks to continue a conversation in
  // web chat (Sessions → open in chat). BrainChat mounts on open and switches to the requested session.
  useEffect(() => {
    const onOpen = () => { dock.addAdvisorPane(); dock.setOpen(true); };
    window.addEventListener(BRAIN_OPEN_EVENT, onOpen);
    window.addEventListener(BRAIN_COMPOSE_EVENT, onOpen);
    return () => {
      window.removeEventListener(BRAIN_OPEN_EVENT, onOpen);
      window.removeEventListener(BRAIN_COMPOSE_EVENT, onOpen);
    };
  }, [dock]);
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

  const navigation = mode === 'drawer'
    ? <Sidebar mode="drawer" drawerOpen={drawerOpen} onDrawerClose={() => setDrawerOpen(false)} side={dockLeft ? 'right' : 'left'} />
    : <OrbitalNav
        compact={mode === 'rail'}
        side={dockLeft ? 'right' : 'left'}
        onToggleCollapse={pinnable ? () => setPin(pin === 'rail' ? 'full' : 'rail') : undefined}
      />;
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
        <div className={`mx-auto flex w-full flex-col ${CONTENT_MAX}`}>
          {/* Frameless page heading + global actions. In drawer mode it also opens mobile navigation. */}
          <TopBar
            onMenuClick={mode === 'drawer' ? () => setDrawerOpen(true) : undefined}
            showLocation={false}
          />
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
      {!docked && !onChat && <AdvisorLauncher onOpen={() => dock.setOpen(true)} />}
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

export function Shell({ children }: { children: ReactNode }) {
  return (
    <EffectsProvider>
      <Providers>
        <ThemeProvider>
        <UiScaleProvider>
        <LanguageProvider>
        <ToastProvider>
          <PageHeaderProvider>
            <LoginGate>
              <ShellBody>{children}</ShellBody>
            </LoginGate>
          </PageHeaderProvider>
        </ToastProvider>
        </LanguageProvider>
        </UiScaleProvider>
        </ThemeProvider>
      </Providers>
    </EffectsProvider>
  );
}
