/** Orca's terminal theme registry. The exported `color.*` helpers intentionally stay stable while
 *  their palette can switch at runtime (`/theme`) without rebuilding every component import. */

const fg = (r: number, g: number, b: number): string => `38;2;${r};${g};${b}`;
const bg = (r: number, g: number, b: number): string => `48;2;${r};${g};${b}`;
const sgr = (code: string, s: string): string => `\x1b[${code}m${s}\x1b[0m`;
const sgrOpen = (code: string, s: string): string => `\x1b[${code}m${s}`;

export type ChatThemeName = 'orca' | 'blue' | 'mono';

export interface ChatTheme {
  name: ChatThemeName;
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
  orca: {
    name: 'orca',
    label: 'Orca cyan',
    accent: fg(78, 211, 202),
    accentDim: fg(34, 151, 146),
    accentSoft: fg(132, 231, 224),
    text: fg(229, 231, 235),
    muted: fg(139, 141, 153),
    faint: fg(82, 84, 96),
    success: fg(57, 222, 151),
    warning: fg(255, 174, 44),
    error: fg(255, 107, 129),
    panelBg: bg(4, 4, 6),
    inputBg: bg(15, 15, 18),
    modalBg: bg(5, 5, 8),
    selectedBg: bg(78, 211, 202),
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
};

let activeTheme: ChatTheme = CHAT_THEMES.orca;

export function chatTheme(): ChatTheme {
  return activeTheme;
}

export function setChatTheme(name: ChatThemeName): ChatTheme {
  activeTheme = CHAT_THEMES[name];
  return activeTheme;
}

export function isChatThemeName(value: string): value is ChatThemeName {
  return value === 'orca' || value === 'blue' || value === 'mono';
}

export function chatThemeItems(): { value: ChatThemeName; label: string; description?: string }[] {
  return (Object.keys(CHAT_THEMES) as ChatThemeName[]).map((name) => ({
    value: name,
    label: CHAT_THEMES[name].label,
    description: name === activeTheme.name ? 'current' : name,
  }));
}

export const ansi = {
  bg,
  fg,
  open: sgrOpen,
  sgr,
};

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
  panelBg: (s: string): string => sgr(activeTheme.panelBg, s),
  inputBg: (s: string): string => sgr(activeTheme.inputBg, s),
  modalBg: (s: string): string => sgr(activeTheme.modalBg, s),
  selected: (s: string): string => sgr(`${activeTheme.selectedBg};30;1`, s),
};

/** Brand glyphs and labels. */
export const glyph = {
  whale: '🐋',
  tool: '⏺',
  think: '💭',
  you: 'you',
  orca: 'orca',
  dot: '·',
};
