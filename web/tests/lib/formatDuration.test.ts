import { describe, it, expect } from 'vitest';
import { formatDuration, compactElapsed } from '../../lib/formatDuration';

const S = 1000, M = 60 * S, H = 60 * M, D = 24 * H;

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
