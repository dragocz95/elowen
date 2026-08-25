import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildChartRows, deltaPct, toLocalHours, seriesKey, colorFor, HOURS } from '../../../modules/dashboard/pulseSeries';
import type { PulsePerson } from '../../../lib/types';

/** The chart's arithmetic, tested away from the DOM on purpose: jsdom computes no layout, so a
 *  ResponsiveContainer there has zero width and renders nothing measurable. Everything that could be
 *  wrong about the numbers is in these pure functions. */

const person = (over: Partial<PulsePerson> = {}): PulsePerson => ({
  userId: 1, label: 'Filip', username: 'filip', working: false, title: '',
  lastTs: '', turns: 0, tokens: 0, cost: null, cacheHitPct: null, memoryHits: 0,
  surfaces: [], hoursToday: Array<number>(HOURS).fill(0), ...over,
});

/** getTimezoneOffset returns minutes WEST of UTC, so Prague in summer (UTC+2) is -120. */
const atOffset = (minutes: number) =>
  vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(minutes);

afterEach(() => vi.restoreAllMocks());

describe('toLocalHours', () => {
  it('shifts a UTC series into the local day', () => {
    atOffset(-120); // UTC+2
    const utc = Array<number>(HOURS).fill(0);
    utc[9] = 7; // 09:00 UTC is 11:00 in Prague

    const local = toLocalHours(utc);

    expect(local[11]).toBe(7);
    expect(local[9]).toBe(0);
  });

  it('wraps around midnight instead of dropping the hours that cross it', () => {
    atOffset(-120);
    const utc = Array<number>(HOURS).fill(0);
    utc[23] = 4; // 23:00 UTC is 01:00 the next local day

    const local = toLocalHours(utc);

    expect(local[1]).toBe(4);
    // Nothing may be lost in the shift: the day's total has to survive it.
    expect(local.reduce((a, b) => a + b, 0)).toBe(4);
  });

  it('leaves the series alone at UTC', () => {
    atOffset(0);
    const utc = Array<number>(HOURS).fill(0);
    utc[6] = 3;

    expect(toLocalHours(utc)[6]).toBe(3);
  });

  it('keeps every hour when the zone is offset by a half hour', () => {
    atOffset(-330); // UTC+5:30, India
    const utc = Array.from({ length: HOURS }, (_, i) => i + 1);

    const local = toLocalHours(utc);

    // Rounding to the nearest hour must not double up or drop a bucket.
    expect(local).toHaveLength(HOURS);
    expect(local.reduce((a, b) => a + b, 0)).toBe(utc.reduce((a, b) => a + b, 0));
  });
});

describe('buildChartRows', () => {
  it('gives every person their own key on one row per hour', () => {
    atOffset(0);
    const a = person({ userId: 1, hoursToday: Array.from({ length: HOURS }, (_, h) => (h === 5 ? 2 : 0)) });
    const b = person({ userId: 2, hoursToday: Array.from({ length: HOURS }, (_, h) => (h === 5 ? 9 : 0)) });

    const rows = buildChartRows([a, b], Array<number>(HOURS).fill(0));

    expect(rows).toHaveLength(HOURS);
    // A shared hour must resolve both people, which is what lets one hover report the whole instance.
    expect(rows[5]![seriesKey(a)]).toBe(2);
    expect(rows[5]![seriesKey(b)]).toBe(9);
    expect(rows[4]![seriesKey(a)]).toBe(0);
  });

  it('keys series by user id so a rename cannot detach a curve from its row', () => {
    const renamed = person({ userId: 7, label: 'New Name' });
    expect(seriesKey(renamed)).toBe(seriesKey(person({ userId: 7, label: 'Old Name' })));
  });

  it('carries the memory backdrop on its own key', () => {
    atOffset(0);
    const memory = Array.from({ length: HOURS }, (_, h) => (h === 3 ? 120 : 0));

    const rows = buildChartRows([person()], memory);

    expect(rows[3]!.memory).toBe(120);
  });
});

describe('deltaPct', () => {
  it('reports the change against yesterday', () => {
    expect(deltaPct(12, 10)).toBeCloseTo(20);
    expect(deltaPct(8, 10)).toBeCloseTo(-20);
  });

  it('refuses to turn a start from nothing into a percentage', () => {
    // "+100 %" against an empty yesterday would overstate a single first turn as a doubling.
    expect(deltaPct(5, 0)).toBeNull();
  });
});

describe('colorFor', () => {
  it('repeats the palette instead of running out of colours', () => {
    expect(colorFor(0)).toBe(colorFor(5));
    expect(colorFor(0)).not.toBe(colorFor(1));
  });
});
