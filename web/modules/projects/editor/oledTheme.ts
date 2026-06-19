/** Our OLED black Monaco theme — pure-black canvas + the app's accent/status colors, so the editor
 *  matches the rest of the design instead of VS Code's grey. Defined before the editor mounts. */
export function defineOledTheme(monaco: { editor: { defineTheme: (n: string, t: unknown) => void } }) {
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
}
