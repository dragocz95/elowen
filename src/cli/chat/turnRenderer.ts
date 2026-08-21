import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { MarkdownTheme } from '@earendil-works/pi-tui';
import type { ChatTurn, ToolItem } from '../../brain/transcript.js';
import { groupToolItems, failureSignature, submittedPlanOf } from '../../brain/transcript.js';
import { formatDuration, formatK, padAnsi, terminalInlineText, terminalPlainText } from '../ui/text.js';
import { toolGlyph } from '../../shared/toolGlyph.js';
import { framedDiffBlock, toolOutputBlock, UserBlock, workflowCounts, workflowTitle } from './components.js';
import { ensureLang, langForPath } from './codeHighlight.js';
import { color, modalRow } from './theme.js';
import { prettyCwd } from './projectDir.js';
import { activeKeymap } from './keys.js';
import { composingLabel, type ComposeLocale } from './composeLabels.js';
import { settledTurnMeta } from './composeLines.js';

export const TOOL_INDENT = '    ';
const TOOL_OUTPUT_INDENT = '      ';
const PROGRESS_TAIL_ROWS = 8;
/** Braille spinner cycled while the model is authoring a tool call; the frame loop re-renders ~4×/s, which
 *  the caller-supplied `spinnerFrame` advances one step per render. */
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** The one line that identifies a failed tool result. Its own `status` ("needs attention") is dropped: the
 *  collapsed row already says Error, and repeating it would spend the only line we have on nothing. */
function errorHeadline(output: NonNullable<ToolItem['output']>): string {
  const first = terminalInlineText(output.text ?? '').trim().replace(/^Error:\s*/i, '');
  return first || output.status || 'failed';
}

export interface TranscriptRow {
  line: string;
  kind?: 'thought' | 'expandable' | 'subagent' | 'workflow';
  key?: string;
  turnIndex?: number;
}

export interface TurnRenderOptions {
  showThoughts: boolean;
  thinkingSeconds: number;
  /** The frame loop has decided the authoring window stalled long enough to surface the hint. */
  composingMarkerReady: boolean;
  /** Monotonic frame counter driving the composing spinner; the renderer stays pure by taking it as input. */
  spinnerFrame: number;
  /** Locale for the localized composing-tool action label. Defaults to English when omitted. */
  locale?: ComposeLocale;
  expandedThoughts: ReadonlySet<string>;
  expandedTools: ReadonlySet<string>;
}

/** The connector every SHOWN-OUTPUT tool leads with — a diff block, an output block, or a silent command
 *  row. One arrow across all of them (the tool name carries identity); tools we DON'T expand keep their
 *  per-tool marker glyph instead. This is the split the user asked for: output → arrow, no output → icon. */
const SHOWN_OUTPUT_CONNECTOR = '←';

export function toolRowSpec(name: string, detail?: string): { glyph: string; title: string } {
  const safeName = terminalInlineText(name);
  const safeDetail = detail ? terminalInlineText(detail) : '';
  // Title is the tool's literal name (+ detail); only the glyph is inferred from the name (a monochrome
  // direction hint). Substring labels used to misname tools — `CreateSkill`/`TodoWrite` read as a file
  // "Write" — so the real name is shown verbatim; a search detail is the query, hence quoted.
  const isSearch = /(search|grep|glob)/i.test(safeName);
  const title = !safeDetail ? safeName : isSearch ? `${safeName} "${safeDetail}"` : `${safeName} ${safeDetail}`;
  // The marker itself is shared with the web (src/shared/toolGlyph.ts) so the two surfaces agree; only the
  // title is terminal-specific. LSP's ⚙ shows on its compact marker row (empty result); the usual case —
  // a result block — leads with the shared ← connector like every other shown-output tool.
  return { glyph: toolGlyph(safeName), title };
}

/** A sub-agent finish marker's detail is small JSON (see recordSubagentFinishMarker). Parse defensively:
 *  a malformed row falls back to the raw string rather than throwing on a render path. */
function parseSubagentMarker(detail: string): { task: string; status: string } | null {
  try {
    const raw: unknown = JSON.parse(detail);
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    if (typeof obj.status !== 'string') return null;
    return { task: typeof obj.task === 'string' ? obj.task : '', status: obj.status };
  } catch { return null; }
}

/** A workflow finish marker's detail is small JSON (see recordWorkflowFinishMarker). Parse defensively,
 *  like parseSubagentMarker: a malformed row falls back to the raw string on a render path. */
function parseWorkflowMarker(detail: string): { title: string; status: string; ran: number; total: number } | null {
  try {
    const raw: unknown = JSON.parse(detail);
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    if (typeof obj.status !== 'string' || typeof obj.ran !== 'number' || typeof obj.total !== 'number') return null;
    return { title: typeof obj.title === 'string' ? obj.title : '', status: obj.status, ran: obj.ran, total: obj.total };
  } catch { return null; }
}

/** One-line description of a session-change marker (model/mode/rename/reasoning/cwd/subagent), rendered as
 *  a faint centered-ish row in the transcript. The verb varies by kind; the detail is the new value. */
function sessionEventLabel(kind: string, detail: string): string {
  const value = terminalInlineText(detail);
  switch (kind) {
    case 'model': return `model → ${value}`;
    case 'mode': return `mode → ${value}`;
    case 'rename': return `renamed → "${value}"`;
    case 'reasoning': return `reasoning → ${value}`;
    // The daemon stores the resolved absolute path; shorten it the same way the status row does, so the
    // marker and the chip below it never disagree about where the conversation is.
    case 'cwd': return `cwd → ${prettyCwd(value)}`;
    case 'subagent': {
      const marker = parseSubagentMarker(detail);
      if (!marker) return value;
      const verb = marker.status === 'error' ? 'sub-agent failed' : 'sub-agent done';
      const task = terminalInlineText(marker.task);
      return task ? `${verb} · ${task}` : verb;
    }
    case 'workflow': {
      const marker = parseWorkflowMarker(detail);
      if (!marker) return value;
      const verb = marker.status === 'error' ? 'workflow failed'
        : marker.status === 'cancelled' ? 'workflow stopped' : 'workflow done';
      const title = terminalInlineText(marker.title);
      const tally = `${marker.ran}/${marker.total} nodes`;
      return title ? `${verb} · ${title} · ${tally}` : `${verb} · ${tally}`;
    }
    default: return value;
  }
}

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
    if (turn.role === 'event') {
      // Styled exactly like a bare tool row (same indent, faint glyph + dim text): both are the machine
      // annotating what it did, so they read as one visual language rather than two. The run stacks with
      // no gaps and closes with the single blank every turn ends with — the tool-row rhythm.
      for (const event of turn.events) {
        add(`${TOOL_INDENT}${color.faint('⚙')} ${color.dim(sessionEventLabel(event.kind, event.detail))}`);
      }
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
          if (item.wf) {
            for (const row of this.workflowBlock(item.wf, width)) add(row.line, row.kind, row.key);
          }
          // A submitted plan renders as the panel INSTEAD of a tool row: the call carries no argument
          // worth a line, and the plan is the whole content of the marker.
          const plan = submittedPlanOf(item);
          if (plan) {
            if (rows.length > 0 && rows.at(-1)?.line !== '') addBlank();
            for (const line of this.planBlock(plan, width)) add(line);
          }
          if (item.diff) {
            const diffKey = `${key}:diff`;
            // The file path in the tool detail picks the grammar (unknown extension → plain colors);
            // ensureLang kicks the async grammar load so the NEXT render highlights this language.
            const diffLang = langForPath(item.detail);
            if (diffLang) ensureLang(diffLang);
            const { lines: block, expandable } = framedDiffBlock(
              item.diff, width, toolRowSpec(item.name, item.detail).title,
              options.expandedTools.has(diffKey), diffLang, SHOWN_OUTPUT_CONNECTOR,
            );
            for (const [index, line] of block.entries()) {
              const toggle = expandable && index === block.length - 1;
              add(line, toggle ? 'expandable' : undefined, toggle ? diffKey : undefined);
            }
          }
          if (item.output && failureSignature(item)) {
            // A failed tool result is a headline, not a document: four framed blocks saying the same thing
            // about four different files pushed the actual work off the screen. Collapse each to one line —
            // the same ▸/click affordance a thought already uses — and fold a repeated refusal into a single
            // counted row. The full text is one click away, which is where a message you have already
            // understood belongs.
            const members = group.members ?? [item];
            const expanded = options.expandedTools.has(key);
            const label = members.length > 1 ? `${members.length}× Error` : 'Error';
            const summary = truncateToWidth(errorHeadline(item.output), Math.max(12, width - 36), '…');
            // The error headline sits in the tool column (TOOL_INDENT), so it aligns with the sibling tool
            // rows it belongs to rather than the shallower thought/prose gutter.
            add(
              `${TOOL_INDENT}${color.warning(expanded ? '▾' : '▸')} ${color.warning(label)} ${color.faint('click')}`
                + (expanded ? '' : `  ${color.dim(summary)}`),
              'expandable', key,
            );
            if (expanded && members.length > 1) {
              for (const member of members) {
                const line = truncateToWidth(errorHeadline(member.output!), Math.max(12, width - 12), '…');
                add(`${TOOL_OUTPUT_INDENT}${color.faint('·')} ${color.dim(line)}`);
              }
              addBlank();
            } else if (expanded) {
              // Wrapped, not framed: the framed block clips a long line at the box edge, so "expand" would
              // still hide the end of the very sentence the user opened it to read.
              const full = terminalPlainText(item.output.fullText ?? item.output.text ?? '');
              for (const line of wrapTextWithAnsi(full, Math.max(12, width - 8))) add(`${TOOL_OUTPUT_INDENT}${color.dim(line)}`);
              addBlank();
            }
          } else if (item.output) {
            const before = rows.length;
            // Header the output block with the tool's own name, like the diff block — the unified look for
            // every shown-output tool. Console tools pass the name ONLY: their `$ command` echo already
            // carries the detail, so folding it into the header too would just repeat it.
            const outHeading = item.output.kind === 'console'
              ? toolRowSpec(item.name).title
              : toolRowSpec(item.name, item.detail).title;
            for (const line of toolOutputBlock(item.output, width, options.expandedTools.has(key), outHeading, SHOWN_OUTPUT_CONNECTOR)) add(line);
            if (item.output.fullText && item.output.fullText !== item.output.text) {
              for (let index = before; index < rows.length; index++) {
                rows[index] = { ...rows[index]!, kind: 'expandable', key, turnIndex };
              }
            }
          } else if (!item.diff && !item.sub && !item.wf && !plan) {
            if (item.command) {
              const command = terminalInlineText(item.command);
              // A silent shell command is shown-output work, so it leads with the same arrow as the blocks —
              // then its `$ cmd · done` shell affordance follows.
              add(`${TOOL_INDENT}${color.faint(SHOWN_OUTPUT_CONNECTOR)} ${color.faint('$')} ${color.dim(truncateToWidth(command, Math.max(12, width - 14), '…'))} ${color.faint(turn.streaming && item === lastToolItem ? '· running…' : '· done')}`);
              if (item.progress) {
                // Shell output is CONTENT, not decoration, so it takes the dim (muted) tier rather than
                // faint — a readable contrast for the machine's actual words, not a background whisper.
                for (const line of terminalPlainText(item.progress).split('\n').slice(-PROGRESS_TAIL_ROWS)) {
                  add(`${TOOL_OUTPUT_INDENT}${color.dim(truncateToWidth(line, Math.max(12, width - 14), '…'))}`);
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
          // The expanded reasoning body is CONTENT the user chose to read — dim (muted), not faint, so it
          // clears the same readability bar as the shell output above rather than fading into the panel.
          for (const line of wrapTextWithAnsi(reasoning, Math.max(1, width - 6))) add(`    ${color.dim(line)}`);
        }
        addBlank();
        continue;
      }

      hasText = true;
      if (segmentIndex > 0 && rows.length > 0 && rows.at(-1)?.line !== '') addBlank();
      for (const line of new Markdown(terminalPlainText(segment.text), 2, 0, this.mdTheme).render(width)) add(line);
    }
    // While the model is writing a tool call whose marker hasn't rendered yet, the transcript would
    // otherwise sit frozen (the text is done, the tool row not started). Only surface it once the window
    // has stalled past the threshold (`composingMarkerReady`) — quick tool calls stay silent so the hint
    // reads as "something is taking a while", not as noise on every call. The row lives in the tool column
    // with a spinner and the real tool name (known before its arguments finish); when the tool starts
    // executing this hint gives way to the full tool row (with its detail). If the name is not yet known it
    // falls back to a neutral label.
    if (turn.streaming && turn.composing && options.composingMarkerReady) {
      const spin = SPINNER[((options.spinnerFrame % SPINNER.length) + SPINNER.length) % SPINNER.length]!;
      // The model's own streamed `reason` (in the user's language) wins; else a long-duration tool upgrades
      // the generic hint to a localized action label with its salient argument; else the tool title / a
      // neutral 'working'.
      const label = composingLabel(turn.composingReason, turn.composingTool, turn.composingDetail, options.locale ?? 'en')
        ?? (turn.composingTool ? toolRowSpec(turn.composingTool).title : 'working');
      // A slow, low-amplitude pulse (muted ↔ fainter, one step per ~2 frames) reads the label as LIVE
      // without touching the spinner. It rides the tail turn's existing ~4fps repaint, so it costs nothing.
      const pulse = Math.floor(options.spinnerFrame / 2) % 2 === 0 ? color.dim : color.faint;
      add(`${TOOL_INDENT}${color.warning(spin)} ${pulse(truncateToWidth(label, Math.max(12, width - 10), '…'))}`);
    } else if (!hasText && toolItems.length === 0 && turn.streaming) {
      // A wholly empty streaming step still needs a pulse of life. Once a real tool row exists, this marker
      // says nothing and became the stray per-step filler the owner saw between consecutive tool-only calls.
      add(`  ${color.faint('…')}`);
    }
    if (!turn.streaming && turn.durationMs != null) {
      // One blank row separates settled metadata from content. Two made quick answers look detached; one is
      // enough to read as metadata while the single trailing blank below remains the next turn's separator.
      if (rows.length > 0 && rows.at(-1)?.line !== '') addBlank();
      add(`  ${settledTurnMeta(turn.durationMs)}`);
    }
    if (!turn.joinNextToolOnly || turn.durationMs != null) addBlank();
    return rows;
  }

  private subagentBlock(subagent: NonNullable<ToolItem['sub']>, width: number): TranscriptRow[] {
    const glyph = subagent.status === 'running'
      ? color.warning('●')
      : subagent.status === 'done' ? color.success('✓') : color.error('✗');
    const task = truncateToWidth(terminalInlineText(subagent.task), Math.max(12, width - 26), '…');
    const tokens = subagent.tokens ? `${formatK(subagent.tokens)} tok` : '';
    const detail = subagent.status === 'running'
      ? [subagent.detail ?? 'starting…', subagent.model, formatDuration(subagent.seconds), tokens]
      : [`${subagent.tools} tool${subagent.tools === 1 ? '' : 's'}`, subagent.model, formatDuration(subagent.seconds), tokens];
    const meta = detail.filter(Boolean).map((value) => terminalInlineText(String(value))).join(' · ');
    // A foreground sub-agent blocks the parent's tool result until it finishes; Ctrl+B detaches it so the
    // parent continues and the child's result is delivered back asynchronously. The footer already carries
    // this hint, but not next to the block it acts on — so surface it on the meta row, only while it can
    // actually be done (running and not already backgrounded). The chord is read live so a rebind stays
    // truthful; if it is unbound the whole segment drops.
    const bgChord = subagent.status === 'running' && !subagent.background
      ? activeKeymap().chordLabel('subagent_background') : null;
    const hint = bgChord ? ` · ${bgChord} background` : '';
    // Budget the hint into the truncation so a long task never wraps the meta row past the terminal edge:
    // the chord label drops first, then the meta text itself ellipsizes into whatever remains.
    const metaLine = truncateToWidth(`↳ ${meta}`, Math.max(12, width - 6 - visibleWidth(hint)), '…');
    return [
      { line: '' },
      { line: `  ${glyph} ${color.text('Sub-agent')} ${color.faint('click')} ${color.dim(task)}`, kind: 'subagent', key: subagent.sessionId },
      { line: `    ${color.faint(metaLine)}${hint ? color.faint(hint) : ''}`, kind: 'subagent', key: subagent.sessionId },
    ];
  }

  /** The transcript marker for a WorkflowStart call — the sub-agent block's twin, and the durable way
   *  back into a workflow: the telemetry rail only carries RUNNING ones, so once a DAG finishes this row
   *  is the only thing that can still open its modal. Clicking anywhere on it drills in by workflow id. */
  private workflowBlock(wf: NonNullable<ToolItem['wf']>, width: number): TranscriptRow[] {
    const glyph = wf.status === 'running'
      ? color.warning('⛓')
      : wf.status === 'done' ? color.success('⛓') : color.error('⛓');
    const counts = workflowCounts(wf);
    const title = terminalInlineText(workflowTitle(wf));
    const tally = [
      color.success(`${counts.done}✓`),
      color.warning(`${counts.running}●`),
      color.faint(`${counts.pending}⏸`),
      ...(counts.error ? [color.error(`${counts.error}✗`)] : []),
    ].join(' ');
    const meta = [tally, counts.tokens ? color.faint(`${formatK(counts.tokens)} tok`) : ''].filter(Boolean).join('  ');
    return [
      { line: '' },
      {
        line: `  ${glyph} ${color.text('Workflow')} ${color.faint('click')} ${color.dim(truncateToWidth(title, Math.max(12, width - 30), '…'))}`,
        kind: 'workflow', key: wf.id,
      },
      { line: `    ${color.faint('↳')} ${meta}`, kind: 'workflow', key: wf.id },
    ];
  }

  /** The framed panel a submitted plan renders as — raised by an `ExitPlanMode` call, never by prose. */
  private planBlock(markdown: string, width: number): string[] {
    // Clamped DOWN from the terminal width, never up to a minimum: `max(28, width)` made the frame wider
    // than the screen below ~32 columns, so the borders wrapped and the panel came apart. The sibling
    // blocks all clamp the same direction.
    const inner = Math.max(12, width - 4);
    const border = color.faint;
    // The title is clipped too, or on a very narrow terminal the header alone outgrows the frame it is
    // supposed to sit in — the rule going to zero only stops the padding, not the text.
    const title = truncateToWidth(` ${color.bold(color.text('Proposed plan'))} ${color.faint('ready to implement')} `, inner, '…');
    const rule = Math.max(0, inner - visibleWidth(title));
    const row = (content: string): string => {
      const clipped = truncateToWidth(content, inner, '…');
      return `  ${border('│')}${modalRow(padAnsi(clipped, inner), inner)}${border('│')}`;
    };
    const body = new Markdown(markdown.trim(), 0, 0, this.mdTheme).render(inner);
    return [
      `  ${border('╭')}${border('─'.repeat(rule))}${title}${border('╮')}`,
      ...body.map(row),
      `  ${border('╰')}${border('─'.repeat(inner))}${border('╯')}`,
    ];
  }
}
