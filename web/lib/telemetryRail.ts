'use client';

/** The docked telemetry rail's size contract, in CSS pixels.
 *
 * Pixels rather than percentages of the shell: the rail holds one mono line of numbers
 * ("340k / 1.0M · $1875.90") and a mascot header, and what makes those legible is an absolute width, not
 * a share of whatever display the reader happens to be on. `react-resizable-panels` v4 takes numeric
 * sizes as pixels directly (strings without units are percentages), so this contract reaches the panel
 * unconverted and there is exactly one source of truth for it. */
export const RAIL_MIN_WIDTH = 280;
export const RAIL_DEFAULT_WIDTH = 340;
export const RAIL_MAX_WIDTH = 560;

/** Collapsed the rail is a 52px stub, not zero: telemetry goes away, but the mascot, the vertical context
 * meter and its percentage stay on screen. A rail that collapsed to nothing would take the agent's state
 * with it, and the reader would have to reopen the panel to learn whether a turn is still running. */
export const RAIL_COLLAPSED_WIDTH = 52;

/** The group layout `useDefaultLayout` persists, and the panel ids it keys the saved layout by. Both
 * panels are named so a conditionally-mounted group restores the right sizes instead of redistributing
 * them across whatever happens to be rendered on the next mount. */
export const RAIL_LAYOUT_STORAGE_KEY = 'elowen:chat-rail-layout';
export const CHAT_CONTENT_PANEL_ID = 'chat-content';
export const CHAT_RAIL_PANEL_ID = 'chat-telemetry';
