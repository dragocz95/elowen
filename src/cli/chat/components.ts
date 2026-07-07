import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { isDownKey, isEnterKey, isEscapeKey, isUpKey } from './keys.js';
import type { Component, Container, Editor, Focusable, TUI } from '@earendil-works/pi-tui';
import type { AskQuestion, BrainCard } from '../../brain/events.js';
import { ansi, chatTheme, color } from './theme.js';
import type { ToolOutputView } from '../../brain/messageView.js';
import { formatDuration, formatK, padAnsi } from '../ui/text.js';

/** opencode-style visual building blocks, hand-rolled on pi-tui's Component contract (render(width)
 *  → lines). Kept separate from app.ts so the layout logic stays readable and these are unit-testable. */

/** Bold that resets ONLY bold (\x1b[22m), so it never clears the surrounding background. */
const bold = (s: string): string => `\x1b[1m${s}\x1b[22m`;

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Time-based braille spinner frame — every render advances it (the app re-renders on a 250ms ticker
 *  while a turn streams, so animation needs no timer of its own). Shared by the prompt meta chip and
 *  the live sub-agent row. */
export function spinnerFrame(now = Date.now()): string {
  return SPINNER_FRAMES[Math.floor(now / 120) % SPINNER_FRAMES.length]!;
}

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

/** One row of the live sub-agents panel (see {@link SubagentPanel}). */
export interface SubagentPanelEntry {
  sessionId: string;
  task: string;
  status: 'running' | 'done' | 'error';
  detail?: string;
  tools: number;
  tokens?: number;
  seconds: number;
}

/** A slim fixed panel under the Todos card listing the conversation's delegated sub-agents — a
 *  spinner + task per row with the child's current tool and counters, each row clickable to open that
 *  child's session. Running agents only (settled ones live on as their transcript row); renders
 *  nothing when no sub-agent runs, so the bottom stack pays zero rows for the feature at rest. */
export class SubagentPanel implements Component {
  private entries: SubagentPanelEntry[] = [];
  private collapsed = false;
  /** Row index (0-based within this panel's output) → the sub-agent session that row opens. */
  private rowTargets = new Map<number, string>();
  invalidate(): void { /* re-rendered on the next frame */ }
  set(entries: SubagentPanelEntry[]): void { this.entries = entries.filter((e) => e.status === 'running'); }
  targetAt(index: number): string | null { return this.rowTargets.get(index) ?? null; }
  /** The header (row 0) toggles the agent list open/closed, mirroring the Todos card. */
  isHeaderRow(index: number): boolean { return index === 0 && this.entries.length > 0; }
  toggleCollapsed(): void { this.collapsed = !this.collapsed; }
  render(width = 80): string[] {
    this.rowTargets = new Map();
    if (this.entries.length === 0) return [];
    const lines: string[] = [`  ${FAINTC(this.collapsed ? '▸' : '▾')} ${bold(WHITE('Sub-agents'))}${FAINTC(`  ${this.entries.length} running`)} ${FAINTC('click')}`];
    if (this.collapsed) return lines;
    for (const e of this.entries) {
      const meta = [e.detail, formatDuration(e.seconds), e.tokens ? `${formatK(e.tokens)} tok` : ''].filter(Boolean).join(' · ');
      const metaText = FAINTC(truncateToWidth(meta, Math.max(10, Math.floor(width * 0.5)), '…'));
      const task = DIM(truncateToWidth(e.task.replace(/\s+/g, ' ').trim(), Math.max(10, width - visibleWidth(metaText) - 12), '…'));
      const row = `    ${color.accent(spinnerFrame())} ${task} ${FAINTC('click')}`;
      const gap = Math.max(1, width - visibleWidth(row) - visibleWidth(metaText) - 2);
      this.rowTargets.set(lines.length, e.sessionId);
      lines.push(`${row}${' '.repeat(gap)}${metaText}`);
    }
    return lines;
  }
}

export interface ApprovalDockOpts {
  tui: TUI;
  /** The approval question (kind 'approval' on the `ask` event): three fixed options — see
   *  brain/toolPermissions.ts. */
  question: AskQuestion;
  /** The user decided — deliver the picked option's LABEL ('Allow once' / 'Always allow' / 'Deny'). */
  onPick: (label: string) => void;
}

/** Blocking tool-approval prompt (permission `ask` rules), replacing the chat editor while parked —
 *  the approval sibling of AskChoiceDock, warning-toned so it reads as a security decision, not a
 *  content question. Keys: 1..9 pick instantly, arrows + Enter confirm, Esc = Deny. */
export class ApprovalDock implements Component, Focusable {
  private selectedIndex = 0;
  private _focused = false;

  constructor(private opts: ApprovalDockOpts) {}

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; }

  invalidate(): void { /* stateless render from the current selection */ }

  private options(): { label: string; description?: string }[] {
    return this.opts.question.options;
  }

  /** Esc resolves to the explicit Deny option (by label), so a bail can never approve anything. */
  private denyLabel(): string {
    const ops = this.options();
    return ops.find((o) => o.label === 'Deny')?.label ?? ops[ops.length - 1]?.label ?? 'Deny';
  }

  handleInput(data: string): void {
    const ops = this.options();
    if (isEscapeKey(data)) { this.opts.onPick(this.denyLabel()); return; }
    if (isUpKey(data)) { this.selectedIndex = (this.selectedIndex + ops.length - 1) % ops.length; this.opts.tui.requestRender(); return; }
    if (isDownKey(data)) { this.selectedIndex = (this.selectedIndex + 1) % ops.length; this.opts.tui.requestRender(); return; }
    if (/^[1-9]$/.test(data)) {
      const picked = ops[Number(data) - 1];
      if (picked) this.opts.onPick(picked.label);
      return;
    }
    if (isEnterKey(data)) {
      const picked = ops[this.selectedIndex];
      if (picked) this.opts.onPick(picked.label);
    }
  }

  render(width: number): string[] {
    const w = Math.max(2, width);
    const innerWidth = Math.max(1, w - 2);
    const theme = chatTheme();
    const border = color.warning;
    const fill = (text: string): string => `\x1b[${theme.inputBg}m${padAnsi(text, innerWidth)}\x1b[0m`;
    const row = (content: string): string => `${border('│')}${fill(content)}${border('│')}`;
    const rows = this.options().map((op, i) => {
      const key = `${i + 1}.`;
      const label = padAnsi(`${key} ${op.label}`, 20);
      const desc = truncateToWidth(op.description ?? '', Math.max(1, innerWidth - 20 - 5), '');
      if (i === this.selectedIndex) return `${border('│')}${color.selected(padAnsi(`  ${key} ${op.label}  ${desc}`, innerWidth))}${border('│')}`;
      return row(`  ${ansi.open(theme.text, label)} ${ansi.open(theme.muted, desc)}`);
    });
    return [
      `${border('╭')}${color.faint('─'.repeat(innerWidth))}${border('╮')}`,
      row(`  ${color.warning('⚠')} ${ansi.open(theme.text, 'Approval needed')}  ${ansi.open(theme.faint, this.opts.question.header || 'permission')}`),
      // The question carries the tool name / verbatim command — wrap, never truncate, so it stays auditable.
      ...wrapTextWithAnsi(this.opts.question.question, Math.max(1, innerWidth - 4)).map((line) => row(`  ${ansi.open(theme.text, line)}`)),
      row(''),
      ...rows,
      row(''),
      row(`  ${ansi.open(theme.text, '1-3')} ${ansi.open(theme.muted, 'pick')}  ${ansi.open(theme.text, 'enter')} ${ansi.open(theme.muted, 'confirm')}  ${ansi.open(theme.text, 'esc')} ${ansi.open(theme.muted, 'deny')}`),
      `${border('╰')}${color.faint('─'.repeat(innerWidth))}${border('╯')}`,
    ];
  }
}

export interface ApprovalFlowOpts {
  tui: TUI;
  /** The layout slot normally holding the editor; the flow borrows it, then restores the editor. */
  slot: Container;
  editor: Editor;
  question: AskQuestion;
  /** The user decided — deliver the picked option label (POSTed as the answer to /brain/answer). */
  onDecision: (label: string) => void;
}

/** Drive one blocking approval prompt in the TUI (the approval sibling of runAskFlow): swap the chat
 *  editor for an ApprovalDock, restore it on any decision, then deliver the pick. */
export function runApprovalFlow(o: ApprovalFlowOpts): void {
  const dock = new ApprovalDock({
    tui: o.tui,
    question: o.question,
    onPick: (label) => {
      o.slot.clear();
      o.slot.addChild(o.editor);
      o.tui.setFocus(o.editor);
      o.tui.requestRender(true);
      o.onDecision(label);
    },
  });
  o.slot.clear();
  o.slot.addChild(dock);
  o.tui.setFocus(dock);
  o.tui.requestRender(true);
}

/** Pending image attachments as a chip row above the input ("[img] shot.png · 42 KB · esc to drop").
 *  Renders nothing while empty, so it costs no rows until an image is attached. */
export class AttachmentChips implements Component {
  private images: { name: string; bytes: number }[] = [];
  invalidate(): void { /* state driven */ }
  set(images: { name: string; bytes: number }[]): void { this.images = images; }
  render(width: number): string[] {
    if (this.images.length === 0) return [];
    const chips = this.images.map((i) => `${color.accent('[img]')} ${color.text(i.name)} ${color.faint(`· ${Math.max(1, Math.round(i.bytes / 1024))} KB`)}`);
    return [truncateToWidth(`  ${chips.join('   ')} ${color.faint('· esc to drop')}`, width, '…')];
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
  // Muted, not full-bright: the command echo is context, not content (matches the dim tool rows).
  if (output.command) lines.push(` ${ansi.open(theme.faint, '$')} ${ansi.open(theme.muted, output.command)}`);
  if (output.status) {
    const statusColor = output.tone === 'warning' || output.tone === 'danger' ? theme.warning : theme.success;
    lines.push(` ${ansi.open(statusColor, output.status)}`);
  }
  if (lines.length > 0) lines.push('');
  const expandable = Boolean(output.fullText && output.fullText !== output.text);
  const body = expanded && output.fullText ? output.fullText : output.text;
  // A notes-only view (e.g. a formatter annotation under an edit diff) has an empty body — skip the
  // stray blank row it would otherwise render.
  for (const raw of body ? body.split('\n') : []) {
    if (!raw) { lines.push(''); continue; }
    // Bookkeeping lines ((cwd: …), [exit N], repeated $ command echoes) drop to faint — they are
    // context, not content, and at full muted they competed with the agent's actual reply.
    const toneColor = /^\s*(\(cwd: |\[exit \d+\]|\$ )/.test(raw)
      ? theme.faint
      : /\b(error|failed|warning|needs attention|exit\s+[1-9])\b/i.test(raw)
        ? theme.warning
        : /^✓|^(passed|success|ok)\b/i.test(raw)
          ? theme.success
          : theme.muted;
    lines.push(` ${ansi.open(toneColor, raw)}`);
  }
  // Hook-appended notes ("formatted a.ts with prettier") — faint suffix lines: context, not content.
  for (const note of output.notes ?? []) lines.push(` ${ansi.open(theme.faint, `· ${note}`)}`);
  if (expandable) {
    lines.push('');
    lines.push(` ${color.faint(expanded ? 'Click to collapse' : 'Click to expand')}`);
  }
  return simpleBlock(output.title, lines.map((line) => CODE_ROW(padAnsi(line, Math.max(1, width - 10)))), width);
}
