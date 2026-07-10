import { describe, expect, it } from 'vitest';
import { defineEditorThemes } from '../../../../modules/projects/editor/oledTheme';

interface CapturedTheme {
  base?: string;
  rules?: { token: string; foreground?: string }[];
  colors?: Record<string, string>;
}

describe('defineEditorThemes', () => {
  it('registers one OLED theme with Ember interaction colors and semantic syntax colors', () => {
    const captured: { name: string; theme: CapturedTheme }[] = [];
    defineEditorThemes({
      editor: {
        defineTheme: (name, theme) => captured.push({ name, theme: theme as CapturedTheme }),
      },
    });

    expect(captured).toHaveLength(1);
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
});
