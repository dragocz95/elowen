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
  // Deliberately NOT persisted here. The docked panel already saves its own layout (and a collapsed panel
  // is just a layout), so a second stored flag would be a second answer to "how wide is the rail" — free
  // to disagree with the first after any drag. This is the live mirror of the panel's state: the panel
  // reports it on mount and on every resize, and a toggle here drives the panel back.
  const [collapsed, setCollapsed] = useState(false);
  // A drawer that reopened itself on every visit would be a nuisance rather than a setting, so the mobile
  // overlay is transient by design.
  const [mobileOpen, setMobileOpen] = useState(false);
  const [workflowId, setWorkflowId] = useState<string | null>(null);

  // The provider intentionally outlives route content so the desktop panel does not lose its live mirror,
  // but transient overlays belong to /chat. Leaving the route closes both; crossing to desktop also closes
  // the phone drawer so narrowing later cannot resurrect an overlay the user already left behind.
  useEffect(() => {
    if (pathname !== '/chat') {
      setMobileOpen(false);
      setWorkflowId(null);
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
