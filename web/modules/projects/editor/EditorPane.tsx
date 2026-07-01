'use client';
import { useRef } from 'react';
import { MonacoEditor } from './monacoLoader';
import { defineEditorThemes } from './oledTheme';
import { langOf } from './helpers';
import { useTheme } from '../../../lib/useTheme';

/** Monaco editor for one file. Cmd/Ctrl+S saves (always the latest handler via a ref, so the
 *  keybinding never goes stale). */
export function EditorPane({ path, value, onChange, onSave, wordWrap }: {
  path: string; value: string; onChange: (v: string) => void; onSave: () => void; wordWrap: boolean;
}) {
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  const { resolvedTheme } = useTheme();
  return (
    <MonacoEditor
      key={path}
      height="100%"
      theme={resolvedTheme === 'light' ? 'orca-light' : 'orca-oled'}
      beforeMount={defineEditorThemes}
      onMount={(editor, monaco) => { editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current()); }}
      language={langOf(path)}
      value={value}
      onChange={(v) => onChange(v ?? '')}
      options={{ fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true, padding: { top: 10 }, wordWrap: wordWrap ? 'on' : 'off' }}
    />
  );
}
