'use client';
import type { ReactNode } from 'react';
import { Providers } from '../../app/providers';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

export function Shell({ children }: { children: ReactNode }) {
  return (
    <Providers>
      <div className="grid min-h-screen grid-cols-[12rem_1fr] max-md:grid-cols-1">
        <Sidebar />
        <div className="flex flex-col">
          <TopBar />
          <main className="flex-1 p-4">{children}</main>
        </div>
      </div>
    </Providers>
  );
}
