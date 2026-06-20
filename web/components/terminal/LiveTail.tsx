'use client';
import { useEffect, useRef, useState } from 'react';
import { Maximize2 } from 'lucide-react';
import { useSessionPane } from '../../lib/useSessionPane';
import { parseAnsi } from '../../lib/ansi';
import { useTranslation } from '../../lib/i18n';

/** Live, ANSI-coloured tail of a tmux session's pane — the single source of truth for the
 *  "what is the agent doing right now" preview. Polls only while mounted, and is optionally
 *  clickable (onExpand → open the full terminal). */
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

  // Full-screen TUIs (opencode) draw a wide, box-drawn layout that mangles if it wraps. Keep the
  // pane unwrapped and shrink the whole thing to fit the panel width so the entire UI stays visible.
  const boxRef = useRef<HTMLDivElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const [fit, setFit] = useState({ scale: 1, h: 0 });
  useEffect(() => {
    const box = boxRef.current, pre = preRef.current;
    if (!box || !pre) return;
    const measure = () => {
      const cw = pre.scrollWidth, ch = pre.scrollHeight, bw = box.clientWidth;
      if (!cw || !bw) return;
      const scale = Math.min(1, bw / cw); // never upscale short, plain-text output
      setFit({ scale, h: Math.ceil(ch * scale) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  }, [tail]);

  const pane = (
    <div
      ref={boxRef}
      className={`${heightClass} overflow-auto`}
    >
      <div className="overflow-hidden" style={{ height: fit.h || undefined }}>
        <pre
          ref={preRef}
          style={{ transform: fit.scale < 1 ? `scale(${fit.scale})` : undefined, transformOrigin: 'top left' }}
          className="w-max whitespace-pre font-mono text-xs leading-relaxed text-text-muted"
        >
          {isLoading ? t.sessions.loading : tail
            ? parseAnsi(tail).map((s, i) => <span key={i} style={s.color ? { color: s.color } : undefined}>{s.text}</span>)
            : t.sessions.noOutput}
        </pre>
      </div>
    </div>
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
