'use client';
import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useTerminalStream } from '../../lib/useTerminalStream';
import { useTheme } from '../../lib/useTheme';
import { Terminal } from './Terminal';
import { xtermTheme } from './xtermTheme';

/** A real-PTY terminal: raw bytes stream over a WebSocket straight from a `tmux attach`, so the cursor,
 *  scrollback and redraws are native — no snapshot mirror. Fully interactive (keystrokes reach the
 *  pane). When the stream is unavailable (node-pty missing, or no reverse proxy fronting the daemon WS)
 *  it falls back to the interactive snapshot `<Terminal>`. */
export function StreamTerminal({ name }: { name: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const streamRef = useRef<{ send: (d: string) => void; resize: (c: number, r: number) => void } | null>(null);
  // Holds the current "fit + push size to the PTY" routine so the WS-open effect below can fire it
  // even though it's created inside the mount effect.
  const syncSizeRef = useRef<() => void>(() => {});
  const [fallback, setFallback] = useState(false);
  const { resolvedTheme } = useTheme();

  // Push every inbound PTY byte straight into xterm. `termRef` is stable, so the callback identity
  // doesn't matter — the hook holds it in a ref and never reconnects on its account.
  const stream = useTerminalStream(name, !fallback, (bytes) => termRef.current?.write(bytes));
  streamRef.current = stream;

  // An unsupported stream → render the snapshot mirror instead (and stop the hook via `enabled=false`).
  useEffect(() => { if (stream.status === 'unsupported') setFallback(true); }, [stream.status]);

  useEffect(() => {
    if (!ref.current || fallback) return;
    const term = new XTerm({ convertEol: false, cursorBlink: true, fontSize: 12, theme: xtermTheme(resolvedTheme) });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current);
    termRef.current = term;

    // Forward every keystroke verbatim to the PTY over the socket.
    const dataSub = term.onData((d) => streamRef.current?.send(d));

    // Fit xterm to the container, then tell the PTY the new size so the attached tmux window resizes
    // (SIGWINCH → the agent TUI redraws to fill the panel). No dedupe: the resize frame is tiny, and
    // it MUST go out again whenever the socket (re)opens — the first fit usually runs before the WS is
    // connected, when the resize would otherwise be dropped, leaving the PTY stuck at its default size.
    const syncSize = () => {
      const t = termRef.current;
      if (!t) return;
      fit.fit();
      streamRef.current?.resize(t.cols, t.rows);
    };
    syncSizeRef.current = syncSize;

    const rafId = requestAnimationFrame(syncSize);
    const ro = new ResizeObserver(syncSize);
    ro.observe(ref.current);

    return () => {
      cancelAnimationFrame(rafId);
      dataSub.dispose();
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      syncSizeRef.current = () => {};
    };
  }, [name, fallback]);

  // Repaint the palette in place on theme toggle — avoids tearing down and recreating the terminal
  // (which would drop scrollback and reset the PTY size negotiation).
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = xtermTheme(resolvedTheme);
  }, [resolvedTheme]);

  // Re-push the size the moment the socket opens: the initial fit almost always runs before the WS is
  // ready, so without this the PTY never learns the real terminal size and the content can't fill the panel.
  useEffect(() => { if (stream.status === 'open') syncSizeRef.current(); }, [stream.status]);

  if (fallback) return <Terminal name={name} interactive />;
  return <div ref={ref} className="h-full w-full border border-border bg-bg" />;
}
