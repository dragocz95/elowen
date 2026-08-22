import { describe, it, expect } from 'vitest';
import { parseMascotArt } from '../../../src/cli/chat/mascotArt.js';
import { MASCOT_ART } from '../../../src/cli/chat/mascot.js';

const fg = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`;
const bg = (r: number, g: number, b: number) => `\x1b[48;2;${r};${g};${b}m`;
const reset = '\x1b[0m';

describe('parseMascotArt', () => {
  it('accepts truecolor half-block art and pads every row to the widest', () => {
    const art = parseMascotArt(`${fg(1, 2, 3)}${bg(4, 5, 6)}▀▀${reset}\n${fg(7, 8, 9)}▄${reset}`);
    expect(art).not.toBeNull();
    expect(art).toHaveLength(2);
    expect(art![0]).toContain('▀▀');
    expect(art![0]).toContain(fg(1, 2, 3));
    expect(art![0]).toContain(bg(4, 5, 6));
    // Ragged input must not produce ragged output — callers centre the block by measuring one row.
    const widths = art!.map((row) => [...row.replace(/\x1b\[[0-9;]*m/g, '')].length);
    expect(widths).toEqual([2, 2]);
  });

  it('round-trips the built-in flame', () => {
    // The generator and this grammar have to agree, and the built-in art is the reference output of
    // that generator. A drift here means a themed instance would be rejected for being well-formed.
    const art = parseMascotArt(MASCOT_ART.join('\n'));
    expect(art).not.toBeNull();
    expect(art).toHaveLength(MASCOT_ART.length);
  });

  // The art is written straight to a terminal, which executes escape sequences as commands, and the
  // daemon serving it is not necessarily one the user owns. Each of these WOULD reach the terminal
  // under a pass-through implementation.
  it.each([
    ['OSC 52 clipboard write hidden between valid runs', `${fg(1, 2, 3)}▀\x1b]52;c;cHduZWQ=\x07▀${reset}`],
    ['OSC 0 window retitle', `\x1b]0;pwned\x07${fg(1, 2, 3)}▀${reset}`],
    ['alternate screen switch', `\x1b[?1049h${fg(1, 2, 3)}▀${reset}`],
    ['scroll region change', `\x1b[1;5r${fg(1, 2, 3)}▀${reset}`],
    ['device status query', `${fg(1, 2, 3)}▀${reset}\x1b[6n`],
    ['bare escape', `${fg(1, 2, 3)}▀\x1b${reset}`],
    ['smuggled text', `${fg(1, 2, 3)}run rm -rf /${reset}`],
    ['non-block glyph', `${fg(1, 2, 3)}█${reset}`],
    ['colour channel out of range', `${fg(1, 2, 999)}▀${reset}`],
    ['unsupported SGR form (256-colour)', `\x1b[38;5;196m▀${reset}`],
    ['carriage-return overprint', `${fg(1, 2, 3)}▀\rX${reset}`],
  ])('rejects %s', (_label, payload) => {
    expect(parseMascotArt(payload)).toBeNull();
  });

  it('rejects the whole file for one bad row, rather than dropping that row', () => {
    // Half-rendered art is worse than the fallback, and a partial reject would hide a hostile file.
    const good = `${fg(1, 2, 3)}▀${reset}`;
    expect(parseMascotArt(`${good}\n${good}`)).toHaveLength(2);
    expect(parseMascotArt(`${good}\n\x1b]52;c;x\x07\n${good}`)).toBeNull();
  });

  it('rejects empty, oversized and over-tall input', () => {
    expect(parseMascotArt('')).toBeNull();
    expect(parseMascotArt('\n\n')).toBeNull(); // no glyphs at all
    expect(parseMascotArt(`${fg(1, 2, 3)}▀${reset}\n`.repeat(41))).toBeNull();
    expect(parseMascotArt('▀'.repeat(201))).toBeNull();
    expect(parseMascotArt(' '.repeat(256 * 1024 + 1))).toBeNull();
  });

  it('emits nothing outside its own grammar', () => {
    // The output is REBUILT from parsed values, so this holds even if the tokenizer had a hole: strip
    // the sequences the grammar produces and no escape byte may survive.
    const art = parseMascotArt(MASCOT_ART.join('\n'))!;
    const stripped = art.join('\n').replace(/\x1b\[(?:38|48);2;\d{1,3};\d{1,3};\d{1,3}m|\x1b\[0m/g, '');
    expect(stripped).not.toContain('\x1b');
    expect(stripped.replace(/[ \u2580\u2584\n]/g, '')).toBe('');
  });

  it('tolerates CRLF and a trailing newline without inventing a blank row', () => {
    expect(parseMascotArt(`${fg(1, 2, 3)}▀${reset}\r\n${fg(1, 2, 3)}▀${reset}\n`)).toHaveLength(2);
  });
});
