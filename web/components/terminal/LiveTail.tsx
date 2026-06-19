'use client';
import { useEffect, useRef, useState } from 'react';
import { Maximize2 } from 'lucide-react';
import { useSessionPane } from '../../modules/sessions/useSessionPane';
import { parseAnsi } from '../../modules/sessions/ansi';
import { useTranslation } from '../../lib/i18n';

/** Live, ANSI-coloured tail of a tmux session's pane — the single source of truth for the
 *  "what is the agent doing right now" preview. Polls only while mounted, flashes its edge on
 *  fresh output, and is optionally clickable (onExpand → open the full terminal). */
export function LiveTail({ name, lines = 20, heightClass = 'max-h-80', onExpand }: {
  name: string;
  /** How many trailing pane rows to show — bigger = more of the agent's work visible. */
  lines?: number;
  /** Tailwind height/scroll class for the pane box. */
  heightClass?: string;
  /** When set, the tail is clickable and opens the full terminal. */
  onExpand?: () => void;
}) {
  const { t } = useTranslation();
  const { tail, isLoading } = useSessionPane(name, lines);

  // Flash the edge whenever fresh output streams in.
  const [flash, setFlash] = useState(false);
  const prev = useRef(tail);
  useEffect(() => {
    if (prev.current === tail) return;
    prev.current = tail;
    if (!tail) return;
    setFlash(true);
    const id = setTimeout(() => setFlash(false), 600);
    return () => clearTimeout(id);
  }, [tail]);

  const pane = (
    <pre
      data-flash={flash ? 'true' : undefined}
      className={`tail-live ${heightClass} overflow-auto whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-text-muted`}
    >
      {isLoading ? t.sessions.loading : tail
        ? parseAnsi(tail).map((s, i) => <span key={i} style={s.color ? { color: s.color } : undefined}>{s.text}</span>)
        : t.sessions.noOutput}
    </pre>
  );

  if (!onExpand) {
    return <div className="rounded-md border border-border bg-bg p-3">{pane}</div>;
  }
  return (
    <div className="group relative">
      <div
        role="button"
        tabIndex={0}
        onClick={onExpand}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onExpand(); } }}
        title={t.tasks.openTerminal}
        className="block w-full cursor-pointer rounded-md border border-border bg-bg p-3 transition-colors hover:border-accent/60 focus:border-accent focus:outline-none"
      >
        {pane}
      </div>
      <span className="pointer-events-none absolute right-2 top-2 flex items-center gap-1 rounded-md border border-border bg-surface/90 px-2 py-1 text-[11px] text-text-muted opacity-0 backdrop-blur transition-opacity group-hover:opacity-100">
        <Maximize2 size={12} aria-hidden /> {t.tasks.openTerminal}
      </span>
    </div>
  );
}
