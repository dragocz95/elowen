'use client';
import { useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { Menu } from 'lucide-react';
import { Providers } from '../../app/providers';
import { LanguageProvider, useTranslation } from '../../lib/i18n';
import { ToastProvider } from '../ui/Toast';
import { LoginGate } from '../auth/LoginGate';
import { Sidebar } from './Sidebar';
import { CommandPalette } from './CommandPalette';
import { AdvisorPanel } from '../../modules/advisor/AdvisorPanel';
import { AdvisorLauncher } from '../../modules/advisor/AdvisorLauncher';
import { useDockState } from '../../lib/useDockState';
import { UiScaleProvider } from '../../lib/useUiScale';

function ShellLayout({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const dock = useDockState();
  const docked = dock.state.open;
  // When the dock takes the left edge, the sidebar moves to the right edge (mirrored) so the two
  // never stack on the same side.
  const dockLeft = docked && dock.state.side === 'left';
  const sidebar = (
    <Sidebar mobileOpen={drawerOpen} onMobileClose={() => setDrawerOpen(false)} side={dockLeft ? 'right' : 'left'} />
  );

  return (
    <>
      <div className="flex h-dvh overflow-hidden">
        {dockLeft ? <AdvisorPanel dock={dock} /> : sidebar}
        <div className="flex min-w-0 flex-1 flex-col">
          <main className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain">
            {/* Mobile top bar — sits at the top of the page and scrolls away with content */}
            <div className="flex h-12 items-center gap-2 border-b border-border bg-surface px-3 md:hidden">
              <button type="button" onClick={() => setDrawerOpen(true)} aria-label={t.common.toggleSidebar} className="flex h-9 w-9 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text">
                <Menu size={20} aria-hidden />
              </button>
              <img src="/orca-logo.png" alt={t.common.appName} className="h-7 w-auto" />
            </div>
            <div className="p-4">{children}</div>
          </main>
        </div>
        {dockLeft ? sidebar : (docked && dock.state.side === 'right' && <AdvisorPanel dock={dock} />)}
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
      <UiScaleProvider>
      <LanguageProvider>
      <ToastProvider>
        <LoginGate>
          <ShellBody>{children}</ShellBody>
        </LoginGate>
      </ToastProvider>
      </LanguageProvider>
      </UiScaleProvider>
    </Providers>
  );
}
