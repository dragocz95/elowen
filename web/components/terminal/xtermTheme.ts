import type { ITheme } from '@xterm/xterm';
import type { ResolvedTheme } from '../../lib/useTheme';
import type { TerminalSettings, TerminalPalette } from '../../lib/types';
import { PALETTE_KEYS } from './palettes';

/** xterm's own light/dark palettes — mirrors the app's `data-theme` since xterm can't read CSS
 *  custom properties (its renderer wants literal color strings). The ANSI colors are re-tuned for
 *  light backgrounds too: xterm's defaults assume a dark terminal, so on white they'd wash out. */
const DARK: ITheme = {
  background: '#000000',
  foreground: '#f5f5f5',
  cursor: '#f5f5f5',
  cursorAccent: '#000000',
  selectionBackground: '#2c4870',
};

const LIGHT: ITheme = {
  background: '#ffffff',
  foreground: '#232323',
  cursor: '#232323',
  cursorAccent: '#ffffff',
  selectionBackground: '#cfe0ff',
  black: '#232323',
  red: '#c4314b',
  green: '#166534',
  yellow: '#946200',
  blue: '#1d4ed8',
  magenta: '#9333ea',
  cyan: '#0e7490',
  white: '#6b6b6b',
  brightBlack: '#6b6b6b',
  brightRed: '#dc2626',
  brightGreen: '#16a34a',
  brightYellow: '#ca8a04',
  brightBlue: '#2563eb',
  brightMagenta: '#a855f7',
  brightCyan: '#0891b2',
  brightWhite: '#111827',
};

const isHex6 = (v: string): boolean => /^#[0-9a-f]{6}$/i.test(v);

/** Turn a user palette into an xterm ITheme, dropping any non-`#rrggbb` value (defensive — the server
 *  already validates, but an old/corrupt cached blob shouldn't poison the renderer). */
function paletteTheme(p: TerminalPalette): ITheme {
  const out: Record<string, string> = {};
  for (const k of PALETTE_KEYS) { const v = p[k]; if (isHex6(v)) out[k] = v; }
  return out as ITheme;
}

/** The xterm theme for a terminal: the user's custom palette when `prefs.theme==='custom'`, otherwise
 *  the app-theme-following light/dark default (unchanged pre-feature behaviour). */
export function xtermTheme(resolvedTheme: ResolvedTheme, prefs?: TerminalSettings): ITheme {
  if (prefs?.theme === 'custom') return paletteTheme(prefs.palette);
  return resolvedTheme === 'light' ? LIGHT : DARK;
}

/** The background xterm will actually paint, always a `#rrggbb`: a custom palette whose background was
 *  dropped by the validation above falls back to the app-theme default. It lives here rather than at the
 *  call site because this module is the one place allowed to hold a terminal colour literal — a
 *  terminal's palette is deliberately independent of the app's design tokens, which is exactly why
 *  anything tinting itself AGAINST that background has to ask for it instead of writing its own. */
export function xtermBackground(resolvedTheme: ResolvedTheme, prefs?: TerminalSettings): string {
  const fallback = resolvedTheme === 'light' ? LIGHT : DARK;
  return xtermTheme(resolvedTheme, prefs).background ?? fallback.background!;
}
