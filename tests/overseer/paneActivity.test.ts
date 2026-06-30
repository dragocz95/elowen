import { describe, it, expect } from 'vitest';
import { PaneActivityTracker } from '../../src/overseer/paneActivity.js';

describe('PaneActivityTracker', () => {
  it('returns 0 on first sight and on every change, then grows while static', () => {
    const t = new PaneActivityTracker();
    expect(t.seen('s', 'frame-a', 1000)).toBe(0);        // first sight
    expect(t.seen('s', 'frame-a', 1500)).toBe(500);      // unchanged → idle grows
    expect(t.seen('s', 'frame-b', 2000)).toBe(0);        // changed → reset
    expect(t.seen('s', 'frame-b', 9000)).toBe(7000);     // unchanged again
  });

  it('tracks sessions independently', () => {
    const t = new PaneActivityTracker();
    t.seen('a', 'x', 0);
    t.seen('b', 'y', 100);
    expect(t.seen('a', 'x', 1000)).toBe(1000);
    expect(t.seen('b', 'y', 1000)).toBe(900);
  });

  it('treats an empty capture as unknown (null) and does not track it', () => {
    const t = new PaneActivityTracker();
    expect(t.seen('s', '', 1000)).toBeNull();
    // a later non-empty capture is a fresh first-sight, not "idle since 1000"
    expect(t.seen('s', 'now-alive', 5000)).toBe(0);
  });

  it('length is part of the signature, so a different-length screen reads as changed', () => {
    // The length guard makes a hash collision between two DIFFERENT-length captures still read as
    // "changed" rather than a false "idle" (real pane changes almost always change the length too).
    const t = new PaneActivityTracker();
    expect(t.seen('s', 'output line', 0)).toBe(0);
    expect(t.seen('s', 'output line\nmore', 1000)).toBe(0); // longer → reset, not idle 1000
  });

  it('forget() drops the entry so the next sight starts fresh', () => {
    const t = new PaneActivityTracker();
    t.seen('s', 'x', 0);
    t.forget('s');
    expect(t.seen('s', 'x', 5000)).toBe(0); // first sight again, not idle 5000
  });
});
