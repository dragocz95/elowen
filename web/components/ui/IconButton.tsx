'use client';
import type { LucideIcon } from 'lucide-react';

import { Button } from './Button';

/** A square, icon-only control: the app `Button` at its `icon` size, with the label moved out of the child
 *  and into `aria-label`.
 *
 *  It goes through `./Button.tsx` rather than reaching past it to the primitive, which is what it used to
 *  do. That shortcut cost two things. It spelled shadcn variant names here — a second app→shadcn map, in
 *  which `default` meant `outline` while the same word meant `secondary` one file over — and it asked for
 *  a size and then contradicted it in `className`, so the size axis decided nothing. Now the size axis
 *  supplies the square box and its padding, and the only classes left are this app's two deliberate
 *  deviations from the primitive's `icon` size. */
export function IconButton({ icon: Icon, label, onClick, variant = 'default', disabled = false }: { icon: LucideIcon; label: string; onClick?: () => void; variant?: 'default' | 'danger'; disabled?: boolean }) {
  return (
    <Button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      variant={variant === 'danger' ? 'outline-danger' : 'outline'}
      size="icon"
      icon={Icon}
      // 28px rather than the primitive's 36px, because these sit in table rows and toolbars where a 36px
      // control would set the row height. Square, not rounded, and deliberately so: these align to the
      // edge of a cell or a toolbar, where a radius reads as a gap in the rule the row is drawn on.
      className="size-7 rounded-none"
      style={{ transitionDuration: 'var(--motion-fast)' }}
    />
  );
}
