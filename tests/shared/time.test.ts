import { describe, it, expect } from 'vitest';
import { parseDbTs } from '../../src/shared/time.js';

describe('parseDbTs', () => {
  it('parses a SQLite space-separated UTC timestamp', () => {
    expect(parseDbTs('2026-06-19 11:13:20')).toBe(Date.parse('2026-06-19T11:13:20Z'));
  });
  it('parses an ISO timestamp with an explicit zone unchanged', () => {
    expect(parseDbTs('2026-06-19T11:13:20Z')).toBe(Date.parse('2026-06-19T11:13:20Z'));
    expect(parseDbTs('2026-06-19T11:13:20+02:00')).toBe(Date.parse('2026-06-19T11:13:20+02:00'));
  });
  it('does not double-append Z to an already UTC-suffixed space form', () => {
    expect(parseDbTs('2026-06-19 11:13:20Z')).toBe(Date.parse('2026-06-19T11:13:20Z'));
  });
  it('returns 0 for empty, null or unparseable input', () => {
    expect(parseDbTs()).toBe(0);
    expect(parseDbTs(null)).toBe(0);
    expect(parseDbTs('')).toBe(0);
    expect(parseDbTs('not-a-date')).toBe(0);
  });
});
