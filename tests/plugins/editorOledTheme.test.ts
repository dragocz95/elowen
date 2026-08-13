import { describe, expect, it } from 'vitest';
import { defineEditorThemes, editorTheme } from '../../web/lib/monaco/oledTheme';

interface CapturedTheme {
  base?: string;
  rules?: { token: string; foreground?: string }[];
  colors?: Record<string, string>;
}

function capture(): { name: string; theme: CapturedTheme }[] {
  const captured: { name: string; theme: CapturedTheme }[] = [];
  defineEditorThemes({
    editor: {
      defineTheme: (name, theme) => captured.push({ name, theme: theme as CapturedTheme }),
    },
  });
  return captured;
}

describe('defineEditorThemes', () => {
  it('registers the OLED theme with Ember interaction colors and semantic syntax colors', () => {
    const captured = capture();

    expect(captured).toHaveLength(2);
    expect(captured[0]?.name).toBe('elowen-oled');
    expect(captured[0]?.theme.base).toBe('vs-dark');
    expect(captured[0]?.theme.colors?.['editor.background']).toBe('#000000');
    expect(captured[0]?.theme.colors?.['editorCursor.foreground']).toBe('#ff735c');
    expect(captured[0]?.theme.colors?.['editor.selectionBackground']).toBe('#ff52364d');

    const rules = captured[0]?.theme.rules ?? [];
    expect(rules.find((rule) => rule.token === 'string')?.foreground).toBe('22c55e');
    expect(rules.find((rule) => rule.token === 'number')?.foreground).toBe('f59e0b');
    expect(rules.find((rule) => rule.token === 'keyword')?.foreground).toBe('4d8bff');
  });

  it('registers the paper theme on a light base, so a light skin has an editor to match', () => {
    const captured = capture();

    expect(captured[1]?.name).toBe('elowen-paper');
    expect(captured[1]?.theme.base).toBe('vs');
    expect(captured[1]?.theme.colors?.['editor.background']).toBe('#ffffff');
    expect(captured[1]?.theme.colors?.['editorCursor.foreground']).toBe('#2563eb');
  });
});

describe('editorTheme', () => {
  it('answers the dark default where there is no document to read (SSR)', () => {
    expect(editorTheme()).toBe('elowen-oled');
  });
});
