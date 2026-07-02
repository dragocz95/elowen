import { visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { Component } from '@earendil-works/pi-tui';

/** opencode-style visual building blocks, hand-rolled on pi-tui's Component contract (render(width)
 *  → lines). Kept separate from app.ts so the layout logic stays readable and these are unit-testable. */

// Exact opencode default theme (dark), truecolor.
const BLUE = '38;2;92;156;245';            // secondary #5c9cf5 — user rail
const TEXT = '38;2;238;238;238';           // step12 #eeeeee — bright text (logo)
const MUTED = '38;2;128;128;128';          // step11 #808080 — tool lines, stats
const FAINT = '38;2;96;96;96';             // step8 #606060 — subtle hints
const BAR = `\x1b[${BLUE}m▌\x1b[0m`;        // blue left rail (half-block, reads as a clean edge)
const BG = '48;2;20;20;20';                // backgroundPanel #141414 (title bar)
const BG_USER = '48;2;30;30;30';           // backgroundElement #1e1e1e (user block)
const BG_CLOSE = '\x1b[0m';
/** Bold that resets ONLY bold (\x1b[22m), so it never clears the surrounding background. */
const bold = (s: string): string => `\x1b[1m${s}\x1b[22m`;

const ACCENT = (t: string): string => `\x1b[${BLUE}m${t}\x1b[0m`;
const WHITE = (t: string): string => `\x1b[${TEXT}m${t}\x1b[0m`;
const DIM = (t: string): string => `\x1b[${MUTED}m${t}\x1b[0m`;
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

/** A full-width user message: a blue left rail and a raised gray background (opencode backgroundElement),
 *  padded to width. The rows are wrapped in one blank raised row top and bottom for breathing room. */
export class UserBlock implements Component {
  constructor(private text: string) {}
  invalidate(): void { /* stateless — rebuilt fresh each render */ }
  render(width: number): string[] {
    const railed = (body: string): string => {
      const pad = Math.max(0, width - 1 - visibleWidth(body));
      return `${BAR}\x1b[${BG_USER}m${body}${' '.repeat(pad)}${BG_CLOSE}`;
    };
    const wrapped = wrapTextWithAnsi(this.text, Math.max(1, width - 3));
    const rows = wrapped.map((l) => railed(` ${l}`));
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

/** Block-letter "ORCA" logo (5 rows, each letter 5 cells wide) shown on an empty conversation. */
const ORCA_ART = [
  '█████ █████ █████  ███ ',
  '█   █ █   █ █     █   █',
  '█   █ ████  █     █████',
  '█   █ █  █  █     █   █',
  '█████ █   █ █████ █   █',
];

/** The empty-conversation welcome: a centered two-tone "ORCA" logo (opencode-style: dim + bright halves),
 *  the model, and a one-line hint. */
export function banner(model?: string): string[] {
  const cols = process.stdout.columns || 80;
  const pad = Math.max(0, Math.floor((cols - ORCA_ART[0]!.length) / 2));
  const indent = ' '.repeat(pad);
  // Split each row "OR" | "CA" (each letter 5 cells + 1 space → boundary at 12) for the two-tone logo.
  const art = ORCA_ART.map((l) => `${indent}${DIM(l.slice(0, 12))}${WHITE(l.slice(12))}`);
  const centered = (t: string): string => `${' '.repeat(Math.max(0, Math.floor((cols - visibleWidth(t)) / 2)))}${t}`;
  return [
    '', '',
    ...art,
    '',
    centered(`${FAINTC('model')}  ${DIM(model || '—')}`),
    centered(FAINTC('Ask me anything — tasks, missions, plans, agents, files, the web…')),
    centered(FAINTC('/help for commands')),
    '',
  ];
}

/** Compact number with thousands separators: 39413 → "39,413". */
export function fmtCount(n: number): string {
  return n.toLocaleString('en-US');
}

/** The top title-bar content: the conversation title (left) and usage stats (right, when available). */
export function titleBarContent(title: string, usage?: { totalTokens: number; percent: number | null; cost: number } | null): { left: string; right: string } {
  const left = bold(WHITE(title || 'New conversation'));
  if (!usage) return { left, right: '' };
  const parts = [DIM(fmtCount(usage.totalTokens))];
  if (usage.percent != null) parts.push(DIM(`${Math.round(usage.percent)}%`));
  if (usage.cost > 0) parts.push(DIM(`($${usage.cost.toFixed(2)})`));
  return { left, right: parts.join('  ') };
}

/** A tool-call line in the Claude Code style: `⏺ read_file(src/foo.ts)` — accent dot, plain name,
 *  muted argument summary in parens. */
export function toolChip(name: string, detail?: string): string {
  const args = detail ? `(${detail})` : '';
  return `  ${ACCENT('⏺')} ${name}${DIM(args)}`;
}

// Claude-Code-style diff rows: colored text on a tinted full-row background.
const DIFF_ADD = (t: string): string => `\x1b[48;2;28;54;38m\x1b[38;2;127;216;143m${t}\x1b[0m`;
const DIFF_DEL = (t: string): string => `\x1b[48;2;62;30;34m\x1b[38;2;224;108;117m${t}\x1b[0m`;
/** A diff row is `  12 - text` (our numbered format) or a bare unified `-text` / `+text`. */
const DIFF_SIGN = /^\s*\d+ ([-+ ]) |^([-+])/;

/** Render a display diff Claude-Code style: added rows on a green-tinted background, removed on red,
 *  context muted; indented under the tool line and capped so a huge edit can't flood the conversation. */
export function diffBlock(diff: string, maxLines = 60): string[] {
  const lines = diff.replace(/\n+$/, '').split('\n');
  const shown = lines.slice(0, maxLines).map((l) => {
    const sign = DIFF_SIGN.exec(l);
    const s = sign?.[1] ?? sign?.[2];
    if (s === '+') return `    ${DIFF_ADD(l)}`;
    if (s === '-') return `    ${DIFF_DEL(l)}`;
    return `    ${FAINTC(l)}`;
  });
  if (lines.length > maxLines) shown.push(`    ${FAINTC(`… +${lines.length - maxLines} more lines`)}`);
  return shown;
}

/** The compact footer under an assistant reply: `▪ <model>` (small blue square + muted model). */
export function metaLine(model?: string): string {
  return `  ${ACCENT('▪')} ${DIM(model || 'orca')}`;
}
