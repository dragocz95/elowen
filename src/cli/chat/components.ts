import { visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { Component } from '@earendil-works/pi-tui';

/** opencode-style visual building blocks, hand-rolled on pi-tui's Component contract (render(width)
 *  → lines). Kept separate from app.ts so the layout logic stays readable and these are unit-testable. */

const TEAL = '38;5;44';
const FAINT = '38;5;240';
const BAR = `\x1b[${TEAL}m▌\x1b[0m`;       // teal left rail (half-block, reads as a clean edge)
const BG = '48;5;236';                     // subtle raised background (title bar)
const BG_USER = '48;5;238';                // slightly stronger gray for the user message block
const BG_CLOSE = '\x1b[0m';
/** Bold that resets ONLY bold (\x1b[22m), so it never clears the surrounding background. */
const bold = (s: string): string => `\x1b[1m${s}\x1b[22m`;

const ACCENT = (t: string): string => `\x1b[${TEAL}m${t}\x1b[0m`;
const DIM = (t: string): string => `\x1b[90m${t}\x1b[0m`;
const FAINTC = (t: string): string => `\x1b[${FAINT}m${t}\x1b[0m`;

/** A full-width bar with a subtle background and left/right justified content (the top title bar).
 *  Both sides carry their own ANSI; the whole row is painted with the background color. */
export class TitleBar implements Component {
  private left = '';
  private right = '';
  invalidate(): void { /* re-rendered on the next frame */ }
  set(left: string, right: string): void { this.left = left; this.right = right; }
  render(width: number): string[] {
    const inner = width - 2; // one space of padding each side
    const gap = Math.max(1, inner - visibleWidth(this.left) - visibleWidth(this.right));
    const body = ` ${this.left}${' '.repeat(gap)}${this.right} `;
    return [`\x1b[${BG}m${body}${BG_CLOSE}`];
  }
}

/** A full-width user message: a teal left rail and a raised gray background with bold text, padded to
 *  width. The rows are wrapped in one blank raised row top and bottom for breathing room. */
export class UserBlock implements Component {
  constructor(private text: string) {}
  invalidate(): void { /* stateless — rebuilt fresh each render */ }
  render(width: number): string[] {
    const railed = (body: string): string => {
      const pad = Math.max(0, width - 1 - visibleWidth(body));
      return `${BAR}\x1b[${BG_USER}m${body}${' '.repeat(pad)}${BG_CLOSE}`;
    };
    const wrapped = wrapTextWithAnsi(this.text, Math.max(1, width - 3));
    const rows = wrapped.map((l) => railed(` ${bold(l)}`));
    return [railed(''), ...rows, railed('')];
  }
}

/** A bottom status bar: left text and right text justified to the two edges. */
export class StatusBar implements Component {
  constructor(private left: string, private right: string) {}
  invalidate(): void { /* re-rendered on the next frame */ }
  setLeft(left: string): void { this.left = left; }
  render(width: number): string[] {
    const gap = Math.max(1, width - visibleWidth(this.left) - visibleWidth(this.right));
    return [this.left + ' '.repeat(gap) + this.right];
  }
}

/** The empty-conversation welcome banner: a bordered box with the brand, model and a hint line. */
export function banner(model?: string): string[] {
  const inner = [
    `${ACCENT('🐋  Orca AI')}  ${FAINTC('— tvůj agent nad celou flotilou')}`,
    '',
    `${FAINTC('model')}  ${DIM(model || '—')}`,
    FAINTC('Zeptej se na cokoli — tasky, mise, plán, stav agentů, soubory, web…'),
  ];
  const width = Math.max(40, ...inner.map((l) => visibleWidth(l))) + 4;
  const bar = '─'.repeat(width - 2);
  const top = ACCENT(`╭${bar}╮`);
  const bottom = ACCENT(`╰${bar}╯`);
  const rows = inner.map((l) => `${ACCENT('│')} ${l}${' '.repeat(Math.max(0, width - 4 - visibleWidth(l)))} ${ACCENT('│')}`);
  return ['', top, ...rows, bottom, `${FAINTC('  /help')} ${FAINTC('pro příkazy')}`, ''];
}

/** Compact number with thousands separators: 39413 → "39,413". */
export function fmtCount(n: number): string {
  return n.toLocaleString('en-US');
}

/** The top title-bar content: the conversation title (left) and usage stats (right, when available). */
export function titleBarContent(title: string, usage?: { totalTokens: number; percent: number | null; cost: number } | null): { left: string; right: string } {
  const left = bold(title || 'Nová konverzace');
  if (!usage) return { left, right: '' };
  const parts = [FAINTC(fmtCount(usage.totalTokens))];
  if (usage.percent != null) parts.push(FAINTC(`${Math.round(usage.percent)}%`));
  if (usage.cost > 0) parts.push(FAINTC(`($${usage.cost.toFixed(2)})`));
  return { left, right: parts.join('  ') };
}

/** The glyph for a tool line: file/read ops get an arrow, everything else a star (opencode style). */
function toolGlyph(name: string): string {
  return /read|glob|list|ls|cat|open|dir|file|scan/i.test(name) ? '→' : '*';
}

/** A single dim tool-call line above an assistant reply: `* web_search` / `→ read_file`. */
export function toolChip(name: string): string {
  return `  ${FAINTC(`${toolGlyph(name)} ${name}`)}`;
}

/** The compact footer under an assistant reply: `▪ <model>` (small teal square + dim model). */
export function metaLine(model?: string): string {
  return `  ${ACCENT('▪')} ${DIM(model || 'orca')}`;
}
