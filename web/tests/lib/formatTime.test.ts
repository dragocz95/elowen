import { describe, it, expect } from 'vitest';
import { formatTaskTime, localDateTime } from '../../lib/formatTime';

const ISO = '2026-06-18 10:00:00'; // SQLite UTC format
const at = (iso: string) => new Date(iso).getTime();
// The tooltip title is the timestamp rendered in LOCAL time; compute it the same way the
// helper does so the assertion is timezone-independent.
const localTitle = (locale?: string) => new Date(at('2026-06-18T10:00:00Z')).toLocaleString(locale, {
  year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

describe('formatTaskTime', () => {
  it('returns a compact relative label within the last 24h', () => {
    expect(formatTaskTime(ISO, at('2026-06-18T10:00:30Z')).label).toBe('30s');
    expect(formatTaskTime(ISO, at('2026-06-18T10:03:00Z')).label).toBe('3m');
    expect(formatTaskTime(ISO, at('2026-06-18T15:00:00Z')).label).toBe('5h');
  });

  it('switches to a locale date at/after 24h', () => {
    const r = formatTaskTime(ISO, at('2026-06-20T10:00:00Z'), 'en-US');
    expect(r.label).toMatch(/Jun/);
    expect(r.title).toBe(localTitle('en-US'));
  });

  it('returns the absolute LOCAL time as title (not raw UTC)', () => {
    expect(formatTaskTime(ISO, at('2026-06-18T10:05:00Z'), 'en-US').title).toBe(localTitle('en-US'));
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

describe('localDateTime', () => {
  const expected = (seconds: boolean) => new Date(at('2026-06-18T10:00:00Z')).toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : {}),
  });
  it('renders SQLite UTC in local time, with seconds by default', () => {
    expect(localDateTime(ISO, 'en-US')).toBe(expected(true));
  });
  it('omits seconds when asked', () => {
    expect(localDateTime(ISO, 'en-US', false)).toBe(expected(false));
  });
  it('parses an already-Z-suffixed space form without producing Invalid Date', () => {
    expect(localDateTime('2026-06-18 10:00:00Z', 'en-US', false)).toBe(expected(false));
  });
  it('falls back to the raw input when unparseable', () => {
    expect(localDateTime('not-a-date', 'en-US')).toBe('not-a-date');
  });
});