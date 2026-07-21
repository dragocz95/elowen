import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs plugin module, no types
import { isSteered } from '../../plugins/_shared/turnResult.mjs';

describe('shared turn result — isSteered', () => {
  it('treats the empty-string sentinel as a steered (injected) message', () => {
    expect(isSteered('')).toBe(true);
  });

  it('treats any real assistant reply as answered, not steered', () => {
    expect(isSteered('done')).toBe(false);
    expect(isSteered(' ')).toBe(false);
    expect(isSteered('✅ hotovo')).toBe(false);
  });
});
