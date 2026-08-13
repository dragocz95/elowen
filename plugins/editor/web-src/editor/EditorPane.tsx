'use client';
import { useRef } from 'react';
import { MonacoEditor } from './monacoLoader';
import { langOf } from './helpers';
import { runtime } from '../runtime';

/** Monaco editor for one file. Cmd/Ctrl+S saves (always the latest handler via a ref, so the
 *  keybinding never goes stale). */
export function EditorPane({ path, value, onChange, onSave, wordWrap }: {
  path: string; value: string; onChange: (v: string) => void; onSave: () => void; wordWrap: boolean;
}) {
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  return (
    <MonacoEditor
      key={path}
      height="100%"
      theme={runtime().utils.editorTheme()}
      beforeMount={runtime().utils.defineEditorThemes}
      onMount={(editor, monaco) => { editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current()); }}
      language={langOf(path)}
      value={value}
      onChange={(v) => onChange(v ?? '')}
      options={{ fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true, padding: { top: 10 }, wordWrap: wordWrap ? 'on' : 'off' }}
    />
  );
}
