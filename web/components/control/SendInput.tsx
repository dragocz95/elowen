'use client';
import { useState } from 'react';
import { Button } from '../ui/Button';
export function SendInput({ onSend }: { onSend: (keys: string[]) => void }) {
  const [text, setText] = useState('');
  return (
    <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); if (text) { onSend([text, 'Enter']); setText(''); } }}>
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder="send keys…" className="bg-surface border border-border rounded-none px-2 py-1 text-xs text-text" />
      <Button type="submit">Send</Button>
    </form>
  );
}
