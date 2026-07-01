/** Our Monaco themes — an OLED black canvas for dark mode and a matching light counterpart, both
 *  built from the app's accent/status colors so the editor matches the rest of the design instead
 *  of VS Code's default grey. Both are registered up front (not just the active one) since toggling
 *  the app theme only changes the `theme` prop — it doesn't remount the editor to re-run `beforeMount`. */
type Monaco = { editor: { defineTheme: (n: string, t: unknown) => void } };

export function defineEditorThemes(monaco: Monaco) {
  monaco.editor.defineTheme('orca-oled', {
    base: 'vs-dark', inherit: true,
    rules: [
      { token: '', foreground: 'f5f5f5' },
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
      'editor.foreground': '#f5f5f5',
      'editorLineNumber.foreground': '#3a3a3a',
      'editorLineNumber.activeForeground': '#9a9a9a',
      'editor.lineHighlightBackground': '#0a0a0a',
      'editor.selectionBackground': '#1d3a6e',
      'editorCursor.foreground': '#4d8bff',
      'editorGutter.background': '#000000',
      'editorWidget.background': '#0a0a0a',
      'editorWidget.border': '#2e2e2e',
      'input.background': '#0a0a0a',
      'dropdown.background': '#0a0a0a',
      'editorIndentGuide.background1': '#161616',
      'minimap.background': '#000000',
      'diffEditor.insertedTextBackground': '#22c55e22',
      'diffEditor.removedTextBackground': '#ef444422',
      'diffEditor.insertedLineBackground': '#22c55e14',
      'diffEditor.removedLineBackground': '#ef444414',
    },
  });
  monaco.editor.defineTheme('orca-light', {
    base: 'vs', inherit: true,
    rules: [
      { token: '', foreground: '232323' },
      { token: 'comment', foreground: '767676', fontStyle: 'italic' },
      { token: 'string', foreground: '15803d' },
      { token: 'number', foreground: 'b45309' },
      { token: 'keyword', foreground: '1d4ed8' },
      { token: 'type', foreground: '1d4ed8' },
      { token: 'delimiter', foreground: '6b6b6b' },
      { token: 'tag', foreground: '1d4ed8' },
    ],
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#232323',
      'editorLineNumber.foreground': '#b0b0b0',
      'editorLineNumber.activeForeground': '#6b6b6b',
      'editor.lineHighlightBackground': '#f5f5f5',
      'editor.selectionBackground': '#cfe0ff',
      'editorCursor.foreground': '#1d4ed8',
      'editorGutter.background': '#ffffff',
      'editorWidget.background': '#fafafa',
      'editorWidget.border': '#e2e2e2',
      'input.background': '#fafafa',
      'dropdown.background': '#fafafa',
      'editorIndentGuide.background1': '#eeeeee',
      'minimap.background': '#ffffff',
      'diffEditor.insertedTextBackground': '#22c55e22',
      'diffEditor.removedTextBackground': '#ef444422',
      'diffEditor.insertedLineBackground': '#22c55e14',
      'diffEditor.removedLineBackground': '#ef444414',
    },
  });
}
