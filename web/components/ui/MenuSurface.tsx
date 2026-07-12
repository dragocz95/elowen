'use client';

import { forwardRef, useEffect, useRef, type CSSProperties, type HTMLAttributes } from 'react';

export const MenuSurface = forwardRef<HTMLDivElement, Omit<HTMLAttributes<HTMLDivElement>, 'autoFocus'> & {
  autoFocus?: 'first' | 'last' | false;
  onDismiss: (reason: 'escape' | 'tab') => void;
  style?: CSSProperties;
}>(function MenuSurface({ autoFocus = 'first', onDismiss, onKeyDown, ...props }, forwardedRef) {
  const localRef = useRef<HTMLDivElement | null>(null);
  const setRef = (node: HTMLDivElement | null) => {
    localRef.current = node;
    if (typeof forwardedRef === 'function') forwardedRef(node);
    else if (forwardedRef) forwardedRef.current = node;
  };
  const items = () => Array.from(localRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []);

  useEffect(() => {
    if (!autoFocus) return;
    const available = items();
    (autoFocus === 'last' ? available.at(-1) : available[0])?.focus({ preventScroll: true });
  }, [autoFocus]);

  return (
    <div
      {...props}
      ref={setRef}
      role="menu"
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) return;
        const available = items();
        const current = available.indexOf(document.activeElement as HTMLElement);
        if (event.key === 'Escape') { event.preventDefault(); onDismiss('escape'); return; }
        if (event.key === 'Tab') { onDismiss('tab'); return; }
        if (available.length === 0) return;
        let next: number | null = null;
        if (event.key === 'ArrowDown') next = current < 0 || current === available.length - 1 ? 0 : current + 1;
        else if (event.key === 'ArrowUp') next = current <= 0 ? available.length - 1 : current - 1;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = available.length - 1;
        if (next != null) { event.preventDefault(); available[next]?.focus(); }
      }}
    />
  );
});
