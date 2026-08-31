'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { useMobileViewport } from '../../lib/useMobile';

interface TelemetryRailState {
  /** Desktop: the rail is in its collapsed stub. */
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  toggleCollapsed: () => void;
  /** Mobile: the full-screen overlay is open. */
  mobileOpen: boolean;
  setMobileOpen: (open: boolean) => void;
  /** The workflow whose DAG is open, raised from a rail row and rendered by the chat host. */
  workflowId: string | null;
  openWorkflow: (id: string) => void;
  closeWorkflow: () => void;
}

const Ctx = createContext<TelemetryRailState | null>(null);

/** Shared state for the chat telemetry rail.
 *
 *  It exists because the redesign split the rail's CONTROLS from the rail's GEOMETRY: the collapse toggle
 *  lives in the conversation's own header (`BrainChatSurface`, inside the content panel) while the panel it
 *  toggles is a sibling of that panel, owned by the shell. Passing a callback down would mean threading it
 *  through the whole chat subtree; a context keeps the two ends addressing one state.
 *
 *  The drill-in workflow id rides along for the same reason in reverse: the rail raises it, but the DAG
 *  modal belongs to the chat page, which is no longer the rail's parent. */
export function TelemetryRailProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const mobile = useMobileViewport();
  // Desktop telemetry is an ambient instrument strip, not a dashboard that should claim 340px on arrival.
  // Expansion is transient: a fresh provider and every new visit to /chat start compact, while the panel's
  // resize callback remains the live source of truth during the visit.
  const [collapsed, setCollapsed] = useState(true);
  // A drawer that reopened itself on every visit would be a nuisance rather than a setting, so the mobile
  // overlay is transient by design.
  const [mobileOpen, setMobileOpen] = useState(false);
  const [workflowId, setWorkflowId] = useState<string | null>(null);

  // The provider intentionally outlives route content, but every transient chat surface belongs to the
  // current visit. Leaving /chat resets the desktop rail to compact and closes its overlays. Entering a phone
  // viewport does the same for the hidden desktop dock, so widening later cannot resurrect an old expansion.
  useEffect(() => {
    if (pathname !== '/chat') {
      setCollapsed(true);
      setMobileOpen(false);
      setWorkflowId(null);
    } else if (mobile === true) {
      setCollapsed(true);
    } else if (mobile === false) {
      setMobileOpen(false);
    }
  }, [mobile, pathname]);

  const toggleCollapsed = useCallback(() => setCollapsed((value) => !value), []);
  // Opening a DAG dismisses the mobile overlay: on a phone the modal would otherwise open behind the
  // sheet that raised it.
  const openWorkflow = useCallback((id: string) => { setMobileOpen(false); setWorkflowId(id); }, []);
  const closeWorkflow = useCallback(() => setWorkflowId(null), []);

  const value = useMemo<TelemetryRailState>(() => ({
    collapsed,
    setCollapsed,
    toggleCollapsed,
    mobileOpen,
    setMobileOpen,
    workflowId,
    openWorkflow,
    closeWorkflow,
  }), [collapsed, toggleCollapsed, mobileOpen, workflowId, openWorkflow, closeWorkflow]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The rail state, or `null` outside a chat shell. Nullable rather than throwing: the telemetry panel is
 *  also rendered standalone (settings previews, focused tests) where there is no chat host to provide it,
 *  and a hard requirement there would turn a presentational mount into a crash. */
export function useTelemetryRail(): TelemetryRailState | null {
  return useContext(Ctx);
}
