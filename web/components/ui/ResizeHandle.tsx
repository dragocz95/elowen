'use client';
import { useCallback, useRef } from 'react';

/** A thin draggable divider. Emits the pointer delta along its axis on every move while dragging, so
 *  the parent owns the actual sizing maths (and clamping/persistence). `vertical` resizes width (dx),
 *  `horizontal` resizes height (dy). Pointer capture keeps the drag alive even when the cursor leaves
 *  the 1px strip.
 *
 *  Passing `label` (with the current value and its range) turns it into a focusable window splitter:
 *  the arrow keys along the drag axis emit `step`-sized deltas, so the size is reachable without a
 *  pointer at all. Without a label it stays a decorative divider and out of the tab order — a splitter
 *  whose range is unknown would only announce itself as broken. */
export function ResizeHandle({ orientation, onDelta, onEnd, onReset, className, label, value, min, max, step = 16 }: {
  orientation: 'vertical' | 'horizontal';
  onDelta: (delta: number) => void;
  onEnd?: () => void;
  /** Double-click behaviour, when the parent has a default size to return to. */
  onReset?: () => void;
  className?: string;
  label?: string;
  value?: number;
  min?: number;
  max?: number;
  step?: number;
}) {
  const last = useRef<number | null>(null);
  const axis = orientation === 'vertical' ? 'clientX' : 'clientY';

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    last.current = e[axis];
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }, [axis]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (last.current === null) return;
    const cur = e[axis];
    onDelta(cur - last.current);
    last.current = cur;
  }, [axis, onDelta]);

  const end = useCallback((e: React.PointerEvent) => {
    if (last.current === null) return;
    last.current = null;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    onEnd?.();
  }, [onEnd]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    const [back, forward] = orientation === 'vertical'
      ? ['ArrowLeft', 'ArrowRight']
      : ['ArrowUp', 'ArrowDown'];
    if (e.key !== back && e.key !== forward) return;
    e.preventDefault();
    onDelta(e.key === back ? -step : step);
    onEnd?.();
  }, [orientation, onDelta, onEnd, step]);

  const base = orientation === 'vertical'
    ? 'w-1 cursor-col-resize'
    : 'h-1 cursor-row-resize';

  const keyboard = label !== undefined;

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={keyboard ? 0 : undefined}
      onKeyDown={keyboard ? onKeyDown : undefined}
      onDoubleClick={onReset}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onLostPointerCapture={end}
      className={`shrink-0 select-none bg-border transition-colors hover:bg-primary active:bg-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${base} ${className ?? ''}`}
    />
  );
}
