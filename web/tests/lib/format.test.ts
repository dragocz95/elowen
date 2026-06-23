import { describe, it, expect } from 'vitest';
import { formatDuration, compactElapsed, formatTokens, formatCost, formatTaskTime, localDateTime, parseTs } from '../../lib/format';

const S = 1000, M = 60 * S, H = 60 * M, D = 24 * H;

describe('parseTs', () => {
  it('parses SQLite space-separated UTC timestamps', () => {
    expect(parseTs('2026-06-18 10:38:49')).toBe(Date.parse('2026-06-18T10:38:49Z'));
  });
  it('parses ISO timestamps with an explicit offset unchanged', () => {
    expect(parseTs('2026-06-18T10:38:49+02:00')).toBe(Date.parse('2026-06-18T10:38:49+02:00'));
  });
  // W18: an already-Z-suffixed space-form must not get a second 'Z' (which → Invalid Date → null).
  it('does not double-append Z to an already UTC-suffixed value', () => {
    expect(parseTs('2026-06-18 10:38:49Z')).toBe(Date.parse('2026-06-18T10:38:49Z'));
  });
  it('returns null for empty or unparseable input', () => {
    expect(parseTs(null)).toBeNull();
    expect(parseTs('')).toBeNull();
    expect(parseTs('not-a-date')).toBeNull();
  });
});

describe('formatDuration', () => {
  it('formats with two units down the ladder', () => {
    expect(formatDuration(8 * S)).toBe('8s');
    expect(formatDuration(3 * M + 12 * S)).toBe('3m 12s');
    expect(formatDuration(H + 4 * M)).toBe('1h 4m');
  });
  it('clamps negatives to 0s', () => {
    expect(formatDuration(-5000)).toBe('0s');
  });
});

describe('compactElapsed', () => {
  it('picks the single largest unit that fits', () => {
    expect(compactElapsed(12 * S)).toBe('12s');
    expect(compactElapsed(3 * M)).toBe('3m');
    expect(compactElapsed(5 * H)).toBe('5h');
    expect(compactElapsed(2 * D)).toBe('2d');
  });
  it('clamps negatives to 0s', () => {
    expect(compactElapsed(-1)).toBe('0s');
  });
});

describe('formatTokens', () => {
  it('shows raw counts below 1k', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(950)).toBe('950');
  });
  it('shows one decimal k below 10k, whole k below 1M', () => {
    expect(formatTokens(1234)).toBe('1.2k');
    expect(formatTokens(12345)).toBe('12k');
    expect(formatTokens(999_000)).toBe('999k');
  });
  it('shows M above a million', () => {
    expect(formatTokens(1_250_000)).toBe('1.3M');
  });
  it('guards non-finite and negative inputs', () => {
    expect(formatTokens(NaN)).toBe('0');
    expect(formatTokens(-5)).toBe('0');
  });
});

describe('formatCost', () => {
  it('renders USD with a fixed 4 decimals', () => {
    expect(formatCost(0.1234)).toBe('$0.1234');
    expect(formatCost(1)).toBe('$1.0000');
    expect(formatCost(0)).toBe('$0.0000');
  });
});

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
