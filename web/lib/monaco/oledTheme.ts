/** Elowen's Monaco themes. The built-in design is a true-black OLED canvas with Ember interaction
 *  colors ('elowen-oled'); a light SKIN flips the whole app to a paper canvas, so a matching light
 *  editor ('elowen-paper') registers alongside it and `editorTheme()` picks by the document's
 *  resolved color-scheme — the one signal a skin already controls, so no component ever needs to
 *  know skin names. */
type Monaco = { editor: { defineTheme: (n: string, t: unknown) => void } };

export function defineEditorThemes(monaco: Monaco) {
  monaco.editor.defineTheme('elowen-oled', {
    base: 'vs-dark', inherit: true,
    rules: [
      { token: '', foreground: 'f7f3f0' },
      { token: 'comment', foreground: '6a6a6a', fontStyle: 'italic' },
      { token: 'string', foreground: '22c55e' },
      { token: 'number', foreground: 'f59e0b' },
      { token: 'keyword', foreground: '4d8bff' },
      { token: 'type', foreground: '4d8bff' },
      { token: 'delimiter', foreground: '9a9a9a' },
      { token: 'tag', foreground: '4d8bff' },
    ],
    colors: {
      'editor.background': '#000000',
      'editor.foreground': '#f7f3f0',
      'editorLineNumber.foreground': '#40332e',
      'editorLineNumber.activeForeground': '#ff735c',
      'editor.lineHighlightBackground': '#090807',
      'editor.lineHighlightBorder': '#00000000',
      'editor.selectionBackground': '#ff52364d',
      'editor.inactiveSelectionBackground': '#ff523629',
      'editor.selectionHighlightBackground': '#ff735c24',
      'editorCursor.foreground': '#ff735c',
      'editor.findMatchBackground': '#ff523652',
      'editor.findMatchHighlightBackground': '#ff735c29',
      'editorGutter.background': '#000000',
      'editorWidget.background': '#13100f',
      'editorWidget.border': '#29221f',
      'input.background': '#090807',
      'dropdown.background': '#13100f',
      'editorIndentGuide.background1': '#1b1614',
      'minimap.background': '#000000',
      'diffEditor.insertedTextBackground': '#22c55e22',
      'diffEditor.removedTextBackground': '#ef444422',
      'diffEditor.insertedLineBackground': '#22c55e14',
      'diffEditor.removedLineBackground': '#ef444414',
    },
  });
  monaco.editor.defineTheme('elowen-paper', {
    base: 'vs', inherit: true,
    rules: [
      { token: '', foreground: '0f1c2e' },
      { token: 'comment', foreground: '8a97ab', fontStyle: 'italic' },
      { token: 'string', foreground: '15803d' },
      { token: 'number', foreground: 'b45309' },
      { token: 'keyword', foreground: '2563eb' },
      { token: 'type', foreground: '2563eb' },
      { token: 'delimiter', foreground: '5c6b80' },
      { token: 'tag', foreground: '2563eb' },
    ],
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#0f1c2e',
      'editorLineNumber.foreground': '#b6c2d4',
      'editorLineNumber.activeForeground': '#2563eb',
      'editor.lineHighlightBackground': '#f4f7fc',
      'editor.lineHighlightBorder': '#00000000',
      'editor.selectionBackground': '#2563eb2e',
      'editor.inactiveSelectionBackground': '#2563eb1a',
      'editor.selectionHighlightBackground': '#2563eb17',
      'editorCursor.foreground': '#2563eb',
      'editor.findMatchBackground': '#2563eb3d',
      'editor.findMatchHighlightBackground': '#2563eb1f',
      'editorGutter.background': '#ffffff',
      'editorWidget.background': '#ffffff',
      'editorWidget.border': '#e3e8f1',
      'input.background': '#f8fafd',
      'dropdown.background': '#ffffff',
      'editorIndentGuide.background1': '#eef2f8',
      'minimap.background': '#ffffff',
      'diffEditor.insertedTextBackground': '#15803d22',
      'diffEditor.removedTextBackground': '#dc262622',
      'diffEditor.insertedLineBackground': '#15803d12',
      'diffEditor.removedLineBackground': '#dc262612',
    },
  });
}

/** The Monaco theme matching the app's current design: paper when the active skin resolved the
 *  document to a light color-scheme, the OLED theme otherwise (including SSR, where the dark
 *  default matches the built-in design). */
export function editorTheme(): 'elowen-oled' | 'elowen-paper' {
  if (typeof document === 'undefined') return 'elowen-oled';
  return getComputedStyle(document.documentElement).colorScheme === 'light' ? 'elowen-paper' : 'elowen-oled';
}
