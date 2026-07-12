import { describe, expect, it } from 'vitest';
import { CURSOR_MARKER, visibleWidth } from '@earendil-works/pi-tui';
import {
  padAnsi,
  terminalInlineText,
  terminalPhysicalRow,
  terminalPlainText,
  terminalSafeAnsi,
  terminalSafeComponent,
} from '../../../src/cli/ui/text.js';

describe('terminal text trust boundary', () => {
  it('returns an exact-width styled row byte-for-byte without ANSI truncation work', () => {
    const chunk = `\x1b[31m${'x'.repeat(20)}\x1b[0m${' '.repeat(20)}`;
    const styled = chunk.repeat(4);
    const row = `${styled}${'x'.repeat(180 - visibleWidth(styled))}`;
    expect(padAnsi(row, 180)).toBe(row);
    padAnsi(row, 180); // warm segmenter/JIT
    const startedAt = performance.now();
    for (let index = 0; index < 100; index++) padAnsi(row, 180);
    expect(performance.now() - startedAt).toBeLessThan(30);

    const overflow = padAnsi(`${row}unsafe-tail`, 180);
    expect(visibleWidth(overflow)).toBe(180);
    expect(overflow).not.toContain('unsafe-tail');
  });

  it('normalizes untrusted labels through one shared printable inline projection', () => {
    expect(terminalInlineText('  first\nsecond\t\x1b[2J third  ')).toBe('first second third');
  });

  it('keeps renderer-owned SGR, OSC 8 links, and the PI cursor marker only', () => {
    const input = [
      '\x1b[31mred\x1b[0m',
      '\x1b]8;;https://example.com\x07link\x1b]8;;\x07',
      CURSOR_MARKER,
      '\x1b[2Jclear',
      '\x1b]0;forged title\x07title',
      '\x1b]52;c;Zm9yZ2Vk\x07clipboard',
      '\x1bPdanger\x1b\\dcs',
      '\x1b_forged\x07apc',
    ].join(' ');

    const safe = terminalSafeAnsi(input);
    expect(safe).toContain('\x1b[31mred\x1b[0m');
    expect(safe).toContain('\x1b]8;;https://example.com\x07link\x1b]8;;\x07');
    expect(safe).toContain(CURSOR_MARKER);
    expect(safe).not.toContain('\x1b[2J');
    expect(safe).not.toContain('\x1b]0;');
    expect(safe).not.toContain('\x1b]52;');
    expect(safe).not.toContain('\x1bP');
    expect(safe).not.toContain('\x1b_forged');
    expect(terminalPlainText(safe).replace(/\s+/g, ' ')).toContain('red link clear title clipboard dcs apc');
  });

  it('keeps ANSI sanitization multiline while folding a final physical row boundary', () => {
    expect(terminalSafeAnsi('first\nsecond')).toBe('first\nsecond');
    expect(terminalPhysicalRow('first\r\nsecond\nthird\rfourth')).toBe('first second third fourth');
  });

  it('preserves owned ANSI and the cursor marker while folding an embedded physical newline', () => {
    const source = {
      invalidate: () => {},
      render: () => [`\x1b[31mleft${CURSOR_MARKER}\nright\x1b[0m`],
    };
    const [row] = terminalSafeComponent(source).render(80);

    expect(row).toBe(`\x1b[31mleft${CURSOR_MARKER} right\x1b[0m`);
    expect(row).not.toMatch(/[\r\n]/);
  });

  it('projects overlay rows while preserving focus and input delegation', () => {
    let focused = false;
    let input = '';
    const source = {
      get focused() { return focused; },
      set focused(value: boolean) { focused = value; },
      invalidate: () => {},
      handleInput: (value: string) => { input = value; },
      render: () => ['hostile session\x1b]52;c;Zm9yZ2Vk\x07\x1b[2J\nforged physical row'],
    };
    const safe = terminalSafeComponent(source) as typeof source;
    safe.focused = true;
    safe.handleInput('enter');
    const rendered = safe.render(80).join('\n');
    expect(focused).toBe(true);
    expect(input).toBe('enter');
    expect(rendered).toContain('hostile session');
    expect(rendered).not.toContain('\x1b]52;');
    expect(rendered).not.toContain('\x1b[2J');
    expect(rendered).not.toMatch(/[\r\n]/);
    expect(rendered).toContain('hostile session forged physical row');
  });
});
