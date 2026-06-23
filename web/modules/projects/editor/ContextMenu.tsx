'use client';
import { useEffect, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { uiZoom } from '../../../lib/uiZoom';

interface MenuItem {
  label: string;
  icon?: LucideIcon;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}
/** A divider between groups. */
export const DIVIDER = 'divider' as const;
export type MenuEntry = MenuItem | typeof DIVIDER;

export interface ContextMenuState { x: number; y: number; items: MenuEntry[] }

/** A floating right-click menu (OLED styled). Closes on outside click, Esc, scroll, or after an
 *  item runs. Position is clamped so the menu never overflows the viewport. */
export function ContextMenu({ state, onClose }: { state: ContextMenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // state.x/y are MouseEvent.clientX/Y from the right-click — zoomed (visual) viewport coords. This menu
  // is fixed-positioned inside the UI-scale `zoom`, so divide by z (and the rect width/height likewise)
  // or it lands away from the cursor at any scale ≠ 100%. uiZoom() is 1 at normal scale (no-op).
  const [pos, setPos] = useState(() => { const z = uiZoom(); return { x: state.x / z, y: state.y / z }; });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const z = uiZoom();
    const { width, height } = el.getBoundingClientRect();
    setPos({
      x: Math.min(state.x / z, window.innerWidth - width / z - 8),
      y: Math.min(state.y / z, window.innerHeight - height / z - 8),
    });
  }, [state.x, state.y]);

  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    // Defer the outside-click listener a tick so the opening right-click doesn't instantly close it.
    const id = window.setTimeout(() => window.addEventListener('mousedown', close), 0);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    return () => { window.clearTimeout(id); window.removeEventListener('mousedown', close); window.removeEventListener('keydown', onKey); window.removeEventListener('resize', close); };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      onMouseDown={(e) => e.stopPropagation()}
      className="fixed z-50 min-w-44 overflow-hidden rounded-lg border border-border bg-elevated py-1 text-xs text-text"
      style={{ left: pos.x, top: pos.y, boxShadow: 'var(--shadow-card)' }}
    >
      {state.items.map((item, i) => {
        if (item === DIVIDER) return <div key={`d${i}`} className="my-1 h-px bg-border" aria-hidden />;
        const Icon = item.icon;
        return (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => { item.onClick(); onClose(); }}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${item.danger ? 'text-danger hover:bg-danger/10' : 'hover:bg-surface'}`}
          >
            {Icon ? <Icon size={13} className="shrink-0" aria-hidden /> : <span className="w-[13px]" aria-hidden />}
            <span className="truncate">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
