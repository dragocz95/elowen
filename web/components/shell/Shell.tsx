'use client';
import type { ReactNode } from 'react';
import { Providers } from '../../app/providers';
import { LanguageProvider } from '../../lib/i18n';
import { ToastProvider } from '../ui/Toast';
import { LoginGate } from '../auth/LoginGate';
import { Sidebar } from './Sidebar';
import { CommandPalette } from './CommandPalette';

export function Shell({ children }: { children: ReactNode }) {
  return (
    <Providers>
      <LanguageProvider>
      <ToastProvider>
        <LoginGate>
          <div className="flex h-screen overflow-hidden">
            <Sidebar />
            <main className="flex-1 overflow-y-auto p-4">{children}</main>
          </div>
          <CommandPalette />
        </LoginGate>
      </ToastProvider>
      </LanguageProvider>
    </Providers>
  );
}
