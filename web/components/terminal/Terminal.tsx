'use client';
import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useSessionStream } from '../../lib/useSessionStream';
import { orcaClient } from '../../lib/orcaClient';
import { composeFrame } from './frame';

export function Terminal({ name }: { name: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const paneRef = useRef<string>('');
  const lastSize = useRef<string>('');
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pane = useSessionStream(name);

  useEffect(() => {
    if (!ref.current) return;
    const term = new XTerm({ convertEol: true, cursorBlink: false, fontSize: 12, theme: { background: '#000000' } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current);
    termRef.current = term;
    fitRef.current = fit;

    // Push xterm's fitted dimensions to the tmux pane so the running agent — especially
    // full-screen TUIs like opencode — redraws at exactly our width instead of wrapping.
    const pushSize = () => {
      const t = termRef.current;
      if (!t) return;
      const key = `${t.cols}x${t.rows}`;
      if (key === lastSize.current) return;
      lastSize.current = key;
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
      resizeTimer.current = setTimeout(() => { orcaClient.resizeSession(name, t.cols, t.rows).catch(() => {}); }, 150);
    };

    // Defer first fit to next animation frame so the modal/container has
    // been painted and has real dimensions before xterm measures columns.
    const rafId = requestAnimationFrame(() => {
      if (termRef.current) { fit.fit(); pushSize(); }
    });

    // Refit on container resize; repaint current pane so content appears
    // the instant the terminal is sized (e.g. when the modal opens).
    const ro = new ResizeObserver(() => {
      if (!termRef.current) return;
      fit.fit();
      pushSize();
      if (paneRef.current) termRef.current.write(composeFrame(paneRef.current));
    });
    ro.observe(ref.current);

    return () => {
      cancelAnimationFrame(rafId);
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [name]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (pane === paneRef.current) return;
    paneRef.current = pane;
    term.write(composeFrame(pane));
  }, [pane]);

  return <div ref={ref} className="h-full w-full border border-border bg-bg" />;
}
