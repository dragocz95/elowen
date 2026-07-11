import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { MASCOT_ART } from './mascot.js';
import { FLOAT_BAND } from './mascotFloat.js';
import type { Component, MarkdownTheme } from '@earendil-works/pi-tui';
import { framedDiffBlock, ProcessPanel, spinnerFrame, toolOutputBlock, UserBlock } from './components.js';
import { ansi, chatTheme, color, glyph } from './theme.js';
import type { BrainRateLimits, BrainRateLimitWindow, BrainUsageView, McpServerView } from './brainClient.js';
import type { ProcessInfo } from '../../brain/processRegistry.js';
import type { ChatView, ToolItem } from '../../brain/transcript.js';
import { getChatViewChange, groupToolItems } from '../../brain/transcript.js';
import { formatDuration, formatK, padAnsi, terminalPlainText } from '../ui/text.js';

export const TOP_RULE_ROWS = 1;
/** Left indent for a tool row (glyph line, silent-command line). Deeper than the 2-space assistant prose
 *  so tool traffic sits visually SET APART from the answer (opencode-style). The nested blocks a tool
 *  spawns (diff/console output) indent one level deeper again — see components.ts. */
export const TOOL_INDENT = '    ';
/** One level deeper than TOOL_INDENT — the live `run_command` progress tail sits under its `$` row, at
 *  the same depth as a console-output block body (see components.ts BLOCK_BODY_INDENT). */
const TOOL_OUTPUT_INDENT = '      ';
/** How many trailing lines of a running command's rolling output tail to show live under its `$` row. */
const PROGRESS_TAIL_ROWS = 8;
export const PANEL_GUTTER_COLUMNS = 3;
export const ENABLE_MOUSE = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';
export const DISABLE_MOUSE = '\x1b[?1000l\x1b[?1002l\x1b[?1006l';
// Alternate screen buffer. pi-tui renders INLINE (into the primary buffer), so a terminal that scrolls
// its native buffer on wheel/trackpad (instead of forwarding to us) mixes our live UI with the frames
// left in scrollback — the input scrolls out of view and the layout "falls apart", worst when a tall
// console-output block pushed extra frames into scrollback. The chat is a full-screen TUI with its OWN
// in-app scroll (PageUp/wheel + History chip), so it belongs on the alternate screen: we own the whole
// display, native scroll has nothing to reveal, and the shell + its scrollback are restored untouched on
// exit. Pair every `ON` with an `OFF` on teardown AND the crash/signal path, or a throw strands the user
// on a blank alt-screen.
export const ALT_SCREEN_ON = '\x1b[?1049h';
export const ALT_SCREEN_OFF = '\x1b[?1049l';

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
  /** Owning turn for targeted expansion invalidation. Kept on interactive rows only. */
  turnIndex?: number;
}

interface TurnLayoutEntry {
  turn: ChatView['turns'][number];
  /** Exact rendered height for the current width/theme/visibility context; null until indexed. */
  height: number | null;
  /** Optional rendered rows. Off-screen heights are learned only as the user scrolls; visible rows live
   *  in an LRU so opening a large history never schedules a full-transcript Markdown pass. */
  rows: TranscriptRow[] | null;
}

const HISTORY_OVERSCAN_ROWS = 8;
/** Soft bound: one exceptionally tall visible turn may exceed it, but off-screen rows are evicted. */
export const CHAT_VIEWPORT_ROW_CACHE_LIMIT = 2_048;

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
    const safeWidth = Math.max(0, Math.floor(width));
    const reserve = Math.max(0, Math.min(Math.max(0, safeWidth - 1), this.getReserve()));
    const mainWidth = Math.max(0, safeWidth - reserve);
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
  const safeWidth = Math.max(1, Math.floor(width));
  const boxWidth = Math.min(safeWidth, Math.max(Math.min(32, safeWidth), Math.min(72, safeWidth - 8)));
  return { boxWidth, leftPad: Math.max(0, Math.floor((width - boxWidth) / 2)) };
}

/** Row (0-based, within the start screen's rows) where the input box starts — mirror of the vertical
 *  centering in {@link StartScreen.render}, kept here so overlay anchoring can never drift from it. */
export function startScreenInputTop(rows: number, inputRows: number, noticeRows: number): number {
  const bodyLength = BANNER_ROWS + 1 + inputRows + 2 + 2 + 1 + (noticeRows ? 1 + noticeRows : 0);
  if (bodyLength > rows - 1) {
    let room = Math.max(0, rows - 1);
    const inputCount = Math.min(inputRows, room);
    room -= inputCount;
    const noticeCount = Math.min(noticeRows, room);
    room -= noticeCount;
    const modelCount = room > 0 ? 1 : 0;
    room -= modelCount;
    const hintCount = room > 0 ? 1 : 0;
    const compactLength = inputCount + noticeCount + modelCount + hintCount;
    return Math.max(0, rows - 1 - compactLength);
  }
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
    width = Math.max(1, Math.floor(width));
    const st = this.getState();
    const center = (text: string): string => {
      const clipped = truncateToWidth(text, width, '…');
      return `${' '.repeat(Math.max(0, Math.floor((width - visibleWidth(clipped)) / 2)))}${clipped}`;
    };
    const { boxWidth, leftPad } = startScreenBox(width);
    const indent = ' '.repeat(leftPad);
    const inputLines = this.input.render(boxWidth);
    const noticeLines = st.notice ? st.notice.split('\n') : [];
    const boxLine = (line: string): string => `${indent}${truncateToWidth(line, boxWidth, '…')}`;
    const hint = truncateToWidth(st.hints, boxWidth, '…');
    const hintLine = `${' '.repeat(Math.max(0, leftPad + boxWidth - visibleWidth(hint)))}${hint}`;
    const body = [
      ...MASCOT_ART.map((line) => center(line)),
      '',
      ...inputLines.map(boxLine),
      `${indent}${truncateToWidth(st.modelLine, boxWidth, '…')}`,
      hintLine,
      '',
      '',
      center(st.tip),
      ...(noticeLines.length ? ['', ...noticeLines.map((line) => center(line))] : []),
    ];
    const sidePad = Math.min(2, Math.max(0, Math.floor((width - 1) / 4)));
    const available = Math.max(0, width - sidePad * 2);
    let versionLabel = truncateToWidth(color.faint(`elowen v${st.version}`), Math.floor(available * 0.45), '…');
    let statusLeft = truncateToWidth(st.statusLeft, Math.max(0, available - visibleWidth(versionLabel) - 1), '…');
    if (!statusLeft && available > 0) {
      versionLabel = truncateToWidth(versionLabel, available, '…');
    }
    const statusGap = Math.max(0, available - visibleWidth(statusLeft) - visibleWidth(versionLabel));
    const statusRow = padAnsi(`${' '.repeat(sidePad)}${statusLeft}${' '.repeat(statusGap)}${versionLabel}`, width);
    const rows = Math.max(1, Math.floor(this.getRows()));
    // Short terminals cannot fit the decorative mascot/tip block. Keep the composer and status pinned,
    // then spend any remaining rows on live notices/model/hints; never return more than the allocation.
    if (body.length > rows - 1) {
      let room = Math.max(0, rows - 1);
      const inputCount = Math.min(inputLines.length, room);
      const shownInput = (inputCount > 0 ? inputLines.slice(-inputCount) : []).map(boxLine);
      room -= shownInput.length;
      const shownNotice = noticeLines.slice(0, room).map((line) => center(line));
      room -= shownNotice.length;
      const showModel = room > 0;
      if (showModel) room--;
      const showHints = room > 0;
      const compact = [
        ...shownInput,
        ...(showModel ? [`${indent}${truncateToWidth(st.modelLine, boxWidth, '…')}`] : []),
        ...(showHints ? [hintLine] : []),
        ...shownNotice,
      ];
      while (compact.length < rows - 1) compact.unshift('');
      return [...compact, statusRow];
    }
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

export interface ChatViewportMetrics {
  renderMs: number;
  transcriptRows: number;
  transcriptRowsExact: boolean;
  visibleRows: number;
  renderedTurns: number;
  reconciledTurns: number;
  indexedTurns: number;
  cachedRows: number;
}

export class ChatViewport implements Component {
  private state: ChatViewportState;
  private scrollOffset = 0;
  private maxOffset = 0;
  private viewportHeight = 0;
  private totalLines = 0;
  private scrollbarColumn = 0;
  private expandableRows = new Map<number, { key: string; turnIndex: number }>();
  private subagentRows = new Map<number, string>();
  // Drag-to-copy selection uses exact BOTTOM-relative row offsets. Discovering an older prefix in the
  // background therefore cannot move an active selection or the visible viewport.
  private selAnchor: number | null = null;
  private selHead: number | null = null;
  /** Only the currently visible transcript rows. Older code retained/mapped the entire flattened history
   *  on every frame solely for drag-copy; a long conversation therefore stayed O(total rendered lines)
   *  even though the terminal can show only `viewportHeight` rows. */
  private lastRows: string[] = [];
  private lastPlainRows: string[] = [];
  private lastStart = 0;
  private lastTotal = 0;
  // Tail-first layout index. Heights are authoritative; row arrays are retained only for the visible/recent
  // LRU. `knownStart` means every entry from it through the tail has an exact height.
  private layout: TurnLayoutEntry[] = [];
  private layoutTurnsRef: ChatView['turns'] | null = null;
  private knownStart = 0;
  private knownSuffixRows = 0;
  private prefixHeights: number[] | null = null;
  private layoutWidth = 0;
  private layoutTheme: unknown = null;
  private layoutShowsThoughts = true;
  private rowLru = new Map<TurnLayoutEntry, true>();
  private cachedRowCount = 0;
  private currentExtraRows: TranscriptRow[] = [];
  private currentContentWidth = 0;
  private expandedThoughts = new Set<string>();
  private expandedTools = new Set<string>();
  private frameRenderedTurns = 0;
  private frameReconciledTurns = 0;
  private indexedTurnCount = 0;
  private lastRenderMs = 0;

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

  /** Introspection used by focused tests/benchmarks and by no UI decisions: true only when totalLines is
   *  exact for every turn at the current layout context. */
  isHistoryIndexComplete(): boolean {
    return this.currentContentWidth > 0
      && this.knownStart === 0
      && this.layout.length === this.state.view.turns.length;
  }

  indexedHistoryTurns(): number { return this.indexedTurnCount; }
  cachedHistoryRows(): number { return this.cachedRowCount; }
  metrics(): ChatViewportMetrics {
    return {
      renderMs: this.lastRenderMs,
      transcriptRows: this.totalLines,
      transcriptRowsExact: this.isHistoryIndexComplete(),
      visibleRows: this.viewportHeight,
      renderedTurns: this.frameRenderedTurns,
      reconciledTurns: this.frameReconciledTurns,
      indexedTurns: this.indexedTurnCount,
      cachedRows: this.cachedRowCount,
    };
  }

  scroll(delta: number): void {
    if (delta > 0) this.ensureScrollCapacity(this.scrollOffset + delta);
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
    if (idx < this.lastStart || idx >= this.lastTotal || idx >= this.lastStart + this.lastRows.length) return null;
    return this.lastTotal - 1 - idx;
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
    // Larger bottom-offset = visually older/higher row. Convert the stable offsets into this frame's
    // top-to-bottom visible indices only at copy time.
    const older = Math.max(a, h);
    const newer = Math.min(a, h);
    const lo = this.lastTotal - 1 - older;
    const hi = this.lastTotal - 1 - newer;
    const text = this.lastPlainRows.slice(lo - this.lastStart, hi - this.lastStart + 1)
      .map((line) => line.replace(/\s+$/, ''))
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
    const target = this.expandableRows.get(absRow - this.getTopRow() + 1);
    if (!target) return;
    const store = target.key.startsWith('tool:') ? this.expandedTools : this.expandedThoughts;
    if (store.has(target.key)) store.delete(target.key);
    else store.add(target.key);
    // Only this turn's height/rows changed. Updating its exact delta keeps every other settled Markdown
    // cache valid (the old global epoch made one click re-render a thousand off-screen turns).
    this.reindexTurn(target.turnIndex, true);
  }

  isScrollbarHit(x: number, y: number): boolean {
    const localRow = y - this.getTopRow() + 1;
    return this.isHistoryIndexComplete()
      && this.totalLines > this.viewportHeight
      && localRow >= 1
      && localRow <= this.viewportHeight
      && Math.abs(x - this.scrollbarColumn) <= 1;
  }

  setScrollFromRow(absRow: number): void {
    // A thumb ratio is meaningful only after every older turn has an exact height. PageUp/wheel remain
    // available while indexing because their bottom-relative offsets can be satisfied incrementally.
    if (!this.isHistoryIndexComplete()) return;
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
    const startedAt = performance.now();
    this.frameRenderedTurns = 0;
    this.frameReconciledTurns = 0;
    const height = Math.max(1, this.getRows());
    const chatWidth = Math.max(1, Math.min(width, this.getWidth()));
    const contentWidth = Math.max(1, chatWidth - 5);
    this.prepareLayout(contentWidth);
    this.currentExtraRows = this.extraRows();
    this.viewportHeight = height;
    this.scrollbarColumn = chatWidth;
    // The first synchronous paint touches only the exact tail needed for the screen plus a small wheel
    // buffer. Older turns remain completely cold until PageUp/wheel asks for them, so an idle CLI never
    // spends seconds parsing history the user did not open.
    this.ensureTail(height + this.scrollOffset + HISTORY_OVERSCAN_ROWS, true);
    this.refreshMetrics();
    this.expandableRows = new Map();
    this.subagentRows = new Map();

    const totalRows = this.totalLines;
    const start = Math.max(0, totalRows - height - this.scrollOffset);
    this.lastStart = start;
    const selLo = this.selAnchor != null && this.selHead != null ? Math.min(this.selAnchor, this.selHead) : -1;
    const selHi = this.selAnchor != null && this.selHead != null ? Math.max(this.selAnchor, this.selHead) : -1;
    const visible = this.collectWindow(start, start + height);
    while (visible.length < height) visible.push({ line: '' });
    this.lastRows = visible.map((r) => r.line);
    this.lastPlainRows = this.lastRows.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ''));
    this.lastTotal = totalRows;
    const rendered = visible.map((entry, i) => {
      if ((entry.kind === 'thought' || entry.kind === 'expandable') && entry.key && entry.turnIndex != null) {
        this.expandableRows.set(i + 1, { key: entry.key, turnIndex: entry.turnIndex });
      }
      if (entry.kind === 'subagent' && entry.key) this.subagentRows.set(i + 1, entry.key);
      const content = i === 0 && this.scrollOffset > 0
        ? this.historyChip(entry.line, chatWidth - 2)
        : entry.line;
      let cell = padAnsi(content, chatWidth - 2);
      // Drag-to-copy highlight: reverse-video the selected rows; re-arm after every SGR reset inside
      // the line, otherwise the first themed span would cancel the inversion mid-row.
      const bottomOffset = totalRows - 1 - (start + i);
      if (this.selAnchor != null && this.selHead != null && bottomOffset >= selLo && bottomOffset <= selHi) {
        cell = `\x1b[7m${cell.split('\x1b[0m').join('\x1b[0m\x1b[7m')}\x1b[27m`;
      }
      return padAnsi(`${cell} ${this.scrollbar(i, height, totalRows)}`, width);
    });
    this.lastRenderMs = performance.now() - startedAt;
    return rendered;
  }

  private prepareLayout(width: number): void {
    this.currentContentWidth = width;
    const theme = chatTheme();
    const showThoughts = this.state.showThoughts !== false;
    const turns = this.state.view.turns;
    const contextChanged = this.layoutWidth !== width
      || this.layoutTheme !== theme
      || this.layoutShowsThoughts !== showThoughts;

    if (contextChanged) {
      this.clearSelection();
      this.clearAllCachedRows();
      this.layout = turns.map((turn) => ({ turn, height: null, rows: null }));
      this.layoutTurnsRef = turns;
      this.indexedTurnCount = 0;
      this.knownStart = this.layout.length;
      this.knownSuffixRows = 0;
      this.prefixHeights = null;
      this.layoutWidth = width;
      this.layoutTheme = theme;
      this.layoutShowsThoughts = showThoughts;
      return;
    }

    if (this.layoutTurnsRef !== turns || this.layout.length !== turns.length) {
      const change = getChatViewChange(this.state.view);
      let handled = false;
      if (change?.kind === 'none' && this.layout.length === turns.length) {
        handled = true;
      } else if (change?.kind === 'append'
        && change.index === this.layout.length
        && turns.length >= this.layout.length) {
        for (let i = this.layout.length; i < turns.length; i++) this.layout.push({ turn: turns[i]!, height: null, rows: null });
        this.frameReconciledTurns += turns.length - change.index;
        this.prefixHeights = null;
        this.recomputeKnownSuffix();
        handled = true;
      } else if (change?.kind === 'turn'
        && change.index >= 0
        && change.index < turns.length
        && this.layout.length === turns.length) {
        this.clearSelection();
        const previous = this.layout[change.index]!;
        if (previous.height != null) this.indexedTurnCount--;
        this.discardRows(previous);
        this.layout[change.index] = { turn: turns[change.index]!, height: null, rows: null };
        this.frameReconciledTurns++;
        this.prefixHeights = null;
        this.recomputeKnownSuffix();
        handled = true;
      } else if (change?.kind === 'reset') {
        this.clearSelection();
        this.clearAllCachedRows();
        this.layout = turns.map((turn) => ({ turn, height: null, rows: null }));
        this.indexedTurnCount = 0;
        this.knownStart = this.layout.length;
        this.knownSuffixRows = 0;
        this.prefixHeights = null;
        this.expandedThoughts.clear();
        this.expandedTools.clear();
        this.frameReconciledTurns += turns.length;
        handled = true;
      }

      if (!handled) {
        let common = 0;
        while (common < this.layout.length && common < turns.length) {
          this.frameReconciledTurns++;
          if (this.layout[common]!.turn !== turns[common]) break;
          common++;
        }
        if (common !== this.layout.length || common !== turns.length) {
          this.clearSelection();
          const replacedWholeTranscript = this.layout.length > 0 && common === 0;
          for (const entry of this.layout.slice(common)) {
            if (entry.height != null) this.indexedTurnCount--;
            this.discardRows(entry);
          }
          this.layout.length = common;
          for (let i = common; i < turns.length; i++) this.layout.push({ turn: turns[i]!, height: null, rows: null });
          if (replacedWholeTranscript) { this.expandedThoughts.clear(); this.expandedTools.clear(); }
          this.prefixHeights = null;
          this.recomputeKnownSuffix();
        }
      }
      this.layoutTurnsRef = turns;
    }

    // The live tail can mutate its elapsed label/output between object replacements. It alone is volatile;
    // settled entries keep both exact heights and any retained rows.
    const volatile = this.layout.at(-1);
    if (volatile?.turn.role === 'elowen' && volatile.turn.streaming && volatile.height != null) {
      this.clearSelection();
      this.discardRows(volatile);
      volatile.height = null;
      this.indexedTurnCount--;
      this.prefixHeights = null;
      this.recomputeKnownSuffix();
    }
  }

  private extraRows(): TranscriptRow[] {
    const rows: TranscriptRow[] = [];
    if (this.state.notice) rows.push(...this.state.notice.split('\n').map((line) => ({ line: `  ${line}` })));
    if (this.state.view.notice) rows.push({ line: `  ${color.faint(`· ${this.state.view.notice}`)}` });
    return rows;
  }

  private clearSelection(): void { this.selAnchor = null; this.selHead = null; }

  private clearAllCachedRows(): void {
    for (const entry of this.rowLru.keys()) entry.rows = null;
    this.rowLru.clear();
    this.cachedRowCount = 0;
  }

  private discardRows(entry: TurnLayoutEntry): void {
    if (!entry.rows) return;
    this.cachedRowCount = Math.max(0, this.cachedRowCount - entry.rows.length);
    entry.rows = null;
    this.rowLru.delete(entry);
  }

  private retainRows(entry: TurnLayoutEntry, rows: TranscriptRow[]): void {
    this.discardRows(entry);
    entry.rows = rows;
    this.cachedRowCount += rows.length;
    this.rowLru.set(entry, true);
    for (const candidate of this.rowLru.keys()) {
      if (this.cachedRowCount <= CHAT_VIEWPORT_ROW_CACHE_LIMIT) break;
      if (candidate === entry) continue; // soft cap: never evict the turn needed by this frame
      this.discardRows(candidate);
    }
  }

  private touchRows(entry: TurnLayoutEntry): void {
    if (!entry.rows || !this.rowLru.has(entry)) return;
    this.rowLru.delete(entry);
    this.rowLru.set(entry, true);
  }

  private renderAndRecord(index: number, retain: boolean): TranscriptRow[] {
    this.frameRenderedTurns++;
    const entry = this.layout[index]!;
    const oldHeight = entry.height;
    const rows = this.renderTurn(entry.turn, index, this.currentContentWidth);
    entry.height = rows.length;
    if (oldHeight == null) this.indexedTurnCount++;
    if (retain) this.retainRows(entry, rows);
    else this.discardRows(entry);
    if (oldHeight != null && oldHeight !== rows.length) {
      const delta = rows.length - oldHeight;
      if (index >= this.knownStart) this.knownSuffixRows += delta;
      if (this.prefixHeights) {
        for (let i = index + 1; i < this.prefixHeights.length; i++) this.prefixHeights[i]! += delta;
      }
    }
    return rows;
  }

  private rowsFor(index: number): TranscriptRow[] {
    const entry = this.layout[index]!;
    if (entry.rows) { this.touchRows(entry); return entry.rows; }
    return this.renderAndRecord(index, true);
  }

  private reindexTurn(index: number, retain: boolean): void {
    if (index < 0 || index >= this.layout.length || this.currentContentWidth <= 0) return;
    this.renderAndRecord(index, retain);
    this.refreshMetrics();
  }

  private recomputeKnownSuffix(): void {
    this.knownStart = this.layout.length;
    this.knownSuffixRows = 0;
    while (this.knownStart > 0) {
      const height = this.layout[this.knownStart - 1]!.height;
      if (height == null) break;
      this.knownStart--;
      this.knownSuffixRows += height;
    }
    if (this.knownStart === 0) this.buildPrefixHeights();
  }

  private indexPrevious(retain: boolean): void {
    if (this.knownStart <= 0) return;
    const index = this.knownStart - 1;
    const entry = this.layout[index]!;
    if (entry.height == null) this.renderAndRecord(index, retain);
    this.knownStart = index;
    this.knownSuffixRows += entry.height ?? 0;
    // Appending/replacing a live tail can reconnect to an already-indexed suffix. Absorb it without
    // re-rendering; this is cheap integer work and preserves all settled caches.
    while (this.knownStart > 0) {
      const previous = this.layout[this.knownStart - 1]!.height;
      if (previous == null) break;
      this.knownStart--;
      this.knownSuffixRows += previous;
    }
    if (this.knownStart === 0) this.buildPrefixHeights();
  }

  private ensureTail(requiredRows: number, retain: boolean): void {
    const requiredTurnRows = Math.max(0, requiredRows - this.currentExtraRows.length);
    while (this.knownStart > 0 && this.knownSuffixRows < requiredTurnRows) this.indexPrevious(retain);
  }

  private ensureScrollCapacity(targetOffset: number): void {
    if (this.currentContentWidth <= 0) return;
    this.ensureTail(this.viewportHeight + Math.max(0, targetOffset), true);
    this.refreshMetrics();
  }

  private refreshMetrics(): void {
    const leadingBlank = this.knownStart === 0 ? 1 : 0;
    this.totalLines = leadingBlank + this.knownSuffixRows + this.currentExtraRows.length;
    this.maxOffset = Math.max(0, this.totalLines - this.viewportHeight);
    this.scrollOffset = Math.max(0, Math.min(this.maxOffset, this.scrollOffset));
  }

  private buildPrefixHeights(): void {
    const prefix = new Array<number>(this.layout.length + 1).fill(0);
    for (let i = 0; i < this.layout.length; i++) prefix[i + 1] = prefix[i]! + (this.layout[i]!.height ?? 0);
    this.prefixHeights = prefix;
  }

  private firstTurnEndingAfter(offset: number): number {
    const prefix = this.prefixHeights!;
    let lo = 0;
    let hi = this.layout.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (prefix[mid + 1]! <= offset) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private collectWindow(start: number, end: number): TranscriptRow[] {
    const visible: TranscriptRow[] = [];
    const append = (rows: TranscriptRow[], chunkStart: number): void => {
      const chunkEnd = chunkStart + rows.length;
      if (chunkEnd <= start || chunkStart >= end) return;
      visible.push(...rows.slice(Math.max(0, start - chunkStart), Math.min(rows.length, end - chunkStart)));
    };

    if (this.knownStart === 0 && this.prefixHeights) {
      append([{ line: '' }], 0);
      const turnTotal = this.prefixHeights[this.layout.length]!;
      const localStart = Math.max(0, start - 1);
      const localEnd = Math.min(turnTotal, end - 1);
      if (localStart < localEnd) {
        for (let i = this.firstTurnEndingAfter(localStart); i < this.layout.length; i++) {
          const chunkStart = 1 + this.prefixHeights[i]!;
          if (chunkStart >= end || this.prefixHeights[i]! >= localEnd) break;
          append(this.rowsFor(i), chunkStart);
        }
      }
      append(this.currentExtraRows, 1 + turnTotal);
      return visible;
    }

    let cursor = 0;
    for (let i = this.knownStart; i < this.layout.length; i++) {
      const height = this.layout[i]!.height ?? 0;
      if (cursor + height > start && cursor < end) append(this.rowsFor(i), cursor);
      cursor += height;
      if (cursor >= end) break;
    }
    append(this.currentExtraRows, this.knownSuffixRows);
    return visible;
  }

  /** All rows of ONE turn, starting from an (assumed) blank boundary and ending with a trailing blank —
   *  the cacheable unit of the transcript. */
  private renderTurn(turn: ChatView['turns'][number], turnIndex: number, width: number): TranscriptRow[] {
    const rows: TranscriptRow[] = [];
    const add = (line: string, kind?: TranscriptRow['kind'], key?: string): void => {
      rows.push(kind ? { line, kind, key, turnIndex } : { line });
    };
    const addBlank = (): void => add('');
    {
      if (turn.role === 'you') {
        for (const line of new UserBlock(turn.text).render(width)) add(line);
        addBlank();
        return rows;
      }
      // A compaction boundary: a subtle centered divider standing in for the summarized-away history.
      if (turn.role === 'divider') {
        add(`  ${color.faint('· · ·  context compacted  · · ·')}`);
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
          // Collapse consecutive same-tool bare rows (repeated Read/List/Grep) into one `… ×N` line at
          // the RENDERER — the fold keeps the items separate so diff/output/subagent attachment by id
          // still works. Groups carrying a block (diff/output/sub) always have count 1.
          for (const group of groupToolItems(seg.items)) {
            const item = group.item;
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
                for (let i = before + 1; i <= rows.length; i++) {
                  rows[i - 1] = { ...rows[i - 1]!, kind: 'expandable', key: keyBase, turnIndex };
                }
              }
            } else if (!item.diff && !item.sub) {
              // A shell/console tool that finished silently still shows its command on its own line.
              // Tool traffic renders DIM across the board (glyph faint, text muted) — it is secondary
              // to the assistant's answer, opencode-style, instead of glowing green next to it.
              if (item.command) {
                const command = terminalPlainText(item.command).replace(/\s+/g, ' ').trim();
                add(`${TOOL_INDENT}${color.faint('$')} ${color.dim(truncateToWidth(command, Math.max(12, width - 12), '…'))} ${color.faint(turn.streaming && item === lastToolItem ? '· running…' : '· done')}`);
                // Live streamed output of a still-running command (run_command `tool_progress`): the last
                // few lines of the rolling tail, faint, under the `$` row. Cleared once the final
                // `tool_output` lands (which renders its own block above), so there's never a doubled dump.
                if (item.progress) {
                  for (const l of terminalPlainText(item.progress).split('\n').slice(-PROGRESS_TAIL_ROWS)) {
                    add(`${TOOL_OUTPUT_INDENT}${color.faint(truncateToWidth(l, Math.max(12, width - 14), '…'))}`);
                  }
                }
              } else {
                // Repeated bare rows collapse — the latest detail plus a faint ×N when the run is >1.
                const spec = toolRowSpec(item.name, item.detail);
                const suffix = group.count > 1 ? ` ${color.faint(`×${group.count}`)}` : '';
                add(`${TOOL_INDENT}${color.faint(spec.glyph)} ${color.dim(truncateToWidth(spec.title, Math.max(12, width - 10), '…'))}${suffix}`);
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
      ? [sub.detail ?? 'starting…', sub.model, formatDuration(sub.seconds), tok]
      : [`${sub.tools} tool${sub.tools === 1 ? '' : 's'}`, sub.model, formatDuration(sub.seconds), tok];
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
    let visualTotal = total;
    let visualMaxOffset = this.maxOffset;
    if (!this.isHistoryIndexComplete()) {
      // Virtualized history knows that `knownStart` older turns exist even before their Markdown heights
      // are materialized. Estimate only the visual thumb; scrolling and thumb dragging remain exact-only.
      const averageTurnRows = this.indexedTurnCount > 0
        ? Math.max(1, this.knownSuffixRows / this.indexedTurnCount)
        : Math.max(1, height / 2);
      visualTotal = Math.max(height + 1, Math.ceil(
        this.knownSuffixRows + averageTurnRows * this.knownStart + this.currentExtraRows.length + 1,
      ));
      visualMaxOffset = Math.max(1, visualTotal - height);
    }
    if (visualTotal <= height) return color.faint('│');
    const thumbSize = this.thumbSize(height, visualTotal);
    const visualOffset = Math.min(this.scrollOffset, visualMaxOffset);
    const top = Math.floor(((visualMaxOffset - visualOffset) / visualMaxOffset) * (height - thumbSize));
    return index >= top && index < top + thumbSize ? color.accent('█') : color.faint('│');
  }

  private thumbSize(height: number, total: number): number {
    return Math.min(height, Math.max(1, Math.floor((height / total) * height)));
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
  /** Owner-scoped background commands. They live in the right rail so they no longer consume transcript
   *  height; the rail keeps the existing collapse + click-to-kill ProcessPanel behavior. */
  processes?: ProcessInfo[];
  /** OpenAI OAuth subscription usage. Null on other providers/accounts, which hides the whole section. */
  rateLimits?: BrainRateLimits | null;
  /** Eased vertical drift of the flame (in panel rows) while the transcript is being scrolled; 0 at
   *  rest. The flame floats within a reserved ±{@link FLOAT_BAND} band so the Context section never moves. */
  floatOffset: number;
}

const PANEL_BAR_MARGIN = 2;
const MCP_NAMES_SHOWN = 4;

export class TelemetryPanel implements Component {
  private readonly processPanel = new ProcessPanel();
  private processTop = -1;
  constructor(private getState: () => TelemetryState) {}
  invalidate(): void { /* state driven */ }
  isProcessHeaderRow(row: number): boolean {
    return this.processTop >= 0 && this.processPanel.isHeaderRow(row - this.processTop);
  }
  toggleProcesses(): void { this.processPanel.toggleCollapsed(); }
  processKillAt(row: number, x: number): string | null {
    return this.processTop >= 0 ? this.processPanel.killAt(row - this.processTop, x) : null;
  }
  render(width: number): string[] {
    const st = this.getState();
    const usage = st.usage;
    const pct = usage?.percent != null ? `${Math.round(usage.percent)}%` : '—';
    const tokens = usage ? `${formatK(usage.tokens ?? 0)} / ${formatK(usage.contextWindow)}` : '—';
    const logo = panelLogo(width, st.floatOffset);
    const rows = [
      '',
      ...logo,
      '',
      `  ${color.bold(color.text('Context'))}`,
      `  ${color.text(tokens)} ${color.faint('tokens')} ${color.faint(`· ${pct}`)}${usage ? ` ${color.faint(`· $${usage.cost.toFixed(2)}`)}` : ''}`,
      `${' '.repeat(PANEL_BAR_MARGIN)}${this.contextBar(usage?.percent ?? 0, width)}`,
    ];
    const limitRows = this.rateLimitRows(st.rateLimits ?? null, width);
    if (limitRows.length > 0) rows.push('', ...limitRows);
    this.processPanel.set(st.processes ?? []);
    this.processPanel.setMaxRows(5);
    const processRows = this.processPanel.render(width);
    this.processTop = processRows.length > 0 ? rows.length + 1 : -1;
    if (processRows.length > 0) rows.push('', ...processRows);
    rows.push(
      '',
      `  ${color.bold(color.text('Project'))}`,
      `  ${color.text(truncateToWidth(st.cwd, Math.max(1, width - 4), '…'))}`,
      `  ${color.faint('branch')} ${color.accent(st.branch || 'unknown')}`,
      ...this.mcpRows(st.mcp, width),
      ...this.lspRows(st.lspEnabled),
    );
    return rows.map((r) => color.panelBg(padAnsi(r, width)));
  }

  /** Two deliberately one-line subscription meters: enough to spot the 5h/weekly pressure and reset
   *  without turning the telemetry rail into a dashboard. Missing windows disappear independently. */
  private rateLimitRows(limits: BrainRateLimits | null, width: number): string[] {
    if (!limits) return [];
    const meta = [limits.planType, limits.stale ? 'stale' : ''].filter(Boolean).join(' · ');
    const rows = [`  ${color.bold(color.text('Limits'))}${meta ? ` ${color.faint(meta)}` : ''}`];
    if (limits.primary) rows.push(this.rateLimitWindowRow(limits.primary, width));
    if (limits.secondary) rows.push(this.rateLimitWindowRow(limits.secondary, width));
    return rows.length > 1 ? rows : [];
  }

  private rateLimitWindowRow(window: BrainRateLimitWindow, width: number): string {
    const labelWidth = 7;
    const label = this.rateLimitDuration(window.windowMinutes).padEnd(labelWidth);
    const pctValue = Math.max(0, Math.min(100, window.usedPercent));
    const pct = `${Math.round(pctValue)}%`.padStart(4);
    const reset = this.rateLimitReset(window.resetsAt, window.windowMinutes);
    // `  label` + bar + ` pct reset`; at the supported 36-col rail minimum this still leaves >=9 cells.
    const cells = Math.max(4, width - 15 - visibleWidth(reset));
    const bar = this.progressBar(pctValue, cells);
    return `  ${color.faint(label)}${bar} ${color.text(pct)} ${color.faint(reset)}`;
  }

  private rateLimitDuration(minutes: number | null): string {
    if (minutes === 10_080) return 'weekly';
    if (minutes == null || minutes <= 0) return 'window';
    if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
    if (minutes % 60 === 0) return `${minutes / 60}h`;
    return `${Math.round(minutes)}m`;
  }

  private rateLimitReset(seconds: number | null, minutes: number | null): string {
    if (seconds == null || !Number.isFinite(seconds)) return '↻ —';
    const at = new Date(seconds * 1_000);
    if (Number.isNaN(at.getTime())) return '↻ —';
    const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    if ((minutes ?? 0) < 1_440) return `↻ ${time}`;
    const weekday = at.toLocaleDateString(undefined, { weekday: 'short' });
    return `↻ ${weekday} ${time}`;
  }

  /** The context meter spans the panel minus an equal margin on both edges and shares the exact same
   * block vocabulary as the OAuth limit windows at every responsive panel width. */
  private contextBar(percent: number, width: number): string {
    const cells = Math.max(8, width - PANEL_BAR_MARGIN * 2);
    return this.progressBar(percent, cells);
  }

  private progressBar(percent: number, cells: number): string {
    const value = Math.max(0, Math.min(100, percent));
    const filled = Math.max(0, Math.min(cells, Math.round((value / 100) * cells)));
    return `${color.accent('█'.repeat(filled))}${color.faint('░'.repeat(cells - filled))}`;
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

function panelLogo(width: number, offset = 0): string[] {
  // The flame mascot, centered in the panel. Its truecolor lines already carry their own colors, so
  // the panel just pads them; wider than the panel (never, at the 36-col minimum) it clips gracefully.
  const art = MASCOT_ART.map((line) => {
    const pad = Math.max(0, Math.floor((width - visibleWidth(line)) / 2));
    return `${' '.repeat(pad)}${line}`;
  });
  // Reserve a fixed band of blank rows above AND below the flame and slide it within that band by whole
  // rows — a positive drift lifts the flame (fewer rows above). The band's total height is constant, so
  // the Context section below never reflows however far the flame drifts.
  const shift = Math.max(-FLOAT_BAND, Math.min(FLOAT_BAND, Math.round(offset)));
  const above = FLOAT_BAND - shift;
  const below = FLOAT_BAND + shift;
  return [
    ...Array.from({ length: above }, () => ''),
    ...art,
    ...Array.from({ length: below }, () => ''),
  ];
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
