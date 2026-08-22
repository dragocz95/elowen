/** Parser for a theme's CLI mascot (`mascot.ans`): truecolor half-block art that replaces the built-in
 *  flame on a white-labeled instance.
 *
 *  This is a SECURITY BOUNDARY, not a formatter. The bytes arrive over HTTP from a daemon the CLI does
 *  not necessarily own — `elowen` happily points at any base URL — and they are written straight to a
 *  terminal, which executes escape sequences as commands. An unfiltered pass-through would hand that
 *  daemon OSC 52 (write the user's clipboard), OSC 0/2 (retitle the window), DECRQSS-style query/reply
 *  loops that inject text into the shell's input, and alternate-screen or scroll-region changes that
 *  wreck the TUI it is drawn into.
 *
 *  So nothing is passed through. Every line is tokenized against the grammar below and the output is
 *  REBUILT from the parsed values, which means a sequence this parser does not understand cannot reach
 *  the terminal even if the tokenizer had a subtle hole: the worst case is a wrong colour, never a
 *  command. Any violation rejects the whole file rather than the offending line, because half-rendered
 *  art is a worse outcome than the built-in fallback and a partial reject would hide a hostile file. */

/** Foreground/background truecolor, and the full reset. Deliberately NOT the 256-colour or basic SGR
 *  forms: the art generator emits truecolor only, and every additional accepted form is more surface. */
const SGR_RE = /^\x1b\[(38|48);2;(\d{1,3});(\d{1,3});(\d{1,3})m|^\x1b\[0m/;

/** The only printable characters allowed. U+2580/U+2584 are the half blocks the art is built from; the
 *  space is the transparent cell. No other glyph can appear, which also rules out smuggling text. */
const GLYPH_RE = /^[ \u2580\u2584]+/;

/** Bounds. The art is decoration in a fixed panel, so a file far outside these is either corrupt or an
 *  attempt to stall the render loop / exhaust memory. */
const MAX_ROWS = 40;
const MAX_COLUMNS = 200;
const MAX_BYTES = 256 * 1024;

/** One parsed cell run: the colours in force and the glyphs printed under them. */
interface Run {
  fg: [number, number, number] | null;
  bg: [number, number, number] | null;
  glyphs: string;
}

function parseLine(line: string): Run[] | null {
  const runs: Run[] = [];
  let fg: [number, number, number] | null = null;
  let bg: [number, number, number] | null = null;
  let rest = line;
  let columns = 0;
  while (rest.length > 0) {
    const sgr = SGR_RE.exec(rest);
    if (sgr) {
      if (sgr[1] === undefined) { fg = null; bg = null; } // \x1b[0m
      else {
        const channels = [Number(sgr[2]), Number(sgr[3]), Number(sgr[4])] as [number, number, number];
        if (channels.some((n) => n > 255)) return null;
        if (sgr[1] === '38') fg = channels; else bg = channels;
      }
      rest = rest.slice(sgr[0].length);
      continue;
    }
    const glyphs = GLYPH_RE.exec(rest);
    if (!glyphs) return null; // anything the grammar does not name — including a bare ESC
    columns += glyphs[0].length;
    if (columns > MAX_COLUMNS) return null;
    runs.push({ fg, bg, glyphs: glyphs[0] });
    rest = rest.slice(glyphs[0].length);
  }
  return runs;
}

/** Re-emit a parsed line. The reset after every run keeps a row self-contained: art drawn into a panel
 *  must never leak a background colour into the rows or columns beside it. */
function emit(runs: Run[]): string {
  let out = '';
  for (const run of runs) {
    const fg = run.fg ? `\x1b[38;2;${run.fg[0]};${run.fg[1]};${run.fg[2]}m` : '';
    const bg = run.bg ? `\x1b[48;2;${run.bg[0]};${run.bg[1]};${run.bg[2]}m` : '';
    out += fg || bg ? `${fg}${bg}${run.glyphs}\x1b[0m` : run.glyphs;
  }
  return out;
}

/**
 * Parse a theme's `mascot.ans` into renderable rows, or null when it violates the grammar or the bounds.
 * Null always means "use the built-in behaviour" — this never throws and never returns partial art.
 *
 * Every row is padded to the widest one so callers can centre the block by measuring a single line.
 */
export function parseMascotArt(text: string): string[] | null {
  if (text.length === 0 || text.length > MAX_BYTES) return null;
  // A trailing newline is normal in a text file and must not become an empty final row.
  const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  if (lines.length > MAX_ROWS) return null;
  const parsed: Run[][] = [];
  for (const line of lines) {
    const runs = parseLine(line);
    if (!runs) return null;
    parsed.push(runs);
  }
  const widths = parsed.map((runs) => runs.reduce((sum, run) => sum + run.glyphs.length, 0));
  const width = Math.max(...widths);
  if (width === 0) return null;
  return parsed.map((runs, index) => emit(runs) + ' '.repeat(width - widths[index]!));
}
