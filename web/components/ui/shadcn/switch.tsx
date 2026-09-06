'use client';

import * as React from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { cva } from 'class-variance-authority';

import { cn } from '../../../lib/utils';

/** The track: 36×18, and NO border.
 *
 *  The border is the reason the geometry had to change rather than just the numbers. A 20px track with a
 *  1px edge leaves 18px of interior, and a thumb inset inside that edge can never be the full height of
 *  the control — which is why the old thumb was 14px and the toggle read as a small dot rattling around
 *  in a large slot. The reference has no edge at all: the track IS the shape, the thumb fills it, and
 *  the two states are told apart by the track's fill and the thumb's position.
 *
 *  Losing the border means the FILL is now the only thing drawing the control, which is why the OFF
 *  track had to move off the surface ramp and onto `--color-border` — see below. */
const switchVariants = cva([
  'peer inline-flex h-[18px] w-9 shrink-0 items-center rounded-full outline-none transition-colors',
  // The OFF track is `border`, not `secondary`. With the edge gone the fill is the ONLY thing that draws
  // the control, and `secondary` aliases `--color-muted`, which is a SURFACE: in studio-oled it is
  // #080d0f, byte-identical to that skin's card, so an OFF switch on a card was a thumb floating on
  // nothing, and on studio-light it was #f4f4f5 on white at about 1.05:1. `--color-border` is the token
  // each design already tunes to be the faint-but-visible step away from its surfaces — studio-light
  // resolves it to #e4e4e7, which is the reference's own oklch(0.922) track.
  'data-[state=checked]:bg-primary data-[state=unchecked]:bg-border',
  // No focus utilities here on purpose. `app/styles/base.css` gives `[role="switch"]:focus-visible` a
  // box-shadow ring and is imported unlayered, so it outranks the whole of Tailwind's utilities layer —
  // a `focus-visible:ring-*` class on this element paints nothing at all. That ring is already offset
  // (1px of canvas, then 3px of brand), which is what makes losing the border cost no focus visibility.
  'disabled:cursor-not-allowed disabled:opacity-40',
]);

/** One duration for the whole control. The track's fill and the thumb's travel are two halves of a
 *  single movement, and they used to run on different clocks — the `Toggle` wrapper set the root to
 *  `--motion-fast` while the thumb slid on `--motion-base` — so the colour arrived at the new state
 *  while the thumb was still halfway there.
 *
 *  `--motion-base` resolves to 150ms in both shipped skins, which is the reference's own toggle
 *  duration. Stated as tokens rather than as a literal so `data-effects='off'` and
 *  `prefers-reduced-motion` collapse it to nothing.
 *
 *  `--ease-standard` rather than `--ease-spring`: a spring OVERSHOOTS, and a thumb that fills its track
 *  has nowhere to overshoot to — it lands past the end of the track and springs back into it. */
const SWITCH_MOTION = {
  transitionDuration: 'var(--motion-base)',
  transitionTimingFunction: 'var(--ease-standard)',
} as const;

function Switch({ className = '', style, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(switchVariants(), className)}
      style={{ ...SWITCH_MOTION, ...style }}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        // 18px: the FULL height of the track, so the thumb reads as the track's own moving half rather
        // than as a dot inside it. Its travel is the difference, 36 - 18 = 18px.
        //
        // The thumb keeps the COLOURS it had. The reference paints a white thumb in both states, which
        // works on its palette and does not survive ours: white on studio-light's neutral track is a
        // 1.09:1 shape, and near-black on studio-oled's is the same problem inverted. Each state instead
        // takes the ink the token contract already guarantees against the fill it sits on.
        className={cn(
          'pointer-events-none block size-[18px] rounded-full transition-transform',
          'data-[state=checked]:translate-x-[18px] data-[state=checked]:bg-primary-foreground',
          'data-[state=unchecked]:translate-x-0 data-[state=unchecked]:bg-muted-foreground',
        )}
        style={SWITCH_MOTION}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
