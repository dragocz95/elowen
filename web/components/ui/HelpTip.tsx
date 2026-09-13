'use client';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { HelpCircle } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { Tooltip, TooltipAnchor, TooltipContent } from './shadcn/tooltip';

// Grace period before the tooltip closes, so a pointer that clips the gutter on its way past the trigger
// doesn't make it flicker.
const CLOSE_DELAY_MS = 120;

/** A small "?" that reveals inline help on hover, focus or tap, composed from the tooltip parts in
 *  `./shadcn/tooltip.tsx`.
 *
 *  Those parts sit on Radix's POPOVER rather than its Tooltip, and the reason is this component: it is a
 *  help affordance next to a form label, so it must open on tap as well as on hover — a phone has no
 *  hover, and Radix's Tooltip treats a press as "dismiss". The tooltip SEMANTICS are kept regardless:
 *  `role="tooltip"` on the body, `aria-describedby` from the button, no focus movement, and a body that
 *  is transparent to the pointer. See the header of `./shadcn/tooltip.tsx` for the full argument.
 *
 *  What Radix now owns is the placement (below the trigger, aligned to the side `align` asks for,
 *  flipped above and shifted inward when it would leave the viewport) and dismissal on Escape or an
 *  outside press. What stays here is the app's policy: which gestures open it, and the close debounce.
 *
 *  `label` names the trigger when the mark belongs to a NAMED record rather than to the field it sits
 *  beside. A list of records otherwise presents a column of buttons all called "Help": the label is what
 *  a screen reader's element list and voice control have to tell them apart. */
export function HelpTip({ children, align = 'right', label }: { children: ReactNode; align?: 'left' | 'right'; label?: string }) {
  const [open, setOpen] = useState(false);
  const tooltipId = useId();
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { t } = useTranslation();

  const cancelClose = () => {
    if (closeTimer.current !== null) { clearTimeout(closeTimer.current); closeTimer.current = null; }
  };
  const show = () => { cancelClose(); setOpen(true); };
  // Debounced so a pointer that crosses the gap between the button and the body doesn't close it.
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => { closeTimer.current = null; setOpen(false); }, CLOSE_DELAY_MS);
  };

  // Drop any pending close timer on unmount so it can't fire against a torn-down component.
  useEffect(() => () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
  }, []);

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={scheduleClose}
    >
      <Tooltip open={open} onOpenChange={(next) => { cancelClose(); setOpen(next); }}>
        {/* The glyph is 16px and stays 16px — it is a quiet mark beside a label, and growing the BOX
            would push whatever sits next to it. What grows is the hit area alone: a transparent
            pseudo-element inset by -0.25rem on every side, so the target is 24x24 with no layer of the
            layout moving. Below that size a near miss lands on whatever is underneath, which in a
            navigation record is the control stretched over the whole row. The pseudo-element belongs to
            this button, so it inherits its place in the paint order and keeps that control from taking
            the press. A coarse pointer still gets the full --touch-target box. */}
        <TooltipAnchor asChild>
          <button
            type="button"
            aria-label={label ?? t.common.help}
            aria-describedby={open ? tooltipId : undefined}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); show(); }}
            onFocus={show}
            onBlur={scheduleClose}
            className="relative inline-flex h-4 w-4 items-center justify-center text-muted-foreground transition-colors before:absolute before:-inset-1 before:content-[''] hover:text-foreground pointer-coarse:h-[var(--touch-target)] pointer-coarse:w-[var(--touch-target)]"
          >
            <HelpCircle size={14} aria-hidden />
          </button>
        </TooltipAnchor>
        {/* `right` alignment has always meant "the body hangs to the LEFT of the trigger", which is
            Radix's `align="end"`: the body's end edge lines up with the trigger's. */}
        <TooltipContent id={tooltipId} align={align === 'left' ? 'start' : 'end'}>
          {children}
        </TooltipContent>
      </Tooltip>
    </span>
  );
}
