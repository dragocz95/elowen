import { describe, it, expect } from 'vitest';
import { formatTaskTime } from '../../lib/formatTime';

const ISO = '2026-06-18 10:00:00'; // SQLite UTC format
const at = (iso: string) => new Date(iso).getTime();

describe('formatTaskTime', () => {
  it('returns a compact relative label within the last 24h', () => {
    expect(formatTaskTime(ISO, at('2026-06-18T10:00:30Z')).label).toBe('30s');
    expect(formatTaskTime(ISO, at('2026-06-18T10:03:00Z')).label).toBe('3m');
    expect(formatTaskTime(ISO, at('2026-06-18T15:00:00Z')).label).toBe('5h');
  });

  it('switches to a locale date at/after 24h', () => {
    const r = formatTaskTime(ISO, at('2026-06-20T10:00:00Z'), 'en-US');
    expect(r.label).toMatch(/Jun/);
    expect(r.title).toBe(ISO);
  });

  it('always returns the full ISO as title', () => {
    expect(formatTaskTime(ISO, at('2026-06-18T10:05:00Z')).title).toBe(ISO);
  });

  it('handles null/empty input', () => {
    expect(formatTaskTime(null, Date.now())).toEqual({ label: '', title: '' });
    expect(formatTaskTime('', Date.now())).toEqual({ label: '', title: '' });
  });

  it('returns the raw input when it cannot be parsed', () => {
    expect(formatTaskTime('not-a-date', Date.now())).toEqual({ label: 'not-a-date', title: 'not-a-date' });
  });

  it('clamps future timestamps to a relative bucket of 0s', () => {
    expect(formatTaskTime(ISO, at('2026-06-18T09:59:00Z')).label).toBe('0s');
  });
});