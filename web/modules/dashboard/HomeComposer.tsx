'use client';
import { useState } from 'react';
import { ArrowUp, Flame } from 'lucide-react';
import { openBrainComposer } from '../../lib/brainDock';

export function HomeComposer({ placeholder, actionLabel }: { placeholder: string; actionLabel: string }) {
  const [text, setText] = useState('');
  const open = () => {
    openBrainComposer(text.trim());
    setText('');
  };
  return (
    <form
      className="group relative flex min-h-28 flex-col rounded-2xl border border-accent/45 bg-black/45 p-3 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.04),0_18px_70px_rgb(255_82_54_/_0.08)] transition-[border-color,box-shadow] focus-within:border-accent focus-within:shadow-[inset_0_1px_0_rgb(255_255_255_/_0.05),0_20px_80px_rgb(255_82_54_/_0.14)]"
      onSubmit={(event) => { event.preventDefault(); open(); }}
    >
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); open(); }
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        rows={2}
        className="min-h-16 w-full resize-none bg-transparent px-1 py-1 text-sm leading-relaxed text-text outline-none placeholder:text-text-muted/70"
      />
      <div className="mt-auto flex items-center justify-between gap-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-full border border-border bg-elevated/70 text-accent" aria-hidden><Flame size={14} /></span>
        <button type="submit" aria-label={actionLabel} title={actionLabel} className="flex h-9 w-9 items-center justify-center rounded-full bg-accent text-bg transition-[transform,filter] hover:brightness-110 active:scale-95">
          <ArrowUp size={17} strokeWidth={2.4} aria-hidden />
        </button>
      </div>
    </form>
  );
}
