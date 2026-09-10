/** Per-user web-terminal (xterm) appearance settings. Persisted as a single JSON blob under the
 *  `user_settings` key `terminal`; every value is re-validated on read/write because the blob is
 *  user-supplied and never trusted. `theme:'auto'` (the default) reproduces the pre-feature behaviour
 *  (palette follows the app light/dark theme), so existing users are unaffected. */

/** The full xterm ANSI palette we expose for customization (mirrors `@xterm/xterm`'s `ITheme` colour
 *  fields). Every entry is an `#rrggbb` string; used only when `theme:'custom'`. */
export interface TerminalPalette {
  background: string; foreground: string; cursor: string; cursorAccent: string; selectionBackground: string;
  black: string; red: string; green: string; yellow: string; blue: string; magenta: string; cyan: string; white: string;
  brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string; brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string;
}

type TerminalFontFamily = 'system' | 'menlo' | 'ibm' | 'courier';
type TerminalCursorStyle = 'block' | 'bar' | 'underline';
type TerminalThemeMode = 'auto' | 'custom';

export interface TerminalSettings {
  fontSize: number;
  fontFamily: TerminalFontFamily;
  cursorStyle: TerminalCursorStyle;
  cursorBlink: boolean;
  scrollback: number;
  theme: TerminalThemeMode;
  palette: TerminalPalette;
  /** Render the model's Thought rows in the CLI chat transcript. Cross-device (per user), toggled from
   *  Account → Terminal or `/reasoning show` in the CLI. */
  showThoughtsCli: boolean;
  /** How many sent prompts the CLI chat keeps for ↑-recall, per project. The history file itself is
   *  per-machine, but how far back a person wants to reach is a property of the person, so the depth
   *  travels with the account and the CLI reads it at boot. */
  promptHistoryDepth: number;
  /** How long the first Esc stays armed in the CLI chat, i.e. how quickly the confirming SECOND press has
   *  to follow to interrupt the turn. Purely the CONFIRMATION window — decoding `\x1b[A` into an arrow key
   *  is the stdin buffer's own affair (pi-tui, 10 ms, and byte-driven), so this value cannot affect it. */
  interruptConfirmMs: number;
}

// The font-family id → CSS stack mapping lives only where it's applied (the web, in
// `web/components/terminal/palettes.ts`); the server just validates the id enum.

const PALETTE_KEYS: (keyof TerminalPalette)[] = [
  'background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground',
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
];

/** The canonical dark palette — the current hardcoded xterm background/foreground plus a standard
 *  VS Code-style ANSI set. Doubles as the seed for a fresh custom palette. */
export const DARK_PALETTE: TerminalPalette = {
  background: '#000000', foreground: '#f5f5f5', cursor: '#f5f5f5', cursorAccent: '#000000', selectionBackground: '#2c4870',
  black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510', blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
  brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#ffffff',
};

export const TERMINAL_DEFAULTS: TerminalSettings = {
  fontSize: 12,
  fontFamily: 'system',
  cursorStyle: 'block',
  cursorBlink: true,
  scrollback: 1000,
  theme: 'auto',
  palette: DARK_PALETTE,
  showThoughtsCli: true,
  promptHistoryDepth: 100,
  interruptConfirmMs: 1800,
};

const isHex6 = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
const isFontFamily = (v: unknown): v is TerminalFontFamily => v === 'system' || v === 'menlo' || v === 'ibm' || v === 'courier';
const isCursorStyle = (v: unknown): v is TerminalCursorStyle => v === 'block' || v === 'bar' || v === 'underline';
const isThemeMode = (v: unknown): v is TerminalThemeMode => v === 'auto' || v === 'custom';

/** Keep font size legible and bounded; non-numbers fall back to the default. */
function clampFontSize(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return TERMINAL_DEFAULTS.fontSize;
  return Math.min(20, Math.max(10, Math.round(v)));
}

/** Bound scrollback so a runaway value can't balloon xterm's buffer memory. */
function clampScrollback(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return TERMINAL_DEFAULTS.scrollback;
  return Math.min(50_000, Math.max(500, Math.round(v)));
}

/** Bound the ↑-recall depth. The whole history file is rewritten on every sent prompt, so the ceiling is
 *  what keeps that write cheap; below the floor the recall stops reaching past the current sitting. */
const PROMPT_HISTORY_DEPTH_BOUNDS: [min: number, max: number] = [20, 1000];
/** Bound the double-Esc confirmation window. The floor is what a second deliberate keypress needs — under
 *  it the feature reads as broken, since the first Esc disarms before a hand can follow it. The ceiling is
 *  a correctness bound: an armed window that outlives the turn it was armed in would let a press meant for
 *  that turn abort the NEXT one, which is the stale-arm failure `interruptPress` exists to prevent. */
const INTERRUPT_CONFIRM_BOUNDS: [min: number, max: number] = [500, 5000];

function clampToBounds(n: unknown, [min, max]: [number, number], fallback: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
}

/** Build a full valid palette from an untrusted partial, dropping any non-`#rrggbb` value to `base`. */
function sanitizePalette(input: unknown, base: TerminalPalette): TerminalPalette {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const out = {} as TerminalPalette;
  for (const k of PALETTE_KEYS) out[k] = isHex6(src[k]) ? (src[k]).toLowerCase() : base[k];
  return out;
}

/** Coerce an untrusted value (parsed JSON blob or request body) into a complete, valid TerminalSettings,
 *  filling every missing/invalid field from `base` (defaults). Never throws. */
export function sanitizeTerminalSettings(input: unknown, base: TerminalSettings = TERMINAL_DEFAULTS): TerminalSettings {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  return {
    fontSize: src.fontSize !== undefined ? clampFontSize(src.fontSize) : base.fontSize,
    fontFamily: isFontFamily(src.fontFamily) ? src.fontFamily : base.fontFamily,
    cursorStyle: isCursorStyle(src.cursorStyle) ? src.cursorStyle : base.cursorStyle,
    cursorBlink: typeof src.cursorBlink === 'boolean' ? src.cursorBlink : base.cursorBlink,
    scrollback: src.scrollback !== undefined ? clampScrollback(src.scrollback) : base.scrollback,
    theme: isThemeMode(src.theme) ? src.theme : base.theme,
    palette: sanitizePalette(src.palette, base.palette),
    showThoughtsCli: typeof src.showThoughtsCli === 'boolean' ? src.showThoughtsCli : base.showThoughtsCli,
    promptHistoryDepth: src.promptHistoryDepth !== undefined ? clampToBounds(src.promptHistoryDepth, PROMPT_HISTORY_DEPTH_BOUNDS, base.promptHistoryDepth) : base.promptHistoryDepth,
    interruptConfirmMs: src.interruptConfirmMs !== undefined ? clampToBounds(src.interruptConfirmMs, INTERRUPT_CONFIRM_BOUNDS, base.interruptConfirmMs) : base.interruptConfirmMs,
  };
}

/** Merge an untrusted partial patch onto the current settings (palette merged key-by-key) and re-validate
 *  the result. Fields absent from the patch keep their current value. */
export function mergeTerminalSettings(current: TerminalSettings, patch: unknown): TerminalSettings {
  const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;
  const mergedPalette = p.palette && typeof p.palette === 'object'
    ? { ...current.palette, ...(p.palette as Record<string, unknown>) }
    : current.palette;
  return sanitizeTerminalSettings({ ...current, ...p, palette: mergedPalette }, current);
}
