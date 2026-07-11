import { describe, expect, it } from 'vitest';
import { CURSOR_MARKER } from '@earendil-works/pi-tui';
import { terminalPlainText, terminalSafeAnsi } from '../../../src/cli/ui/text.js';

describe('terminal text trust boundary', () => {
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
});
