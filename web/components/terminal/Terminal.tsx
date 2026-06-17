'use client';
import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useSessionStream } from '../../lib/useSessionStream';

export function Terminal({ name }: { name: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const pane = useSessionStream(name);

  useEffect(() => {
    if (!ref.current) return;
    const term = new XTerm({ convertEol: true, fontSize: 12, theme: { background: '#000000' } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    // spec §4.3 — refit terminal on container resize
    const ro = new ResizeObserver(() => { fit.fit(); });
    ro.observe(ref.current);

    return () => { ro.disconnect(); term.dispose(); termRef.current = null; fitRef.current = null; };
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (term) { term.clear(); term.write(pane); }
  }, [pane]);

  return <div ref={ref} className="h-64 w-full border border-border bg-bg" />;
}
