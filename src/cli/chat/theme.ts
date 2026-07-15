import { padAnsi } from '../ui/text.js';

/** Elowen's terminal theme registry. The exported `color.*` helpers intentionally stay stable while
 *  their palette can switch at runtime (`/theme`) without rebuilding every component import. */

const fg = (r: number, g: number, b: number): string => `38;2;${r};${g};${b}`;
const bg = (r: number, g: number, b: number): string => `48;2;${r};${g};${b}`;
const sgr = (code: string, s: string): string => `\x1b[${code}m${s}\x1b[0m`;
const sgrOpen = (code: string, s: string): string => `\x1b[${code}m${s}`;

export type ChatThemeName =
  | 'elowen' | 'blue' | 'mono'
  | 'midnight' | 'forest' | 'ember' | 'rose' | 'violet' | 'ocean'
  | 'sunset' | 'nord' | 'dracula' | 'gruvbox' | 'matrix' | 'sand';

export interface ChatTheme {
  /** A preset name, or 'custom' when built from the user's web terminal palette. */
  name: ChatThemeName | 'custom';
  label: string;
  accent: string;
  accentDim: string;
  accentSoft: string;
  text: string;
  muted: string;
  faint: string;
  success: string;
  warning: string;
  error: string;
  panelBg: string;
  inputBg: string;
  modalBg: string;
  selectedBg: string;
}

const CHAT_THEMES: Record<ChatThemeName, ChatTheme> = {
  elowen: {
    name: 'elowen',
    label: 'Elowen red',
    accent: fg(255, 82, 54),
    accentDim: fg(201, 51, 35),
    accentSoft: fg(255, 146, 120),
    text: fg(236, 231, 229),
    muted: fg(154, 133, 128),
    faint: fg(96, 76, 74),
    success: fg(101, 214, 149),
    warning: fg(255, 178, 62),
    error: fg(255, 108, 128),
    panelBg: bg(9, 6, 6),
    inputBg: bg(19, 12, 12),
    modalBg: bg(12, 8, 8),
    selectedBg: bg(255, 82, 54),
  },
  blue: {
    name: 'blue',
    label: 'Legacy blue',
    accent: fg(92, 156, 245),
    accentDim: fg(61, 125, 216),
    accentSoft: fg(147, 197, 253),
    text: fg(238, 238, 238),
    muted: fg(128, 128, 128),
    faint: fg(96, 96, 96),
    success: fg(127, 216, 143),
    warning: fg(255, 174, 44),
    error: fg(224, 108, 117),
    panelBg: bg(8, 9, 12),
    inputBg: bg(20, 20, 20),
    modalBg: bg(8, 8, 10),
    selectedBg: bg(92, 156, 245),
  },
  mono: {
    name: 'mono',
    label: 'Mono graphite',
    accent: fg(212, 212, 216),
    accentDim: fg(161, 161, 170),
    accentSoft: fg(244, 244, 245),
    text: fg(229, 229, 229),
    muted: fg(140, 140, 148),
    faint: fg(82, 82, 91),
    success: fg(187, 247, 208),
    warning: fg(250, 204, 21),
    error: fg(248, 113, 113),
    panelBg: bg(5, 5, 5),
    inputBg: bg(18, 18, 18),
    modalBg: bg(7, 7, 7),
    selectedBg: bg(212, 212, 216),
  },
  midnight: {
    name: 'midnight',
    label: 'Midnight indigo',
    accent: fg(129, 140, 248),
    accentDim: fg(99, 102, 241),
    accentSoft: fg(165, 180, 252),
    text: fg(226, 232, 240),
    muted: fg(129, 134, 158),
    faint: fg(71, 74, 102),
    success: fg(74, 222, 128),
    warning: fg(251, 191, 36),
    error: fg(248, 113, 113),
    panelBg: bg(6, 7, 15),
    inputBg: bg(14, 16, 28),
    modalBg: bg(8, 9, 18),
    selectedBg: bg(129, 140, 248),
  },
  forest: {
    name: 'forest',
    label: 'Forest green',
    accent: fg(74, 222, 128),
    accentDim: fg(34, 160, 92),
    accentSoft: fg(134, 239, 172),
    text: fg(228, 235, 228),
    muted: fg(126, 148, 130),
    faint: fg(66, 84, 70),
    success: fg(74, 222, 128),
    warning: fg(250, 204, 21),
    error: fg(248, 113, 113),
    panelBg: bg(4, 8, 5),
    inputBg: bg(12, 20, 14),
    modalBg: bg(6, 11, 7),
    selectedBg: bg(74, 222, 128),
  },
  ember: {
    name: 'ember',
    label: 'Ember orange',
    accent: fg(251, 146, 60),
    accentDim: fg(217, 119, 45),
    accentSoft: fg(253, 186, 116),
    text: fg(240, 232, 225),
    muted: fg(160, 138, 122),
    faint: fg(96, 78, 66),
    success: fg(163, 222, 108),
    warning: fg(250, 204, 21),
    error: fg(248, 113, 113),
    panelBg: bg(12, 7, 3),
    inputBg: bg(24, 16, 10),
    modalBg: bg(16, 10, 5),
    selectedBg: bg(251, 146, 60),
  },
  rose: {
    name: 'rose',
    label: 'Rose pink',
    accent: fg(244, 114, 182),
    accentDim: fg(214, 74, 148),
    accentSoft: fg(249, 168, 212),
    text: fg(240, 228, 234),
    muted: fg(163, 132, 148),
    faint: fg(97, 72, 84),
    success: fg(110, 231, 183),
    warning: fg(251, 191, 36),
    error: fg(251, 113, 133),
    panelBg: bg(12, 5, 9),
    inputBg: bg(24, 12, 18),
    modalBg: bg(16, 7, 12),
    selectedBg: bg(244, 114, 182),
  },
  violet: {
    name: 'violet',
    label: 'Violet haze',
    accent: fg(167, 139, 250),
    accentDim: fg(139, 108, 232),
    accentSoft: fg(196, 181, 253),
    text: fg(233, 228, 244),
    muted: fg(146, 138, 168),
    faint: fg(84, 76, 108),
    success: fg(110, 231, 183),
    warning: fg(251, 191, 36),
    error: fg(248, 113, 113),
    panelBg: bg(9, 6, 15),
    inputBg: bg(19, 14, 30),
    modalBg: bg(12, 8, 20),
    selectedBg: bg(167, 139, 250),
  },
  ocean: {
    name: 'ocean',
    label: 'Ocean blue',
    accent: fg(56, 189, 248),
    accentDim: fg(14, 150, 214),
    accentSoft: fg(125, 211, 252),
    text: fg(224, 234, 240),
    muted: fg(122, 145, 158),
    faint: fg(60, 82, 96),
    success: fg(45, 212, 191),
    warning: fg(251, 191, 36),
    error: fg(248, 113, 113),
    panelBg: bg(3, 8, 13),
    inputBg: bg(10, 18, 26),
    modalBg: bg(5, 11, 17),
    selectedBg: bg(56, 189, 248),
  },
  sunset: {
    name: 'sunset',
    label: 'Sunset coral',
    accent: fg(251, 113, 133),
    accentDim: fg(225, 82, 104),
    accentSoft: fg(253, 164, 175),
    text: fg(243, 231, 227),
    muted: fg(168, 138, 132),
    faint: fg(101, 76, 72),
    success: fg(250, 204, 21),
    warning: fg(251, 146, 60),
    error: fg(239, 68, 68),
    panelBg: bg(13, 6, 6),
    inputBg: bg(26, 13, 13),
    modalBg: bg(17, 8, 8),
    selectedBg: bg(251, 113, 133),
  },
  nord: {
    name: 'nord',
    label: 'Nord frost',
    accent: fg(136, 192, 208),
    accentDim: fg(94, 158, 176),
    accentSoft: fg(163, 210, 224),
    text: fg(216, 222, 233),
    muted: fg(129, 141, 158),
    faint: fg(76, 86, 106),
    success: fg(163, 190, 140),
    warning: fg(235, 203, 139),
    error: fg(191, 97, 106),
    panelBg: bg(30, 34, 42),
    inputBg: bg(46, 52, 64),
    modalBg: bg(36, 41, 51),
    selectedBg: bg(136, 192, 208),
  },
  dracula: {
    name: 'dracula',
    label: 'Dracula',
    accent: fg(189, 147, 249),
    accentDim: fg(155, 110, 222),
    accentSoft: fg(212, 182, 251),
    text: fg(248, 248, 242),
    muted: fg(148, 152, 178),
    faint: fg(98, 104, 130),
    success: fg(80, 250, 123),
    warning: fg(241, 250, 140),
    error: fg(255, 85, 85),
    panelBg: bg(30, 31, 41),
    inputBg: bg(40, 42, 54),
    modalBg: bg(34, 36, 46),
    selectedBg: bg(189, 147, 249),
  },
  gruvbox: {
    name: 'gruvbox',
    label: 'Gruvbox retro',
    accent: fg(250, 189, 47),
    accentDim: fg(215, 153, 33),
    accentSoft: fg(250, 211, 110),
    text: fg(235, 219, 178),
    muted: fg(168, 153, 132),
    faint: fg(102, 92, 84),
    success: fg(184, 187, 38),
    warning: fg(254, 128, 25),
    error: fg(251, 73, 52),
    panelBg: bg(29, 32, 33),
    inputBg: bg(40, 40, 40),
    modalBg: bg(34, 37, 38),
    selectedBg: bg(250, 189, 47),
  },
  matrix: {
    name: 'matrix',
    label: 'Matrix green',
    accent: fg(0, 255, 128),
    accentDim: fg(0, 200, 100),
    accentSoft: fg(128, 255, 190),
    text: fg(190, 245, 210),
    muted: fg(96, 160, 122),
    faint: fg(40, 84, 58),
    success: fg(0, 255, 128),
    warning: fg(230, 255, 90),
    error: fg(255, 96, 96),
    panelBg: bg(0, 6, 3),
    inputBg: bg(2, 14, 8),
    modalBg: bg(1, 9, 5),
    selectedBg: bg(0, 255, 128),
  },
  sand: {
    name: 'sand',
    label: 'Desert sand',
    accent: fg(214, 178, 120),
    accentDim: fg(184, 148, 92),
    accentSoft: fg(230, 204, 160),
    text: fg(235, 226, 210),
    muted: fg(166, 152, 130),
    faint: fg(100, 90, 74),
    success: fg(170, 200, 130),
    warning: fg(230, 190, 100),
    error: fg(224, 122, 108),
    panelBg: bg(12, 10, 7),
    inputBg: bg(24, 20, 15),
    modalBg: bg(16, 13, 9),
    selectedBg: bg(214, 178, 120),
  },
};

let activeTheme: ChatTheme = CHAT_THEMES.elowen;

export function chatTheme(): ChatTheme {
  return activeTheme;
}

export function setChatTheme(name: ChatThemeName): ChatTheme {
  activeTheme = CHAT_THEMES[name];
  return activeTheme;
}

export function isChatThemeName(value: string): value is ChatThemeName {
  return Object.prototype.hasOwnProperty.call(CHAT_THEMES, value);
}

/** Apply a chat theme derived from the user's web Account → Terminal CUSTOM palette (#rrggbb fields),
 *  so the colors configured on the web carry into the CLI chat. Each slot maps to its nearest ANSI
 *  role; an invalid/missing hex keeps the Elowen default for that slot. Backgrounds are derived from the
 *  palette background (panels darker-as-is, input/modal slightly lifted so the layers stay readable). */
export function setCustomChatTheme(palette: Partial<Record<string, string>>): ChatTheme {
  const base = CHAT_THEMES.elowen;
  const rgb = (hex?: string): [number, number, number] | null => {
    const m = /^#([0-9a-f]{6})$/i.exec(hex ?? '');
    if (!m) return null;
    const n = parseInt(m[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const f = (hex: string | undefined, fallback: string): string => { const c = rgb(hex); return c ? fg(...c) : fallback; };
  const lift = (hex: string | undefined, amount: number, fallback: string): string => {
    const c = rgb(hex);
    return c ? bg(Math.min(255, c[0] + amount), Math.min(255, c[1] + amount), Math.min(255, c[2] + amount)) : fallback;
  };
  activeTheme = {
    name: 'custom',
    label: 'Custom (web)',
    accent: f(palette.cyan, base.accent),
    accentDim: f(palette.blue, base.accentDim),
    accentSoft: f(palette.brightCyan, base.accentSoft),
    text: f(palette.foreground, base.text),
    muted: f(palette.white, base.muted),
    faint: f(palette.brightBlack, base.faint),
    success: f(palette.green, base.success),
    warning: f(palette.yellow, base.warning),
    error: f(palette.red, base.error),
    panelBg: lift(palette.background, 0, base.panelBg),
    inputBg: lift(palette.background, 14, base.inputBg),
    modalBg: lift(palette.background, 5, base.modalBg),
    selectedBg: (() => { const c = rgb(palette.selectionBackground) ?? rgb(palette.cyan); return c ? bg(...c) : base.selectedBg; })(),
  };
  return activeTheme;
}

export function chatThemeItems(): { value: ChatThemeName; label: string; description?: string }[] {
  return (Object.keys(CHAT_THEMES) as ChatThemeName[]).map((name) => ({
    value: name,
    label: CHAT_THEMES[name].label,
    description: name === activeTheme.name ? 'current' : undefined,
  }));
}

export const ansi = {
  bg,
  fg,
  open: sgrOpen,
  sgr,
};

/** Paint `text` across `width` columns on the background `bgCode`.
 *
 *  SGR has no stack. Every reset inside the text — the `\x1b[0m` a colour helper closes with, or a cell
 *  of the mascot art carrying its own background — clears the ROW's background as well, so everything
 *  after it, padding included, falls back to the terminal's default. That is what drew the black stripes
 *  down the telemetry rail and the black patch beside the flame. Re-arming the background after each
 *  such reset keeps the row one colour whatever it contains, which is the only thing a caller ever meant
 *  by "paint this row". */
export function paintRow(bgCode: string, text: string, width: number): string {
  const open = `\x1b[${bgCode}m`;
  const body = padAnsi(text, width).replace(/\x1b\[(?:0|49)?m/g, (reset) => `${reset}${open}`);
  return `${open}${body}\x1b[0m`;
}

export const color = {
  accent: (s: string): string => sgr(activeTheme.accent, s),
  accentDim: (s: string): string => sgr(activeTheme.accentDim, s),
  accentSoft: (s: string): string => sgr(activeTheme.accentSoft, s),
  text: (s: string): string => sgr(activeTheme.text, s),
  bold: (s: string): string => `\x1b[1m${s}\x1b[22m`,
  dim: (s: string): string => sgr(activeTheme.muted, s),
  faint: (s: string): string => sgr(activeTheme.faint, s),
  error: (s: string): string => sgr(activeTheme.error, s),
  success: (s: string): string => sgr(activeTheme.success, s),
  warning: (s: string): string => sgr(activeTheme.warning, s),
  // No panelBg/inputBg/modalBg helpers: a background belongs to a whole ROW, and wrapping text in one
  // here would end at the first reset the text itself carries. Paint rows with `paintRow`.
  selected: (s: string): string => sgr(`${activeTheme.selectedBg};30;1`, s),
};

/** Brand glyphs and labels. */
export const glyph = {
  whale: 'elowen',
  tool: '*',
  think: 'thought',
  you: 'you',
  elowen: 'elowen',
  dot: '·',
};
