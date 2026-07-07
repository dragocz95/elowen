import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { Component } from '@earendil-works/pi-tui';
import type { BrainCard } from '../../brain/events.js';
import { ansi, chatTheme, color } from './theme.js';
import type { ToolOutputView } from '../../brain/messageView.js';
import { padAnsi } from '../ui/text.js';

/** opencode-style visual building blocks, hand-rolled on pi-tui's Component contract (render(width)
 *  → lines). Kept separate from app.ts so the layout logic stays readable and these are unit-testable. */

/** Bold that resets ONLY bold (\x1b[22m), so it never clears the surrounding background. */
const bold = (s: string): string => `\x1b[1m${s}\x1b[22m`;

const WHITE = color.text;
const DIM = color.dim;
const FAINTC = color.faint;
const GREENC = color.success;

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
  private collapsed = false;
  /** Row indices (0-based, within this panel's own output) that are clickable card headers — so the app
   *  can hit-test a mouse click against them and toggle the checklist open/closed. */
  private headerRows = new Set<number>();
  invalidate(): void { /* re-rendered on the next frame */ }
  set(cards: BrainCard[]): void { this.cards = cards; }
  toggleCollapsed(): void { this.collapsed = !this.collapsed; }
  isHeaderRow(index: number): boolean { return this.headerRows.has(index); }
  render(_width?: number): string[] {
    // Pinned cards only; a checklist whose items are ALL completed collapses (the work is done).
    const visible = this.cards.filter((c) => c.pinned
      && !(c.items && c.items.length > 0 && c.items.every((i) => i.status === 'completed')));
    this.headerRows = new Set();
    const lines: string[] = [];
    for (const c of visible) {
      this.headerRows.add(lines.length); // a card's first row is its clickable header
      lines.push(...cardBlock(c, 12, this.collapsed));
    }
    return lines;
  }
}

/** A bottom status bar: left text and right text justified to the two edges. */
export class StatusBar implements Component {
  constructor(private left: string, private right: string) {}
  invalidate(): void { /* re-rendered on the next frame */ }
  setLeft(left: string): void { this.left = left; }
  setRight(right: string): void { this.right = right; }
  render(width: number): string[] {
    let left = this.left;
    let right = this.right;
    const maxRight = Math.max(0, Math.floor(width * 0.55));
    if (visibleWidth(right) > maxRight) right = truncateToWidth(right, maxRight, '…');
    const availableLeft = Math.max(0, width - visibleWidth(right) - 1);
    if (visibleWidth(left) > availableLeft) left = truncateToWidth(left, availableLeft, '…');
    const gap = Math.max(0, width - visibleWidth(left) - visibleWidth(right));
    return [left + ' '.repeat(gap) + right];
  }
}

/** Render one display card (title + checklist items + freeform body) as fixed-panel rows — the item
 *  glyphs use a compact terminal checklist style. `maxRows` bounds the WHOLE card
 *  (items + body) so a big card can't overrun the fixed bottom stack and wreck the TUI. */
export function cardBlock(card: BrainCard, maxRows = 12, collapsed = false): string[] {
  const items = card.items ?? [];
  const done = items.filter((i) => i.status === 'completed').length;
  const counter = items.length ? FAINTC(`  ${done}/${items.length}`) : '';
  const header = `  ${FAINTC(collapsed ? '▸' : '▾')} ${bold(WHITE(card.title ?? 'Todos'))}${counter} ${FAINTC('click')}`;
  if (collapsed) return [header];
  const lines = [header];
  const bodyLines = card.body ? card.body.split('\n') : [];
  const shownItems = Math.min(items.length, Math.max(0, maxRows - bodyLines.length));
  for (const it of items.slice(0, shownItems)) {
    if (it.status === 'completed') lines.push(`    ${GREENC('[x]')} ${DIM(it.text)}`);
    else if (it.status === 'in_progress') lines.push(`    ${color.warning('[•]')} ${color.warning(it.text)}`);
    else lines.push(`    ${FAINTC('[ ]')} ${DIM(it.text)}`);
  }
  if (items.length > shownItems) lines.push(`    ${FAINTC(`… +${items.length - shownItems} more`)}`);
  for (const l of bodyLines.slice(0, maxRows)) lines.push(`    ${DIM(l)}`);
  return lines;
}

const GIT_ADD = `${ansi.bg(3, 58, 22)};${ansi.fg(63, 185, 80)}`;
const GIT_DEL = `${ansi.bg(103, 6, 12)};${ansi.fg(248, 81, 73)}`;
const CODE_BG = ansi.bg(13, 13, 16);
const DIFF_ADD = (t: string): string => ansi.sgr(GIT_ADD, t);
const DIFF_DEL = (t: string): string => ansi.sgr(GIT_DEL, t);
const CODE_ROW = (t: string): string => ansi.sgr(CODE_BG, t);
const LEGACY_SIGN = /^\s*\d+ ([-+ ]) /;
const PI_ROW = /^([-+ ])\s*(\d+) (.*)$/;
const LEGACY_ROW = /^\s*(\d+) ([-+ ]) (.*)$/;

function diffLine(line: string, width?: number): string {
  const pi = PI_ROW.exec(line);
  const legacy = LEGACY_ROW.exec(line);
  const sign = pi?.[1] ?? legacy?.[2] ?? ' ';
  const num = pi?.[2] ?? legacy?.[1] ?? '';
  const text = pi?.[3] ?? legacy?.[3] ?? line;
  const gutter = `${num.padStart(5)} ${sign}`;
  const plainRow = ` ${gutter} ${text}`;
  const padded = width ? padAnsi(plainRow, width) : plainRow;
  if (sign === '+') return DIFF_ADD(padded);
  if (sign === '-') return DIFF_DEL(padded);
  return CODE_ROW(width ? padAnsi(`${color.faint(gutter)} ${color.dim(text)}`, width) : `${color.faint(gutter)} ${color.dim(text)}`);
}

/** Render a display diff with stable line numbers and git-style add/delete colors. Indented under the
 *  file-action label and capped so a huge edit can't flood the conversation. */
export function diffBlock(diff: string, maxLines = 60, rowWidth?: number): string[] {
  const raw = diff.replace(/\n+$/, '');
  const rendered = raw.split('\n').map((l) => {
    const s = PI_ROW.exec(l)?.[1] ?? LEGACY_SIGN.exec(l)?.[1];
    return s === '+' || s === '-' || s === ' ' ? diffLine(l, rowWidth) : CODE_ROW(rowWidth ? padAnsi(color.dim(l), rowWidth) : color.dim(l));
  });
  const shown = rendered.slice(0, maxLines).map((l) => `    ${l}`);
  if (rendered.length > maxLines) shown.push(`    ${FAINTC(`… +${rendered.length - maxLines} more lines`)}`);
  return shown;
}

function simpleBlock(title: string, lines: string[], width: number, footer?: string): string[] {
  const inner = Math.max(24, width - 6);
  const out = [`  ${color.faint('<')} ${color.text(title)}`];
  for (const line of lines) out.push(`    ${truncateToWidth(line, inner, '…')}`);
  if (footer) out.push(`    ${color.faint(footer)}`);
  return out;
}

/** File diff preview for the chat transcript: quiet left label + code rows, no decorative frame. */
export function framedDiffBlock(diff: string, width: number, title = 'diff'): string[] {
  const inner = Math.max(24, width - 10);
  return simpleBlock(title, diffBlock(diff, 18, inner), width);
}

/** Console/tool output preview. The daemon already decides which tool results are worth showing;
 *  this renderer keeps them compact and visually separate from assistant prose. */
export function toolOutputBlock(output: ToolOutputView, width: number, expanded = false): string[] {
  const theme = chatTheme();
  const lines: string[] = [];
  if (output.command) lines.push(` ${ansi.open(theme.faint, '$')} ${ansi.open(theme.text, output.command)}`);
  if (output.status) {
    const statusColor = output.tone === 'warning' || output.tone === 'danger' ? theme.warning : theme.success;
    lines.push(` ${ansi.open(statusColor, output.status)}`);
  }
  if (lines.length > 0) lines.push('');
  const expandable = Boolean(output.fullText && output.fullText !== output.text);
  const body = expanded && output.fullText ? output.fullText : output.text;
  for (const raw of body.split('\n')) {
    if (!raw) { lines.push(''); continue; }
    const toneColor = /\b(error|failed|warning|needs attention|exit\s+[1-9])\b/i.test(raw)
      ? theme.warning
      : /^✓|^(passed|success|ok)\b/i.test(raw)
        ? theme.success
        : theme.muted;
    lines.push(` ${ansi.open(toneColor, raw)}`);
  }
  if (expandable) {
    lines.push('');
    lines.push(` ${color.faint(expanded ? 'Click to collapse' : 'Click to expand')}`);
  }
  return simpleBlock(output.title, lines.map((line) => CODE_ROW(padAnsi(line, Math.max(1, width - 10)))), width);
}
