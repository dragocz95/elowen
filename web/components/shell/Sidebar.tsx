'use client';
import { usePathname } from 'next/navigation';
import { ChevronLeft, ChevronRight, Circle } from 'lucide-react';
import { useCallback, useRef } from 'react';
import { NAV_GROUPS } from '../../lib/nav';
import { useSidebarState } from '../../lib/useSidebarState';
import { useHealth } from '../../lib/queries';
import { NavGroup } from './NavGroup';

export function Sidebar() {
  const pathname = usePathname();
  const { collapsed, width, toggle, setWidth } = useSidebarState();
  const { data } = useHealth();
  const up = data?.ok === true;
  const dragging = useRef(false);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true;
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }, []);
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (dragging.current) setWidth(e.clientX);
  }, [setWidth]);
  const onPointerUp = useCallback((e: React.PointerEvent) => {
    dragging.current = false;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  }, []);

  return (
    <nav
      aria-label="Primary"
      className="relative flex h-full flex-col border-r border-border bg-surface"
      style={{ width: collapsed ? 56 : width }}
    >
      <div className="flex items-center justify-center border-b border-border px-3 py-3">
        <span className="font-bold tracking-tight text-text">{collapsed ? 'O' : 'Orca'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {NAV_GROUPS.map((g) => <NavGroup key={g.label} group={g} pathname={pathname} collapsed={collapsed} />)}
      </div>

      <div className="flex items-center gap-2 border-t border-border px-3 py-2">
        <Circle size={8} className={up ? 'text-accent fill-accent' : 'text-text-muted fill-text-muted'} aria-label={up ? 'daemon up' : 'daemon down'} />
        {!collapsed && <span className="font-mono text-[10px] uppercase tracking-wide text-text-muted">daemon</span>}
      </div>

      <button
        type="button"
        aria-label="Toggle sidebar"
        onClick={toggle}
        className="absolute -right-3 top-1/2 z-10 flex h-6 w-6 -translate-y-1/2 items-center justify-center border border-border bg-elevated text-text-muted hover:text-text"
      >
        {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
      </button>

      {!collapsed && (
        <div
          data-testid="sidebar-resize"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onDoubleClick={() => setWidth(224)}
          className="absolute right-0 top-0 h-full w-1 cursor-col-resize"
        />
      )}
    </nav>
  );
}
