'use client';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trash2, type LucideIcon } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { uiZoom } from '../../lib/uiZoom';

export interface ActionMenuItem {
  label: string;
  icon?: LucideIcon;
  tone?: 'default' | 'danger';
  onSelect: () => void;
}

/**
 * Global hover/click action menu. Opens on hover (and click for touch), and stays
 * open while the pointer is over the trigger OR the menu — a small close delay plus
 * a gapless dropdown means moving down onto an item never dismisses it early.
 * Default trigger is a red trash icon. Reusable across destructive/contextual actions.
 */
export function ActionMenu({ items, label, trigger, triggerClassName, align = 'right' }: {
  items: ActionMenuItem[];
  label?: string;
  trigger?: ReactNode;
  /** Override the trigger button styling. Defaults to the red destructive-action look. */
  triggerClassName?: string;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { t } = useTranslation();
  const resolvedLabel = label ?? t.common.actions;

  // Portalled to <body> + fixed-positioned from the trigger rect so the dropdown escapes the
  // card's stacking context / overflow — otherwise a sibling card below paints over it.
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number } | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const place = useCallback(() => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // The UI-scale feature puts `zoom: z` on <html>. This menu is portalled into <body> (inside that
    // zoom) and fixed-positioned, so its CSS px render at z×. getBoundingClientRect already returns
    // zoomed (visual) viewport coords, so divide them by z to land the menu under the trigger instead
    // of flinging it off to the side. window.innerWidth is the unzoomed layout width → left as-is.
    const z = uiZoom();
    setPos(align === 'right'
      ? { top: r.bottom / z, right: window.innerWidth - r.right / z }
      : { top: r.bottom / z, left: r.left / z });
  }, [align]);

  const cancelClose = () => { if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; } };
  const scheduleClose = () => { cancelClose(); closeTimer.current = setTimeout(() => setOpen(false), 160); };
  const openMenu = () => { cancelClose(); place(); setOpen(true); };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      if (menuRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const reposition = () => place();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, place]);

  useEffect(() => () => cancelClose(), []);

  return (
    <div
      ref={ref}
      className="relative"
      onMouseEnter={openMenu}
      onMouseLeave={scheduleClose}
    >
      <button
        ref={btnRef}
        type="button"
        aria-label={resolvedLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        title={resolvedLabel}
        onClick={() => (open ? setOpen(false) : openMenu())}
        className={triggerClassName ?? 'inline-flex h-8 w-8 items-center justify-center rounded-md border border-danger/60 text-danger transition-colors hover:bg-danger hover:text-white'}
        style={{ transitionDuration: 'var(--motion-fast)' }}
      >
        {trigger ?? <Trash2 size={15} aria-hidden />}
      </button>
      {mounted && open && pos && createPortal(
        <div
          ref={menuRef}
          role="menu"
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          className="fixed z-[61] min-w-[12rem] overflow-hidden rounded-lg border border-border bg-surface py-1.5"
          style={{ top: pos.top, left: pos.left, right: pos.right, boxShadow: 'var(--shadow-raised)' }}
        >
          {items.map((it) => {
            const Icon = it.icon;
            const danger = it.tone === 'danger';
            return (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                onClick={() => { setOpen(false); it.onSelect(); }}
                className={`flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-sm transition-colors ${danger ? 'text-danger hover:bg-danger hover:text-white' : 'text-text hover:bg-elevated'}`}
                style={{ transitionDuration: 'var(--motion-fast)' }}
              >
                {Icon ? <Icon size={15} aria-hidden /> : null}
                {it.label}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
