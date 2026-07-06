'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { BRAIN_OPEN_EVENT } from '../../lib/brainDock';
import { Providers } from '../../app/providers';
import { LanguageProvider } from '../../lib/i18n';
import { ToastProvider } from '../ui/Toast';
import { LoginGate } from '../auth/LoginGate';
import { Sidebar, type SidebarMode } from './Sidebar';
import { TopBar } from './TopBar';
import { CommandPalette } from './CommandPalette';
import { AdvisorPanel } from '../../modules/advisor/AdvisorPanel';
import { AdvisorLauncher } from '../../modules/advisor/AdvisorLauncher';
import { ImpersonationBanner } from './ImpersonationBanner';
import { useDockState } from '../../lib/useDockState';
import { useElementWidth } from '../../lib/useElementWidth';
import { UiScaleProvider } from '../../lib/useUiScale';
import { ThemeProvider } from '../../lib/useTheme';
import { PageHeaderProvider } from '../../lib/pageHeader';

/** Below this many px of room for the sidebar+content region the sidebar becomes a hamburger drawer
 *  (real phones, or a dock dragged nearly full-width); below the next it auto-collapses to an icon rail
 *  so the content keeps usable room; above it the user's own pin decides. Driven by the MEASURED region
 *  width (window − dock), not the viewport — so dragging the dock adapts the chrome just like resizing. */
const DRAWER_MAX = 720;
const RAIL_MAX = 1000;

function ShellLayout({ children }: { children: ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const dock = useDockState();
  const docked = dock.state.open;
  // Open (and reveal the advisor pane of) the dock when another view asks to continue a conversation in
  // web chat (Sessions → open in chat). BrainChat mounts on open and switches to the requested session.
  useEffect(() => {
    const onOpen = () => { dock.addAdvisorPane(); dock.setOpen(true); };
    window.addEventListener(BRAIN_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(BRAIN_OPEN_EVENT, onOpen);
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
  const mode: SidebarMode = regionW === 0 ? 'full' : regionW < DRAWER_MAX ? 'drawer' : regionW < RAIL_MAX ? 'rail' : 'full';

  const sidebar = (
    <Sidebar mode={mode} drawerOpen={drawerOpen} onDrawerClose={() => setDrawerOpen(false)} side={dockLeft ? 'right' : 'left'} />
  );
  const content = (
    <div className="flex min-w-0 flex-1 flex-col">
      {/* NOTE: no `container-type` here on purpose — it would make <main> a containing block for
          `position: fixed` descendants and re-anchor any non-portaled overlay (full-screen modals,
          context menus) to it. Content views scope their own `@container` around just the grid/list
          instead, keeping overlays outside it. */}
      <main className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain [scrollbar-gutter:stable]">
        {/* Global top bar: breadcrumb + account/bell/theme/language. In drawer mode it also carries the
            hamburger that opens the off-canvas sidebar. */}
        <TopBar onMenuClick={mode === 'drawer' ? () => setDrawerOpen(true) : undefined} />
        <div className="p-4">{children}</div>
      </main>
    </div>
  );

  return (
    <>
      <div className="flex flex-col overflow-hidden" style={{ height: 'calc(100dvh / var(--ui-scale, 1))' }}>
        <ImpersonationBanner />
        {dockTop ? <AdvisorPanel dock={dock} /> : null}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {dockLeft ? <AdvisorPanel dock={dock} /> : null}
          {/* The sidebar + content region — the dock sits OUTSIDE it, so this width = window − dock. */}
          <div ref={regionRef} className="flex min-w-0 flex-1 overflow-hidden">
            {dockLeft ? <>{content}{sidebar}</> : <>{sidebar}{content}</>}
          </div>
          {docked && dock.state.side === 'right' ? <AdvisorPanel dock={dock} /> : null}
        </div>
        {dockBottom ? <AdvisorPanel dock={dock} /> : null}
      </div>
      <CommandPalette />
      {!docked && <AdvisorLauncher onOpen={() => dock.setOpen(true)} />}
    </>
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
  );
}
