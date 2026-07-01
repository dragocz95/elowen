import type { MarkdownTheme } from '@earendil-works/pi-tui';
import type { EditorTheme } from '@earendil-works/pi-tui';

/** Orca's terminal identity in one place. Raw ANSI (no chalk dep) — 256-colour teal accent to match
 *  the Orca brand, with muted/error/success helpers. Every colour the chat UI uses comes from here. */

const wrap = (code: string) => (s: string): string => `\x1b[${code}m${s}\x1b[0m`;

export const color = {
  accent: wrap('38;5;44'),   // Orca teal
  accentDim: wrap('38;5;30'),
  bold: wrap('1'),
  dim: wrap('90'),
  error: wrap('31'),
  success: wrap('32'),
  warn: wrap('33'),
};

/** Brand glyphs and labels. */
export const glyph = {
  whale: '🐋',
  tool: '⚙',
  prompt: '›',
  you: 'ty',
  orca: 'orca',
};

/** Spinner frames for the "thinking" loader. */
export const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Markdown rendering theme for assistant replies — headings/code/quotes in Orca teal, de-emphasised
 *  borders. Every field is required by pi-tui's MarkdownTheme. */
export const orcaMarkdownTheme: MarkdownTheme = {
  heading: color.bold,
  link: color.accent,
  linkUrl: color.dim,
  code: color.accent,
  codeBlock: (t) => t,
  codeBlockBorder: color.dim,
  quote: color.dim,
  quoteBorder: color.accentDim,
  hr: color.dim,
  listBullet: color.accent,
  bold: color.bold,
  italic: wrap('3'),
  strikethrough: wrap('9'),
  underline: wrap('4'),
};

/** Editor (input line) theme: teal border, teal select-list accents for `/command` autocomplete. */
export const orcaEditorTheme: EditorTheme = {
  borderColor: color.accent,
  selectList: {
    selectedPrefix: color.accent,
    selectedText: color.bold,
    description: color.dim,
    scrollInfo: color.dim,
    noMatch: color.dim,
  },
};
