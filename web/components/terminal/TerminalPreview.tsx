'use client';
import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { ResolvedTheme } from '../../lib/useTheme';
import type { TerminalSettings } from '../../lib/types';
import { xtermBackground, xtermTheme } from './xtermTheme';
import { FONT_STACKS } from './palettes';

// A fixed sample that exercises the whole palette: a shell prompt (foreground + named colours), the 3
// status colours, the 8 normal + 8 bright ANSI background swatches, and a trailing prompt so the cursor
// style is visible. Deterministic on purpose — the preview must only change with the settings.
const SAMPLE = [
  '\x1b[32m➜\x1b[0m \x1b[36m~/elowen\x1b[0m \x1b[90mgit:(\x1b[0m\x1b[35mmain\x1b[0m\x1b[90m)\x1b[0m elowen run build',
  '\x1b[32m✓ build green\x1b[0m  \x1b[33m⚠ 2 warnings\x1b[0m  \x1b[31m✗ 1 failed\x1b[0m  \x1b[90m(1.4s)\x1b[0m',
  '\x1b[40m  \x1b[41m  \x1b[42m  \x1b[43m  \x1b[44m  \x1b[45m  \x1b[46m  \x1b[47m  \x1b[0m',
  '\x1b[100m  \x1b[101m  \x1b[102m  \x1b[103m  \x1b[104m  \x1b[105m  \x1b[106m  \x1b[107m  \x1b[0m',
  '',
  '\x1b[32m➜\x1b[0m \x1b[36m~/elowen\x1b[0m ',
].join('\r\n');

// macOS-style titlebar traffic lights. The three hues carry no meaning here — they are window chrome —
// so they take the design's own three status tones rather than the macOS literals they imitate, and a
// skin repaints the preview frame along with everything else.
const DOTS = ['var(--color-danger)', 'var(--color-warning)', 'var(--color-success)'];

/** Whether a `#rrggbb` background is light — picks the titlebar chrome colour (the frame is filled with
 *  the terminal's own background, which is independent of the app theme). */
function isLightBg(hex: string): boolean {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255) > 140;
}

/** A non-interactive xterm rendering a fixed ANSI sample under the in-progress (unsaved) terminal
 *  settings, framed as a mini terminal window, so the Account section shows palette/font/cursor changes
 *  live before they're saved. */
export function TerminalPreview({ settings, resolvedTheme }: { settings: TerminalSettings; resolvedTheme: ResolvedTheme }) {
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Initial values for the mount effect, held in a ref so the effect keys on nothing (updates go through
  // the redraw effect below) without tripping exhaustive-deps.
  const initial = useRef({ settings, resolvedTheme });

  useEffect(() => {
    if (!ref.current) return;
    const { settings: s, resolvedTheme: rt } = initial.current;
    const term = new XTerm({
      convertEol: true, disableStdin: true, cursorBlink: false,
      // The preview terminal is never focused; mirror the chosen style on the inactive cursor too.
      cursorInactiveStyle: s.cursorStyle,
      fontSize: s.fontSize, fontFamily: FONT_STACKS[s.fontFamily], cursorStyle: s.cursorStyle,
      theme: xtermTheme(rt, s),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current);
    termRef.current = term;
    fitRef.current = fit;
    const raf = requestAnimationFrame(() => { fitRef.current?.fit(); term.write(SAMPLE); });
    return () => { cancelAnimationFrame(raf); term.dispose(); termRef.current = null; fitRef.current = null; };
  }, []);

  // Re-apply appearance and redraw the sample on any settings/theme change.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = xtermTheme(resolvedTheme, settings);
    term.options.fontSize = settings.fontSize;
    term.options.fontFamily = FONT_STACKS[settings.fontFamily];
    term.options.cursorStyle = settings.cursorStyle;
    term.options.cursorInactiveStyle = settings.cursorStyle;
    fitRef.current?.fit();
    term.reset();
    term.write(SAMPLE);
  }, [settings, resolvedTheme]);

  const bg = xtermBackground(resolvedTheme, settings);
  // The frame's hairline and its caption are a wash over the TERMINAL's background, not over an app
  // surface, so neither can come from a design token: a light palette inside a dark app needs dark
  // chrome and vice versa. Mixed INTO that background rather than layered over it with an alpha —
  // against an opaque backdrop the two produce the identical colour, and the mix keeps the extremes as
  // the CSS keywords they are instead of two more colour literals in the component tree.
  const ink = isLightBg(bg) ? 'black' : 'white';
  const chrome = (percent: number) => `color-mix(in srgb, ${ink} ${percent}%, ${bg})`;
  return (
    <div data-testid="terminal-preview" className="min-w-0 max-w-full overflow-hidden rounded-lg border border-border" style={{ backgroundColor: bg }}>
      <div className="flex items-center gap-1.5 px-3.5 py-2.5" style={{ borderBottom: `1px solid ${chrome(10)}` }}>
        {DOTS.map((c) => <span key={c} className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: c }} aria-hidden />)}
        <span className="ml-2 truncate font-mono text-[10px]" style={{ color: chrome(45) }}>elowen</span>
      </div>
      <div className="min-w-0 overflow-hidden px-3.5 py-3">
        <div ref={ref} className="h-40 min-w-0 max-w-full overflow-hidden [&_.xterm]:max-w-full [&_.xterm-screen]:max-w-full [&_.xterm-viewport]:[scrollbar-width:none] [&_.xterm-viewport::-webkit-scrollbar]:hidden" />
      </div>
    </div>
  );
}
