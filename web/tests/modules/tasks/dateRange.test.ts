import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RANGE, RANGE_PRESETS, serializeRange, parseRange, isStoredRange, rangeBounds, inRange, taskDayMs, isUnscheduled,
} from '../../../modules/tasks/dateRange';

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

  it('isUnscheduled: true when neither scheduled_at nor closed_at is set', () => {
    const base = { id: '1', title: 'T', status: 'open' as const, created_at: '2026-06-01T10:00:00Z' };
    expect(isUnscheduled({ ...base })).toBe(true);
    // null values are also unscheduled
    expect(isUnscheduled({ ...base, scheduled_at: null, closed_at: null })).toBe(true);
    // in_progress with no schedule — must stay visible
    expect(isUnscheduled({ ...base, status: 'in_progress' as const })).toBe(true);
  });

  it('isUnscheduled: false when scheduled_at or closed_at is present', () => {
    const base = { id: '1', title: 'T', status: 'open' as const, created_at: '2026-06-01T10:00:00Z' };
    expect(isUnscheduled({ ...base, scheduled_at: '2026-06-20T09:00:00Z' })).toBe(false);
    expect(isUnscheduled({ ...base, closed_at: '2026-06-10T10:00:00Z' })).toBe(false);
    expect(isUnscheduled({ ...base, scheduled_at: '2026-06-20T09:00:00Z', closed_at: '2026-06-10T10:00:00Z' })).toBe(false);
  });

  it('taskDayMs returns scheduled_at over closed_at over created_at, 0 for dateless', () => {
    const base = { id: '1', title: 'T', status: 'open' as const, created_at: '2026-06-01T10:00:00Z', closed_at: null as null, scheduled_at: null as null };
    expect(taskDayMs({ ...base })).toBe(new Date('2026-06-01T10:00:00Z').getTime());
    expect(taskDayMs({ ...base, closed_at: '2026-06-10T10:00:00Z' })).toBe(new Date('2026-06-10T10:00:00Z').getTime());
    expect(taskDayMs({ ...base, scheduled_at: '2026-06-20T09:00:00Z', closed_at: '2026-06-10T10:00:00Z' })).toBe(new Date('2026-06-20T09:00:00Z').getTime());
    // No date fields at all → 0 (dateless tasks never hide from any filter)
    expect(taskDayMs({ id: '2', title: 'T', status: 'open' as const })).toBe(0);
  });
});
