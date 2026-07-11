import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { MarkdownTheme } from '@earendil-works/pi-tui';
import type { ChatTurn, ToolItem } from '../../brain/transcript.js';
import { groupToolItems } from '../../brain/transcript.js';
import { formatDuration, formatK, padAnsi, terminalInlineText, terminalPlainText } from '../ui/text.js';
import { framedDiffBlock, spinnerFrame, toolOutputBlock, UserBlock } from './components.js';
import { chatTheme, color } from './theme.js';

export const TOOL_INDENT = '    ';
const TOOL_OUTPUT_INDENT = '      ';
const PROGRESS_TAIL_ROWS = 8;

export interface TranscriptRow {
  line: string;
  kind?: 'thought' | 'expandable' | 'subagent';
  key?: string;
  turnIndex?: number;
}

export interface TurnRenderOptions {
  showThoughts: boolean;
  thinkingSeconds: number;
  expandedThoughts: ReadonlySet<string>;
  expandedTools: ReadonlySet<string>;
}

function toolRowSpec(name: string, detail?: string): { glyph: string; title: string } {
  const safeName = terminalInlineText(name);
  const safeDetail = detail ? terminalInlineText(detail) : '';
  const title = (label: string): string => (safeDetail ? `${label} ${safeDetail}` : label);
  if (/(search|grep|glob)/i.test(safeName)) return { glyph: '✱', title: safeDetail ? `Search "${safeDetail}"` : 'Search' };
  if (/(edit|patch|update|modify|replace)/i.test(safeName)) return { glyph: '←', title: title('Edit') };
  if (/(write|create)/i.test(safeName)) return { glyph: '←', title: title('Write') };
  if (/(read|open|cat)/i.test(safeName)) return { glyph: '→', title: title('Read') };
  if (/list_dir/i.test(safeName)) return { glyph: '→', title: title('List') };
  if (/diff/i.test(safeName)) return { glyph: '←', title: title('Diff') };
  if (/(lsp|diagnostic)/i.test(safeName)) return { glyph: '✱', title: title('Diagnostics') };
  if (/(fetch|web|http|url)/i.test(safeName)) return { glyph: '%', title: title('Fetch') };
  return { glyph: '⚙', title: title(safeName.replace(/[_-]+/g, ' ')) };
}

const blockFill = (text: string, width: number): string =>
  `\x1b[${chatTheme().modalBg}m${padAnsi(text, width)}\x1b[0m`;

/** Stateless renderer for one transcript turn. Expansion sets remain viewport interaction state and are
 * supplied per call, keeping Markdown/tool projection independent from height indexing and scrolling. */
export class TurnRenderer {
  constructor(private readonly mdTheme: MarkdownTheme) {}

  render(turn: ChatTurn, turnIndex: number, width: number, options: TurnRenderOptions): TranscriptRow[] {
    const rows: TranscriptRow[] = [];
    const add = (line: string, kind?: TranscriptRow['kind'], key?: string): void => {
      rows.push(kind ? { line, kind, key, turnIndex } : { line });
    };
    const addBlank = (): void => add('');

    if (turn.role === 'you') {
      for (const line of new UserBlock(turn.text).render(width)) add(line);
      addBlank();
      return rows;
    }
    if (turn.role === 'divider') {
      add(`  ${color.faint('· · ·  context compacted  · · ·')}`);
      addBlank();
      return rows;
    }

    let hasText = false;
    const toolItems = turn.segments.flatMap((segment) => segment.kind === 'tools' ? segment.items : []);
    const lastToolItem = toolItems.at(-1);
    for (const [segmentIndex, segment] of turn.segments.entries()) {
      if (segment.kind === 'tools') {
        for (const group of groupToolItems(segment.items)) {
          const item = group.item;
          const key = item.id
            ? `tool:${item.id}`
            : `tool:${turnIndex}:${segmentIndex}:${item.name}:${item.detail ?? ''}`;
          if (item.sub) {
            for (const row of this.subagentBlock(item.sub, width)) add(row.line, row.kind, row.key);
          }
          if (item.diff) {
            for (const line of framedDiffBlock(item.diff, width, toolRowSpec(item.name, item.detail).title)) add(line);
          }
          if (item.output) {
            const before = rows.length;
            for (const line of toolOutputBlock(item.output, width, options.expandedTools.has(key))) add(line);
            if (item.output.fullText && item.output.fullText !== item.output.text) {
              for (let index = before; index < rows.length; index++) {
                rows[index] = { ...rows[index]!, kind: 'expandable', key, turnIndex };
              }
            }
          } else if (!item.diff && !item.sub) {
            if (item.command) {
              const command = terminalInlineText(item.command);
              add(`${TOOL_INDENT}${color.faint('$')} ${color.dim(truncateToWidth(command, Math.max(12, width - 12), '…'))} ${color.faint(turn.streaming && item === lastToolItem ? '· running…' : '· done')}`);
              if (item.progress) {
                for (const line of terminalPlainText(item.progress).split('\n').slice(-PROGRESS_TAIL_ROWS)) {
                  add(`${TOOL_OUTPUT_INDENT}${color.faint(truncateToWidth(line, Math.max(12, width - 14), '…'))}`);
                }
              }
            } else {
              const spec = toolRowSpec(item.name, item.detail);
              const suffix = group.count > 1 ? ` ${color.faint(`×${group.count}`)}` : '';
              add(`${TOOL_INDENT}${color.faint(spec.glyph)} ${color.dim(truncateToWidth(spec.title, Math.max(12, width - 10), '…'))}${suffix}`);
            }
          }
        }
        continue;
      }

      if (segment.kind === 'reasoning') {
        if (!options.showThoughts) continue;
        const liveTail = turn.streaming && segment === turn.segments.at(-1);
        const reasoning = terminalPlainText(segment.text);
        const first = terminalInlineText(reasoning) || 'thinking';
        const label = liveTail ? `Thought: ${formatDuration(options.thinkingSeconds)}` : 'Thought';
        const key = `${turnIndex}:${segmentIndex}`;
        const expanded = options.expandedThoughts.has(key);
        if (rows.length > 0 && rows.at(-1)?.line !== '') addBlank();
        add(`  ${color.warning(expanded ? '▾' : '▸')} ${color.warning(label)} ${color.faint('click')} ${color.dim(truncateToWidth(first, Math.max(12, width - 32), '…'))}`, 'thought', key);
        if (expanded) {
          for (const line of wrapTextWithAnsi(reasoning, Math.max(1, width - 6))) add(`    ${color.faint(line)}`);
        }
        addBlank();
        continue;
      }

      hasText = true;
      if (segmentIndex > 0 && rows.length > 0 && rows.at(-1)?.line !== '') addBlank();
      for (const line of this.renderTextWithPlans(segment.text, width)) add(line);
    }
    if (!hasText && turn.streaming) add(`  ${color.faint('…')}`);
    addBlank();
    return rows;
  }

  private subagentBlock(subagent: NonNullable<ToolItem['sub']>, width: number): TranscriptRow[] {
    const glyph = subagent.status === 'running'
      ? color.accent(spinnerFrame())
      : subagent.status === 'done' ? color.success('✓') : color.error('✗');
    const task = truncateToWidth(terminalInlineText(subagent.task), Math.max(12, width - 26), '…');
    const tokens = subagent.tokens ? `${formatK(subagent.tokens)} tok` : '';
    const detail = subagent.status === 'running'
      ? [subagent.detail ?? 'starting…', subagent.model, formatDuration(subagent.seconds), tokens]
      : [`${subagent.tools} tool${subagent.tools === 1 ? '' : 's'}`, subagent.model, formatDuration(subagent.seconds), tokens];
    const meta = detail.filter(Boolean).map((value) => terminalInlineText(String(value))).join(' · ');
    return [
      { line: '' },
      { line: `  ${glyph} ${color.text('Sub-agent')} ${color.faint('click')} ${color.dim(task)}`, kind: 'subagent', key: subagent.sessionId },
      { line: `    ${color.faint(truncateToWidth(`↳ ${meta}`, Math.max(12, width - 6), '…'))}`, kind: 'subagent', key: subagent.sessionId },
    ];
  }

  private renderTextWithPlans(text: string, width: number): string[] {
    text = terminalPlainText(text);
    const rows: string[] = [];
    const plan = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/gi;
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = plan.exec(text))) {
      const before = text.slice(last, match.index);
      if (before.trim()) rows.push(...new Markdown(before, 2, 0, this.mdTheme).render(width));
      rows.push(...this.planBlock(match[1] ?? '', width));
      last = match.index + match[0].length;
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
    const inner = Math.max(12, Math.max(28, width) - 6);
    const border = color.faint;
    const title = ` ${color.bold(color.text('Proposed plan'))} ${color.faint('ready to implement')} `;
    const rule = Math.max(0, inner - visibleWidth(title));
    const row = (content: string): string => {
      const clipped = truncateToWidth(content, inner, '…');
      return `  ${border('│')}${blockFill(padAnsi(clipped, inner), inner)}${border('│')}`;
    };
    const body = new Markdown(markdown.trim(), 0, 0, this.mdTheme).render(inner);
    return [
      `  ${border('╭')}${border('─'.repeat(rule))}${title}${border('╮')}`,
      ...body.map(row),
      `  ${border('╰')}${border('─'.repeat(inner))}${border('╯')}`,
    ];
  }
}
