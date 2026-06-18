import './globals.css';
import { GeistMono } from 'geist/font/mono';
import type { ReactNode } from 'react';
import { Shell } from '../components/shell/Shell';
import { en } from '../lib/i18n/dictionaries/en';

export const metadata = { title: en.common.appName };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={GeistMono.variable} suppressHydrationWarning>
      <body><Shell>{children}</Shell></body>
    </html>
  );
}
