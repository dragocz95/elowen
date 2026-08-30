import { describe, it, expect } from 'vitest';
import {
  railTypeVars,
  RAIL_MIN_WIDTH,
  RAIL_MAX_WIDTH,
  RAIL_DEFAULT_WIDTH,
  RAIL_COLLAPSED_WIDTH,
  RAIL_LAYOUT_STORAGE_KEY,
  CHAT_CONTENT_PANEL_ID,
  CHAT_RAIL_PANEL_ID,
} from '../../lib/telemetryRail';

const num = (v: string) => Number.parseFloat(v);

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

  // A collapsed rail is a 52px stub, never zero: the mascot and the context meter stay on screen, so the
  // reader can still see whether a turn is running without reopening the panel.
  it('never collapses the rail to nothing', () => {
    expect(RAIL_COLLAPSED_WIDTH).toBeGreaterThan(0);
  });

  it('names the persisted layout and both panels, so a remembered width survives a remount', () => {
    expect(RAIL_LAYOUT_STORAGE_KEY).toMatch(/^elowen:/);
    expect(CHAT_CONTENT_PANEL_ID).not.toBe(CHAT_RAIL_PANEL_ID);
  });
});

describe('railTypeVars', () => {
  it('publishes exactly the two rail-local text tokens', () => {
    expect(Object.keys(railTypeVars(RAIL_DEFAULT_WIDTH)).sort()).toEqual(['--text-caption', '--text-tiny']);
  });

  it('grows the type with the width', () => {
    const at = (w: number) => railTypeVars(w) as Record<string, string>;
    const narrow = num(at(RAIL_MIN_WIDTH)['--text-tiny'] ?? '0');
    const mid = num(at((RAIL_MIN_WIDTH + RAIL_MAX_WIDTH) / 2)['--text-tiny'] ?? '0');
    const wide = num(at(RAIL_MAX_WIDTH)['--text-tiny'] ?? '0');
    expect(mid).toBeGreaterThan(narrow);
    expect(wide).toBeGreaterThan(mid);
    expect(num(at(RAIL_MIN_WIDTH)['--text-caption'] ?? '0')).toBeGreaterThan(narrow);
  });

  // The panel reports a live pixel width on every drag frame, and a collapsed rail reports 52 — well
  // under the contract's floor. Clamping is what keeps those from emitting a type scale nothing designed.
  it('clamps outside the contract instead of extrapolating', () => {
    const tiny = (w: number) => (railTypeVars(w) as Record<string, string>)['--text-tiny'];
    expect(tiny(RAIL_COLLAPSED_WIDTH)).toBe(tiny(RAIL_MIN_WIDTH));
    expect(tiny(10)).toBe(tiny(RAIL_MIN_WIDTH));
    expect(tiny(4000)).toBe(tiny(RAIL_MAX_WIDTH));
  });
});
