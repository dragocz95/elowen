'use client';
import type { CSSProperties } from 'react';

/** The docked telemetry rail's size contract, in CSS pixels.
 *
 *  Pixels rather than percentages of the shell: the rail holds one mono line of numbers
 *  ("340k / 1.0M · $1875.90") and a mascot header, and what makes those legible is an absolute width, not
 *  a share of whatever display the reader happens to be on. `react-resizable-panels` v4 takes numeric
 *  sizes as pixels directly (strings without units are percentages), so this contract reaches the panel
 *  unconverted and there is exactly one source of truth for it. */
export const RAIL_MIN_WIDTH = 280;
export const RAIL_DEFAULT_WIDTH = 340;
export const RAIL_MAX_WIDTH = 560;

/** Collapsed the rail is a 52px stub, not zero: telemetry goes away, but the mascot, the vertical context
 *  meter and its percentage stay on screen. A rail that collapsed to nothing would take the agent's state
 *  with it, and the reader would have to reopen the panel to learn whether a turn is still running. */
export const RAIL_COLLAPSED_WIDTH = 52;

/** The group layout `useDefaultLayout` persists, and the panel ids it keys the saved layout by. Both
 *  panels are named so a conditionally-mounted group restores the right sizes instead of redistributing
 *  them across whatever happens to be rendered on the next mount. */
export const RAIL_LAYOUT_STORAGE_KEY = 'elowen:chat-rail-layout';
export const CHAT_CONTENT_PANEL_ID = 'chat-content';
export const CHAT_RAIL_PANEL_ID = 'chat-telemetry';

const TINY_AT_MIN = 0.75, TINY_AT_MAX = 1;            /* 12px → 16px */
const CAPTION_AT_MIN = 0.875, CAPTION_AT_MAX = 1.125; /* 14px → 18px */

/** The rail's own type scale, published as the two smallest text tokens.
 *
 *  `--text-tiny` / `--text-caption` are GLOBAL tokens: the Tailwind utilities compile to
 *  `var(--text-tiny)` and some two dozen modules across the app use them, so raising them in
 *  `tokens.css` would resize the whole product to fix one column. Overriding them on the rail element
 *  keeps the sections on the very same utilities while sizing them for this column alone.
 *
 *  The scale rides the width because that is what the drag means: a rail pulled wider is one the user
 *  wants to read from further away, and text that stayed at 12px in a 560px column would only look
 *  emptier. Widths outside the contract clamp, so a collapsed stub or a mid-drag overshoot still yields
 *  a value inside the designed range. */
export function railTypeVars(width: number): CSSProperties {
  const t = Math.max(0, Math.min(1, (width - RAIL_MIN_WIDTH) / (RAIL_MAX_WIDTH - RAIL_MIN_WIDTH)));
  const rem = (from: number, to: number) => `${Math.round((from + (to - from) * t) * 1000) / 1000}rem`;
  return {
    '--text-tiny': rem(TINY_AT_MIN, TINY_AT_MAX),
    '--text-caption': rem(CAPTION_AT_MIN, CAPTION_AT_MAX),
  } as CSSProperties;
}
