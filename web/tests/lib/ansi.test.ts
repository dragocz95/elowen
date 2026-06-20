import { describe, it, expect } from 'vitest';
import { parseAnsi } from '../../lib/ansi';

const ESC = '\x1b';

describe('parseAnsi', () => {
  it('returns a single uncolored segment for plain text', () => {
    expect(parseAnsi('hello world')).toEqual([{ text: 'hello world', color: undefined }]);
  });

  it('colors text between an SGR code and reset', () => {
    const segs = parseAnsi(`ok ${ESC}[31mFAIL${ESC}[0m done`);
    expect(segs[0]).toEqual({ text: 'ok ', color: undefined });
    expect(segs[1]).toEqual({ text: 'FAIL', color: '#ef4444' });
    expect(segs[2]).toEqual({ text: ' done', color: undefined });
  });

  it('handles 256-color and truecolor foreground', () => {
    const segs = parseAnsi(`${ESC}[38;5;46mA${ESC}[0m${ESC}[38;2;10;20;30mB${ESC}[0m`);
    expect(segs[0].text).toBe('A');
    expect(segs[0].color).toMatch(/^rgb\(/);
    expect(segs[1].color).toBe('rgb(10,20,30)');
  });

  it('strips non-color control sequences but keeps literal brackets in text', () => {
    const segs = parseAnsi(`${ESC}[2K${ESC}[1Gconst a = [1, 2]`);
    expect(segs.map((s) => s.text).join('')).toBe('const a = [1, 2]');
  });
});
