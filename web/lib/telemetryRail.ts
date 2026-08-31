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

/** Compact desktop telemetry is a 52px instrument strip, not an empty gutter: command access, context and
 * subscription pressure, live work, MCP/LSP and project identity remain reachable without taking reading
 * width from the conversation. A fresh desktop visit deliberately starts at this size. */
export const RAIL_COLLAPSED_WIDTH = 52;

/** Stable panel ids keep the separator's ARIA ownership deterministic across responsive mounts. */
export const CHAT_CONTENT_PANEL_ID = 'chat-content';
export const CHAT_RAIL_PANEL_ID = 'chat-telemetry';
