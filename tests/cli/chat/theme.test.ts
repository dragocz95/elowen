import { describe, it, expect } from 'vitest';
import { color, glyph } from '../../../src/cli/chat/theme.js';

describe('chat theme', () => {
  it('colour helpers wrap text in an ANSI sequence and reset', () => {
    const out = color.accent('hi');
    expect(out.startsWith('\x1b[')).toBe(true);
    expect(out.endsWith('\x1b[0m')).toBe(true);
    expect(out).toContain('hi');
  });

  it('exposes the Orca brand glyphs', () => {
    expect(glyph.whale).toBe('🐋');
    expect(glyph.tool).toBe('⚙');
  });
});
