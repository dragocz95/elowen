import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { Component } from '@earendil-works/pi-tui';
import { renderDiff } from '@earendil-works/pi-coding-agent';
import type { BrainCard } from '../../brain/events.js';
import { color } from './theme.js';

/** opencode-style visual building blocks, hand-rolled on pi-tui's Component contract (render(width)
 *  → lines). Kept separate from app.ts so the layout logic stays readable and these are unit-testable. */

/** Bold that resets ONLY bold (\x1b[22m), so it never clears the surrounding background. */
const bold = (s: string): string => `\x1b[1m${s}\x1b[22m`;

const ACCENT = color.accent;
const WHITE = color.text;
const DIM = color.dim;
const FAINTC = color.faint;
const GREENC = color.success;

export function padAnsi(text: string, width: number): string {
  const w = visibleWidth(text);
  return w >= width ? truncateToWidth(text, width) : text + ' '.repeat(width - w);
}

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
    return [color.inputBg(body)];
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
      return `${color.accent('▌')}${color.inputBg(`${body}${' '.repeat(pad)}`)}`;
    };
    const wrapped = wrapTextWithAnsi(this.text, Math.max(1, width - 3));
    const rows = wrapped.map((l) => railed(` ${l}`));
    return [railed(''), ...rows, railed('')];
  }
}

/** The persistent card panel for the fixed bottom stack (pinned above the status line): renders every
 *  `pinned` card a plugin emitted via ctx.emitCard (the todo checklist is the canonical one). A
 *  multi-line Component; collapses to nothing when there are no pinned cards worth showing. */
export class CardPanel implements Component {
  private cards: BrainCard[] = [];
  invalidate(): void { /* re-rendered on the next frame */ }
  set(cards: BrainCard[]): void { this.cards = cards; }
  render(_width?: number): string[] {
    // Pinned cards only; a checklist whose items are ALL completed collapses (the work is done).
    const visible = this.cards.filter((c) => c.pinned
      && !(c.items && c.items.length > 0 && c.items.every((i) => i.status === 'completed')));
    return visible.flatMap((c) => cardBlock(c));
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

/** A tool-call line in the Claude Code style: `⏺ read_file(src/foo.ts)` — leading glyph, plain name,
 *  muted argument summary in parens. The glyph is the daemon-resolved per-tool `icon` (from the core map
 *  + plugin manifest `icons`), falling back to the generic accent dot (e.g. on reloaded history, which
 *  carries no icon). */
export function toolChip(name: string, detail?: string, icon?: string): string {
  const args = detail ? `(${detail})` : '';
  return `  ${icon ?? ACCENT('⏺')} ${name}${DIM(args)}`;
}

/** Render one display card (title + checklist items + freeform body) as fixed-panel rows — the item
 *  glyphs match the todo look (✔ done / ◐ in-progress / ○ pending). `maxRows` bounds the WHOLE card
 *  (items + body) so a big card can't overrun the fixed bottom stack and wreck the TUI. */
export function cardBlock(card: BrainCard, maxRows = 12): string[] {
  const items = card.items ?? [];
  const done = items.filter((i) => i.status === 'completed').length;
  const count = items.length ? ` ${DIM(`${done}/${items.length}`)}` : '';
  const lines = [`  ${ACCENT('☑')} ${bold(WHITE(card.title ?? 'Card'))}${count}`];
  const bodyLines = card.body ? card.body.split('\n') : [];
  const shownItems = Math.min(items.length, Math.max(0, maxRows - bodyLines.length));
  for (const it of items.slice(0, shownItems)) {
    if (it.status === 'completed') lines.push(`    ${GREENC('✔')} ${DIM(it.text)}`);
    else if (it.status === 'in_progress') lines.push(`    ${ACCENT('◐')} ${WHITE(it.text)}`);
    else lines.push(`    ${FAINTC('○')} ${DIM(it.text)}`);
  }
  if (items.length > shownItems) lines.push(`    ${FAINTC(`… +${items.length - shownItems} more`)}`);
  for (const l of bodyLines.slice(0, maxRows)) lines.push(`    ${DIM(l)}`);
  return lines;
}

// Claude-Code-style diff rows for the LEGACY stored format (`  12 - text`, number first).
const DIFF_ADD = (t: string): string => `\x1b[48;2;28;54;38m\x1b[38;2;127;216;143m${t}\x1b[0m`;
const DIFF_DEL = (t: string): string => `\x1b[48;2;62;30;34m\x1b[38;2;224;108;117m${t}\x1b[0m`;
const LEGACY_SIGN = /^\s*\d+ ([-+ ]) /;

/** Render a display diff: pi's renderDiff handles the current format (sign first — colored rows with
 *  intra-line change highlighting); older stored diffs (number first) keep the simple row coloring.
 *  Indented under the tool line and capped so a huge edit can't flood the conversation. */
export function diffBlock(diff: string, maxLines = 60): string[] {
  const raw = diff.replace(/\n+$/, '');
  // Every plugin diff has at least one changed row; sign-first marks the current pi-compatible format.
  const isPiFormat = raw.split('\n').some((l) => /^[-+]\s*\d+ /.test(l));
  const rendered = isPiFormat
    ? renderDiff(raw).replace(/\n+$/, '').split('\n')
    : raw.split('\n').map((l) => {
        const s = LEGACY_SIGN.exec(l)?.[1];
        return s === '+' ? DIFF_ADD(l) : s === '-' ? DIFF_DEL(l) : FAINTC(l);
      });
  const shown = rendered.slice(0, maxLines).map((l) => `    ${l}`);
  if (rendered.length > maxLines) shown.push(`    ${FAINTC(`… +${rendered.length - maxLines} more lines`)}`);
  return shown;
}

/** The compact footer under an assistant reply: `▪ <model>` (small blue square + muted model). */
export function metaLine(model?: string): string {
  return `  ${ACCENT('▪')} ${DIM(model || 'orca')}`;
}
