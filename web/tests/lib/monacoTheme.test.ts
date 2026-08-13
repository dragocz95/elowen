import { describe, expect, it } from 'vitest';
import { editorTheme } from '../../lib/monaco/oledTheme';

// The colour tables themselves are asserted in tests/plugins/editorOledTheme.test.ts (no DOM needed).
// This is the half that only means anything in a document: which table the app asks Monaco for.
describe('editorTheme', () => {
  it('follows the document color-scheme a skin controls, not a skin name', () => {
    // jsdom resolves an unset color-scheme to 'normal', which is not 'light' — the built-in dark design.
    expect(editorTheme()).toBe('elowen-oled');

    document.documentElement.style.colorScheme = 'light';
    try {
      expect(editorTheme()).toBe('elowen-paper');
    } finally {
      document.documentElement.style.colorScheme = '';
    }
  });
});
