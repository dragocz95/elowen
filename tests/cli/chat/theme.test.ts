import { describe, it, expect } from 'vitest';
import { chatTheme, chatThemeItems, color, glyph, isChatThemeName, setChatTheme } from '../../../src/cli/chat/theme.js';

describe('chat theme', () => {
  it('colour helpers wrap text in an ANSI sequence and reset', () => {
    const out = color.accent('hi');
    expect(out.startsWith('\x1b[')).toBe(true);
    expect(out.endsWith('\x1b[0m')).toBe(true);
    expect(out).toContain('hi');
  });

  it('exposes the Orca brand glyphs', () => {
    expect(glyph.whale).toBe('orca');
    expect(glyph.tool).toBe('*');
  });

  it('switches the active terminal theme at runtime', () => {
    const before = chatTheme().name;
    expect(isChatThemeName('mono')).toBe(true);
    expect(isChatThemeName('missing')).toBe(false);
    setChatTheme('mono');
    expect(chatTheme().name).toBe('mono');
    expect(chatThemeItems().some((item) => item.value === 'mono' && item.description === 'current')).toBe(true);
    setChatTheme(before);
  });

  it('ships a wide palette and every listed theme is a valid, switchable name', () => {
    const items = chatThemeItems();
    expect(items.length).toBeGreaterThanOrEqual(13);
    const before = chatTheme().name;
    for (const item of items) {
      expect(isChatThemeName(item.value)).toBe(true);
      const theme = setChatTheme(item.value);
      // every palette slot must be populated so no component renders an undefined ANSI code
      for (const slot of ['accent', 'text', 'muted', 'faint', 'success', 'warning', 'error', 'panelBg', 'inputBg', 'modalBg', 'selectedBg'] as const) {
        expect(typeof theme[slot]).toBe('string');
        expect(theme[slot].length).toBeGreaterThan(0);
      }
    }
    setChatTheme(before);
  });
});
