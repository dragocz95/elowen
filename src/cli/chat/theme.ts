/** Orca's terminal accent in one place. Raw ANSI (no chalk dep) — a 256-colour teal to match the Orca
 *  brand, plus muted/bold helpers. The rich markdown/editor rendering comes from pi's own theme
 *  (getMarkdownTheme/getSelectListTheme); this file only carries the Orca-specific accents and glyphs. */

const wrap = (code: string) => (s: string): string => `\x1b[${code}m${s}\x1b[0m`;

export const color = {
  accent: wrap('38;5;44'),   // Orca teal
  accentDim: wrap('38;5;30'),
  bold: wrap('1'),
  dim: wrap('90'),
  error: wrap('31'),
  success: wrap('32'),
};

/** Brand glyphs and labels. */
export const glyph = {
  whale: '🐋',
  tool: '⚙',
  you: 'ty',
  orca: 'orca',
};
