import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { Component, MarkdownTheme } from '@earendil-works/pi-tui';
import { chatTheme, color } from './theme.js';
import type { ChatTurn } from '../../brain/transcript.js';
import type { TranscriptRead } from '../../brain/transcriptModel.js';
import { DynamicHeightIndex } from './heightIndex.js';
import { padAnsi, terminalInlineText, terminalPlainText } from '../ui/text.js';
import { TurnRenderer } from './turnRenderer.js';
import type { TranscriptRow } from './turnRenderer.js';

interface TurnLayoutEntry {
  turn: ChatTurn | null;
  /** Exact rendered height for the current width/theme/visibility context; null until indexed. */
  height: number | null;
  /** Optional rendered rows. Off-screen heights are learned only as the user scrolls; visible rows live
   *  in an LRU so opening a large history never schedules a full-transcript Markdown pass. */
  rows: TranscriptRow[] | null;
}

const HISTORY_OVERSCAN_ROWS = 8;
const SCROLLBAR_DRAG_INDEX_TURNS = 128;
const SCROLLBAR_DRAG_INDEX_MS = 16;
/** Soft bound: one exceptionally tall visible turn may exceed it, but off-screen rows are evicted. */
export const CHAT_VIEWPORT_ROW_CACHE_LIMIT = 2_048;

export interface ChatViewportState {
  transcript: TranscriptRead;
  transcriptNotice?: string;
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
  layoutVisits: number;
  scrollOffset: number;
  maxScrollOffset: number;
  heightIndexOperations: number;
}

interface VisualScrollMetrics {
  total: number;
  maxOffset: number;
  thumbSize: number;
  thumbTop: number;
}

interface ViewportResetAnchor {
  turnRatio: number;
  withinTurnRatio: number;
  averageTurnRows: number;
}

export class ChatViewport implements Component {
  private readonly turnRenderer: TurnRenderer;
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
  private layoutTranscript: TranscriptRead | null = null;
  private layoutRevision = -1;
  private knownStart = 0;
  private suffixReconnect: { boundary: number; start: number } | null = null;
  private heightIndex = new DynamicHeightIndex();
  private estimatedLayout = false;
  private estimatedTurnHeight = 0;
  private pendingResetAnchor: ViewportResetAnchor | null = null;
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
  private frameLayoutVisits = 0;
  private scrollbarDrag: { localRow: number; grabOffset: number } | null = null;

  constructor(
    initial: ChatViewportState,
    mdTheme: MarkdownTheme,
    private readonly getRows: () => number,
    private readonly getTopRow: () => number,
    private readonly getWidth: () => number,
  ) {
    this.state = initial;
    this.turnRenderer = new TurnRenderer(mdTheme);
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
      && this.layout.length === this.state.transcript.turnCount
      && this.indexedTurnCount === this.layout.length;
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
      layoutVisits: this.frameLayoutVisits,
      scrollOffset: this.scrollOffset,
      maxScrollOffset: this.maxOffset,
      heightIndexOperations: this.heightIndex.operationCount(),
    };
  }

  resetHeightIndexOperationCount(): void { this.heightIndex.resetOperationCount(); }

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
    const metrics = this.visualScrollMetrics(this.viewportHeight);
    return metrics.total > this.viewportHeight
      && localRow >= 1
      && localRow <= this.viewportHeight
      && Math.abs(x - this.scrollbarColumn) <= 1
      && localRow - 1 >= metrics.thumbTop
      && localRow - 1 < metrics.thumbTop + metrics.thumbSize;
  }

  /** Begin a real thumb drag without moving it. Remembering where inside the thumb the pointer landed
   *  prevents the common "grab then jump to centre" glitch. Returns whether older history still needs
   *  bounded background indexing (normally false until the pointer actually moves upward). */
  beginScrollbarDrag(absRow: number): boolean {
    if (this.viewportHeight <= 0) return false;
    const metrics = this.visualScrollMetrics(this.viewportHeight);
    const localRow = Math.max(0, Math.min(this.viewportHeight - 1, absRow - this.getTopRow()));
    this.scrollbarDrag = {
      localRow,
      grabOffset: Math.max(0, Math.min(metrics.thumbSize - 1, localRow - metrics.thumbTop)),
    };
    return false;
  }

  /** Move an active scrollbar drag. One call performs at most one bounded history-index batch. The
   *  boolean tells the shell to schedule another one-shot continuation even if the mouse stops moving. */
  updateScrollbarDrag(absRow: number): boolean {
    if (!this.scrollbarDrag || this.viewportHeight <= 0) return false;
    const localRow = Math.max(0, Math.min(this.viewportHeight - 1, absRow - this.getTopRow()));
    if (localRow === this.scrollbarDrag.localRow) return false;
    this.scrollbarDrag.localRow = localRow;
    return this.advanceScrollbarDrag();
  }

  continueScrollbarDrag(): boolean {
    return this.scrollbarDrag ? this.advanceScrollbarDrag() : false;
  }

  endScrollbarDrag(): void {
    this.scrollbarDrag = null;
  }

  setScrollFromRow(absRow: number): void {
    if (this.viewportHeight <= 0) return;
    const metrics = this.visualScrollMetrics(this.viewportHeight);
    this.scrollbarDrag = {
      localRow: Math.max(0, Math.min(this.viewportHeight - 1, absRow - this.getTopRow())),
      grabOffset: Math.floor(metrics.thumbSize / 2),
    };
    this.advanceScrollbarDrag();
    this.endScrollbarDrag();
  }

  private advanceScrollbarDrag(): boolean {
    const drag = this.scrollbarDrag;
    if (!drag || this.viewportHeight <= 0) return false;
    let metrics = this.visualScrollMetrics(this.viewportHeight);
    if (metrics.total <= this.viewportHeight || metrics.maxOffset <= 0) {
      this.scrollOffset = 0;
      return false;
    }
    const targetOffset = (visual: VisualScrollMetrics): number => {
      const maxTop = Math.max(1, this.viewportHeight - visual.thumbSize);
      const targetTop = Math.max(0, Math.min(maxTop, drag.localRow - drag.grabOffset));
      return Math.round(visual.maxOffset - (targetTop / maxTop) * visual.maxOffset);
    };

    // Each continuation remains frame-budgeted. The shell re-arms a one-shot timer while this returns
    // true, so a stationary pointer can still reach an estimated old-history target without blocking
    // input or creating a permanent/idle render loop.
    if (!this.isHistoryIndexComplete() && targetOffset(metrics) > this.maxOffset) {
      this.indexOlderBounded(SCROLLBAR_DRAG_INDEX_TURNS, SCROLLBAR_DRAG_INDEX_MS);
      this.refreshMetrics();
      metrics = this.visualScrollMetrics(this.viewportHeight);
    }
    const desired = targetOffset(metrics);
    this.scrollOffset = Math.max(0, Math.min(this.maxOffset, desired));
    return !this.isHistoryIndexComplete() && desired > this.maxOffset;
  }

  render(width: number): string[] {
    const startedAt = performance.now();
    this.frameRenderedTurns = 0;
    this.frameReconciledTurns = 0;
    this.frameLayoutVisits = 0;
    const height = Math.max(1, this.getRows());
    const chatWidth = Math.max(1, Math.min(width, this.getWidth()));
    const contentWidth = Math.max(1, chatWidth - 5);
    this.prepareLayout(contentWidth);
    this.currentExtraRows = this.extraRows();
    this.viewportHeight = height;
    this.scrollbarColumn = chatWidth;
    const estimatedAnchor = this.pendingResetAnchor ?? (this.estimatedLayout ? this.captureViewportAnchor(false) : null);
    if (estimatedAnchor) {
      const anchor = estimatedAnchor;
      this.restoreResetAnchor(anchor);
      this.materializeEstimatedWindow(anchor, height + HISTORY_OVERSCAN_ROWS);
      this.restoreResetAnchor(anchor);
      this.pendingResetAnchor = null;
    }
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
    this.lastPlainRows = this.lastRows.map((line) => terminalPlainText(line));
    this.lastTotal = totalRows;
    const scrollMetrics = this.visualScrollMetrics(height);
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
      return padAnsi(`${cell} ${this.scrollbar(i, scrollMetrics)}`, width);
    });
    this.lastRenderMs = performance.now() - startedAt;
    return rendered;
  }

  private prepareLayout(width: number): void {
    this.currentContentWidth = width;
    const theme = chatTheme();
    const showThoughts = this.state.showThoughts !== false;
    const transcript = this.state.transcript;
    const transcriptChanged = this.layoutTranscript !== transcript;
    const contextChanged = this.layoutWidth !== width
      || this.layoutTheme !== theme
      || this.layoutShowsThoughts !== showThoughts;

    if (transcriptChanged || contextChanged) {
      const anchor = !transcriptChanged && contextChanged ? this.captureViewportAnchor(true) : null;
      this.resetLayout(transcript.turnCount, transcriptChanged, anchor);
      this.layoutTranscript = transcript;
      this.layoutRevision = transcript.revision;
      this.layoutWidth = width;
      this.layoutTheme = theme;
      this.layoutShowsThoughts = showThoughts;
      return;
    }

    const change = transcript.changesSince(this.layoutRevision);
    if (change.kind === 'full' || this.layout.length > transcript.turnCount) {
      this.resetLayout(transcript.turnCount, true, this.captureViewportAnchor(true));
    } else {
      const dirtyIndices = change.kind === 'turns' || change.kind === 'patch' ? change.indices : [];
      const sparseValid = dirtyIndices.every((index) => index >= 0 && index < this.layout.length && index < transcript.turnCount);
      if (!sparseValid) {
        this.resetLayout(transcript.turnCount, true, this.captureViewportAnchor(true));
      } else {
        for (const index of dirtyIndices) this.reconcileTurn(index);
        const suffixFrom = change.kind === 'suffix' || change.kind === 'patch' ? change.from : null;
        if (suffixFrom != null) {
          if (suffixFrom < 0 || suffixFrom > this.layout.length || suffixFrom > transcript.turnCount) {
            this.resetLayout(transcript.turnCount, true, this.captureViewportAnchor(true));
          } else {
            this.replaceSuffix(suffixFrom, transcript.turnCount);
          }
        } else if (this.layout.length !== transcript.turnCount) {
          this.resetLayout(transcript.turnCount, true, this.captureViewportAnchor(true));
        }
      }
    }
    this.layoutRevision = change.revision;

    // The live tail can mutate its elapsed label/output between object replacements. It alone is volatile;
    // settled entries keep both exact heights and any retained rows.
    const volatile = this.layout.at(-1);
    if (volatile?.turn?.role === 'elowen' && volatile.turn.streaming && volatile.height != null) {
      this.clearSelection();
      this.invalidateKnownTail(this.layout.length - 1);
    }
  }

  private resetLayout(
    turnCount: number,
    clearExpansions: boolean,
    anchor: ViewportResetAnchor | null = null,
  ): void {
    this.clearSelection();
    this.clearAllCachedRows();
    this.layout = Array.from({ length: turnCount }, () => ({ turn: null, height: null, rows: null }));
    this.heightIndex = new DynamicHeightIndex();
    this.estimatedTurnHeight = anchor ? Math.max(1, Math.round(anchor.averageTurnRows)) : 0;
    this.heightIndex.resize(turnCount, this.estimatedTurnHeight);
    this.indexedTurnCount = 0;
    this.estimatedLayout = anchor != null;
    this.pendingResetAnchor = anchor;
    this.knownStart = anchor ? 0 : turnCount;
    this.suffixReconnect = null;
    if (clearExpansions) {
      this.expandedThoughts.clear();
      this.expandedTools.clear();
    }
  }

  private captureViewportAnchor(deepOnly: boolean): ViewportResetAnchor | null {
    const turnCount = this.layout.length;
    if (turnCount === 0 || this.viewportHeight <= 0) return null;
    if (deepOnly && this.scrollOffset <= Math.max(this.viewportHeight * 2, HISTORY_OVERSCAN_ROWS)) return null;
    const turnRows = this.heightIndex.prefixSum(turnCount);
    if (turnRows <= 0) return null;
    const leadingBlank = this.knownStart === 0 ? 1 : 0;
    const liveTotal = leadingBlank + turnRows + this.currentExtraRows.length;
    const topRow = Math.max(0, liveTotal - this.viewportHeight - this.scrollOffset);
    const turnOffset = Math.max(0, Math.min(turnRows - 1, topRow - leadingBlank));
    const turnIndex = Math.min(turnCount - 1, this.heightIndex.lowerBoundOffset(turnOffset));
    const turnStart = this.heightIndex.prefixSum(turnIndex);
    const turnHeight = Math.max(1, this.heightIndex.valueAt(turnIndex));
    const exactRows = this.estimatedLayout
      ? turnRows
      : this.heightIndex.rangeSum(this.knownStart, turnCount);
    const averageTurnRows = this.estimatedLayout
      ? turnRows / turnCount
      : exactRows / Math.max(1, this.indexedTurnCount);
    return {
      turnRatio: turnCount > 1 ? turnIndex / (turnCount - 1) : 0,
      withinTurnRatio: Math.max(0, Math.min(1, (turnOffset - turnStart) / turnHeight)),
      averageTurnRows: Math.max(1, averageTurnRows),
    };
  }

  private restoreResetAnchor(anchor: ViewportResetAnchor): void {
    const turnCount = this.layout.length;
    if (turnCount === 0) { this.scrollOffset = 0; return; }
    const turnIndex = Math.max(0, Math.min(turnCount - 1, Math.round(anchor.turnRatio * (turnCount - 1))));
    const turnStart = this.heightIndex.prefixSum(turnIndex);
    const turnHeight = Math.max(1, this.heightIndex.valueAt(turnIndex));
    const leadingBlank = 1;
    const topRow = leadingBlank + turnStart + Math.floor(anchor.withinTurnRatio * turnHeight);
    const estimatedTotal = leadingBlank
      + this.heightIndex.prefixSum(turnCount)
      + this.currentExtraRows.length;
    this.scrollOffset = Math.max(0, estimatedTotal - this.viewportHeight - topRow);
  }

  private materializeEstimatedWindow(anchor: ViewportResetAnchor, requiredRows: number): void {
    if (!this.estimatedLayout || this.layout.length === 0) return;
    const first = Math.max(0, Math.min(
      this.layout.length - 1,
      Math.round(anchor.turnRatio * (this.layout.length - 1)),
    ));
    let rows = 0;
    let visits = 0;
    // A turn always renders at least its trailing boundary row. Budgeting one visit per requested row
    // therefore covers even a very tall terminal full of one-row turns without tying work to history
    // depth. The 64-turn floor preserves the normal small-terminal recovery bound and overscan cache.
    const maxVisits = Math.max(64, requiredRows + 1);
    for (let index = first;
      index < this.layout.length && rows < requiredRows && visits < maxVisits; index += 1) {
      this.frameLayoutVisits++;
      visits++;
      const entry = this.layout[index]!;
      if (entry.height == null) this.renderAndRecord(index, true);
      const height = entry.height ?? this.estimatedTurnHeight;
      // The logical anchor can sit deep inside a tall turn. Only the rows remaining below that
      // intra-turn position cover the frozen window; counting the whole turn would stop the prepass
      // before a following cold entry that collectWindow is about to consume.
      rows += index === first
        ? Math.max(0, height - Math.floor(anchor.withinTurnRatio * height))
        : height;
    }
  }

  private reconcileTurn(index: number): void {
    const entry = this.layout[index]!;
    const nextTurn = this.state.transcript.turnAt(index);
    if (!nextTurn || entry.turn === nextTurn) return;
    this.clearSelection();
    const retain = entry.rows != null;
    entry.turn = nextTurn;
    this.frameReconciledTurns++;
    if (entry.height != null && !(nextTurn.role === 'elowen' && nextTurn.streaming)) {
      this.renderAndRecord(index, retain);
    }
  }

  private replaceSuffix(from: number, turnCount: number): void {
    if (from < this.layout.length) this.clearSelection();
    const oldKnownStart = this.knownStart;
    for (const entry of this.layout.slice(from)) {
      if (entry.height != null) this.indexedTurnCount--;
      this.discardRows(entry);
    }
    this.layout.length = from;
    this.heightIndex.resize(from);
    while (this.layout.length < turnCount) this.layout.push({ turn: null, height: null, rows: null });
    this.heightIndex.resize(turnCount, this.estimatedLayout ? this.estimatedTurnHeight : 0);
    this.frameReconciledTurns += turnCount - from;
    if (this.estimatedLayout) {
      this.knownStart = 0;
      this.suffixReconnect = null;
      return;
    }
    this.knownStart = turnCount;
    this.suffixReconnect = from >= oldKnownStart ? { boundary: from, start: oldKnownStart } : null;
    this.applySuffixReconnect();
  }

  private invalidateKnownTail(index: number): void {
    const entry = this.layout[index]!;
    const oldKnownStart = this.knownStart;
    this.discardRows(entry);
    entry.height = null;
    this.heightIndex.replace(index, this.estimatedLayout ? this.estimatedTurnHeight : 0);
    this.indexedTurnCount--;
    if (this.estimatedLayout) return;
    this.knownStart = this.layout.length;
    this.suffixReconnect = index >= oldKnownStart ? { boundary: index, start: oldKnownStart } : null;
  }

  private extraRows(): TranscriptRow[] {
    const rows: TranscriptRow[] = [];
    if (this.state.notice) rows.push(...terminalPlainText(this.state.notice).split('\n').map((line) => ({ line: `  ${line}` })));
    if (this.state.transcriptNotice) rows.push({ line: `  ${color.faint(`· ${terminalInlineText(this.state.transcriptNotice)}`)}` });
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
    const turn = this.state.transcript.turnAt(index);
    if (!turn) return [];
    entry.turn = turn;
    const oldHeight = entry.height;
    const rows = this.renderTurn(turn, index, this.currentContentWidth);
    entry.height = rows.length;
    if (oldHeight == null) this.indexedTurnCount++;
    this.heightIndex.replace(index, rows.length);
    if (this.indexedTurnCount === this.layout.length) this.estimatedLayout = false;
    if (retain) this.retainRows(entry, rows);
    else this.discardRows(entry);
    return rows;
  }

  /** Compose a frame only from heights made exact before total/start/selection/scrollbar geometry was
   *  frozen. The viewport-sized prepass guarantees this invariant independent of history depth. */
  private rowsForFrozenWindow(index: number): TranscriptRow[] {
    const entry = this.layout[index]!;
    if (entry.rows) { this.touchRows(entry); return entry.rows; }
    if (entry.height == null && this.estimatedLayout) {
      throw new Error('estimated viewport prepass left a visible turn cold');
    }
    return this.renderAndRecord(index, true);
  }

  private reindexTurn(index: number, retain: boolean): void {
    if (index < 0 || index >= this.layout.length || this.currentContentWidth <= 0) return;
    this.renderAndRecord(index, retain);
    this.refreshMetrics();
  }

  private applySuffixReconnect(): void {
    if (this.suffixReconnect && this.knownStart === this.suffixReconnect.boundary) {
      this.knownStart = this.suffixReconnect.start;
      this.suffixReconnect = null;
    }
  }

  private indexPrevious(retain: boolean): void {
    if (this.knownStart <= 0) return;
    const index = this.knownStart - 1;
    this.frameLayoutVisits++;
    const entry = this.layout[index]!;
    if (entry.height == null) this.renderAndRecord(index, retain);
    this.knownStart = index;
    this.applySuffixReconnect();
  }

  private ensureTail(requiredRows: number, retain: boolean): void {
    const requiredTurnRows = Math.max(0, requiredRows - this.currentExtraRows.length);
    while (this.knownStart > 0
      && this.heightIndex.rangeSum(this.knownStart, this.layout.length) < requiredTurnRows) {
      this.indexPrevious(retain);
    }
  }

  private ensureScrollCapacity(targetOffset: number): void {
    if (this.currentContentWidth <= 0) return;
    this.ensureTail(this.viewportHeight + Math.max(0, targetOffset), true);
    this.refreshMetrics();
  }

  private indexOlderBounded(maxTurns: number, maxMs: number): void {
    const startedAt = performance.now();
    let indexed = 0;
    while (this.knownStart > 0 && indexed < maxTurns) {
      this.indexPrevious(true);
      indexed++;
      if (performance.now() - startedAt >= maxMs) break;
    }
  }

  private refreshMetrics(): void {
    const leadingBlank = this.knownStart === 0 ? 1 : 0;
    this.totalLines = leadingBlank
      + this.heightIndex.rangeSum(this.knownStart, this.layout.length)
      + this.currentExtraRows.length;
    this.maxOffset = Math.max(0, this.totalLines - this.viewportHeight);
    this.scrollOffset = Math.max(0, Math.min(this.maxOffset, this.scrollOffset));
  }

  private collectWindow(start: number, end: number): TranscriptRow[] {
    const visible: TranscriptRow[] = [];
    const append = (rows: TranscriptRow[], chunkStart: number): void => {
      const chunkEnd = chunkStart + rows.length;
      if (chunkEnd <= start || chunkStart >= end) return;
      visible.push(...rows.slice(Math.max(0, start - chunkStart), Math.min(rows.length, end - chunkStart)));
    };

    const leadingBlank = this.knownStart === 0 ? 1 : 0;
    if (leadingBlank) append([{ line: '' }], 0);
    const knownBase = this.heightIndex.prefixSum(this.knownStart);
    const turnTotal = this.heightIndex.rangeSum(this.knownStart, this.layout.length);
    const localStart = Math.max(0, start - leadingBlank);
    const localEnd = Math.min(turnTotal, end - leadingBlank);
    if (localStart < localEnd) {
      for (let index = this.heightIndex.lowerBoundOffset(knownBase + localStart);
        index < this.layout.length; index += 1) {
        const turnStart = this.heightIndex.prefixSum(index) - knownBase;
        const chunkStart = leadingBlank + turnStart;
        if (chunkStart >= end || turnStart >= localEnd) break;
        append(this.rowsForFrozenWindow(index), chunkStart);
      }
    }
    append(this.currentExtraRows, leadingBlank + turnTotal);
    return visible;
  }

  /** Render exactly one turn; viewport state supplies expansion/visibility without sharing index ownership. */
  private renderTurn(turn: ChatTurn, turnIndex: number, width: number): TranscriptRow[] {
    return this.turnRenderer.render(turn, turnIndex, width, {
      showThoughts: this.state.showThoughts !== false,
      thinkingSeconds: this.state.thinkingSeconds,
      expandedThoughts: this.expandedThoughts,
      expandedTools: this.expandedTools,
    });
  }

  private historyChip(line: string, width: number): string {
    const chip = `${color.accent('History')} ${color.faint(`+${this.scrollOffset} lines`)}`;
    const plain = visibleWidth(line) > 0 ? `  ${line}` : '';
    return truncateToWidth(`${chip}${plain}`, width, '');
  }

  private visualScrollMetrics(height: number): VisualScrollMetrics {
    let visualTotal = this.totalLines;
    if (!this.isHistoryIndexComplete()) {
      // Virtualized history knows that `knownStart` older turns exist even before their Markdown heights
      // are materialized. Painting and pointer hit-testing share this geometry, so the visible control
      // and the area the user can grab cannot diverge.
      const knownRows = this.heightIndex.rangeSum(this.knownStart, this.layout.length);
      const averageTurnRows = this.indexedTurnCount > 0
        ? Math.max(1, knownRows / this.indexedTurnCount)
        : Math.max(1, height / 2);
      visualTotal = Math.max(height + 1, Math.ceil(
        knownRows + averageTurnRows * this.knownStart + this.currentExtraRows.length + 1,
      ));
    }
    const visualMaxOffset = Math.max(0, visualTotal - height);
    const thumbSize = this.thumbSize(height, visualTotal);
    const visualOffset = Math.min(this.scrollOffset, visualMaxOffset);
    const thumbTop = visualMaxOffset > 0
      ? Math.floor(((visualMaxOffset - visualOffset) / visualMaxOffset) * (height - thumbSize))
      : 0;
    return { total: visualTotal, maxOffset: visualMaxOffset, thumbSize, thumbTop };
  }

  private scrollbar(index: number, metrics: VisualScrollMetrics): string {
    if (metrics.total <= this.viewportHeight) return color.faint('│');
    return index >= metrics.thumbTop && index < metrics.thumbTop + metrics.thumbSize
      ? color.accent('█')
      : color.faint('│');
  }

  private thumbSize(height: number, total: number): number {
    return Math.min(height, Math.max(1, Math.floor((height / total) * height)));
  }
}
