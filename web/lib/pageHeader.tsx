'use client';
import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { LucideIcon } from 'lucide-react';
import { useMobileViewport } from './useMobile';

/** The page title (+ optional count + icon) that the shell's frameless masthead shows. A page publishes
 *  it via <ModuleHeader>; route-owned controls may portal into the separate top-bar host below. */
export type PageHeader = { title?: string; count?: number; icon?: LucideIcon };

interface PageHeaderContextValue {
  header: PageHeader;
  setHeader: (header: PageHeader) => void;
  topBarHost: HTMLElement | null;
  setTopBarHost: (host: HTMLElement | null) => void;
}

const PageHeaderContext = createContext<PageHeaderContextValue | null>(null);

export function PageHeaderProvider({ children }: { children: ReactNode }) {
  const [header, setHeaderState] = useState<PageHeader>({});
  const [topBarHost, setTopBarHostState] = useState<HTMLElement | null>(null);
  const setHeader = useCallback((next: PageHeader) => setHeaderState(next), []);
  const setTopBarHost = useCallback((host: HTMLElement | null) => setTopBarHostState(host), []);
  // Memoized so the context value only changes identity when the header or portal host actually changes.
  // The host is a DOM node owned by TopBar; page-local controls portal into it without lifting their state.
  const value = useMemo(
    () => ({ header, setHeader, topBarHost, setTopBarHost }),
    [header, setHeader, topBarHost, setTopBarHost],
  );
  return <PageHeaderContext.Provider value={value}>{children}</PageHeaderContext.Provider>;
}

/** Null outside the provider (e.g. the chromeless terminal pop-out), so callers must optional-chain. */
export function usePageHeader() {
  return useContext(PageHeaderContext);
}

/** The shell-owned destination for route-specific controls inside the Studio top bar. */
export function PageTopBarHost({ className = '' }: { className?: string }) {
  const setTopBarHost = usePageHeader()?.setTopBarHost;
  return <div ref={setTopBarHost} data-testid="page-top-bar-host" className={className} />;
}

/** Keep page controls where their state lives, but paint them in the shell bar. Chat opts into a local
 * phone fallback because its global bar is intentionally hidden there; ordinary page tabs stay in it. */
export function PageTopBarPortal({ children, localOnPhone = false }: { children: ReactNode; localOnPhone?: boolean }) {
  const topBarHost = usePageHeader()?.topBarHost;
  const mobile = useMobileViewport();
  if (!topBarHost || (localOnPhone && mobile !== false)) return <>{children}</>;
  return createPortal(children, topBarHost);
}
