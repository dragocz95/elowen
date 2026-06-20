export interface AnsiSegment { text: string; color?: string }

// A readable terminal palette tuned for the OLED background.
const BASE: Record<number, string> = {
  30: '#3a3a3a', 31: '#ef4444', 32: '#22c55e', 33: '#eab308', 34: '#3b82f6', 35: '#a855f7', 36: '#06b6d4', 37: '#d4d4d4',
  90: '#6b7280', 91: '#f87171', 92: '#4ade80', 93: '#facc15', 94: '#60a5fa', 95: '#c084fc', 96: '#22d3ee', 97: '#f5f5f5',
};

function color256(n: number): string {
  if (n < 16) return BASE[n < 8 ? 30 + n : 90 + (n - 8)] ?? '#d4d4d4';
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
  const i = n - 16;
  const r = Math.floor(i / 36), g = Math.floor((i % 36) / 6), b = i % 6;
  const c = (x: number) => (x === 0 ? 0 : 55 + x * 40);
  return `rgb(${c(r)},${c(g)},${c(b)})`;
}

// Strip non-SGR escape sequences (cursor moves, private modes, charset selects, stray ESC).
function stripControl(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-ln-~]/g, '') // CSI sequences that are not SGR (m handled separately)
    .replace(/\x1b[()][0-9A-Za-z]/g, '')          // charset selection
    .replace(/\x1b[=>]/g, '')                       // keypad modes
    .replace(/\x1b/g, '');                          // any stray ESC
}

/** Parse SGR colour codes into styled text segments; other control sequences are stripped. */
export function parseAnsi(input: string): AnsiSegment[] {
  const segs: AnsiSegment[] = [];
  let color: string | undefined;
  let buf = '';
  const flush = () => { if (buf) { segs.push({ text: stripControl(buf), color }); buf = ''; } };
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0; let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    buf += input.slice(last, m.index);
    flush();
    last = re.lastIndex;
    const codes = (m[1] || '0').split(';').map((x) => Number(x || 0));
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === 0 || code === 39) color = undefined;
      else if (BASE[code]) color = BASE[code];
      else if (code === 38) {
        if (codes[i + 1] === 5) { color = color256(codes[i + 2] ?? 7); i += 2; }
        else if (codes[i + 1] === 2) { color = `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`; i += 4; }
      }
      // background (40-49) and text styles are intentionally ignored for the preview
    }
  }
  buf += input.slice(last);
  flush();
  return segs.filter((s) => s.text.length > 0);
}
