'use client';
import { MonacoDiffEditor } from './monacoLoader';
import { defineOledTheme } from './oledTheme';
import { langOf } from './helpers';

/** Native Monaco side-by-side diff: original (file at HEAD) vs modified (working content). Read-only. */
export function DiffEditorPane({ path, original, modified }: { path: string; original: string; modified: string }) {
  return (
    <MonacoDiffEditor
      key={path}
      height="100%"
      theme="orca-oled"
      beforeMount={defineOledTheme}
      language={langOf(path)}
      original={original}
      modified={modified}
      options={{ readOnly: true, renderSideBySide: true, fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true, ignoreTrimWhitespace: false }}
    />
  );
}
