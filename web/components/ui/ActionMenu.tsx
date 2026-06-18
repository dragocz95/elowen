'use client';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Trash2, type LucideIcon } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';

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
export function ActionMenu({ items, label, trigger, align = 'right' }: {
  items: ActionMenuItem[];
  label?: string;
  trigger?: ReactNode;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { t } = useTranslation();
  const resolvedLabel = label ?? t.common.actions;

  const cancelClose = () => { if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; } };
  const scheduleClose = () => { cancelClose(); closeTimer.current = setTimeout(() => setOpen(false), 160); };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  useEffect(() => () => cancelClose(), []);

  return (
    <div
      ref={ref}
      className="relative"
      onMouseEnter={() => { cancelClose(); setOpen(true); }}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        aria-label={resolvedLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        title={resolvedLabel}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-danger/60 text-danger transition-colors hover:bg-danger hover:text-white"
        style={{ transitionDuration: 'var(--motion-fast)' }}
      >
        {trigger ?? <Trash2 size={15} aria-hidden />}
      </button>
      {open && (
        <div
          role="menu"
          // top-full (no margin gap) keeps the hover path continuous from trigger to items
          className={`absolute top-full z-50 min-w-[12rem] overflow-hidden rounded-lg border border-border bg-surface py-1.5 ${align === 'right' ? 'right-0' : 'left-0'}`}
          style={{ boxShadow: 'var(--shadow-raised)' }}
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
        </div>
      )}
    </div>
  );
}
