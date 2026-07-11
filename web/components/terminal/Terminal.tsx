'use client';
import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useSessionStream } from '../../lib/useSessionStream';
import { elowenClient } from '../../lib/elowenClient';
import { useTheme } from '../../lib/useTheme';
import { useTerminalPrefs } from '../../lib/useTerminalPrefs';
import { composeFrame } from './frame';
import { xtermTheme } from './xtermTheme';
import { FONT_STACKS } from './palettes';

export function Terminal({ name, interactive = false }: { name: string; interactive?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const paneRef = useRef<string>('');
  const lastSize = useRef<string>('');
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pane = useSessionStream(name);
  const { resolvedTheme } = useTheme();
  const prefs = useTerminalPrefs();
  // Latest theme + user prefs, read once when the terminal is created. Held in refs so the mount effect
  // isn't reactive to them (re-running it would drop scrollback + reset PTY size); the repaint effect
  // below applies live theme/prefs changes in place.
  const themeRef = useRef(resolvedTheme);
  themeRef.current = resolvedTheme;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  useEffect(() => {
    if (!ref.current) return;
    const p = prefsRef.current;
    const term = new XTerm({
      convertEol: true,
      // A read-only mirror never blinks; an interactive dock respects the user's cursor-blink pref.
      cursorBlink: interactive && p.cursorBlink,
      cursorStyle: p.cursorStyle,
      fontSize: p.fontSize,
      fontFamily: FONT_STACKS[p.fontFamily],
      scrollback: p.scrollback,
      theme: xtermTheme(themeRef.current, p),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current);
    termRef.current = term;
    fitRef.current = fit;

    // Interactive mode (advisor dock): forward EVERY keystroke verbatim. xterm `onData` yields the
    // exact terminal bytes (printable chars, control codes, ESC sequences); the daemon replays them
    // with `send-keys -l`, so arrows/Ctrl/Enter all reach the agent like in a real terminal.
    const dataSub = interactive ? term.onData((data) => { void elowenClient.sessionInput(name, data).catch(() => {}); }) : null;

    // Push xterm's fitted dimensions to the tmux pane so the running agent — especially
    // full-screen TUIs like opencode — redraws at exactly our width instead of wrapping.
    const pushSize = () => {
      const t = termRef.current;
      if (!t) return;
      const key = `${t.cols}x${t.rows}`;
      if (key === lastSize.current) return;
      lastSize.current = key;
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
      resizeTimer.current = setTimeout(() => { elowenClient.resizeSession(name, t.cols, t.rows).catch(() => {}); }, 150);
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
      dataSub?.dispose();
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [name, interactive]);

  // Apply theme toggles + user pref changes in place — no tear-down (which would drop scrollback and the
  // current pane frame). Font-size/family changes alter cell metrics, so refit afterwards.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = xtermTheme(resolvedTheme, prefs);
    term.options.fontSize = prefs.fontSize;
    term.options.fontFamily = FONT_STACKS[prefs.fontFamily];
    term.options.cursorStyle = prefs.cursorStyle;
    term.options.cursorBlink = interactive && prefs.cursorBlink;
    term.options.scrollback = prefs.scrollback;
    fitRef.current?.fit();
  }, [resolvedTheme, prefs, interactive]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (pane === paneRef.current) return;
    paneRef.current = pane;
    term.write(composeFrame(pane));
  }, [pane]);

  return <div ref={ref} className="elowen-terminal h-full w-full overflow-hidden border border-border bg-bg" />;
}
