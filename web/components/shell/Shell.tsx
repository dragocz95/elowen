'use client';
import { useState, type ReactNode } from 'react';
import { Menu } from 'lucide-react';
import { Providers } from '../../app/providers';
import { LanguageProvider, useTranslation } from '../../lib/i18n';
import { ToastProvider } from '../ui/Toast';
import { LoginGate } from '../auth/LoginGate';
import { Sidebar } from './Sidebar';
import { CommandPalette } from './CommandPalette';

function ShellLayout({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  return (
    <>
      <div className="flex h-screen overflow-hidden">
        <Sidebar mobileOpen={drawerOpen} onMobileClose={() => setDrawerOpen(false)} />
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Mobile top bar — the sidebar is a click-to-open drawer below md */}
          <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2 md:hidden">
            <button type="button" onClick={() => setDrawerOpen(true)} aria-label={t.common.toggleSidebar} className="flex h-9 w-9 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text">
              <Menu size={20} aria-hidden />
            </button>
            <img src="/orca-logo.png" alt={t.common.appName} className="h-7 w-auto" />
          </div>
          <main className="flex-1 overflow-y-auto p-4">{children}</main>
        </div>
      </div>
      <CommandPalette />
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
