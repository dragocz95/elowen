import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { MASCOT_ART } from './mascot.js';
import type { Component, MarkdownTheme } from '@earendil-works/pi-tui';
import { framedDiffBlock, spinnerFrame, toolOutputBlock, UserBlock } from './components.js';
import { ansi, chatTheme, color, glyph } from './theme.js';
import type { BrainUsageView, McpServerView } from './brainClient.js';
import type { ChatView, ToolItem } from '../../brain/transcript.js';
import { formatDuration, formatK, padAnsi } from '../ui/text.js';

export const TOP_RULE_ROWS = 1;
export const PANEL_GUTTER_COLUMNS = 3;
export const ENABLE_MOUSE = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';
export const DISABLE_MOUSE = '\x1b[?1000l\x1b[?1002l\x1b[?1006l';

export interface MouseEvent {
  code: number;
  x: number;
  y: number;
  down: boolean;
}

export function mouseEvent(data: string): MouseEvent | null {
  const m = /^\x1b\[<(\d+);(\d+);(\d+)([mM])$/.exec(data);
  if (!m) return null;
  return { code: Number(m[1]), x: Number(m[2]), y: Number(m[3]), down: m[4] === 'M' };
}

export function mouseWheel(data: string): number {
  const ev = mouseEvent(data);
  if (!ev?.down || (ev.code & 64) !== 64) return 0;
  return (ev.code & 1) === 0 ? 3 : -3;
}

export function mouseClick(data: string): { x: number; y: number } | null {
  const ev = mouseEvent(data);
  if (!ev?.down || ev.code !== 0) return null;
  return { x: ev.x, y: ev.y };
}

const bgFill = (text: string, width: number, bgCode = chatTheme().inputBg): string => `\x1b[${bgCode}m${padAnsi(text, width)}\x1b[0m`;

/** Welcome/panel banner height: just the flame mascot (no wordmark — the logo speaks for itself). The
 *  start screen's vertical-centering math keys off this so the logo block stays centered. */
const BANNER_ROWS = MASCOT_ART.length;

/** opencode-style per-tool row spec: a fixed glyph + Title-case verb, keyed on the tool NAME so live
 *  and resumed-history rows render identically (`item.icon` exists only on live events). The glyph set
 *  mirrors opencode: `→` reads, `←` writes/edits, `✱` searches, `%` fetches, `⚙` everything else. */
function toolRowSpec(name: string, detail?: string): { glyph: string; title: string } {
  const t = (label: string): string => (detail ? `${label} ${detail}` : label);
  if (/(search|grep|glob)/i.test(name)) return { glyph: '✱', title: detail ? `Search "${detail}"` : 'Search' };
  if (/(edit|patch|update|modify|replace)/i.test(name)) return { glyph: '←', title: t('Edit') };
  if (/(write|create)/i.test(name)) return { glyph: '←', title: t('Write') };
  if (/(read|open|cat)/i.test(name)) return { glyph: '→', title: t('Read') };
  if (/list_dir/i.test(name)) return { glyph: '→', title: t('List') };
  if (/diff/i.test(name)) return { glyph: '←', title: t('Diff') };
  if (/(lsp|diagnostic)/i.test(name)) return { glyph: '✱', title: t('Diagnostics') };
  if (/(fetch|web|http|url)/i.test(name)) return { glyph: '%', title: t('Fetch') };
  return { glyph: '⚙', title: t(name.replace(/[_-]+/g, ' ')) };
}

function toolTitle(name: string, detail?: string): string {
  return toolRowSpec(name, detail).title;
}

interface TranscriptRow {
  line: string;
  kind?: 'thought' | 'expandable' | 'subagent';
  key?: string;
}

export class TopRule implements Component {
  /** `getTitle` supplies the active conversation's name; falls back to the brand when it's still empty
   *  (a brand-new, not-yet-titled chat). Kept as a getter so the rule re-renders when the title lands. */
  constructor(private readonly getTitle: () => string = () => '') {}
  invalidate(): void { /* stateless */ }
  render(width: number): string[] {
    const title = this.getTitle().trim();
    const label = title
      ? ` ${color.accent(glyph.whale)} ${color.text(truncateToWidth(title, Math.max(8, width - 12), '…'))} `
      // The brand fallback is 28 visible chars — on a narrower terminal it MUST clip too, or pi-tui's
      // width assert throws and takes the whole TUI down (leaving mouse reporting on).
      : truncateToWidth(` ${color.accent('Elowen Chat')} ${color.faint('new conversation')} `, width, '…');
    return [`${label}${color.accent('─'.repeat(Math.max(0, width - visibleWidth(label))))}`];
  }
}

export class MainColumn implements Component {
  /** `getChildren` so the column can swap its stack per render (start screen ↔ normal chat layout). */
  constructor(private getReserve: () => number, private getChildren: () => Component[]) {}
  invalidate(): void { for (const child of this.getChildren()) child.invalidate?.(); }
  render(width: number): string[] {
    const reserve = Math.max(0, Math.min(width - 24, this.getReserve()));
    const mainWidth = Math.max(24, width - reserve);
    const lines: string[] = [];
    for (const child of this.getChildren()) {
      for (const line of child.render(mainWidth)) {
        lines.push(`${padAnsi(line, mainWidth)}${' '.repeat(reserve)}`);
      }
    }
    return lines;
  }
}

export interface StartScreenState {
  /** Pre-coloured model/mode line shown under the input (mirrors the normal prompt meta line). */
  modelLine: string;
  /** Pre-coloured keyboard hints, right-aligned to the input box edge. */
  hints: string;
  /** Pre-coloured tip line, centered below the hints. */
  tip: string;
  /** Transient system lines (command output, errors) that normally render in the transcript. */
  notice: string;
  /** Pre-coloured bottom-left status (project dir · git branch). */
  statusLeft: string;
  /** Plain version string, rendered faint in the bottom-right corner. */
  version: string;
}

/** The centered input box geometry of the start screen — shared with overlay anchoring (the slash
 *  suggestions must open right under this input, not at the normal layout's bottom-of-screen slot). */
export function startScreenBox(width: number): { boxWidth: number; leftPad: number } {
  const boxWidth = Math.max(32, Math.min(72, width - 8));
  return { boxWidth, leftPad: Math.max(0, Math.floor((width - boxWidth) / 2)) };
}

/** Row (0-based, within the start screen's rows) where the input box starts — mirror of the vertical
 *  centering in {@link StartScreen.render}, kept here so overlay anchoring can never drift from it. */
export function startScreenInputTop(rows: number, inputRows: number, noticeRows: number): number {
  const bodyLength = BANNER_ROWS + 1 + inputRows + 2 + 2 + 1 + (noticeRows ? 1 + noticeRows : 0);
  const topPad = Math.max(0, Math.floor((rows - 1 - bodyLength) / 2) - 1);
  return topPad + BANNER_ROWS + 1;
}

/** The empty-conversation start screen (opencode-style): a centered two-tone ELOWEN wordmark, the input
 *  box beneath it with the model line, keyboard hints, a tip — and a slim bottom status row with the
 *  project on the left and the Elowen version in the bottom-right corner. The right telemetry panel stays
 *  hidden until the first message lands. */
export class StartScreen implements Component {
  constructor(
    private readonly input: Component,
    private readonly getRows: () => number,
    private readonly getState: () => StartScreenState,
  ) {}
  invalidate(): void { this.input.invalidate?.(); }
  render(width: number): string[] {
    const st = this.getState();
    const center = (text: string): string => `${' '.repeat(Math.max(0, Math.floor((width - visibleWidth(text)) / 2)))}${text}`;
    const { boxWidth, leftPad } = startScreenBox(width);
    const indent = ' '.repeat(leftPad);
    const inputLines = this.input.render(boxWidth);
    const noticeLines = st.notice ? st.notice.split('\n') : [];
    const body = [
      ...MASCOT_ART.map((line) => center(line)),
      '',
      ...inputLines.map((line) => `${indent}${line}`),
      `${indent}${truncateToWidth(st.modelLine, boxWidth, '…')}`,
      `${' '.repeat(Math.max(0, leftPad + boxWidth - visibleWidth(st.hints)))}${st.hints}`,
      '',
      '',
      center(st.tip),
      ...(noticeLines.length ? ['', ...noticeLines.map((line) => center(line))] : []),
    ];
    const versionLabel = color.faint(`elowen v${st.version}`);
    const statusGap = Math.max(1, width - 2 - visibleWidth(st.statusLeft) - visibleWidth(versionLabel) - 2);
    const statusRow = `  ${st.statusLeft}${' '.repeat(statusGap)}${versionLabel}`;
    const rows = this.getRows();
    // Center the block vertically, biased slightly upward (startScreenInputTop mirrors this math);
    // the status row is pinned to the last line.
    const topPad = Math.max(0, startScreenInputTop(rows, inputLines.length, noticeLines.length) - BANNER_ROWS - 1);
    const lines: string[] = Array.from({ length: topPad }, () => '');
    lines.push(...body);
    while (lines.length < rows - 1) lines.push('');
    lines.push(statusRow);
    return lines;
  }
}

export interface ChatViewportState {
  view: ChatView;
  notice: string;
  modelName: string;
  thinkingSeconds: number;
  /** Render the model's Thought rows (default true) — `/reasoning show` toggles it. */
  showThoughts?: boolean;
}

export class ChatViewport implements Component {
  private state: ChatViewportState;
  private scrollOffset = 0;
  private maxOffset = 0;
  private viewportHeight = 0;
  private totalLines = 0;
  private scrollbarColumn = 0;
  private expandableRows = new Map<number, string>();
  private subagentRows = new Map<number, string>();
  // Drag-to-copy selection: transcript row indices (into the FULL rendered transcript, not the visible
  // window) so a selection survives scrolling while the button is held.
  private selAnchor: number | null = null;
  private selHead: number | null = null;
  private lastRows: string[] = [];
  private lastStart = 0;
  // Per-turn render cache (see renderTranscript): settled turns render once per (width, theme,
  // expand-state, index) — typing must not pay for Markdown-ing the whole history every keystroke.
  private turnCache = new WeakMap<object, { key: string; rows: TranscriptRow[] }>();
  private renderEpoch = 0;
  private lastTheme: unknown = null;
  private expandedThoughts = new Set<string>();
  private expandedTools = new Set<string>();

  constructor(
    initial: ChatViewportState,
    private readonly mdTheme: MarkdownTheme,
    private readonly getRows: () => number,
    private readonly getTopRow: () => number,
    private readonly getWidth: () => number,
  ) {
    this.state = initial;
  }

  setState(next: ChatViewportState): void {
    this.state = next;
  }

  invalidate(): void { /* computed from current state */ }

  scroll(delta: number): void {
    this.scrollOffset = Math.max(0, Math.min(this.maxOffset, this.scrollOffset + delta));
  }

  isThoughtRow(x: number, absRow: number): boolean {
    const localRow = absRow - this.getTopRow() + 1;
    return x >= 1 && x <= this.scrollbarColumn - 2 && this.expandableRows.has(localRow);
  }

  /** Map a screen row to its index in the full rendered transcript, or null outside the viewport. */
  private transcriptIndexAt(absRow: number): number | null {
    const local = absRow - this.getTopRow() + 1;
    if (local < 1 || local > this.viewportHeight) return null;
    const idx = this.lastStart + local - 1;
    return idx >= 0 && idx < this.lastRows.length ? idx : null;
  }

  /** Start a drag-to-copy selection at a screen position. False when the press lands outside the
   *  transcript text area (scrollbar column, panel) — the caller then leaves the press alone. */
  beginSelect(x: number, absRow: number): boolean {
    if (x < 1 || x > this.scrollbarColumn - 2) return false;
    const idx = this.transcriptIndexAt(absRow);
    if (idx == null) return false;
    this.selAnchor = idx;
    this.selHead = idx;
    return true;
  }

  dragSelect(absRow: number): void {
    if (this.selAnchor == null) return;
    const idx = this.transcriptIndexAt(absRow);
    if (idx != null) this.selHead = idx;
  }

  hasSelection(): boolean { return this.selAnchor != null; }

  /** Finish the selection: the covered lines as plain text (ANSI stripped, right-trimmed), or null for
   *  a no-drag click / whitespace-only span. Always clears the highlight. */
  takeSelection(): string | null {
    const a = this.selAnchor;
    const h = this.selHead;
    this.selAnchor = null;
    this.selHead = null;
    if (a == null || h == null || a === h) return null;
    const [lo, hi] = a <= h ? [a, h] : [h, a];
    const text = this.lastRows.slice(lo, hi + 1)
      .map((line) => line.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+$/, ''))
      .join('\n');
    return text.trim() ? text : null;
  }

  /** The sub-agent session id under a click, or null — subagent rows open the child transcript
   *  instead of expanding in place, so they live in their own registry. */
  subagentAt(x: number, absRow: number): string | null {
    const localRow = absRow - this.getTopRow() + 1;
    if (x < 1 || x > this.scrollbarColumn - 2) return null;
    return this.subagentRows.get(localRow) ?? null;
  }

  toggleThought(absRow: number): void {
    const key = this.expandableRows.get(absRow - this.getTopRow() + 1);
    if (!key) return;
    const store = key.startsWith('tool:') ? this.expandedTools : this.expandedThoughts;
    if (store.has(key)) store.delete(key);
    else store.add(key);
    this.renderEpoch++; // expansion changes a SETTLED turn's rows → invalidate the per-turn cache
  }

  isScrollbarHit(x: number, y: number): boolean {
    const localRow = y - this.getTopRow() + 1;
    return this.totalLines > this.viewportHeight
      && localRow >= 1
      && localRow <= this.viewportHeight
      && Math.abs(x - this.scrollbarColumn) <= 1;
  }

  setScrollFromRow(absRow: number): void {
    if (this.totalLines <= this.viewportHeight || this.maxOffset <= 0) {
      this.scrollOffset = 0;
      return;
    }
    const thumbSize = this.thumbSize(this.viewportHeight, this.totalLines);
    const maxTop = Math.max(1, this.viewportHeight - thumbSize);
    const localRow = absRow - this.getTopRow() + 1;
    const targetTop = Math.max(0, Math.min(maxTop, localRow - 1 - Math.floor(thumbSize / 2)));
    const ratio = targetTop / maxTop;
    this.scrollOffset = Math.max(0, Math.min(this.maxOffset, Math.round(this.maxOffset - ratio * this.maxOffset)));
  }

  render(width: number): string[] {
    const height = Math.max(8, this.getRows());
    const chatWidth = Math.max(24, Math.min(width, this.getWidth()));
    const contentWidth = Math.max(20, chatWidth - 5);
    const rows = this.renderTranscript(contentWidth);
    this.maxOffset = Math.max(0, rows.length - height);
    this.scrollOffset = Math.max(0, Math.min(this.maxOffset, this.scrollOffset));
    this.viewportHeight = height;
    this.scrollbarColumn = chatWidth;
    this.totalLines = rows.length;
    this.expandableRows = new Map();
    this.subagentRows = new Map();

    const start = Math.max(0, rows.length - height - this.scrollOffset);
    this.lastRows = rows.map((r) => r.line);
    this.lastStart = start;
    const selLo = this.selAnchor != null && this.selHead != null ? Math.min(this.selAnchor, this.selHead) : -1;
    const selHi = this.selAnchor != null && this.selHead != null ? Math.max(this.selAnchor, this.selHead) : -1;
    const visible = rows.slice(start, start + height);
    while (visible.length < height) visible.push({ line: '' });
    return visible.map((entry, i) => {
      if ((entry.kind === 'thought' || entry.kind === 'expandable') && entry.key) this.expandableRows.set(i + 1, entry.key);
      if (entry.kind === 'subagent' && entry.key) this.subagentRows.set(i + 1, entry.key);
      const content = i === 0 && this.scrollOffset > 0
        ? this.historyChip(entry.line, chatWidth - 2)
        : entry.line;
      let cell = padAnsi(content, chatWidth - 2);
      // Drag-to-copy highlight: reverse-video the selected rows; re-arm after every SGR reset inside
      // the line, otherwise the first themed span would cancel the inversion mid-row.
      if (start + i >= selLo && start + i <= selHi) cell = `\x1b[7m${cell.split('\x1b[0m').join('\x1b[0m\x1b[7m')}\x1b[27m`;
      return padAnsi(`${cell} ${this.scrollbar(i, height, rows.length)}`, width);
    });
  }

  private renderTranscript(width: number): TranscriptRow[] {
    // Per-turn row cache: settled turns are immutable, but re-rendering the WHOLE history through
    // Markdown on every keystroke made typing visibly lag on long conversations. Streaming turns
    // (and anything whose cache key drifted — width, theme, expand state, index) render fresh.
    if (this.lastTheme !== chatTheme()) { this.lastTheme = chatTheme(); this.renderEpoch++; }
    const baseKey = `${width}|${this.state.showThoughts !== false}|${this.renderEpoch}`;
    const rows: TranscriptRow[] = [{ line: '' }];
    for (const [turnIndex, turn] of this.state.view.turns.entries()) {
      const turnKey = `${baseKey}|${turnIndex}`;
      const cached = this.turnCache.get(turn);
      if (cached && cached.key === turnKey) { rows.push(...cached.rows); continue; }
      const turnRows = this.renderTurn(turn, turnIndex, width);
      if (turn.role === 'you' || !turn.streaming) this.turnCache.set(turn, { key: turnKey, rows: turnRows });
      rows.push(...turnRows);
    }
    if (this.state.notice) for (const line of this.state.notice.split('\n')) rows.push({ line: `  ${line}` });
    if (this.state.view.notice) rows.push({ line: `  ${color.faint(`· ${this.state.view.notice}`)}` });
    // No "thinking… Ns" transcript line — the generating state animates in the prompt meta line
    // under the input instead (a line under the message just pushed the conversation around).
    return rows;
  }

  /** All rows of ONE turn, starting from an (assumed) blank boundary and ending with a trailing blank —
   *  the cacheable unit of the transcript. */
  private renderTurn(turn: ChatView['turns'][number], turnIndex: number, width: number): TranscriptRow[] {
    const rows: TranscriptRow[] = [];
    const add = (line: string, kind?: TranscriptRow['kind'], key?: string): void => { rows.push(kind ? { line, kind, key } : { line }); };
    const addBlank = (): void => add('');
    {
      if (turn.role === 'you') {
        for (const line of new UserBlock(turn.text).render(width)) add(line);
        addBlank();
        return rows;
      }
      let hasText = false;
      // The newest tool item of a streaming turn may still be awaiting approval / running — its
      // silent-command row must not claim "· done" until the turn moves past it.
      const toolItems = turn.segments.flatMap((s) => (s.kind === 'tools' ? s.items : []));
      const lastToolItem = toolItems[toolItems.length - 1];
      for (const [segIndex, seg] of turn.segments.entries()) {
        if (seg.kind === 'tools') {
          for (const item of seg.items) {
            const keyBase = item.id ? `tool:${item.id}` : `tool:${turnIndex}:${segIndex}:${item.name}:${item.detail ?? ''}`;
            if (item.sub) {
              // A delegated sub-agent: header with its task + a live `↳` line mirroring what the child
              // is doing right now (opencode-style). Both rows are clickable → open the child transcript.
              for (const line of this.subagentBlock(item.sub, width)) add(line.line, line.kind, line.key);
            }
            if (item.diff) {
              for (const line of framedDiffBlock(item.diff, width, toolTitle(item.name, item.detail))) add(line);
            }
            if (item.output) {
              const expanded = this.expandedTools.has(keyBase);
              const before = rows.length;
              for (const line of toolOutputBlock(item.output, width, expanded)) add(line);
              if (item.output.fullText && item.output.fullText !== item.output.text) {
                for (let i = before + 1; i <= rows.length; i++) rows[i - 1] = { ...rows[i - 1]!, kind: 'expandable', key: keyBase };
              }
            } else if (!item.diff && !item.sub) {
              // A shell/console tool that finished silently still shows its command on its own line.
              // Tool traffic renders DIM across the board (glyph faint, text muted) — it is secondary
              // to the assistant's answer, opencode-style, instead of glowing green next to it.
              if (item.command) add(`  ${color.faint('$')} ${color.dim(truncateToWidth(item.command, Math.max(12, width - 10), '…'))} ${color.faint(turn.streaming && item === lastToolItem ? '· running…' : '· done')}`);
              else {
                const spec = toolRowSpec(item.name, item.detail);
                add(`  ${color.faint(spec.glyph)} ${color.dim(truncateToWidth(spec.title, Math.max(12, width - 8), '…'))}`);
              }
            }
          }
        } else if (seg.kind === 'reasoning') {
          if (this.state.showThoughts === false) continue; // `/reasoning show` hid Thought rows
          const liveTail = turn.streaming && seg === turn.segments[turn.segments.length - 1];
          const first = seg.text.replace(/\s+/g, ' ').trim() || 'thinking';
          const label = liveTail ? `Thought: ${formatDuration(this.state.thinkingSeconds)}` : 'Thought';
          const key = `${turnIndex}:${segIndex}`;
          const expanded = this.expandedThoughts.has(key);
          // A blank line above each Thought keeps it from gluing onto the previous tool/output block
          // (the turn boundary itself is already blank, so only intra-turn rows need one).
          if (rows.length > 0 && rows[rows.length - 1]!.line !== '') addBlank();
          add(`  ${color.warning(expanded ? '▾' : '▸')} ${color.warning(label)} ${color.faint('click')} ${color.dim(truncateToWidth(first, Math.max(12, width - 32), '…'))}`, 'thought', key);
          if (expanded) {
            for (const line of wrapTextWithAnsi(seg.text, Math.max(1, width - 6))) add(`    ${color.faint(line)}`);
          }
          addBlank();
        } else {
          hasText = true;
          // A blank line between tool/console blocks and the agent's own words — without it the white
          // reply text visually merges into the (dim) tool output above it.
          if (segIndex > 0 && rows.length > 0 && rows[rows.length - 1]!.line !== '') addBlank();
          for (const line of this.renderTextWithPlans(seg.text, width)) add(line);
        }
      }
      if (!hasText && turn.streaming) add(`  ${color.faint('…')}`);
      addBlank();
    }
    return rows;
  }

  /** The two-row sub-agent block: `⠼ Sub-agent — <task>` while running (✓/✗ when settled) plus a faint
   *  `↳` line with the child's current tool, elapsed seconds and token spend. Every row carries the
   *  child session id so a click can open its transcript. */
  private subagentBlock(sub: NonNullable<ToolItem['sub']>, width: number): TranscriptRow[] {
    const out: TranscriptRow[] = [];
    const glyphFor = sub.status === 'running' ? color.accent(spinnerFrame())
      : sub.status === 'done' ? color.success('✓') : color.error('✗');
    const task = truncateToWidth(sub.task.replace(/\s+/g, ' ').trim(), Math.max(12, width - 26), '…');
    out.push({ line: '' });
    out.push({
      line: `  ${glyphFor} ${color.text('Sub-agent')} ${color.faint('click')} ${color.dim(task)}`,
      kind: 'subagent', key: sub.sessionId,
    });
    const tok = sub.tokens ? `${formatK(sub.tokens)} tok` : '';
    const parts = sub.status === 'running'
      ? [sub.detail ?? 'starting…', formatDuration(sub.seconds), tok]
      : [`${sub.tools} tool${sub.tools === 1 ? '' : 's'}`, formatDuration(sub.seconds), tok];
    out.push({
      line: `    ${color.faint(truncateToWidth(`↳ ${parts.filter(Boolean).join(' · ')}`, Math.max(12, width - 6), '…'))}`,
      kind: 'subagent', key: sub.sessionId,
    });
    return out;
  }

  private historyChip(line: string, width: number): string {
    const chip = `${color.accent('History')} ${color.faint(`+${this.scrollOffset} lines`)}`;
    const plain = visibleWidth(line) > 0 ? `  ${line}` : '';
    return truncateToWidth(`${chip}${plain}`, width, '');
  }

  private scrollbar(index: number, height: number, total: number): string {
    if (total <= height) return color.faint('│');
    const thumbSize = this.thumbSize(height, total);
    const top = Math.floor(((this.maxOffset - this.scrollOffset) / this.maxOffset) * (height - thumbSize));
    return index >= top && index < top + thumbSize ? color.accent('█') : color.faint('│');
  }

  private thumbSize(height: number, total: number): number {
    return Math.max(2, Math.floor((height / total) * height));
  }

  private renderTextWithPlans(text: string, width: number): string[] {
    const rows: string[] = [];
    const re = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/gi;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const before = text.slice(last, m.index);
      if (before.trim()) rows.push(...new Markdown(before, 2, 0, this.mdTheme).render(width));
      rows.push(...this.planBlock(m[1] ?? '', width));
      last = m.index + m[0].length;
    }
    const after = text.slice(last);
    const open = /<proposed_plan>\s*/i.exec(after);
    if (open) {
      const before = after.slice(0, open.index);
      if (before.trim()) rows.push(...new Markdown(before, 2, 0, this.mdTheme).render(width));
      rows.push(...this.planBlock(after.slice(open.index + open[0].length), width));
    } else if (after.trim() || rows.length === 0) {
      rows.push(...new Markdown(after, 2, 0, this.mdTheme).render(width));
    }
    return rows;
  }

  private planBlock(markdown: string, width: number): string[] {
    const outer = Math.max(28, width);
    const inner = Math.max(12, outer - 6);
    const border = color.faint;
    const title = ` ${color.bold(color.text('Proposed plan'))} ${color.faint('ready to implement')} `;
    const rule = Math.max(0, inner - visibleWidth(title));
    const row = (content: string): string => {
      const clipped = truncateToWidth(content, inner, '…');
      return `  ${border('│')}${bgFill(padAnsi(clipped, inner), inner, chatTheme().modalBg)}${border('│')}`;
    };
    const body = new Markdown(markdown.trim(), 0, 0, this.mdTheme).render(inner);
    return [
      `  ${border('╭')}${border('─'.repeat(rule))}${title}${border('╮')}`,
      ...body.map((line) => row(line)),
      `  ${border('╰')}${border('─'.repeat(inner))}${border('╯')}`,
    ];
  }
}

export interface TelemetryState {
  usage: BrainUsageView | null;
  cwd: string;
  branch: string;
  /** MCP servers from the daemon; null when unavailable (plugin off, non-admin) → section hidden. */
  mcp: Pick<McpServerView, 'name' | 'status'>[] | null;
  /** Live LSP diagnostics state; null when the daemon doesn't report it → line hidden. */
  lspEnabled: boolean | null;
}

const PANEL_BAR_MARGIN = 2;
const MCP_NAMES_SHOWN = 4;

export class TelemetryPanel implements Component {
  constructor(private getState: () => TelemetryState) {}
  invalidate(): void { /* state driven */ }
  render(width: number): string[] {
    const st = this.getState();
    const usage = st.usage;
    const pct = usage?.percent != null ? `${Math.round(usage.percent)}%` : '—';
    const tokens = usage ? `${formatK(usage.tokens ?? 0)} / ${formatK(usage.contextWindow)}` : '—';
    const logo = panelLogo(width);
    const rows = [
      '',
      ...logo,
      '',
      `  ${color.bold(color.text('Context'))}`,
      `  ${color.text(tokens)} ${color.faint('tokens')} ${color.faint(`· ${pct}`)}${usage ? ` ${color.faint(`· $${usage.cost.toFixed(2)}`)}` : ''}`,
      `${' '.repeat(PANEL_BAR_MARGIN)}${this.contextBar(usage?.percent ?? 0, width)}`,
      '',
      `  ${color.bold(color.text('Project'))}`,
      `  ${color.text(truncateToWidth(st.cwd, Math.max(1, width - 4), '…'))}`,
      `  ${color.faint('branch')} ${color.accent(st.branch || 'unknown')}`,
      ...this.mcpRows(st.mcp, width),
      ...this.lspRows(st.lspEnabled),
    ];
    return rows.map((r) => color.panelBg(padAnsi(r, width)));
  }

  /** The context meter spans the panel minus an equal margin on both edges, so it grows and shrinks
   *  with the drag-resized panel; a wide panel carries visually heavier block glyphs. */
  private contextBar(percent: number, width: number): string {
    const cells = Math.max(8, width - PANEL_BAR_MARGIN * 2);
    const filled = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)));
    const heavy = width >= 52;
    const [full, empty] = heavy ? ['█', '░'] : ['▰', '▱'];
    return `${color.accent(full.repeat(filled))}${color.faint(empty.repeat(cells - filled))}`;
  }

  /** Active (connected) MCP servers by name plus a connected/total count; hidden when unavailable
   *  AND when nothing is connected — an all-idle section is just panel noise. */
  private mcpRows(mcp: TelemetryState['mcp'], width: number): string[] {
    if (!mcp) return [];
    const connected = mcp.filter((s) => s.status === 'connected');
    if (connected.length === 0) return [];
    const rows = ['', `  ${color.bold(color.text('MCP'))} ${color.faint(`${connected.length}/${mcp.length} active`)}`];
    for (const server of connected.slice(0, MCP_NAMES_SHOWN)) {
      rows.push(`  ${color.success('●')} ${color.text(truncateToWidth(server.name, Math.max(1, width - 6), '…'))}`);
    }
    if (connected.length > MCP_NAMES_SHOWN) rows.push(`  ${color.faint(`… +${connected.length - MCP_NAMES_SHOWN} more`)}`);
    return rows;
  }

  private lspRows(lspEnabled: boolean | null): string[] {
    if (lspEnabled == null) return [];
    return [
      '',
      `  ${color.bold(color.text('LSP'))}`,
      `  ${lspEnabled ? color.success('●') : color.faint('○')} ${color.text(lspEnabled ? 'Active' : 'Inactive')} ${color.faint('· /lsp toggles')}`,
    ];
  }
}

function panelLogo(width: number): string[] {
  // The flame mascot, centered in the panel. Its truecolor lines already carry their own colors, so
  // the panel just pads them; wider than the panel (never, at the 36-col minimum) it clips gracefully.
  return MASCOT_ART.map((line) => {
    const pad = Math.max(0, Math.floor((width - visibleWidth(line)) / 2));
    return `${' '.repeat(pad)}${line}`;
  });
}

export interface SlashOverlayItem {
  value: string;
  label: string;
  description?: string;
}

/** File-mention suggestions rendered above the input — the `@` twin of {@link SlashOverlay}, same
 *  chrome and focus model (the editor keeps focus; the app feeds it the ranked matches, since fuzzy +
 *  frecency ordering lives in mentions.ts, and steers the highlight with the arrow keys). */
export class MentionOverlay implements Component {
  private items: SlashOverlayItem[] = [];
  private selectedIndex = 0;

  invalidate(): void { /* state driven */ }

  /** Replace the (already ranked) matches for the current query; the highlight resets to the top. */
  setItems(items: SlashOverlayItem[]): void {
    this.items = items;
    this.selectedIndex = 0;
  }

  /** Move the highlight up (-1) / down (+1), wrapping around the list. */
  moveSelection(delta: number): void {
    if (this.items.length === 0) return;
    this.selectedIndex = (this.selectedIndex + delta + this.items.length) % this.items.length;
  }

  /** The highlighted path, or null when nothing matches the current query. */
  selectedValue(): string | null {
    return this.items[this.selectedIndex]?.value ?? null;
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 2);
    const top = `${color.accent('╭')}${color.faint('─'.repeat(innerWidth))}${color.accent('╮')}`;
    const bottom = `${color.accent('╰')}${color.faint('─'.repeat(innerWidth))}${color.accent('╯')}`;
    const row = (content: string): string => `${color.accent('│')}${bgFill(content, innerWidth)}${color.accent('│')}`;
    if (this.selectedIndex >= this.items.length) this.selectedIndex = Math.max(0, this.items.length - 1);
    const start = Math.max(0, Math.min(this.selectedIndex - 5, Math.max(0, this.items.length - 10)));
    const shown = this.items.slice(start, start + 10);
    const itemRows = shown.length
      ? shown.map((item, i) => {
          const descWidth = item.description ? Math.min(visibleWidth(item.description), Math.max(0, innerWidth - 4 - visibleWidth(item.label) - 2)) : 0;
          const path = truncateToWidth(item.label, Math.max(1, innerWidth - 4 - (descWidth ? descWidth + 2 : 0)), '…');
          const desc = descWidth ? `  ${truncateToWidth(item.description ?? '', descWidth, '…')}` : '';
          if (start + i === this.selectedIndex) {
            return `${color.accent('│')}${ansi.sgr(`${chatTheme().selectedBg};30;1`, padAnsi(`  ${path}${desc}`, innerWidth))}${color.accent('│')}`;
          }
          return row(`  ${ansi.open(chatTheme().text, path)}${desc ? ansi.open(chatTheme().muted, desc) : ''}`);
        })
      : [row(ansi.open(chatTheme().muted, '  No matching files'))];
    const counter = this.items.length > shown.length ? [row(ansi.open(chatTheme().faint, `  (${Math.min(this.selectedIndex + 1, this.items.length)}/${this.items.length})`))] : [];
    return [
      top,
      row(`  ${ansi.open(chatTheme().faint, 'files · ↑↓ select · tab/enter attach · esc dismiss')}`),
      row(''),
      ...itemRows,
      ...counter,
      bottom,
    ];
  }
}

/** Slash-command suggestions rendered above the input. It never takes focus: the editor owns the typed
 *  text (including the leading '/'), and the app feeds it in via setFilter / steers it via moveSelection. */
export class SlashOverlay implements Component {
  private filter = '';
  private selectedIndex = 0;

  constructor(private readonly items: SlashOverlayItem[]) {}

  invalidate(): void { /* state driven */ }

  /** Follow the editor's text — the leading '/' is stripped, a changed filter resets the highlight. */
  setFilter(text: string): void {
    const filter = text.startsWith('/') ? text.slice(1) : text;
    if (filter === this.filter) return;
    this.filter = filter;
    this.selectedIndex = 0;
  }

  /** Move the highlight up (-1) / down (+1), wrapping around the filtered list. */
  moveSelection(delta: number): void {
    const count = this.filteredItems().length;
    if (count === 0) return;
    this.selectedIndex = (this.selectedIndex + delta + count) % count;
  }

  /** The highlighted command, or null when nothing matches the current filter. */
  selectedValue(): string | null {
    return this.filteredItems()[this.selectedIndex]?.value ?? null;
  }

  filteredItems(): SlashOverlayItem[] {
    const raw = this.filter.trim().toLowerCase();
    const query = raw.startsWith('/') ? raw.slice(1) : raw;
    const score = (item: SlashOverlayItem): number => {
      if (!query) return 1;
      const name = item.value.replace(/^\//, '').toLowerCase();
      const desc = (item.description ?? '').toLowerCase();
      if (name === query) return 100;
      if (name.startsWith(query)) return 80;
      if (name.includes(query)) return 60;
      if (desc.includes(query)) return 35;
      let pos = 0;
      for (const ch of query) {
        pos = name.indexOf(ch, pos);
        if (pos === -1) return 0;
        pos += 1;
      }
      return 20;
    };
    return this.items
      .map((item) => ({ item, score: score(item) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.item.value.localeCompare(b.item.value))
      .map((entry) => entry.item);
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 2);
    const top = `${color.accent('╭')}${color.faint('─'.repeat(innerWidth))}${color.accent('╮')}`;
    const bottom = `${color.accent('╰')}${color.faint('─'.repeat(innerWidth))}${color.accent('╯')}`;
    const row = (content: string): string => `${color.accent('│')}${bgFill(content, innerWidth)}${color.accent('│')}`;
    const items = this.filteredItems();
    if (this.selectedIndex >= items.length) this.selectedIndex = Math.max(0, items.length - 1);
    const start = Math.max(0, Math.min(this.selectedIndex - 5, Math.max(0, items.length - 10)));
    const shown = items.slice(start, start + 10);
    const itemRows = shown.length
      ? shown.map((item, i) => {
          const absoluteIndex = start + i;
          const cmd = padAnsi(item.label, 14);
          const desc = truncateToWidth(item.description ?? '', Math.max(1, innerWidth - 17), '');
          if (absoluteIndex === this.selectedIndex) {
            return `${color.accent('│')}${ansi.sgr(`${chatTheme().selectedBg};30;1`, padAnsi(`  ${cmd} ${desc}`, innerWidth))}${color.accent('│')}`;
          }
          return row(`  ${ansi.open(chatTheme().text, cmd)} ${ansi.open(chatTheme().muted, desc)}`);
        })
      : [row(ansi.open(chatTheme().muted, '  No matching commands'))];
    const counter = items.length > shown.length ? [row(ansi.open(chatTheme().faint, `  (${Math.min(this.selectedIndex + 1, items.length)}/${items.length})`))] : [];
    return [
      top,
      row(`  ${ansi.open(chatTheme().faint, 'commands · ↑↓ select · tab/enter run · esc dismiss')}`),
      row(''),
      ...itemRows,
      ...counter,
      bottom,
    ];
  }
}
