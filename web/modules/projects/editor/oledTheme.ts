/** Elowen's Monaco theme: a true-black OLED canvas with Ember interaction colors and semantic
 *  syntax/status colors. The application is intentionally dark-only, so registering a parallel
 *  light theme would be dead configuration and risks the embedded editors drifting from the UI. */
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
}
