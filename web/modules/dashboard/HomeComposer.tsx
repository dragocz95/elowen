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
      // The lit/unlit shadow pair lives in the stylesheet (.home-composer, dashboard-cosmos.css): both
      // compose `color-mix()`, whose own commas cannot survive a Tailwind arbitrary value.
      className="home-composer group relative flex min-h-28 flex-col rounded-2xl border border-primary/45 bg-background/45 p-3 transition-[border-color,box-shadow] focus-within:border-primary"
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
        className="min-h-16 w-full resize-none bg-transparent px-1 py-1 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/70"
      />
      <div className="mt-auto flex items-center justify-between gap-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-full border border-border bg-muted/70 text-primary" aria-hidden><Flame size={14} /></span>
        <button type="submit" aria-label={actionLabel} title={actionLabel} className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-background transition-[transform,filter] hover:brightness-110 active:scale-95">
          <ArrowUp size={17} strokeWidth={2.4} aria-hidden />
        </button>
      </div>
    </form>
  );
}
