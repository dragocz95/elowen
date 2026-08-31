import { describe, it, expect } from 'vitest';
import {
  RAIL_MIN_WIDTH,
  RAIL_MAX_WIDTH,
  RAIL_DEFAULT_WIDTH,
  RAIL_COLLAPSED_WIDTH,
  CHAT_CONTENT_PANEL_ID,
  CHAT_RAIL_PANEL_ID,
} from '../../lib/telemetryRail';

describe('telemetry rail size contract', () => {
  // The approved geometry, and the reason each number is what it is. Pinned as a test because these are
  // the values the docked panel is configured with: a drift here silently re-sizes the rail rather than
  // failing anything, and the old 240/320 pair is exactly what the redesign moved away from.
  it('states the approved pixel geometry rather than the pre-redesign one', () => {
    expect(RAIL_MIN_WIDTH).toBe(280);
    expect(RAIL_DEFAULT_WIDTH).toBe(340);
    expect(RAIL_MAX_WIDTH).toBe(560);
    expect(RAIL_COLLAPSED_WIDTH).toBe(52);
  });

  it('orders the contract so a panel can be configured from it directly', () => {
    expect(RAIL_COLLAPSED_WIDTH).toBeLessThan(RAIL_MIN_WIDTH);
    expect(RAIL_MIN_WIDTH).toBeLessThan(RAIL_DEFAULT_WIDTH);
    expect(RAIL_DEFAULT_WIDTH).toBeLessThan(RAIL_MAX_WIDTH);
  });

  // Compact telemetry is a real 52px instrument strip, never zero: commands and section summaries remain
  // visible without reopening the full panel.
  it('never compacts the rail to nothing', () => {
    expect(RAIL_COLLAPSED_WIDTH).toBeGreaterThan(0);
  });

  it('names both panels so the separator owns a deterministic pair', () => {
    expect(CHAT_CONTENT_PANEL_ID).not.toBe(CHAT_RAIL_PANEL_ID);
  });
});
