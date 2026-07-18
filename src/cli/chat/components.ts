import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { isDownKey, isEnterKey, isEscapeKey, isKeyRelease, isUpKey } from './keys.js';
import type { Component, Container, Editor, Focusable, TUI } from '@earendil-works/pi-tui';
import type { AskQuestion, BrainCard, BrainCardItem } from '../../brain/events.js';
import type { WorkflowState } from '../../brain/transcript.js';
import type { ProcessInfo } from '../../brain/processRegistry.js';
import { ansi, chatTheme, color, paintRow } from './theme.js';
import { highlightLine, wrapTokens } from './codeHighlight.js';
import type { CodeToken } from './codeHighlight.js';
import type { ToolOutputView } from '../../brain/messageView.js';
import { formatDuration, formatK, padAnsi, terminalInlineText, terminalPlainText } from '../ui/text.js';

/** opencode-style visual building blocks, hand-rolled on pi-tui's Component contract (render(width)
 *  → lines). Kept separate from app.ts so the layout logic stays readable and these are unit-testable. */

/** Bold that resets ONLY bold (\x1b[22m), so it never clears the surrounding background. */
const bold = (s: string): string => `\x1b[1m${s}\x1b[22m`;

/** Strip SGR sequences so a string is safe to wrap in a single background span — any embedded reset would
 *  otherwise end that background early (SGR has no stack). */
const stripSgr = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

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
const inlineText = terminalInlineText;
const TODO_PREVIEW_ITEMS = 4;

/** A rail section header: a collapse chevron, a bold label and optional faint meta — no full-width rule.
 *  Sections separate by the bold label plus the blank row between them, which keeps the rail airy instead
 *  of boxed in horizontal lines. Shared by every rail section so they all read and collapse the same way. */
export function sectionHeaderContent(chevron: string, label: string, meta = ''): string {
  return `${FAINTC(chevron)} ${bold(WHITE(label))}${meta ? ` ${FAINTC(meta)}` : ''}`;
}

/** Fit a pre-styled header to the panel width; over-wide content truncates with an ellipsis. The row is
 *  padded to width later by the panel's background paint, so nothing is appended here. */
export function sectionHeaderRow(content: string, width: number): string {
  return truncateToWidth(content, Math.max(1, width), '…');
}

/** Pick a useful compact Todo snapshot instead of blindly showing the first rows forever.
 *  The preview combines recent progress with the work that matters next, then restores source order
 *  so an interleaved checklist still reads naturally. An active item is always preferred over a
 *  merely pending item, and either group fills spare slots when the other has fewer than two rows. */
function todoPreviewItems(items: readonly BrainCardItem[], limit: number): BrainCardItem[] {
  if (limit <= 0) return [];
  if (items.length <= limit) return [...items];
  const completed = items.map((item, index) => ({ item, index }))
    .filter(({ item }) => item.status === 'completed');
  const remaining = items.map((item, index) => ({ item, index }))
    .filter(({ item }) => item.status !== 'completed');

  let completedCount = Math.min(2, completed.length, limit);
  let remainingCount = Math.min(2, remaining.length, limit - completedCount);
  let spare = limit - completedCount - remainingCount;
  const extraRemaining = Math.min(spare, remaining.length - remainingCount);
  remainingCount += extraRemaining;
  spare -= extraRemaining;
  completedCount += Math.min(spare, completed.length - completedCount);

  const selectedCompleted = completed.slice(-completedCount);
  const selectedRemaining = [...remaining]
    .sort((a, b) => {
      const activeDelta = Number(b.item.status === 'in_progress') - Number(a.item.status === 'in_progress');
      return activeDelta || a.index - b.index;
    })
    .slice(0, remainingCount);

  return [...selectedCompleted, ...selectedRemaining]
    .sort((a, b) => a.index - b.index)
    .map(({ item }) => item);
}

/** A full-width user message: a blue left rail and a raised gray background (opencode backgroundElement),
 *  padded to width. The rows are wrapped in one blank raised row top and bottom for breathing room. */
export class UserBlock implements Component {
  constructor(private text: string) {}
  invalidate(): void { /* stateless — rebuilt fresh each render */ }
  render(width: number): string[] {
    const railed = (body: string): string =>
      `${color.accent('▌')}${paintRow(chatTheme().inputBg, body, Math.max(0, width - 1))}`;
    const wrapped = wrapTextWithAnsi(terminalPlainText(this.text), Math.max(1, width - 3));
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
  private expanded = false;
  /** Hard layout budget supplied by the shell. A pinned card must never be allowed to grow the
   *  full-screen TUI beyond the terminal height; the transcript gets whatever rows remain. */
  private maxRows = Number.POSITIVE_INFINITY;
  /** Row indices (0-based, within this panel's own output) that are clickable card headers — so the app
   *  can hit-test a mouse click against them and toggle the checklist open/closed. */
  private headerRows = new Set<number>();
  private moreRows = new Set<number>();
  invalidate(): void { /* re-rendered on the next frame */ }
  set(cards: BrainCard[]): void { this.cards = cards; }
  setMaxRows(rows: number): void { this.maxRows = Math.max(0, Math.floor(rows)); }
  toggleCollapsed(): void { this.collapsed = !this.collapsed; }
  toggleExpanded(): void { this.expanded = !this.expanded; }
  isExpanded(): boolean { return this.expanded; }
  isHeaderRow(index: number): boolean { return this.headerRows.has(index); }
  isMoreRow(index: number): boolean { return this.moreRows.has(index); }
  /** Uncapped row count for the shell's row allocator. */
  desiredRows(_width = 80): number { return this.buildRows().length; }
  render(_width?: number): string[] {
    const lines = this.buildRows();
    if (lines.length <= this.maxRows) return lines;
    if (this.maxRows <= 0) { this.headerRows = new Set(); this.moreRows = new Set(); return []; }
    const shown = lines.slice(0, this.maxRows);
    if (this.maxRows > 1) {
      const moreRow = this.maxRows - 1;
      // Once the Todo is expanded, a hard terminal-height cap cannot reveal further rows. Keep the
      // control truthful: it returns to the four-item preview instead of pretending to expand again.
      const label = this.expanded ? '▴ Show less' : `… +${lines.length - this.maxRows + 1} more`;
      shown[moreRow] = `    ${color.accent(`\x1b[4m${label}\x1b[24m`)}`;
      this.headerRows.delete(moreRow);
      this.moreRows.add(moreRow);
    }
    this.headerRows = new Set([...this.headerRows].filter((row) => row < this.maxRows));
    this.moreRows = new Set([...this.moreRows].filter((row) => row < this.maxRows));
    return shown;
  }

  private buildRows(): string[] {
    // Pinned cards only; a checklist whose items are ALL completed collapses (the work is done).
    const visible = this.cards.filter((c) => c.pinned
      && !(c.items && c.items.length > 0 && c.items.every((i) => i.status === 'completed')));
    this.headerRows = new Set();
    this.moreRows = new Set();
    const lines: string[] = [];
    for (const c of visible) {
      this.headerRows.add(lines.length); // a card's first row is its clickable header
      const isTodoPreview = c.id === 'todos' && !this.expanded && !this.collapsed
        && (c.items?.length ?? 0) > TODO_PREVIEW_ITEMS;
      const isTodoExpanded = c.id === 'todos' && this.expanded && !this.collapsed
        && (c.items?.length ?? 0) > TODO_PREVIEW_ITEMS;
      const bodyRows = c.body ? terminalPlainText(c.body).split('\n').length : 0;
      const block = cardBlock(
        c,
        isTodoPreview ? TODO_PREVIEW_ITEMS + bodyRows : Number.POSITIVE_INFINITY,
        this.collapsed,
      );
      if (isTodoPreview) {
        // cardBlock already emits the `… +N more` note as the row right after the previewed items; just
        // register its clickable position — re-writing it here duplicated the exact same string.
        this.moreRows.add(lines.length + 1 + TODO_PREVIEW_ITEMS);
      } else if (isTodoExpanded) {
        const lessRow = lines.length + block.length;
        block.push(`    ${color.faint('▴ Show less')}`);
        this.moreRows.add(lessRow);
      }
      lines.push(...block);
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
  model?: string;
  thinkingLevel?: string;
  thinkingLabel?: string;
  background?: boolean;
  autoDeliver?: boolean;
  resultDelivery?: 'pending' | 'acknowledged';
}

/** A bounded live list shared by the telemetry rail and its narrow-terminal chat fallback — a spinner
 *  + task per row with the child's current tool and counters, each row clickable to open that session.
 *  Active agents only: running children plus terminal results awaiting parent acknowledgement. Settled
 *  transcript rows remain drillable after acknowledged entries leave this bounded rail. */
export class SubagentPanel implements Component {
  private entries: SubagentPanelEntry[] = [];
  private collapsed = false;
  private maxRows = Number.POSITIVE_INFINITY;
  private scrollOffset = 0;
  /** Row index (0-based within this panel's output) → the sub-agent session that row opens. */
  private rowTargets = new Map<number, string>();
  /** The sub-agent the user is currently switched into, or null while the parent is focused. */
  private selected: string | null = null;
  invalidate(): void { /* re-rendered on the next frame */ }
  set(entries: readonly SubagentPanelEntry[]): void {
    this.entries = entries.filter((e) => e.status === 'running' || e.resultDelivery === 'pending');
    this.clampScroll();
  }
  setSelected(sessionId: string | null): void { this.selected = sessionId; }
  setMaxRows(rows: number): void {
    this.maxRows = Math.max(0, Math.floor(rows));
    this.clampScroll();
  }
  desiredRows(): number { return this.entries.length === 0 ? 0 : this.collapsed ? 1 : this.entries.length + 1; }
  targetAt(index: number): string | null { return this.rowTargets.get(index) ?? null; }
  canScroll(): boolean { return !this.collapsed && this.viewportRows() > 0 && this.entries.length > this.viewportRows(); }
  scroll(delta: number): boolean {
    if (!this.canScroll()) return false;
    const previous = this.scrollOffset;
    this.scrollOffset = Math.max(0, Math.min(this.maxScrollOffset(), this.scrollOffset - Math.trunc(delta)));
    return this.scrollOffset !== previous;
  }
  /** The header (row 0) toggles the agent list open/closed, mirroring the Todos card. */
  isHeaderRow(index: number): boolean { return index === 0 && this.entries.length > 0 && this.maxRows > 0; }
  toggleCollapsed(): void { this.collapsed = !this.collapsed; this.clampScroll(); }
  render(width = 80): string[] {
    this.rowTargets = new Map();
    if (this.entries.length === 0 || this.maxRows <= 0) return [];
    const capacity = this.viewportRows();
    this.clampScroll();
    const range = this.canScroll()
      ? `${this.scrollOffset + 1}–${Math.min(this.entries.length, this.scrollOffset + capacity)}/${this.entries.length} ↕`
      : `${this.entries.length}`;
    const header = sectionHeaderContent(this.collapsed ? '▸' : '▾', 'Sub-agents', `${range} · click`);
    const lines: string[] = [sectionHeaderRow(header, Math.max(1, width))];
    if (this.collapsed) return lines;
    const shownEntries = this.entries.slice(this.scrollOffset, this.scrollOffset + capacity);
    for (const e of shownEntries) {
      // Built plain first, then coloured — geometry is measured on the plain strings (identical, since
      // visibleWidth strips ANSI) and the selected row MUST receive text with no escapes of its own: SGR
      // has no stack, so an embedded colour would end the highlight at the first glyph.
      const meta = [e.model, formatDuration(e.seconds), e.tokens ? `${formatK(e.tokens)} tok` : '']
        .filter(Boolean).map((value) => inlineText(String(value))).join(' · ');
      // truncateToWidth fences its '…' ellipsis with a `\x1b[0m` reset. On the selected row that reset ends
      // the highlight background early (SGR has no stack), so strip SGR here to keep these strings truly
      // plain — the contract the coloured branches below rely on.
      const metaPlain = stripSgr(truncateToWidth(meta, Math.max(10, Math.floor(width * 0.5)), '…'));
      const taskPlain = stripSgr(truncateToWidth(inlineText(e.task), Math.max(10, width - visibleWidth(metaPlain) - 12), '…'));
      const iconPlain = e.status === 'running' ? '●' : e.status === 'done' ? '✓' : '✗';
      const rowPlain = `    ${iconPlain} ${taskPlain} click`;
      const gap = Math.max(1, width - visibleWidth(rowPlain) - visibleWidth(metaPlain) - 2);
      this.rowTargets.set(lines.length, e.sessionId);
      if (e.sessionId === this.selected) {
        // Strip once more AFTER padAnsi: when the row overflows, padAnsi truncates and re-inserts an
        // ellipsis reset of its own, which would again break the single background span.
        lines.push(color.selected(stripSgr(padAnsi(`${rowPlain}${' '.repeat(gap)}${metaPlain}`, width))));
        continue;
      }
      const icon = e.status === 'running' ? color.warning('●') : e.status === 'done' ? color.success('✓') : color.error('✗');
      lines.push(`    ${icon} ${DIM(taskPlain)} ${FAINTC('click')}${' '.repeat(gap)}${FAINTC(metaPlain)}`);
    }
    return lines;
  }

  private viewportRows(): number {
    return Number.isFinite(this.maxRows) ? Math.max(0, this.maxRows - 1) : this.entries.length;
  }
  private maxScrollOffset(): number { return Math.max(0, this.entries.length - this.viewportRows()); }
  private clampScroll(): void { this.scrollOffset = Math.min(this.scrollOffset, this.maxScrollOffset()); }
}

/** Count a workflow's node statuses into the `✓done ●running ⏸pending ✗error` summary shown on its row.
 *  Shared by the telemetry rail and the transcript marker so one workflow never tallies two ways. */
export function workflowCounts(w: WorkflowState): { done: number; running: number; pending: number; error: number; tokens: number } {
  const counts = { done: 0, running: 0, pending: 0, error: 0, tokens: 0 };
  for (const n of w.nodes) {
    if (n.status === 'done') counts.done += 1;
    else if (n.status === 'running') counts.running += 1;
    else if (n.status === 'error') counts.error += 1;
    else counts.pending += 1;
    if (n.tokens) counts.tokens += n.tokens;
  }
  return counts;
}

/** The telemetry-rail "Workflow" section: one clickable row per RUNNING workflow (a DAG the agent
 *  launched via WorkflowStart). Each row shows the workflow title, its live node tally
 *  (`✓done ●running ⏸pending`) and total tokens; clicking a row opens the navigable workflow modal.
 *  Mirrors SubagentPanel's collapse/scroll/hit-test contract so the rail behaves consistently. */
export class WorkflowPanel implements Component {
  private entries: WorkflowState[] = [];
  private collapsed = false;
  private maxRows = Number.POSITIVE_INFINITY;
  private scrollOffset = 0;
  /** Row index (0-based within this panel's output) → the workflow id that row opens in the modal. */
  private rowTargets = new Map<number, string>();
  invalidate(): void { /* re-rendered on the next frame */ }
  set(entries: readonly WorkflowState[]): void {
    this.entries = entries.filter((w) => w.status === 'running');
    this.clampScroll();
  }
  setMaxRows(rows: number): void { this.maxRows = Math.max(0, Math.floor(rows)); this.clampScroll(); }
  desiredRows(): number { return this.entries.length === 0 ? 0 : this.collapsed ? 1 : this.entries.length + 1; }
  targetAt(index: number): string | null { return this.rowTargets.get(index) ?? null; }
  canScroll(): boolean { return !this.collapsed && this.viewportRows() > 0 && this.entries.length > this.viewportRows(); }
  scroll(delta: number): boolean {
    if (!this.canScroll()) return false;
    const previous = this.scrollOffset;
    this.scrollOffset = Math.max(0, Math.min(this.maxScrollOffset(), this.scrollOffset - Math.trunc(delta)));
    return this.scrollOffset !== previous;
  }
  isHeaderRow(index: number): boolean { return index === 0 && this.entries.length > 0 && this.maxRows > 0; }
  toggleCollapsed(): void { this.collapsed = !this.collapsed; this.clampScroll(); }
  render(width = 80): string[] {
    this.rowTargets = new Map();
    if (this.entries.length === 0 || this.maxRows <= 0) return [];
    const capacity = this.viewportRows();
    this.clampScroll();
    const range = this.canScroll()
      ? `${this.scrollOffset + 1}–${Math.min(this.entries.length, this.scrollOffset + capacity)}/${this.entries.length} ↕`
      : `${this.entries.length}`;
    const header = sectionHeaderContent(this.collapsed ? '▸' : '▾', 'Workflow', `${range} · click`);
    const lines: string[] = [sectionHeaderRow(header, Math.max(1, width))];
    if (this.collapsed) return lines;
    const shownEntries = this.entries.slice(this.scrollOffset, this.scrollOffset + capacity);
    for (const w of shownEntries) {
      const c = workflowCounts(w);
      const tally = [
        color.success(`${c.done}✓`), color.warning(`${c.running}●`), FAINTC(`${c.pending}⏸`),
        ...(c.error ? [color.error(`${c.error}✗`)] : []),
      ].join(' ');
      const meta = [tally, c.tokens ? FAINTC(`${formatK(c.tokens)} tok`) : ''].filter(Boolean).join('  ');
      const label = w.title || `${w.nodes.length}-node workflow`;
      const title = DIM(truncateToWidth(inlineText(label), Math.max(10, width - visibleWidth(meta) - 12), '…'));
      const row = `    ${color.accent('⛓')} ${title} ${FAINTC('click')}`;
      const gap = Math.max(1, width - visibleWidth(row) - visibleWidth(meta) - 2);
      this.rowTargets.set(lines.length, w.id);
      lines.push(`${row}${' '.repeat(gap)}${meta}`);
    }
    return lines;
  }

  private viewportRows(): number {
    return Number.isFinite(this.maxRows) ? Math.max(0, this.maxRows - 1) : this.entries.length;
  }
  private maxScrollOffset(): number { return Math.max(0, this.entries.length - this.viewportRows()); }
  private clampScroll(): void { this.scrollOffset = Math.min(this.scrollOffset, this.maxScrollOffset()); }
}

/** A slim fixed panel under the Sub-agents card listing the owner's live background shell processes
 *  (the terminal plugin's `Bash(background:true)` children). One row per RUNNING process — a
 *  status dot, the truncated command, its run time and a clickable ✕ that kills it. Exited/killed
 *  processes drop off (the daemon's `process` snapshot is the single source of truth); renders nothing
 *  when none run, so the bottom stack pays zero rows at rest. */
export class ProcessPanel implements Component {
  private entries: ProcessInfo[] = [];
  private collapsed = false;
  private maxRows = Number.POSITIVE_INFINITY;
  /** Row index (0-based within this panel's output) → the kill target on that row: the process id and
   *  the 1-based screen-column span its ✕ occupies (the panel renders flush to the left edge, so a
   *  visible-string column maps directly to a screen column for hit-testing). */
  private killZones = new Map<number, { id: string; x0: number; x1: number }>();
  invalidate(): void { /* re-rendered on the next frame */ }
  set(processes: ProcessInfo[]): void { this.entries = processes.filter((p) => p.running); }
  setMaxRows(rows: number): void { this.maxRows = Math.max(0, Math.floor(rows)); }
  /** The header (row 0) toggles the process list open/closed, mirroring the Todos card. */
  isHeaderRow(index: number): boolean { return index === 0 && this.entries.length > 0 && this.maxRows > 0; }
  toggleCollapsed(): void { this.collapsed = !this.collapsed; }
  /** The process whose ✕ covers screen column `x` on panel row `index`, or null (no ✕ there). */
  killAt(index: number, x: number): string | null {
    const z = this.killZones.get(index);
    return z && x >= z.x0 && x <= z.x1 ? z.id : null;
  }
  render(width = 80, now = Date.now()): string[] {
    this.killZones = new Map();
    if (this.entries.length === 0 || this.maxRows <= 0) return [];
    const lines = [sectionHeaderRow(sectionHeaderContent(this.collapsed ? '▸' : '▾', 'Processes', `${this.entries.length} running · click ✕`), Math.max(1, width))];
    if (this.collapsed) return lines;
    const room = Math.max(0, this.maxRows - 1);
    const needsSummary = this.entries.length > room;
    const shownEntries = this.entries.slice(0, Math.max(0, room - (needsSummary && room > 1 ? 1 : 0)));
    for (const p of shownEntries) {
      const secs = Math.max(0, Math.round((now - new Date(p.startedAt).getTime()) / 1000));
      const meta = FAINTC(formatDuration(secs));
      const kill = color.error('✕');
      const cmd = DIM(truncateToWidth(inlineText(p.command), Math.max(10, width - visibleWidth(meta) - 12), '…'));
      const row = `    ${GREENC('●')} ${cmd}`;
      const gap = Math.max(1, width - visibleWidth(row) - visibleWidth(meta) - 3);
      const full = `${row}${' '.repeat(gap)}${meta} ${kill}`;
      // The ✕ is the last visible glyph — its 1-based column is the row's visible width. Give it a
      // couple columns of slack so a near-miss click still lands the kill.
      const killCol = visibleWidth(full);
      this.killZones.set(lines.length, { id: p.id, x0: killCol - 1, x1: killCol + 1 });
      lines.push(full);
    }
    if (shownEntries.length < this.entries.length && lines.length < this.maxRows) {
      lines.push(`    ${FAINTC(`… +${this.entries.length - shownEntries.length} more running`)}`);
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
    if (isKeyRelease(data)) return; // Kitty release edge — one keypress selects/cycles once
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
    const fill = (text: string): string => paintRow(theme.inputBg, text, innerWidth);
    const row = (content: string): string => `${border('│')}${fill(content)}${border('│')}`;
    const rows = this.options().map((op, i) => {
      const key = `${i + 1}.`;
      const safeLabel = inlineText(op.label);
      const label = padAnsi(`${key} ${safeLabel}`, 20);
      const desc = truncateToWidth(inlineText(op.description ?? ''), Math.max(1, innerWidth - 20 - 5), '');
      if (i === this.selectedIndex) return `${border('│')}${color.selected(padAnsi(`  ${key} ${safeLabel}  ${desc}`, innerWidth))}${border('│')}`;
      return row(`  ${ansi.open(theme.text, label)} ${ansi.open(theme.muted, desc)}`);
    });
    return [
      `${border('╭')}${color.faint('─'.repeat(innerWidth))}${border('╮')}`,
      row(`  ${color.warning('⚠')} ${ansi.open(theme.text, 'Approval needed')}  ${ansi.open(theme.faint, inlineText(this.opts.question.header || 'permission'))}`),
      // The question carries the tool name / verbatim command — wrap, never truncate, so it stays auditable.
      ...wrapTextWithAnsi(terminalPlainText(this.opts.question.question), Math.max(1, innerWidth - 4)).map((line) => row(`  ${ansi.open(theme.text, line)}`)),
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
    const chips = this.images.map((i) => `${color.accent('[img]')} ${color.text(inlineText(i.name))} ${color.faint(`· ${Math.max(1, Math.round(i.bytes / 1024))} KB`)}`);
    return [truncateToWidth(`  ${chips.join('   ')} ${color.faint('· esc to drop')}`, width, '…')];
  }
}

/** Pending mid-turn messages as dim QUEUED lines above the input — the opencode "queued prompt" look
 *  (a bright ' QUEUED ' pill + the message text). These are messages typed while a turn streams; they are
 *  STEERED into the running turn (PI delivers them between steps) and reported as a transient backlog via
 *  the daemon's `queue` snapshot. Renders nothing while empty, so it costs no rows at rest. `removeHint` is
 *  a faint one-line reminder of the remove-last keybind, shown only while the queue is non-empty. */
export class QueuedMessages implements Component {
  private items: { id: string; text: string }[] = [];
  private removeHint: string | null = null;
  private maxRows = Number.POSITIVE_INFINITY;
  invalidate(): void { /* state driven */ }
  set(items: { id: string; text: string }[], removeHint?: string | null): void { this.items = items; this.removeHint = removeHint ?? null; }
  /** Bound the queue strip inside the full-screen shell. The complete queue remains in state; this only
   *  changes its compact presentation so queued prompts can never crowd the transcript off-screen. */
  setMaxRows(rows: number | null): void {
    this.maxRows = rows == null ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(rows));
  }
  render(width: number): string[] {
    if (this.items.length === 0 || this.maxRows <= 0) return [];
    const pill = color.selected(' QUEUED ');
    const room = Math.max(8, width - 2 - visibleWidth(pill) - 2);
    const lines = this.items.map((it) => `  ${pill} ${DIM(truncateToWidth(inlineText(it.text), room, '…'))}`);
    if (this.removeHint) lines.push(`  ${FAINTC(inlineText(this.removeHint))}`);
    if (lines.length <= this.maxRows) return lines;
    const clipped = lines.slice(0, this.maxRows);
    clipped[this.maxRows - 1] = `  ${FAINTC(`… +${Math.max(1, this.items.length - Math.max(0, this.maxRows - 1))} more queued`)}`;
    return clipped;
  }
}

/** A bottom status bar: left text and right text justified to the two edges. The left side may
 *  instead be a fitter callback receiving the exact width available at render time, so adaptive
 *  content (drop-whole-segments hints) is built for the real width and the truncation below stays
 *  a defensive path rather than the mechanism that shapes the line. */
export class StatusBar implements Component {
  private leftFit: ((availableWidth: number) => string) | null = null;
  constructor(private left: string, private right: string) {}
  invalidate(): void { /* re-rendered on the next frame */ }
  setLeft(left: string): void { this.left = left; this.leftFit = null; }
  setLeftFit(fit: ((availableWidth: number) => string) | null): void { this.leftFit = fit; }
  setRight(right: string): void { this.right = right; }
  render(width: number): string[] {
    let right = this.right;
    const maxRight = Math.max(0, Math.floor(width * 0.55));
    if (visibleWidth(right) > maxRight) right = truncateToWidth(right, maxRight, '…');
    const availableLeft = Math.max(0, width - visibleWidth(right) - 1);
    let left = this.leftFit ? this.leftFit(availableLeft) : this.left;
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
  const header = `  ${FAINTC(collapsed ? '▸' : '▾')} ${bold(WHITE(inlineText(card.title ?? 'Todos')))}${counter} ${FAINTC('click')}`;
  if (collapsed) return [header];
  const lines = [header];
  const bodyLines = card.body ? terminalPlainText(card.body).split('\n') : [];
  const shownItems = Math.min(items.length, Math.max(0, maxRows - bodyLines.length));
  const visibleItems = card.id === 'todos'
    ? todoPreviewItems(items, shownItems)
    : items.slice(0, shownItems);
  for (const it of visibleItems) {
    const text = inlineText(it.text);
    if (it.status === 'completed') lines.push(`    ${GREENC('[x]')} ${DIM(text)}`);
    else if (it.status === 'in_progress') lines.push(`    ${color.warning('[•]')} ${color.warning(text)}`);
    else lines.push(`    ${FAINTC('[ ]')} ${DIM(text)}`);
  }
  if (items.length > shownItems) lines.push(`    ${FAINTC(`… +${items.length - shownItems} more`)}`);
  for (const l of bodyLines.slice(0, maxRows)) lines.push(`    ${DIM(l)}`);
  return lines;
}

const GIT_ADD_BG = ansi.bg(3, 58, 22);
const GIT_ADD_FG = ansi.fg(63, 185, 80);
const GIT_DEL_BG = ansi.bg(103, 6, 12);
const GIT_DEL_FG = ansi.fg(248, 81, 73);
const GIT_ADD = `${GIT_ADD_BG};${GIT_ADD_FG}`;
const GIT_DEL = `${GIT_DEL_BG};${GIT_DEL_FG}`;
const CODE_BG = ansi.bg(13, 13, 16);
const DIFF_ADD = (t: string): string => ansi.sgr(GIT_ADD, t);
const DIFF_DEL = (t: string): string => ansi.sgr(GIT_DEL, t);
/** A code/diff row on the block background. Painted, not merely opened: the row's own text resets its
 *  colour (the faint gutter, the dim source), and a bare background would end at the first of those. */
const CODE_ROW = (t: string, width?: number): string => paintRow(CODE_BG, t, width ?? visibleWidth(t));
const LEGACY_SIGN = /^\s*\d+ ([-+ ]) /;
const PI_ROW = /^([-+ ])\s*(\d+) (.*)$/;
const LEGACY_ROW = /^\s*(\d+) ([-+ ]) (.*)$/;

/** A syntax-highlighted diff row: per-token foregrounds composited over the row's semantic (add/del/
 *  context) background. Every SGR re-opens the background because SGR has no stack — a bare reset
 *  would drop it; the trailing padding stays background-only and the row closes with one reset. */
function paintTokenRow(gutter: string, gutterFg: string, parts: readonly CodeToken[], bg: string, width?: number): string {
  const head = `\x1b[${bg};${gutterFg}m ${gutter} `;
  const body = parts.map((p) => `\x1b[${bg};${p.fg}m${p.text}`).join('');
  const used = visibleWidth(gutter) + 2 + parts.reduce((sum, p) => sum + visibleWidth(p.text), 0);
  const pad = width != null && used < width ? `\x1b[${bg}m${' '.repeat(width - used)}` : '';
  return `${head}${body}${pad}\x1b[0m`;
}

function diffLine(line: string, width?: number, lang?: string | null): string[] {
  const pi = PI_ROW.exec(line);
  const legacy = LEGACY_ROW.exec(line);
  const sign = pi?.[1] ?? legacy?.[2] ?? ' ';
  const num = pi?.[2] ?? legacy?.[1] ?? '';
  const text = pi?.[3] ?? legacy?.[3] ?? line;
  const gutter = `${num.padStart(5)} ${sign}`;
  // Wrap the source under a fixed gutter instead of truncating it: continuation rows repeat the gutter
  // width as blanks, so an over-wide line stays fully readable and column-aligned. Row width is
  // ` ${gutter} ${text}`, i.e. gutter + 2 framing spaces; a caller with no width keeps the single-row form.
  const gutterPad = ' '.repeat(visibleWidth(gutter));
  const textWidth = width ? Math.max(1, width - visibleWidth(gutter) - 2) : undefined;
  const bg = sign === '+' ? GIT_ADD_BG : sign === '-' ? GIT_DEL_BG : CODE_BG;
  // Syntax path: the background keeps the add/del semantics, the foreground carries the grammar
  // (VSCode-style). highlightLine is null until the grammar loads — the plain path renders then.
  const tokens = lang ? highlightLine(text, lang) : null;
  if (tokens) {
    const gutterFg = sign === '+' ? GIT_ADD_FG : sign === '-' ? GIT_DEL_FG : chatTheme().faint;
    const rows = textWidth ? wrapTokens(tokens, textWidth) : [tokens];
    return rows.map((toks, i) => paintTokenRow(i === 0 ? gutter : gutterPad, gutterFg, toks, bg, width));
  }
  const segments = textWidth ? wrapTextWithAnsi(text, textWidth) : [text];
  return segments.map((seg, i) => {
    const g = i === 0 ? gutter : gutterPad;
    const padded = width ? padAnsi(` ${g} ${seg}`, width) : ` ${g} ${seg}`;
    if (sign === '+') return DIFF_ADD(padded);
    if (sign === '-') return DIFF_DEL(padded);
    return CODE_ROW(`${color.faint(g)} ${color.dim(seg)}`, width);
  });
}

/** Sanitize a display diff into terminal-safe raw rows. This is the single expensive parse pass; both
 *  {@link diffBlock} and {@link framedDiffBlock} reuse its output so a diff is never scanned twice. */
function parseDiffRows(diff: string): string[] {
  return terminalPlainText(diff).replace(/\n+$/, '').split('\n');
}

/** Colour pre-parsed diff rows (see {@link parseDiffRows}) with stable line numbers and git-style
 *  add/delete backgrounds, capped so a huge edit can't flood the conversation. When `lang` names a
 *  loaded grammar, changed and context lines are additionally syntax-highlighted (fg composited over
 *  the semantic row background). */
function renderDiffRows(rows: readonly string[], maxLines = 60, rowWidth?: number, lang?: string | null): string[] {
  // Cap on LOGICAL diff rows (so "+N more lines" stays a diff-line count), then wrap each shown row —
  // one over-wide source line can now expand into several visual rows without inflating that count.
  const rendered = rows.slice(0, maxLines).flatMap((l) => {
    const s = PI_ROW.exec(l)?.[1] ?? LEGACY_SIGN.exec(l)?.[1];
    return s === '+' || s === '-' || s === ' ' ? diffLine(l, rowWidth, lang) : [CODE_ROW(color.dim(l), rowWidth)];
  });
  const shown = rendered.map((l) => `    ${l}`);
  if (rows.length > maxLines) shown.push(`    ${FAINTC(`… +${rows.length - maxLines} more lines`)}`);
  return shown;
}

/** Render a display diff with stable line numbers and git-style add/delete colors. Indented under the
 *  file-action label and capped so a huge edit can't flood the conversation. */
export function diffBlock(diff: string, maxLines = 60, rowWidth?: number, lang?: string | null): string[] {
  return renderDiffRows(parseDiffRows(diff), maxLines, rowWidth, lang);
}

// A tool's nested block (diff / console output) sits one level DEEPER than the 4-space tool row: its
// `< title` header aligns with the tool row (4) and its body rows indent to 6, so the hierarchy reads
// tool → its output. Widths below subtract the extra indent so long lines still fit without wrapping.
const BLOCK_HEADER_INDENT = '    ';
const BLOCK_BODY_INDENT = '      ';

function simpleBlock(title: string, lines: string[], width: number, footer?: string): string[] {
  const inner = Math.max(24, width - 8);
  // An empty title renders a bare `<` connector — the console block does this: the `$ command` line right
  // below already says "shell output", so a "console output" label was just noise. Named blocks (diff,
  // search result, browser observation) keep their label since it isn't otherwise obvious.
  const out = [`${BLOCK_HEADER_INDENT}${title ? `${color.faint('<')} ${color.text(title)}` : color.faint('<')}`];
  for (const line of lines) {
    // diffBlock/toolOutputBlock already allocate and pad nested rows. Re-running ANSI-aware truncation on
    // every exact row dominated burst frames; retain it only as the defensive overflow path.
    const fitted = visibleWidth(line) <= inner ? line : truncateToWidth(line, inner, '…');
    out.push(`${BLOCK_BODY_INDENT}${fitted}`);
  }
  if (footer) out.push(`${BLOCK_BODY_INDENT}${color.faint(footer)}`);
  return out;
}

/** File diff preview for the chat transcript: quiet left label + code rows, no decorative frame. The
 *  diff is parsed exactly once ({@link parseDiffRows}); the caller marks the trailing row as the
 *  expand/collapse toggle iff `expandable` is true. When collapsed, `renderDiffRows` already emits the
 *  `… +N more lines` note as that trailing row, so no redundant replacement is needed. */
export function framedDiffBlock(
  diff: string, width: number, title = 'diff', expanded = false, lang?: string | null,
): { lines: string[]; expandable: boolean } {
  const inner = Math.max(24, width - 12);
  const previewLines = 18;
  const rows = parseDiffRows(diff);
  const expandable = rows.length > previewLines;
  const lines = renderDiffRows(rows, expanded ? Number.POSITIVE_INFINITY : previewLines, inner, lang);
  // Expanded shows every row, so append the collapse affordance; collapsed already carries the
  // more-lines note as its last row.
  if (expandable && expanded) lines.push(`    ${color.faint('▴ Click to collapse')}`);
  return { lines: simpleBlock(title, lines, width), expandable };
}

/** Console/tool output preview. The daemon already decides which tool results are worth showing;
 *  this renderer keeps them compact and visually separate from assistant prose. */
export function toolOutputBlock(output: ToolOutputView, width: number, expanded = false): string[] {
  const theme = chatTheme();
  const lines: string[] = [];
  // Muted, not full-bright: the command echo is context, not content (matches the dim tool rows).
  if (output.command) lines.push(` ${ansi.open(theme.faint, '$')} ${ansi.open(theme.muted, terminalPlainText(output.command).replace(/\s+/g, ' ').trim())}`);
  const status = output.status ? terminalPlainText(output.status).replace(/\s+/g, ' ').trim() : '';
  if (status && !/^\[?exit\s+0\]?$/i.test(status)) {
    const statusColor = output.tone === 'warning' || output.tone === 'danger' ? theme.warning : theme.success;
    lines.push(` ${ansi.open(statusColor, status)}`);
  }
  if (lines.length > 0) lines.push('');
  const expandable = Boolean(output.fullText && output.fullText !== output.text);
  const body = terminalPlainText(expanded && output.fullText ? output.fullText : output.text);
  // A notes-only view (e.g. a formatter annotation under an edit diff) has an empty body — skip the
  // stray blank row it would otherwise render.
  for (const raw of body ? body.split('\n') : []) {
    if (!raw) { lines.push(''); continue; }
    if (/^\s*\[?exit\s+0\]?\s*$/i.test(raw)) continue;
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
  for (const note of output.notes ?? []) lines.push(` ${ansi.open(theme.faint, `· ${terminalPlainText(note).replace(/\s+/g, ' ').trim()}`)}`);
  if (expandable) {
    lines.push('');
    lines.push(` ${color.faint(expanded ? 'Click to collapse' : 'Click to expand')}`);
  }
  // Console output drops its title (bare `<` connector) — the `$ command` echo already identifies it;
  // other kinds (search result, browser observation, tool result) keep the label.
  const title = output.kind === 'console' ? '' : terminalPlainText(output.title).replace(/\s+/g, ' ').trim();
  return simpleBlock(title, lines.map((line) => CODE_ROW(line, Math.max(1, width - 12))), width);
}
