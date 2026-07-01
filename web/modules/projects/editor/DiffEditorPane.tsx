'use client';
import { MonacoDiffEditor } from './monacoLoader';
import { defineEditorThemes } from './oledTheme';
import { langOf } from './helpers';
import { useTheme } from '../../../lib/useTheme';

/** Native Monaco side-by-side diff: original (file at HEAD) vs modified (working content). Read-only. */
export function DiffEditorPane({ path, original, modified }: { path: string; original: string; modified: string }) {
  const { resolvedTheme } = useTheme();
  return (
    <MonacoDiffEditor
      key={path}
      height="100%"
      theme={resolvedTheme === 'light' ? 'orca-light' : 'orca-oled'}
      beforeMount={defineEditorThemes}
      language={langOf(path)}
      original={original}
      modified={modified}
      options={{ readOnly: true, renderSideBySide: true, fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true, ignoreTrimWhitespace: false }}
    />
  );
}
