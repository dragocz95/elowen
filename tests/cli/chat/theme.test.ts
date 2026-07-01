import { describe, it, expect } from 'vitest';
import { color, glyph, spinnerFrames, orcaMarkdownTheme, orcaEditorTheme } from '../../../src/cli/chat/theme.js';

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
    expect(spinnerFrames.length).toBeGreaterThan(0);
  });

  it('markdown theme implements every required renderer', () => {
    for (const key of ['heading', 'link', 'code', 'bold', 'italic', 'listBullet', 'quote'] as const) {
      expect(typeof orcaMarkdownTheme[key]).toBe('function');
    }
  });

  it('editor theme has a border colour and a select list theme', () => {
    expect(typeof orcaEditorTheme.borderColor).toBe('function');
    expect(typeof orcaEditorTheme.selectList.selectedText).toBe('function');
  });
});
