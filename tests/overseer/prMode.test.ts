import { describe, it, expect } from 'vitest';
import { resolvePrEnabled } from '../../src/overseer/prMode.js';

describe('prMode.resolvePrEnabled', () => {
  it('an explicit override wins over everything', () => {
    expect(resolvePrEnabled(true, false, false)).toBe(true);
    expect(resolvePrEnabled(false, true, true)).toBe(false);
  });
  it('falls through to the project override when there is no per-task override', () => {
    expect(resolvePrEnabled(null, true, false)).toBe(true);
    expect(resolvePrEnabled(null, false, true)).toBe(false);
  });
  it('falls through to the global default when neither override is set', () => {
    expect(resolvePrEnabled(null, null, true)).toBe(true);
    expect(resolvePrEnabled(null, undefined, false)).toBe(false);
  });
});
