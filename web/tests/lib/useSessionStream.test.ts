import { describe, it, expect } from 'vitest';
import { nextPane } from '../../lib/useSessionStream';

describe('nextPane dedupe', () => {
  it('returns the previous reference when unchanged', () => {
    const prev = 'same';
    expect(nextPane(prev, 'same')).toBe(prev);
  });
  it('returns the new value when changed', () => {
    expect(nextPane('old', 'new')).toBe('new');
  });
});
