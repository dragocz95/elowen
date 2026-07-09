import { afterEach, describe, expect, it, vi } from 'vitest';
import { visibleWidth } from '@earendil-works/pi-tui';
import { box, mascot, printableInput, editField, inputWindow, newFieldState, type FieldState } from '../../../src/cli/ui/prompts.js';
import { MASCOT_ART } from '../../../src/cli/chat/mascot.js';
import { formatK, padAnsi } from '../../../src/cli/ui/text.js';

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b_pi:c\x07/g, '');

/** Drive a block of code with process.stdout mocked to a fixed size + TTY-ness, restoring after. */
function withTerminal(opts: { columns?: number; rows?: number; isTTY?: boolean }, fn: () => void): void {
  const desc = {
    columns: Object.getOwnPropertyDescriptor(process.stdout, 'columns'),
    rows: Object.getOwnPropertyDescriptor(process.stdout, 'rows'),
    isTTY: Object.getOwnPropertyDescriptor(process.stdout, 'isTTY'),
  };
  if (opts.columns !== undefined) Object.defineProperty(process.stdout, 'columns', { value: opts.columns, configurable: true });
  if (opts.rows !== undefined) Object.defineProperty(process.stdout, 'rows', { value: opts.rows, configurable: true });
  if (opts.isTTY !== undefined) Object.defineProperty(process.stdout, 'isTTY', { value: opts.isTTY, configurable: true });
  try { fn(); }
  finally {
    if (desc.columns) Object.defineProperty(process.stdout, 'columns', desc.columns); else delete (process.stdout as { columns?: number }).columns;
    if (desc.rows) Object.defineProperty(process.stdout, 'rows', desc.rows); else delete (process.stdout as { rows?: number }).rows;
    if (desc.isTTY) Object.defineProperty(process.stdout, 'isTTY', desc.isTTY); else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
}

// Raw terminal sequences matchesKey() recognises in legacy (non-Kitty) mode — the default under vitest.
const KEY = { left: '\x1b[D', right: '\x1b[C', home: '\x1b[H', end: '\x1b[F', del: '\x1b[3~', backspace: '\x7f' };

/** Apply a sequence of input chunks through the reducer, asserting each is owned (never returns null). */
function type(initial: string, ...inputs: string[]): FieldState {
  let state = newFieldState(initial);
  for (const data of inputs) {
    const next = editField(state, data);
    expect(next).not.toBeNull();
    state = next!;
  }
  return state;
}

describe('cli prompt input helpers', () => {
  it('unwraps bracketed paste chunks and drops control characters', () => {
    expect(printableInput('\x1b[200~sk-live-key\n\t\x00\x1b[201~')).toBe('sk-live-key');
  });

  it('accepts regular multi-character printable input', () => {
    expect(printableInput('hello world')).toBe('hello world');
  });

  it('ignores escape/control sequences that are not paste', () => {
    expect(printableInput('\x1b[A')).toBe('');
  });
});

describe('cli TextPrompt editField reducer', () => {
  it('type-over: the first printable key replaces an untouched prefill (admin + bob → bob, never adminbob)', () => {
    const state = type('admin', 'bob');
    expect(state.value).toBe('bob');
    expect(state.cursor).toBe(3);
    expect(state.touched).toBe(true);
  });

  it('type-over applies once: subsequent keys append at the caret', () => {
    const state = type('admin', 'b', 'o', 'b');
    expect(state.value).toBe('bob');
    expect(state.cursor).toBe(3);
  });

  it('moving the caret first marks the field touched, so typing then inserts (append the default)', () => {
    // End then type → keep the prefill and append, instead of type-over.
    const state = type('admin', KEY.end, '2');
    expect(state.value).toBe('admin2');
    expect(state.cursor).toBe(6);
  });

  it('home + printable inserts at the start of a touched field', () => {
    const state = type('admin', KEY.left, KEY.left, KEY.home, 'x');
    expect(state.value).toBe('xadmin');
    expect(state.cursor).toBe(1);
  });

  it('left/right move the caret without changing the value', () => {
    const state = type('admin', KEY.left);
    expect(state.value).toBe('admin');
    expect(state.cursor).toBe(4);
    const back = type('admin', KEY.home, KEY.right, KEY.right);
    expect(back.cursor).toBe(2);
  });

  it('clamps caret movement at both ends', () => {
    expect(type('ab', KEY.home, KEY.left, KEY.left).cursor).toBe(0);
    expect(type('ab', KEY.end, KEY.right, KEY.right).cursor).toBe(2);
  });

  it('backspace deletes the char before the caret (mid-string), not always the last', () => {
    // 'admin' → type-over 'foo', move left once (caret after 'fo'), backspace removes 'o' → 'fo' minus? -> 'f o'
    const state = type('admin', 'foo', KEY.left, KEY.backspace);
    expect(state.value).toBe('fo'); // caret was between 'fo' and 'o'; backspace removes 'o' at index 1 → 'fo'
    expect(state.cursor).toBe(1);
  });

  it('backspace at the start is a no-op but is still owned', () => {
    const state = type('ab', KEY.home, KEY.backspace);
    expect(state.value).toBe('ab');
    expect(state.cursor).toBe(0);
  });

  it('delete removes the char at the caret', () => {
    const state = type('admin', KEY.home, KEY.del);
    expect(state.value).toBe('dmin');
    expect(state.cursor).toBe(0);
  });

  it('returns null for input it does not own (leaves submit/cancel to the caller)', () => {
    expect(editField(newFieldState('x'), '\x1b')).toBeNull(); // bare escape
    expect(editField(newFieldState('x'), '\r')).toBeNull(); // enter
  });

  it('an empty prefill accepts the first key as the value (no type-over surprise)', () => {
    expect(type('', 'h', 'i').value).toBe('hi');
  });
});

describe('cli TextPrompt input window (width-aware, grapheme-safe)', () => {
  // The caret marker has zero visible width; strip it (and any color) before measuring/inspecting.
  const CARET = '\x1b_pi:c\x07';
  const visible = (s: string): number => visibleWidth(stripAnsi(s));
  // A code point is a lone (unpaired) UTF-16 surrogate — the garbage a naive .slice() through an
  // astral character leaves behind.
  const hasLoneSurrogate = (s: string): boolean => {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) { // high surrogate: must be followed by a low surrogate
        const n = s.charCodeAt(i + 1);
        if (!(n >= 0xdc00 && n <= 0xdfff)) return true;
        i++;
      } else if (c >= 0xdc00 && c <= 0xdfff) { // low surrogate with no preceding high
        return true;
      }
    }
    return false;
  };

  it('a plain ASCII value shorter than the window renders in full with the caret at the end', () => {
    const out = inputWindow('admin', 5, 20, false, CARET);
    expect(out).toBe(`admin${CARET}`);
    expect(stripAnsi(out)).toBe('admin'); // caret marker has zero visible width
  });

  it('CJK input never overflows a narrow modal window (width counted in columns, not code units)', () => {
    const value = '中文字符测试项目'; // 8 double-width chars = 16 columns, but only 8 UTF-16 units
    const out = inputWindow(value, value.length, 10, false, CARET);
    expect(visible(out)).toBeLessThanOrEqual(10); // old code-unit slice would have kept all 8 chars = 16 cols
    expect(hasLoneSurrogate(out)).toBe(false);
  });

  it('a caret window never splits an emoji surrogate pair', () => {
    const value = '😀😀😀'; // 3 emoji, each 2 UTF-16 units (6 units) and 2 columns wide
    const out = inputWindow(value, value.length, 4, false, CARET); // window narrower than the full 6 columns
    expect(visible(out)).toBeLessThanOrEqual(4);
    expect(hasLoneSurrogate(out)).toBe(false);
    expect(stripAnsi(out)).toBe('😀😀'); // whole trailing emoji kept, no half glyph
  });

  it('masked rendering uses one bullet per grapheme — an emoji is one dot, not two', () => {
    const out = inputWindow('😀😀😀', 6, 20, true, CARET); // 3 emoji = 6 UTF-16 units
    expect(stripAnsi(out)).toBe('•••'); // regression: was "••••••" ('•'.repeat(value.length))
    expect(visible(out)).toBe(3);
  });

  it('masks a CJK password within the window without overflow', () => {
    const out = inputWindow('密码测试测试测试', 8, 6, true, CARET); // 8 clusters, window of 6 columns
    expect(visible(out)).toBeLessThanOrEqual(6);
    expect(stripAnsi(out)).toMatch(/^•+$/); // only bullets, all width 1
  });

  it('keeps the caret visible by scrolling long input, caret pinned to the right edge', () => {
    const value = 'a'.repeat(50);
    const out = inputWindow(value, value.length, 10, false, CARET);
    expect(visible(out)).toBeLessThanOrEqual(10);
    expect(out.endsWith(CARET)).toBe(true); // caret at the end (right edge) when scrolled
  });
});

describe('cli box renderer (single source, always wraps)', () => {
  it('renders a title into the top rule and frames the body', () => {
    withTerminal({ columns: 80 }, () => {
      const rows = box(['hello'], { title: 'Plan' });
      expect(rows.length).toBe(3); // top + one body row + bottom
      expect(stripAnsi(rows[0]!)).toContain('Plan');
      expect(stripAnsi(rows[0]!).startsWith('╭')).toBe(true);
      expect(stripAnsi(rows[2]!).startsWith('╰')).toBe(true);
      expect(stripAnsi(rows[1]!)).toContain('hello');
    });
  });

  it('WRAPS a body line wider than the inner width instead of truncating it', () => {
    withTerminal({ columns: 80 }, () => {
      const long = 'x'.repeat(200);
      const rows = box([long]);
      const bodyRows = rows.length - 2;
      expect(bodyRows).toBeGreaterThanOrEqual(3); // 200 chars over an ~68-col inner
      const joined = stripAnsi(rows.join(''));
      expect(joined).not.toContain('…'); // never truncates
      expect((joined.match(/x/g) ?? []).length).toBe(200); // every char preserved
    });
  });

  it('grows the frame with content, clamped to the terminal width', () => {
    withTerminal({ columns: 80 }, () => {
      const narrow = visibleWidth(box(['ab'])[0]!);
      const wide = visibleWidth(box(['y'.repeat(60)])[0]!);
      expect(wide).toBeGreaterThan(narrow);
    });
    withTerminal({ columns: 50 }, () => {
      const rows = box(['z'.repeat(200)]);
      expect(visibleWidth(rows[0]!)).toBeLessThanOrEqual(50); // clamped to termWidth - margin
      expect(stripAnsi(rows.join(''))).not.toContain('…'); // still wrapped, not clipped
    });
  });
});

describe('cli mascot header (guards)', () => {
  // The prompt TUIs full-clear the screen on start, so mascot() arms a header the modals render inside
  // the TUI instead of printing to stdout. Module state is involved — isolate via a fresh module per test.
  afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

  async function freshPrompts(): Promise<typeof import('../../../src/cli/ui/prompts.js')> {
    vi.resetModules();
    return import('../../../src/cli/ui/prompts.js');
  }

  it('armed on a wide TTY, the header renders the centered flame art + a spacer', async () => {
    const m = await freshPrompts();
    withTerminal({ columns: 80, rows: 40, isTTY: true }, () => {
      m.mascot();
      const lines = m.mascotHeaderLines(80);
      expect(lines.length).toBe(MASCOT_ART.length + 1);
      // Centered: every art row is prefixed with the same left pad (floor((80-28)/2) = 26 spaces).
      MASCOT_ART.forEach((art, i) => expect(lines[i]).toBe(`${' '.repeat(26)}${art}`));
      expect(lines.at(-1)).toBe('');
    });
  });

  it('never arms when stdout is not a TTY (piped/CI logs stay clean)', async () => {
    const m = await freshPrompts();
    withTerminal({ columns: 80, rows: 40, isTTY: false }, () => {
      m.mascot();
      expect(m.mascotHeaderLines(80)).toEqual([]);
    });
  });

  it('renders nothing while unarmed, on a viewport narrower than the art, or on a short terminal', async () => {
    const m = await freshPrompts();
    withTerminal({ columns: 80, rows: 40, isTTY: true }, () => {
      expect(m.mascotHeaderLines(80)).toEqual([]); // unarmed
      m.mascot();
      expect(m.mascotHeaderLines(20)).toEqual([]); // narrower than the 28-col art
    });
    withTerminal({ columns: 80, rows: 20, isTTY: true }, () => {
      expect(m.mascotHeaderLines(80)).toEqual([]); // too short: art + prompt would not fit
    });
  });
});

describe('cli text helpers', () => {
  it('pads ansi text to a visible width', () => {
    expect(padAnsi('\x1b[31mhi\x1b[0m', 4)).toBe('\x1b[31mhi\x1b[0m  ');
  });

  it('formats compact token counts', () => {
    expect(formatK(999)).toBe('999');
    expect(formatK(34_567)).toBe('35k');
    expect(formatK(1_234_567)).toBe('1.2M');
  });
});
