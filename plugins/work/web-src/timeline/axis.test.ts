import { describe, it, expect } from 'vitest';
import { ensurePluginUiRuntime } from '../../../../web/lib/pluginUi';

// The views resolve every component, hook and helper through window.ElowenUiRuntime at module
// scope — install the REAL runtime first (the same records the app hands a bundle), then import
// them, exactly as the host page does in the browser.
ensurePluginUiRuntime();
const { plotAxis, groupEvents } = await import('./axis');

const HOUR_MS = 3_600_000;
// Fixed "now": 2026-06-17T12:00:00Z
const NOW = Date.parse('2026-06-17T12:00:00Z');
const HOURS = 12;
const WINDOW_START = NOW - HOURS * HOUR_MS;

function makeEvent(id: string, offsetMs: number) {
  return { id, type: 'task', target: `t-${id}`, detail: 'open', timestamp: NOW - offsetMs };
}

describe('plotAxis', () => {
  it('always generates the requested number of ticks', () => {
    const { ticks } = plotAxis([], NOW, HOURS);
    expect(ticks).toHaveLength(HOURS);
  });

  it('tick labels are HH:MM formatted UTC strings', () => {
    const { ticks } = plotAxis([], NOW, HOURS);
    for (const tick of ticks) {
      expect(tick.label).toMatch(/^\d{2}:\d{2}$/);
    }
  });

  it('tick fracs are monotonically increasing and in (0, 1]', () => {
    const { ticks } = plotAxis([], NOW, HOURS);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i].frac).toBeGreaterThan(ticks[i - 1].frac);
    }
    expect(ticks[ticks.length - 1].frac).toBeCloseTo(1, 5);
  });

  it('maps an event at "now" to frac ≈ 1', () => {
    const { points } = plotAxis([makeEvent('a', 0)], NOW, HOURS);
    expect(points).toHaveLength(1);
    expect(points[0].frac).toBeCloseTo(1, 5);
  });

  it('maps an event at the start of the window to frac ≈ 0', () => {
    const event = { id: 'b', type: 'task', target: 't', detail: 'd', timestamp: WINDOW_START };
    const { points } = plotAxis([event], NOW, HOURS);
    expect(points).toHaveLength(1);
    expect(points[0].frac).toBeCloseTo(0, 5);
  });

  it('maps an event at the midpoint to frac ≈ 0.5', () => {
    const mid = { id: 'c', type: 'task', target: 't', detail: 'd', timestamp: WINDOW_START + (HOURS / 2) * HOUR_MS };
    const { points } = plotAxis([mid], NOW, HOURS);
    expect(points[0].frac).toBeCloseTo(0.5, 5);
  });

  it('drops events before the window', () => {
    const old = { id: 'd', type: 'task', target: 't', detail: 'd', timestamp: WINDOW_START - 1 };
    const { points } = plotAxis([old], NOW, HOURS);
    expect(points).toHaveLength(0);
  });

  it('drops events after now', () => {
    const future = { id: 'e', type: 'task', target: 't', detail: 'd', timestamp: NOW + 1 };
    const { points } = plotAxis([future], NOW, HOURS);
    expect(points).toHaveLength(0);
  });

  it('empty events → no points, ticks still present', () => {
    const { ticks, points } = plotAxis([], NOW, HOURS);
    expect(points).toHaveLength(0);
    expect(ticks).toHaveLength(HOURS);
  });

  it('preserves all event fields in the output point', () => {
    const e = { id: 'z', type: 'mission', target: 'my-target', detail: 'active', timestamp: NOW - HOUR_MS };
    const { points } = plotAxis([e], NOW, HOURS);
    expect(points[0]).toMatchObject({ id: 'z', type: 'mission', target: 'my-target', detail: 'active', count: 1 });
  });

  it('collapses a flood of identical signals into one point with a count', () => {
    // 5 "working" signals 5s apart — should render as a single marker ×5.
    const flood = Array.from({ length: 5 }, (_, i) => ({
      id: `s${i}`,
      type: 'signal',
      target: 'agent-1',
      detail: 'working',
      timestamp: NOW - HOUR_MS + i * 5_000,
    }));
    const { points } = plotAxis(flood, NOW, HOURS);
    expect(points).toHaveLength(1);
    expect(points[0].count).toBe(5);
  });
});

describe('groupEvents', () => {
  const sig = (id: string, target: string, detail: string, timestamp: number) => ({
    id,
    type: 'signal',
    target,
    detail,
    timestamp,
  });

  it('collapses consecutive identical events into one with a count', () => {
    const events = [
      sig('a', 'agent-1', 'working', NOW),
      sig('b', 'agent-1', 'working', NOW + 5_000),
      sig('c', 'agent-1', 'working', NOW + 10_000),
    ];
    const groups = groupEvents(events);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(3);
    expect(groups[0].firstTimestamp).toBe(NOW);
    expect(groups[0].timestamp).toBe(NOW + 10_000); // keeps latest timestamp
    expect(groups[0].id).toBe('c'); // keeps latest id
  });

  it('keeps distinct events separate', () => {
    const events = [
      sig('a', 'agent-1', 'working', NOW),
      sig('b', 'agent-2', 'working', NOW + 5_000),
      sig('c', 'agent-1', 'idle', NOW + 10_000),
    ];
    const groups = groupEvents(events);
    expect(groups).toHaveLength(3);
    expect(groups.every((g) => g.count === 1)).toBe(true);
  });

  it('does not merge identical events separated by a large gap', () => {
    const events = [
      sig('a', 'agent-1', 'working', NOW),
      sig('b', 'agent-1', 'working', NOW + 30 * 60 * 1000), // 30 min later
    ];
    const groups = groupEvents(events);
    expect(groups).toHaveLength(2);
  });

  it('sorts unordered input by timestamp before grouping', () => {
    const events = [
      sig('b', 'agent-1', 'working', NOW + 5_000),
      sig('a', 'agent-1', 'working', NOW),
      sig('c', 'agent-1', 'working', NOW + 10_000),
    ];
    const groups = groupEvents(events);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(3);
  });

  it('does not mutate the input array', () => {
    const events = [sig('a', 'agent-1', 'working', NOW + 5_000), sig('b', 'agent-1', 'working', NOW)];
    const snapshot = events.map((e) => e.id);
    groupEvents(events);
    expect(events.map((e) => e.id)).toEqual(snapshot);
  });

  it('returns empty for empty input', () => {
    expect(groupEvents([])).toEqual([]);
  });
});
