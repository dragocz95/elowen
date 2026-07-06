import { Markdown, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { Component, MarkdownTheme, TUI } from '@earendil-works/pi-tui';
import { diffBlock, metaLine, padAnsi, toolChip, UserBlock } from './components.js';
import { ansi, chatTheme, color } from './theme.js';
import type { BrainUsageView } from './brainClient.js';
import type { BrainCard } from '../../brain/events.js';
import type { ChatView } from '../../brain/transcript.js';

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

interface TranscriptRow {
  line: string;
  kind?: 'thought';
}

export class TopRule implements Component {
  invalidate(): void { /* stateless */ }
  render(width: number): string[] {
    const label = ` ${color.accent('Orca Chat')} ${color.faint('dev session')} `;
    return [`${label}${color.accent('─'.repeat(Math.max(0, width - visibleWidth(label))))}`];
  }
}

export class MainColumn implements Component {
  constructor(private getReserve: () => number, private children: Component[]) {}
  invalidate(): void { for (const child of this.children) child.invalidate?.(); }
  render(width: number): string[] {
    const reserve = Math.max(0, Math.min(width - 24, this.getReserve()));
    const mainWidth = Math.max(24, width - reserve);
    const lines: string[] = [];
    for (const child of this.children) {
      for (const line of child.render(mainWidth)) {
        lines.push(`${padAnsi(line, mainWidth)}${' '.repeat(reserve)}`);
      }
    }
    return lines;
  }
}

export interface ChatViewportState {
  view: ChatView;
  notice: string;
  modelName: string;
  thinkingSeconds: number;
}

export class ChatViewport implements Component {
  private state: ChatViewportState;
  private scrollOffset = 0;
  private maxOffset = 0;
  private viewportHeight = 0;
  private totalLines = 0;
  private scrollbarColumn = 0;
  private thoughtRows = new Set<number>();
  private expandedThought = false;

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

  isThoughtRow(absRow: number): boolean {
    return this.thoughtRows.has(absRow - this.getTopRow() + 1);
  }

  toggleThought(): void {
    this.expandedThought = !this.expandedThought;
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
    this.thoughtRows = new Set();

    const start = Math.max(0, rows.length - height - this.scrollOffset);
    const visible = rows.slice(start, start + height);
    while (visible.length < height) visible.push({ line: '' });
    return visible.map((entry, i) => {
      if (entry.kind === 'thought') this.thoughtRows.add(i + 1);
      const content = i === 0 && this.scrollOffset > 0
        ? this.historyChip(entry.line, chatWidth - 2)
        : entry.line;
      return padAnsi(`${padAnsi(content, chatWidth - 2)} ${this.scrollbar(i, height, rows.length)}`, width);
    });
  }

  private renderTranscript(width: number): TranscriptRow[] {
    const rows: TranscriptRow[] = [{ line: '' }];
    const add = (line: string, kind?: TranscriptRow['kind']): void => { rows.push(kind ? { line, kind } : { line }); };
    const addBlank = (): void => add('');
    if (this.state.view.turns.length === 0) {
      add(`  ${color.accent('ORCA')} ${color.faint('ready')} ${color.dim(this.state.modelName || '—')}`);
      add(`  ${color.faint('/help commands · /theme colors · ctrl+r reasoning · ctrl+p telemetry')}`);
      addBlank();
    }
    for (const [i, turn] of this.state.view.turns.entries()) {
      if (turn.role === 'you') {
        for (const line of new UserBlock(turn.text).render(width)) add(line);
        addBlank();
        continue;
      }
      let hasText = false;
      for (const seg of turn.segments) {
        if (seg.kind === 'tools') {
          for (const item of seg.items) {
            add(toolChip(item.name, item.detail, item.icon));
            if (item.diff) for (const line of diffBlock(item.diff)) add(line);
          }
        } else if (seg.kind === 'reasoning') {
          const liveTail = turn.streaming && seg === turn.segments[turn.segments.length - 1];
          if (!liveTail) continue;
          const first = seg.text.replace(/\s+/g, ' ').trim() || 'thinking';
          add(`  ${color.warning(this.expandedThought ? '▾' : '▸')} ${color.warning(`Thought: ${this.state.thinkingSeconds}s`)} ${color.faint('click')} ${color.dim(truncateToWidth(first, Math.max(12, width - 32), '…'))}`, 'thought');
          if (this.expandedThought) {
            for (const line of wrapTextWithAnsi(seg.text, Math.max(1, width - 6))) add(`    ${color.faint(line)}`);
          }
          addBlank();
        } else {
          hasText = true;
          for (const line of new Markdown(seg.text, 2, 0, this.mdTheme).render(width)) add(line);
        }
      }
      if (!hasText && turn.streaming) add(`  ${color.faint('…')}`);
      const nextIsOrca = this.state.view.turns[i + 1]?.role === 'orca';
      if (hasText && !turn.streaming && !nextIsOrca) add(metaLine(this.state.modelName));
      addBlank();
    }
    if (this.state.notice) for (const line of this.state.notice.split('\n')) add(`  ${line}`);
    if (this.state.view.notice) add(`  ${color.faint(`· ${this.state.view.notice}`)}`);
    if (this.state.view.thinking) add(`  ${color.faint(`thinking… ${this.state.thinkingSeconds}s`)}`);
    return rows;
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
}

export interface TelemetryState {
  modelName: string;
  sessionTitle: string;
  usage: BrainUsageView | null;
  thinkingLevel: string;
  thinkingLevels: string[];
  running: boolean;
  cards: BrainCard[];
  themeLabel: string;
}

export class TelemetryPanel implements Component {
  constructor(private getState: () => TelemetryState) {}
  invalidate(): void { /* state driven */ }
  render(width: number): string[] {
    const st = this.getState();
    const usage = st.usage;
    const pct = usage?.percent != null ? `${Math.round(usage.percent)}% used` : 'context unknown';
    const tokens = usage ? `${usage.tokens ?? 0}/${usage.contextWindow}` : '—';
    const rows = [
      '',
      `  ${color.accentSoft('ORCA')}${color.faint(' / coding agent')}`,
      '',
      `  ${color.bold(color.text('Build'))}`,
      `  ${st.running ? color.success('●') : color.faint('○')} ${color.text(st.modelName || '—')}`,
      `  ${color.faint('reasoning')} ${color.warning(st.thinkingLevel || 'default')}`,
      '',
      `  ${color.bold(color.text('Session'))}`,
      `  ${color.text(truncateToWidth(st.sessionTitle || 'New conversation', Math.max(1, width - 4), '…'))}`,
      `  ${color.faint('theme')} ${color.accent(st.themeLabel)}`,
      '',
      `  ${color.bold(color.text('Context'))}`,
      `  ${color.text(tokens)} ${color.faint('tokens')}`,
      `  ${color.faint(pct)} ${usage ? color.faint(`· $${usage.cost.toFixed(2)}`) : ''}`,
      `  ${this.contextBar(usage?.percent ?? 0)}`,
      '',
      `  ${color.bold(color.text('Runtime'))}`,
      `  ${color.accent('◆')} ${color.text('stream')} ${color.dim(st.running ? 'connected' : 'idle')}`,
      `  ${color.accent('◎')} ${color.text('cards')} ${color.dim(String(st.cards.length))}`,
      `  ${color.accent('▣')} ${color.text('levels')} ${color.dim(st.thinkingLevels.length ? st.thinkingLevels.join(', ') : 'n/a')}`,
      '',
      `  ${color.bold(color.text('Keys'))}`,
      `  ${color.dim('ctrl+p panel')}`,
      `  ${color.dim('ctrl+r reasoning')}`,
      `  ${color.dim('/ theme model sessions')}`,
      '',
      `  ${color.dim(process.cwd())}`,
    ];
    return rows.map((r) => color.panelBg(padAnsi(r, width)));
  }

  private contextBar(percent: number): string {
    const filled = Math.max(0, Math.min(10, Math.round(percent / 10)));
    return `${color.accent('▰'.repeat(filled))}${color.faint('▱'.repeat(10 - filled))}`;
  }
}

export interface SlashOverlayItem {
  value: string;
  label: string;
  description?: string;
}

export class SlashOverlay implements Component {
  private filter = '';
  private selectedIndex = 0;

  constructor(
    private readonly tui: TUI,
    private readonly items: SlashOverlayItem[],
    private readonly onPick: (value: string) => void,
    private readonly onCancel: () => void,
  ) {}

  invalidate(): void { /* state driven */ }

  filteredItems(): SlashOverlayItem[] {
    const query = `/${this.filter}`.toLowerCase();
    return this.items.filter((item) => item.value.toLowerCase().startsWith(query));
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape')) { this.onCancel(); return; }
    const items = this.filteredItems();
    if (data === '\x1b[A' || matchesKey(data, 'up')) {
      this.selectedIndex = items.length ? (this.selectedIndex === 0 ? items.length - 1 : this.selectedIndex - 1) : 0;
      this.tui.requestRender();
      return;
    }
    if (data === '\x1b[B' || matchesKey(data, 'down')) {
      this.selectedIndex = items.length ? (this.selectedIndex === items.length - 1 ? 0 : this.selectedIndex + 1) : 0;
      this.tui.requestRender();
      return;
    }
    if (data === '\r' || matchesKey(data, 'enter') || data === '\t') {
      const selected = items[this.selectedIndex];
      if (selected) this.onPick(selected.value);
      return;
    }
    if (matchesKey(data, 'backspace')) {
      this.filter = this.filter.slice(0, -1);
      this.selectedIndex = 0;
      this.tui.requestRender();
      return;
    }
    if (data.length === 1 && data >= ' ') {
      this.filter += data === '/' ? '' : data;
      this.selectedIndex = 0;
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 2);
    const top = `${color.accent('╭')}${color.faint('─'.repeat(innerWidth))}${color.accent('╮')}`;
    const bottom = `${color.accent('╰')}${color.faint('─'.repeat(innerWidth))}${color.accent('╯')}`;
    const row = (content: string): string => `${color.accent('│')}${bgFill(content, innerWidth)}${color.accent('│')}`;
    const items = this.filteredItems();
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
      row(`  ${ansi.open(chatTheme().accent, `/${this.filter}`)}${ansi.open(chatTheme().faint, '  commands')}`),
      row(''),
      ...itemRows,
      ...counter,
      bottom,
    ];
  }
}
