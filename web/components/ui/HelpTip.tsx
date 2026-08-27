'use client';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { HelpCircle } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';

// Grace period before the tooltip closes, so a pointer that clips the gutter on its way past the trigger
// doesn't make it flicker.
const CLOSE_DELAY_MS = 120;

/** A small "?" that reveals a custom tooltip on hover/focus. For inline field help. */
export function HelpTip({ children, align = 'right' }: { children: ReactNode; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { t } = useTranslation();

  const cancelClose = () => {
    if (closeTimer.current !== null) { clearTimeout(closeTimer.current); closeTimer.current = null; }
  };
  const show = () => { cancelClose(); setOpen(true); };
  // Debounced so hovering off the trigger and onto the portaled body (or vice versa) doesn't close it.
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => { closeTimer.current = null; setOpen(false); }, CLOSE_DELAY_MS);
  };

  useLayoutEffect(() => {
    if (!open) { setPosition(null); return; }
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = 256;
      const gutter = 8;
      const edge = 12;
      const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
      const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
      const roomLeft = rect.left - gutter - edge >= width;
      const roomRight = viewportWidth - rect.right - gutter - edge >= width;
      // The existing right alignment opens to the left of the trigger. Flip only when it would hit
      // the viewport edge; explicit left alignment keeps its normal preference when possible.
      const openRight = align === 'left' ? (!roomLeft || roomRight) : !roomLeft && roomRight;
      const left = openRight
        ? Math.min(rect.right + gutter, viewportWidth - width - edge)
        : Math.max(edge, rect.left - width - gutter);
      // Prefer below the trigger; flip above only when the measured body would spill past the bottom
      // edge. The body is rendered (invisible) before this runs so `offsetHeight` is already real.
      const height = tooltipRef.current?.offsetHeight ?? 0;
      const below = rect.bottom + gutter;
      const top = below + height + edge <= viewportHeight ? below : Math.max(edge, rect.top - gutter - height);
      setPosition({ left, top });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [align, open]);

  // Drop any pending close timer on unmount so it can't fire against a torn-down component.
  useEffect(() => () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
  }, []);

  const tooltip = open && typeof document !== 'undefined'
    ? createPortal(
      // `pointer-events-none` is load-bearing: the body floats over neighbouring controls, and it holds no
      // links or selectable data worth reaching, so it must never intercept a click meant for the field
      // underneath. It stays open only while the trigger itself is hovered or focused.
      <span
        ref={tooltipRef}
        role="tooltip"
        className={`overlay-layer-menu pointer-events-none fixed w-64 rounded-md border border-border bg-surface p-3 text-xs font-normal normal-case leading-relaxed tracking-normal text-text-muted${position ? '' : ' invisible'}`}
        style={{ left: position?.left ?? 0, top: position?.top ?? 0, boxShadow: 'var(--shadow-raised)' }}
      >
        {children}
      </span>,
      document.body,
    )
    : null;

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={scheduleClose}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-label={t.common.help}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); show(); }}
        onFocus={show}
        onBlur={scheduleClose}
        className="inline-flex h-4 w-4 items-center justify-center text-text-muted transition-colors hover:text-text"
      >
        <HelpCircle size={14} aria-hidden />
      </button>
      {tooltip}
    </span>
  );
}
