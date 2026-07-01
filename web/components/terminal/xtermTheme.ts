import type { ITheme } from '@xterm/xterm';
import type { ResolvedTheme } from '../../lib/useTheme';

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

export function xtermTheme(resolvedTheme: ResolvedTheme): ITheme {
  return resolvedTheme === 'light' ? LIGHT : DARK;
}
