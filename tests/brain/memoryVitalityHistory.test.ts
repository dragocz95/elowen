import { describe, it, expect } from 'vitest';
import { buildVitalityHistory } from '../../src/brain/memoryVitalityHistory.js';
import {
  DEFAULT_MEMORY_RETENTION,
  vitality,
  type MemoryRetentionConfig,
  type VitalityMemory,
} from '../../src/brain/memoryVitality.js';

const NOW = Date.parse('2026-08-04T12:00:00Z');
const DAY = 86_400_000;
const iso = (daysAgo: number): string => new Date(NOW - daysAgo * DAY).toISOString();

const retention = (over: Partial<MemoryRetentionConfig> = {}): MemoryRetentionConfig => ({
  ...DEFAULT_MEMORY_RETENTION,
  halfLifeByImportance: { ...DEFAULT_MEMORY_RETENTION.halfLifeByImportance },
  ...over,
});

const memory = (over: Partial<VitalityMemory> = {}): VitalityMemory => ({
  importance: 3,
  use_count: 0,
  last_used_at: null,
  created_at: iso(60),
  ...over,
});

const build = (mem: VitalityMemory, recalls: string[], cfg = retention(), pastDays = 30) =>
  buildVitalityHistory({ memory: mem, recalls, retention: cfg, now: NOW, pastDays });

describe('buildVitalityHistory', () => {
  // The curve sits next to the number the list column shows. If its last point disagreed with that
  // number, one of the two would be lying and there would be no way to tell which.
  it('ends on exactly the vitality the memory has right now', () => {
    const mem = memory({ use_count: 3, last_used_at: iso(2) });
    const cfg = retention();

    const history = build(mem, [iso(20), iso(9), iso(2)], cfg);
    const last = history.points[history.points.length - 1];

    expect(last?.vitality).toBeCloseTo(vitality(mem, cfg, NOW), 6);
    expect(last?.at).toBe(new Date(NOW).toISOString());
  });

  it('lifts the curve at a recall and lets it decay in between', () => {
    const mem = memory({ importance: 1, use_count: 2, last_used_at: iso(10) });
    const recallAt = NOW - 10 * DAY;

    const history = build(mem, [iso(25), iso(10)], retention());
    const at = (ms: number): number => {
      const point = [...history.points].reverse().find((p) => Date.parse(p.at) <= ms);
      if (!point) throw new Error('no point at that time');
      return point.vitality;
    };

    expect(at(recallAt + DAY)).toBeGreaterThan(at(recallAt - DAY));
    expect(at(recallAt + DAY)).toBeGreaterThan(at(NOW));
  });

  // A memory whose logged recalls do not account for its whole use_count was used before the log
  // existed. We know a recall happened but not when, so the past must stay undrawn rather than invented.
  it('draws no past when the counters cannot be resolved back', () => {
    const history = build(memory({ use_count: 5, last_used_at: iso(3) }), []);

    expect(history.points).toEqual([]);
    expect(history.historyFrom).toBeNull();
    expect(history.forecast.length).toBeGreaterThan(0);
  });

  it('reconstructs back to creation when every recall is accounted for', () => {
    const history = build(memory({ use_count: 1, last_used_at: iso(4) }), [iso(4)]);

    expect(history.historyFrom).toBe(iso(60));
    // The window only reaches 30 days back, so that is where the drawn curve starts.
    expect(history.points[0]?.at).toBe(iso(30));
  });

  it('marks recalls inside the window and drops the ones outside it', () => {
    const history = build(memory({ use_count: 2, last_used_at: iso(5) }), [iso(40), iso(5)]);

    expect(history.recalls).toEqual([iso(5)]);
  });

  // Every recall in the window used to become both an extra sample in `points` and a mark in `recalls`,
  // so a heavily recalled memory answered with arrays as long as its recall log. The drawer draws one
  // chart element per mark, which is why an unbounded array does not stay a size problem: 1135 marks
  // measured 13.9s of blocked main thread in the browser, against 0.1s once the arrays are bounded.
  it('bounds both arrays however often the memory was recalled', () => {
    const recalls = Array.from({ length: 1200 }, (_, index) => iso(29 - (index * 29) / 1199));
    const history = build(memory({ use_count: 1200, last_used_at: recalls[1199] }), recalls);

    expect(history.recalls.length).toBeLessThanOrEqual(48);
    expect(history.points.length).toBeLessThanOrEqual(96);
  });

  // Thinned, not truncated: dropping the tail would move the last mark weeks back and read as "not
  // recalled since", which is the opposite of what a memory recalled a thousand times is doing.
  it('keeps the thinned marks spanning the whole recall window', () => {
    const recalls = Array.from({ length: 1200 }, (_, index) => iso(29 - (index * 29) / 1199));
    const history = build(memory({ use_count: 1200, last_used_at: recalls[1199] }), recalls);

    expect(history.recalls[0]).toBe(recalls[0]);
    expect(history.recalls[history.recalls.length - 1]).toBe(recalls[1199]);
  });

  it('never evicts a pinned memory, and says so', () => {
    const history = build(memory({ importance: 5, use_count: 1, last_used_at: iso(200) }), [iso(200)]);

    expect(history.evictAt).toBeNull();
    const values = history.forecast.map((p) => p.vitality);
    expect(Math.max(...values) - Math.min(...values)).toBeCloseTo(0, 6);
  });

  it('reports when a decaying memory will cross the floor', () => {
    const mem = memory({ importance: 1, use_count: 1, last_used_at: iso(5) });
    const cfg = retention({ vitalityFloor: 30 });

    const history = build(mem, [iso(5)], cfg);

    expect(history.floor).toBe(30);
    expect(history.evictAt).not.toBeNull();
    const evictMs = Date.parse(history.evictAt ?? '');
    expect(vitality(mem, cfg, evictMs)).toBeLessThan(30);
    // The forecast stops at the crossing rather than running past it into meaningless territory.
    expect(Date.parse(history.forecast[history.forecast.length - 1]?.at ?? '')).toBeLessThanOrEqual(evictMs);
  });

  // Already below the floor: the sweep takes it on its next run, so there is no future left to draw.
  it('collapses the forecast when the memory is already evictable', () => {
    const history = build(
      memory({ importance: 1, use_count: 1, last_used_at: iso(90) }),
      [iso(90)],
      retention({ vitalityFloor: 30 }),
    );

    expect(history.evictAt).toBe(new Date(NOW).toISOString());
    expect(history.forecast).toHaveLength(1);
  });

  it('reports no eviction while retention is switched off', () => {
    const history = build(
      memory({ importance: 1, use_count: 1, last_used_at: iso(300) }),
      [iso(300)],
      retention({ enabled: false }),
    );

    expect(history.evictAt).toBeNull();
  });
});
