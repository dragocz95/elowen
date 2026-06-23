'use client';
import { useCallback, useRef } from 'react';

/** A thin draggable divider. Emits the pointer delta along its axis on every move while dragging, so
 *  the parent owns the actual sizing maths (and clamping/persistence). `vertical` resizes width (dx),
 *  `horizontal` resizes height (dy). Pointer capture keeps the drag alive even when the cursor leaves
 *  the 1px strip. */
export function ResizeHandle({ orientation, onDelta, onEnd, className }: {
  orientation: 'vertical' | 'horizontal';
  onDelta: (delta: number) => void;
  onEnd?: () => void;
  className?: string;
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

  const base = orientation === 'vertical'
    ? 'w-1 cursor-col-resize'
    : 'h-1 cursor-row-resize';

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onLostPointerCapture={end}
      className={`shrink-0 bg-border transition-colors hover:bg-accent ${base} ${className ?? ''}`}
    />
  );
}
