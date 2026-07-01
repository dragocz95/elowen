import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RANGE, RANGE_PRESETS, serializeRange, parseRange, isStoredRange, rangeBounds, inRange,
} from '../../lib/dateRange';

describe('dateRange', () => {
  it('defaults to the last 7 days', () => {
    expect(DEFAULT_RANGE).toEqual({ preset: '7d', from: null, to: null });
  });

  it('serialize/parse round-trips every preset', () => {
    for (const preset of RANGE_PRESETS) {
      const r = { preset, from: null, to: null };
      expect(parseRange(serializeRange(r))).toEqual(r);
    }
  });

  it('serialize/parse round-trips a custom range', () => {
    const r = { preset: 'custom' as const, from: '2026-06-01', to: '2026-06-15' };
    expect(parseRange(serializeRange(r))).toEqual(r);
  });

  it('rejects malformed stored values, accepts valid ones', () => {
    expect(parseRange('garbage')).toBeNull();
    expect(parseRange('weird|')).toBeNull();
    expect(parseRange('7d|notadate|')).toBeNull();
    expect(isStoredRange('7d||')).toBe(true);
    expect(isStoredRange('custom|2026-06-01|2026-06-15')).toBe(true);
    expect(isStoredRange('nope')).toBe(false);
  });

  it("'all' spans everything", () => {
    const b = rangeBounds({ preset: 'all', from: null, to: null }, new Date('2026-06-23T12:00:00').getTime());
    expect(b.fromMs).toBe(-Infinity);
    expect(b.toMs).toBe(Infinity);
  });

  it('last-7-days includes today and 6 days back, excludes 8 days ago', () => {
    const now = new Date('2026-06-23T12:00:00').getTime();
    const r = { preset: '7d' as const, from: null, to: null };
    expect(inRange(new Date('2026-06-23T09:00:00').getTime(), r, now)).toBe(true);  // today
    expect(inRange(new Date('2026-06-17T23:00:00').getTime(), r, now)).toBe(true);  // 6 days back
    expect(inRange(new Date('2026-06-15T12:00:00').getTime(), r, now)).toBe(false); // 8 days back
  });

  it('custom range honors from/to local day bounds inclusively', () => {
    const now = new Date('2026-06-23T12:00:00').getTime();
    const r = { preset: 'custom' as const, from: '2026-06-10', to: '2026-06-12' };
    expect(inRange(new Date('2026-06-10T00:00:00').getTime(), r, now)).toBe(true);
    expect(inRange(new Date('2026-06-12T23:59:00').getTime(), r, now)).toBe(true);
    expect(inRange(new Date('2026-06-09T23:59:00').getTime(), r, now)).toBe(false);
    expect(inRange(new Date('2026-06-13T00:01:00').getTime(), r, now)).toBe(false);
  });

  it('custom with open ends is unbounded on the missing side', () => {
    const now = new Date('2026-06-23T12:00:00').getTime();
    expect(inRange(0, { preset: 'custom', from: null, to: '2026-06-12' }, now)).toBe(true);
    expect(inRange(new Date('2030-01-01T00:00:00').getTime(), { preset: 'custom', from: '2026-06-01', to: null }, now)).toBe(true);
  });

  it("'today' serialize/parse round-trips", () => {
    const r = { preset: 'today' as const, from: null, to: null };
    expect(parseRange(serializeRange(r))).toEqual(r);
    expect(isStoredRange(serializeRange(r))).toBe(true);
  });

  it("'today' bounds cover only the local day", () => {
    const now = new Date('2026-06-23T14:30:00').getTime();
    const r = { preset: 'today' as const, from: null, to: null };
    const { fromMs, toMs } = rangeBounds(r, now);
    // start of local 2026-06-23 (midnight)
    expect(fromMs).toBe(new Date('2026-06-23T00:00:00').getTime());
    // end of local 2026-06-23 (23:59:59.999)
    expect(toMs).toBe(new Date('2026-06-23T23:59:59.999').getTime());
    // timestamps within today pass
    expect(inRange(new Date('2026-06-23T00:00:00').getTime(), r, now)).toBe(true);
    expect(inRange(new Date('2026-06-23T23:59:59').getTime(), r, now)).toBe(true);
    // yesterday and tomorrow are excluded
    expect(inRange(new Date('2026-06-22T23:59:59').getTime(), r, now)).toBe(false);
    expect(inRange(new Date('2026-06-24T00:00:00').getTime(), r, now)).toBe(false);
  });
});
