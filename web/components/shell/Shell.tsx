'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
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
  const [barHidden, setBarHidden] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const lastY = useRef(0);

  // Mobile top bar auto-hides on scroll down, reappears on scroll up (or near the top).
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const onScroll = () => {
      const y = el.scrollTop;
      if (y < 8) { setBarHidden(false); lastY.current = y; return; }
      const dy = y - lastY.current;
      if (Math.abs(dy) < 8) return;
      setBarHidden(dy > 0);
      lastY.current = y;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <>
      <div className="flex h-screen overflow-hidden">
        <Sidebar mobileOpen={drawerOpen} onMobileClose={() => setDrawerOpen(false)} />
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Mobile top bar — sidebar drawer trigger; collapses away as you scroll down */}
          <div className={`shrink-0 overflow-hidden transition-[height] duration-200 md:hidden ${barHidden ? 'h-0' : 'h-12'}`} style={{ transitionTimingFunction: 'var(--ease-out)' }}>
            <div className="flex h-12 items-center gap-2 border-b border-border bg-surface px-3">
              <button type="button" onClick={() => setDrawerOpen(true)} aria-label={t.common.toggleSidebar} className="flex h-9 w-9 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text">
                <Menu size={20} aria-hidden />
              </button>
              <img src="/orca-logo.png" alt={t.common.appName} className="h-7 w-auto" />
            </div>
          </div>
          <main ref={mainRef} className="flex-1 overflow-y-auto overflow-x-hidden p-4">{children}</main>
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
