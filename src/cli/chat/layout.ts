import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { Component, MarkdownTheme } from '@earendil-works/pi-tui';
import { framedDiffBlock, toolOutputBlock, UserBlock } from './components.js';
import { ansi, chatTheme, color, glyph } from './theme.js';
import type { BrainUsageView } from './brainClient.js';
import type { ChatView } from '../../brain/transcript.js';
import { formatK, padAnsi } from '../ui/text.js';

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

const ORCA_ART = [
  '█████ █████ █████  ███ ',
  '█   █ █   █ █     █   █',
  '█   █ ████  █     █████',
  '█   █ █  █  █     █   █',
  '█████ █   █ █████ █   █',
];

function toolTitle(name: string, detail?: string): string {
  const target = detail ? ` ${detail}` : '';
  if (/(edit|patch|update|modify|replace)/i.test(name)) return `Edit${target}`;
  if (/(write|create)/i.test(name)) return `Wrote${target}`;
  if (/(read|open|cat)/i.test(name)) return `Read${target}`;
  if (/(diff)/i.test(name)) return `Diff${target}`;
  return detail ? detail : name.replace(/[_-]+/g, ' ');
}

interface TranscriptRow {
  line: string;
  kind?: 'thought' | 'expandable';
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
      : truncateToWidth(` ${color.accent('Orca Chat')} ${color.faint('new conversation')} `, width, '…');
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
  private expandableRows = new Map<number, string>();
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

  toggleThought(absRow: number): void {
    const key = this.expandableRows.get(absRow - this.getTopRow() + 1);
    if (!key) return;
    const store = key.startsWith('tool:') ? this.expandedTools : this.expandedThoughts;
    if (store.has(key)) store.delete(key);
    else store.add(key);
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

    const start = Math.max(0, rows.length - height - this.scrollOffset);
    const visible = rows.slice(start, start + height);
    while (visible.length < height) visible.push({ line: '' });
    return visible.map((entry, i) => {
      if ((entry.kind === 'thought' || entry.kind === 'expandable') && entry.key) this.expandableRows.set(i + 1, entry.key);
      const content = i === 0 && this.scrollOffset > 0
        ? this.historyChip(entry.line, chatWidth - 2)
        : entry.line;
      return padAnsi(`${padAnsi(content, chatWidth - 2)} ${this.scrollbar(i, height, rows.length)}`, width);
    });
  }

  private renderTranscript(width: number): TranscriptRow[] {
    const rows: TranscriptRow[] = [{ line: '' }];
    const add = (line: string, kind?: TranscriptRow['kind'], key?: string): void => { rows.push(kind ? { line, kind, key } : { line }); };
    const addBlank = (): void => add('');
    if (this.state.view.turns.length === 0) {
      addBlank();
      for (const line of ORCA_ART) {
        const pad = Math.max(0, Math.floor((width - visibleWidth(line)) / 2));
        add(`${' '.repeat(pad)}${color.faint(line.slice(0, 12))}${color.text(line.slice(12))}`);
      }
      addBlank();
      const hint = color.faint('Ask anything. /help commands · shift+tab mode · ctrl+p telemetry');
      add(`${' '.repeat(Math.max(0, Math.floor((width - visibleWidth(hint)) / 2)))}${hint}`);
      addBlank();
    }
    for (const [turnIndex, turn] of this.state.view.turns.entries()) {
      if (turn.role === 'you') {
        for (const line of new UserBlock(turn.text).render(width)) add(line);
        addBlank();
        continue;
      }
      let hasText = false;
      for (const [segIndex, seg] of turn.segments.entries()) {
        if (seg.kind === 'tools') {
          for (const item of seg.items) {
            const keyBase = item.id ? `tool:${item.id}` : `tool:${turnIndex}:${segIndex}:${item.name}:${item.detail ?? ''}`;
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
            } else if (!item.diff) {
              // A shell/console tool that finished silently still shows its command on its own line.
              if (item.command) add(`  ${color.faint('$')} ${color.text(truncateToWidth(item.command, Math.max(12, width - 10), '…'))} ${color.faint('· done')}`);
              else add(`  ${color.success('●')} ${color.dim(toolTitle(item.name, item.detail))}`);
            }
          }
        } else if (seg.kind === 'reasoning') {
          const liveTail = turn.streaming && seg === turn.segments[turn.segments.length - 1];
          const first = seg.text.replace(/\s+/g, ' ').trim() || 'thinking';
          const label = liveTail ? `Thought: ${this.state.thinkingSeconds}s` : 'Thought';
          const key = `${turnIndex}:${segIndex}`;
          const expanded = this.expandedThoughts.has(key);
          // A blank line above each Thought keeps it from gluing onto the previous tool/output block.
          if (rows[rows.length - 1]?.line !== '') addBlank();
          add(`  ${color.warning(expanded ? '▾' : '▸')} ${color.warning(label)} ${color.faint('click')} ${color.dim(truncateToWidth(first, Math.max(12, width - 32), '…'))}`, 'thought', key);
          if (expanded) {
            for (const line of wrapTextWithAnsi(seg.text, Math.max(1, width - 6))) add(`    ${color.faint(line)}`);
          }
          addBlank();
        } else {
          hasText = true;
          for (const line of this.renderTextWithPlans(seg.text, width)) add(line);
        }
      }
      if (!hasText && turn.streaming) add(`  ${color.faint('…')}`);
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
  workMode: 'build' | 'plan';
  usage: BrainUsageView | null;
  running: boolean;
  runSeconds: number;
  cwd: string;
  branch: string;
}

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
      `  ${color.text(tokens)} ${color.faint('tokens')}`,
      `  ${this.contextBar(usage?.percent ?? 0, width)} ${color.faint(pct)} ${usage ? color.faint(`· $${usage.cost.toFixed(2)}`) : ''}`,
      '',
      `  ${color.bold(color.text('Project'))}`,
      `  ${color.text(truncateToWidth(st.cwd, Math.max(1, width - 4), '…'))}`,
      `  ${color.faint('branch')} ${color.accent(st.branch || 'unknown')}`,
      '',
      `  ${color.bold(color.text('Run'))}`,
      `  ${st.running ? color.success('●') : color.faint('○')} ${color.text(st.workMode === 'plan' ? 'Plan' : 'Build')} ${color.faint(st.running ? `${st.runSeconds}s` : 'idle')}`,
    ];
    return rows.map((r) => color.panelBg(padAnsi(r, width)));
  }

  private contextBar(percent: number, width: number): string {
    const cells = Math.max(12, Math.min(22, width - 16));
    const filled = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)));
    return `${color.accent('▰'.repeat(filled))}${color.faint('▱'.repeat(cells - filled))}`;
  }
}

function panelLogo(width: number): string[] {
  return ORCA_ART.map((line) => {
    const compact = line.replaceAll(' ', '');
    const text = visibleWidth(line) + 4 <= width ? line : compact;
    const pad = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
    return `${' '.repeat(pad)}${color.faint(text.slice(0, Math.floor(text.length / 2)))}${color.text(text.slice(Math.floor(text.length / 2)))}`;
  });
}

export interface SlashOverlayItem {
  value: string;
  label: string;
  description?: string;
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
