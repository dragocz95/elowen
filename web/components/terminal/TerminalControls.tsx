'use client';
import { useState } from 'react';
import { Button } from '../ui/Button';

const QUICK_KEYS: { label: string; keys: string[] }[] = [
  { label: 'Enter', keys: ['Enter'] },
  { label: 'Ctrl-C', keys: ['C-c'] },
  { label: 'Esc', keys: ['Escape'] },
  { label: 'Tab', keys: ['Tab'] },
  { label: '↑', keys: ['Up'] },
  { label: '↓', keys: ['Down'] },
];

export function TerminalControls({
  onSendKeys,
  onKill,
  busy = false,
}: {
  onSendKeys: (keys: string[]) => void;
  onKill: () => void;
  busy?: boolean;
}) {
  const [text, setText] = useState('');
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border bg-surface px-3 py-2">
      <form
        className="flex items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = text.trim();
          if (trimmed) {
            onSendKeys([trimmed, 'Enter']);
            setText('');
          }
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="command…"
          className="bg-bg border border-border rounded-none px-2 py-1 font-mono text-xs text-text"
          disabled={busy}
        />
        <Button type="submit" disabled={busy}>Send</Button>
      </form>
      <div className="flex items-center gap-1">
        {QUICK_KEYS.map((k) => (
          <Button key={k.label} onClick={() => onSendKeys(k.keys)} disabled={busy}>{k.label}</Button>
        ))}
      </div>
      <div className="ml-auto">
        <Button variant="danger" onClick={onKill} disabled={busy}>Kill</Button>
      </div>
    </div>
  );
}
