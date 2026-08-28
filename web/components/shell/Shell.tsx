'use client';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { BRAIN_COMPOSE_EVENT, BRAIN_OPEN_EVENT, advisorOpenTarget } from '../../lib/brainDock';
import { useMobileViewport } from '../../lib/useMobile';
import { NAV_COLUMN_MIN_WIDTH, NAV_FULL_MIN_WIDTH } from '../../lib/breakpoints';
import { Providers, type PluginUiSeed, type MeSeed } from '../../app/providers';
import { LanguageProvider, type Locale } from '../../lib/i18n';
import { SkinProvider, useSkin } from '../../lib/skinContext';
import { shellProfileFor, type SkinChoice, type SkinName } from '../../lib/skins';
import { BrandProvider, BUILTIN_THEME, type ThemePayload } from '../../lib/brand';
import { ToastProvider, resolveToastDuration } from '../ui/Toast';
import { useConfig } from '../../lib/queries';
import { LoginGate } from '../auth/LoginGate';
import { OrbitalNav } from './OrbitalNav';
import { StudioNavigation } from './StudioNavigation';
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

/** The measure the interface is read at: `--content-max` (web/app/styles/tokens.css) is the single
 *  authority on how wide a document column may grow, so a skin can retune the reading measure without
 *  touching a component. */
const CONTENT_MAX = 'max-w-[var(--content-max)]';

/** What the user pinned the navigation to, when the window is roomy enough to leave them the choice. */
type NavPin = 'full' | 'rail';
const NAV_PINS: readonly NavPin[] = ['full', 'rail'];

/** The width sets a FLOOR on how compact the chrome is; the user's pin may only go compacter, never
 *  roomier. So the collapse handle is offered exactly when the pin is what decides — in a window already
 *  too narrow for the full rail, a toggle would be a dead control, and before the first measurement
 *  (`regionW === 0`) there is nothing to decide yet.
 *
 *  `regionW` is the MEASURED width of the nav+content region (window − advisor dock), in the same CSS
 *  pixels the stylesheet's media queries and `useMobileViewport()` read — see lib/breakpoints.ts. Using
 *  the region rather than the viewport is what lets dragging the dock re-chrome the app like a resize. */
export function resolveNav(regionW: number, pin: NavPin): { mode: NavMode; pinnable: boolean } {
  if (regionW === 0) return { mode: 'full', pinnable: false };
  if (regionW < NAV_COLUMN_MIN_WIDTH) return { mode: 'drawer', pinnable: false };
  if (regionW < NAV_FULL_MIN_WIDTH) return { mode: 'rail', pinnable: false };
  return { mode: pin, pinnable: true };
}

/** What both navigations take, so the seam below is a straight swap and the shell cannot hand one of them
 *  a state the other never sees. */
interface ShellNavProps {
  compact: boolean;
  side: 'left' | 'right';
  drawer: boolean;
  drawerOpen: boolean;
  onDrawerClose: () => void;
  onToggleCollapse?: () => void;
}

function ShellLayout({ children }: { children: ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Which navigation the active DESIGN asks for. Read from the skin the document is wearing, not from the
  // account's stored choice: an operator who sets ELOWEN_SKIN without offering it in the allow-list gives
  // everyone that design with nothing chosen, and reading the choice would then mount the spatial rail
  // inside the Studio stylesheet.
  const { skin } = useSkin();
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
  // Whether the floating advisor launcher is on screen. Both the launcher itself and the bottom
  // clearance the page keeps for it read this ONE flag, so a page can never reserve the corner for a
  // control that is not there, nor run its last row under one that is.
  const launcherVisible = !docked && !onChat;

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

  // One menu at every width. A phone gets the same menu, in its full labelled form, slid in over the
  // content; wider windows give it a column of its own. Collapsing is offered only where the pin is
  // what decides, and never in the drawer, where there is no column to narrow.
  const navProps: ShellNavProps = {
    compact: mode === 'rail',
    side: dockLeft ? 'right' : 'left',
    drawer: mode === 'drawer',
    drawerOpen,
    onDrawerClose: () => setDrawerOpen(false),
    onToggleCollapse: pinnable ? () => setPin(pin === 'rail' ? 'full' : 'rail') : undefined,
  };
  // THE ONLY THING A SHELL PROFILE SWAPS. Everything else below — the brain-chat provider, the viewport
  // box, <main> and its scroll position, the route content, the command palette, the advisor launcher —
  // is owned by this one component and mounts exactly once, whatever design is on.
  //
  // Branching any higher up (`{studio ? <StudioLayout/> : <ShellLayout/>}`) would make React see two
  // different component types and unmount that whole subtree on a skin switch. The cost is not cosmetic:
  // BrainChatProvider exists to be ONE mount above the route content and every advisor panel, so its SSE
  // stream, transcript and composer draft survive dock toggles and route changes — remounting it drops a
  // live conversation, along with the scroll position, any open modal and every in-flight form on the
  // page. The two navigations therefore take the same props from the same state, and the swapped subtree
  // holds nothing but its own disposable presentation state.
  const navigation = shellProfileFor(skin) === 'command'
    ? <StudioNavigation {...navProps} />
    : <OrbitalNav {...navProps} />;
  const content = (
    <div className="flex min-w-0 flex-1 flex-col">
      {/* NOTE: no `container-type` here on purpose — it would make <main> a containing block for
          `position: fixed` descendants and re-anchor any non-portaled overlay (full-screen modals,
          context menus) to it. Content views scope their own `@container` around just the grid/list
          instead, keeping overlays outside it. */}
      <main className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain [scrollbar-gutter:stable]">
        {/* The measure the interface is read at. Without it the content is purely fluid and every extra
            pixel of a wide monitor goes into stretching the same table across a wider, emptier row.
            Capping it keeps a table's density tied to its type size instead of to the window. The
            heading rides inside the cap so it stays aligned with the content beneath it. */}
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
              The pixel value is deliberate and must stay in step with PHONE_MAX_WIDTH (web/lib/breakpoints.ts);
              it is spelled out rather than interpolated because Tailwind scans class names statically.
              It is a px query, not `md:`, for the same reason the hook is: Tailwind's `md` is 48rem, so a
              reader whose browser font is not 16px would push the CSS boundary away from the pixel media
              query the hook runs — reopening exactly the gap with no bar and no back link that this
              suppression exists to avoid. */}
          <div className={onChat ? 'max-[767px]:hidden' : undefined}>
            <TopBar
              onMenuClick={mode === 'drawer' ? () => setDrawerOpen(true) : undefined}
              showLocation={false}
            />
          </div>
          {/* The launcher floats over the bottom-right corner of this scroller, so the last thing on a
              page must not end underneath it. The clearance is the same `--fab-clearance` the toast dock
              composes (styles/components/primitives.css), and it is spent only while the launcher is
              actually mounted — the condition below is the same one that renders it. */}
          <div className="px-2" style={{ paddingBottom: launcherVisible ? 'var(--fab-clearance)' : '2rem' }}>
            <RouteTransition>{children}</RouteTransition>
          </div>
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
      {/* The app shell is exactly one viewport tall, and `dvh` so a phone's collapsing URL bar does not
          leave a dead strip. The division survives because the Account UI-scale preference still puts a
          `zoom` on <html>: a `100dvh` box under `zoom: z` renders at z×viewport, so filling the screen
          means asking for `100dvh / z`. At the default scale of 1 it is plain `100dvh`. */}
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
      {launcherVisible && <AdvisorLauncher onOpen={openAdvisor} />}
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

export function Shell({ children, theme, pluginUiSeed, meSeed, sessionPresent = true, initialLocale, skinSeed }: { children: ReactNode; theme?: ThemePayload; pluginUiSeed?: PluginUiSeed | null; meSeed?: MeSeed | null; sessionPresent?: boolean; initialLocale?: Locale; skinSeed?: { choice: SkinChoice | null; allowed: SkinChoice[]; fallback: SkinName | null } }) {
  return (
    <EffectsProvider>
      <Providers pluginUiSeed={pluginUiSeed} meSeed={meSeed}>
        <ThemeProvider>
        <UiScaleProvider>
        <LanguageProvider initialLocale={initialLocale}>
          <SkinProvider initialChoice={skinSeed?.choice ?? null} allowedSkins={skinSeed?.allowed} fallback={skinSeed?.fallback ?? null}>
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
          </SkinProvider>
        </LanguageProvider>
        </UiScaleProvider>
        </ThemeProvider>
      </Providers>
    </EffectsProvider>
  );
}
