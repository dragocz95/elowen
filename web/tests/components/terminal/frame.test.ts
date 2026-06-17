import { describe, it, expect } from 'vitest';
import { composeFrame } from '../../../components/terminal/frame';

const CLEAR = '\x1b[H\x1b[2J';

describe('composeFrame', () => {
  it('prefixes the clear/home sequence then the pane body', () => {
    expect(composeFrame('hello')).toBe(`${CLEAR}hello`);
  });
  it('handles an empty pane', () => {
    expect(composeFrame('')).toBe(CLEAR);
  });
});
