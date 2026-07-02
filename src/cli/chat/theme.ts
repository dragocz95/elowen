/** Orca's terminal palette — the exact opencode default theme (dark) in truecolor ANSI, so the CLI reads
 *  1:1 with opencode. The rich markdown/editor rendering still comes from pi's own theme
 *  (getMarkdownTheme/getSelectListTheme); this file carries the accents, chrome colors and glyphs. */

const wrap = (code: string) => (s: string): string => `\x1b[${code}m${s}\x1b[0m`;

export const color = {
  accent: wrap('38;2;92;156;245'),    // secondary #5c9cf5 — user rail, highlights
  accentDim: wrap('38;2;61;125;216'), // darker blue
  bold: wrap('1'),
  dim: wrap('38;2;128;128;128'),      // textMuted #808080 — tool lines, hints
  faint: wrap('38;2;96;96;96'),       // subtle dividers / secondary hints
  error: wrap('38;2;224;108;117'),    // #e06c75
  success: wrap('38;2;127;216;143'),  // #7fd88f
};

/** Brand glyphs and labels. */
export const glyph = {
  whale: '🐋',
  tool: '⏺',      // filled dot — a tool call
  you: 'you',
  orca: 'orca',
  dot: '·',
};
