import { describe, expect, it } from 'vitest';
import {
  assessColdCompaction,
  coldCompactionGateMs,
  coldCompactionWorthwhile,
  lastActivityMs,
} from '../../src/brain/session/coldStartCompaction.js';

/** The factory's summary allowance — the expected summary OUTPUT size the break-even charges for. */
const SUMMARY = 8_000;

describe('coldCompactionWorthwhile', () => {
  it('uses the 5-minute write price at the exact C = 5·F + 20·S boundary', () => {
    expect(coldCompactionWorthwhile(410_000, 50_000, SUMMARY, 5 * 60_000)).toBe(true);
    expect(coldCompactionWorthwhile(409_999, 50_000, SUMMARY, 5 * 60_000)).toBe(false);
  });

  it('uses the 1-hour write price at the exact C = 2·F + 5·S boundary', () => {
    expect(coldCompactionWorthwhile(140_000, 50_000, SUMMARY, 60 * 60_000)).toBe(true);
    expect(coldCompactionWorthwhile(139_999, 50_000, SUMMARY, 60 * 60_000)).toBe(false);
  });

  it('prices the same context differently under short and long retention', () => {
    expect(coldCompactionWorthwhile(200_000, 40_000, SUMMARY, 5 * 60_000)).toBe(false);
    expect(coldCompactionWorthwhile(200_000, 40_000, SUMMARY, 60 * 60_000)).toBe(true);
  });

  it('falls back to the conservative short-TTL price when the previous request TTL is unknown', () => {
    expect(coldCompactionWorthwhile(200_000, 40_000, SUMMARY)).toBe(false);
  });
});

describe('coldCompactionGateMs', () => {
  it('derives the gate from the TTL of the LAST provider request plus the 1-minute buffer', () => {
    expect(coldCompactionGateMs(5 * 60_000)).toBe(6 * 60_000);
    expect(coldCompactionGateMs(60 * 60_000)).toBe(61 * 60_000);
  });

  it('falls back to the LONGEST TTL when the last request predates this process', () => {
    // A retention switch across a restart (long → short) must not open the gate over a still-warm
    // hour-long cache: with no stamp, the gate assumes the longest TTL pi-ai ever uses.
    expect(coldCompactionGateMs(undefined)).toBe(61 * 60_000);
  });
});

describe('assessColdCompaction', () => {
  const inputs = (over: Partial<Parameters<typeof assessColdCompaction>[0]> = {}) => ({
    proactive: () => true,
    breakerBlocks: () => false,
    contextTokens: () => 500_000,
    floorTokens: () => 40_000,
    summaryOutputTokens: () => SUMMARY,
    ...over,
  });

  it('is eligible with the estimates attached when every gate passes', () => {
    expect(assessColdCompaction(inputs())).toEqual({ eligible: true, contextTokens: 500_000, floorTokens: 40_000 });
  });

  it('respects the user’s auto-compact toggle — a cold-start compaction is still an automatic one', () => {
    expect(assessColdCompaction(inputs({ proactive: () => false })))
      .toEqual({ eligible: false, reason: 'auto-compact-off' });
  });

  it('never sneaks past a circuit breaker that refuses automatic compaction', () => {
    expect(assessColdCompaction(inputs({ breakerBlocks: () => true })))
      .toEqual({ eligible: false, reason: 'breaker' });
  });

  it('refuses a conversation below the short-cache break-even', () => {
    expect(assessColdCompaction(inputs({ contextTokens: () => 200_000 }), 5 * 60_000))
      .toEqual({ eligible: false, reason: 'not-worthwhile' });
  });

  it('accepts the same conversation after a long-cache request', () => {
    expect(assessColdCompaction(inputs({ contextTokens: () => 200_000 }), 60 * 60_000))
      .toEqual({ eligible: true, contextTokens: 200_000, floorTokens: 40_000 });
  });
});

describe('lastActivityMs', () => {
  const now = Date.UTC(2026, 7, 8, 12, 0, 0);
  const sqliteTs = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

  it('takes the newer of the stored message and the explicit interaction', () => {
    const messageAt = now - 90 * 60_000;
    expect(lastActivityMs(sqliteTs(messageAt), undefined)).toBe(messageAt);
    expect(lastActivityMs(sqliteTs(messageAt), now - 60_000)).toBe(now - 60_000);
  });

  it('returns 0 for a session with no recorded activity (never cold-compacted)', () => {
    expect(lastActivityMs(undefined, undefined)).toBe(0);
    expect(lastActivityMs('not-a-date', undefined)).toBe(0);
  });
});
