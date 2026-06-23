'use client';
import { useState, type ReactNode } from 'react';
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

function ShellLayout({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const dock = useDockState();
  const docked = dock.state.open;

  return (
    <>
      <div className="flex h-dvh overflow-hidden">
        <Sidebar mobileOpen={drawerOpen} onMobileClose={() => setDrawerOpen(false)} />
        {docked && dock.state.side === 'left' && <AdvisorPanel dock={dock} />}
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
        {docked && dock.state.side === 'right' && <AdvisorPanel dock={dock} />}
      </div>
      <CommandPalette />
      {!docked && <AdvisorLauncher onOpen={() => dock.setOpen(true)} />}
    </>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  return (
    <Providers>
      <LanguageProvider>
      <ToastProvider>
        <LoginGate>
          <ShellLayout>{children}</ShellLayout>
        </LoginGate>
      </ToastProvider>
      </LanguageProvider>
    </Providers>
  );
}
