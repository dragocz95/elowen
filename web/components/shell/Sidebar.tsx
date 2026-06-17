'use client';
import { usePathname } from 'next/navigation';
import { ChevronLeft, ChevronRight, Circle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { modulesByGroup } from '../../modules/registry';
import { useSidebarState } from '../../lib/useSidebarState';
import { useHealth } from '../../lib/queries';
import { NavGroup } from './NavGroup';

export function Sidebar() {
  const pathname = usePathname();
  const { collapsed, width, toggle, setWidth } = useSidebarState();
  const { data } = useHealth();
  const up = data?.ok === true;
  const dragging = useRef(false);

  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    setMobile(mq.matches);
    const handler = (e: MediaQueryListEvent) => setMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const effectiveCollapsed = collapsed || mobile;

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
      style={{ width: effectiveCollapsed ? 56 : width }}
    >
      <div className="flex items-center justify-center border-b border-border px-3 py-3">
        <span className="font-bold tracking-tight text-text">{effectiveCollapsed ? 'O' : 'Orca'}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {modulesByGroup().map((g) => (
          <NavGroup
            key={g.group}
            group={{ label: g.group, items: g.items.map((m) => ({ href: m.route, label: m.label, icon: m.icon })) }}
            pathname={pathname}
            collapsed={effectiveCollapsed}
          />
        ))}
      </div>

      <div className="flex items-center gap-2 border-t border-border px-3 py-2">
        <span role="status" aria-label={up ? 'daemon up' : 'daemon down'}>
          <Circle size={8} className={up ? 'text-accent fill-accent' : 'text-text-muted fill-text-muted'} aria-hidden />
        </span>
        {!effectiveCollapsed && <span className="font-mono text-[10px] uppercase tracking-wide text-text-muted">daemon</span>}
      </div>

      <button
        type="button"
        aria-label="Toggle sidebar"
        onClick={toggle}
        className="absolute -right-3 top-1/2 z-10 flex h-6 w-6 -translate-y-1/2 items-center justify-center border border-border bg-elevated text-text-muted hover:text-text"
      >
        {effectiveCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
      </button>

      {!effectiveCollapsed && (
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
