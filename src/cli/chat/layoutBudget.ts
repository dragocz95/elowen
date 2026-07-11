import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

const RECOMMENDED_TUI_COLUMNS = 32;
const RECOMMENDED_TUI_ROWS = 12;
const TELEMETRY_MIN_COLUMNS = 36;
const TELEMETRY_DEFAULT_COLUMNS = 46;
const TELEMETRY_GUTTER_COLUMNS = 3;

interface LayoutSectionRows {
  header: number;
  transcript: number;
  cards: number;
  subagents: number;
  queue: number;
  attachments: number;
  editor: number;
  status: number;
  hints: number;
}

export interface LayoutBudgetInput {
  columns: number;
  rows: number;
  hasTranscript: boolean;
  telemetryRequested: boolean;
  /** A blocking ask/approval dock owns the composer. It may borrow transcript/panel rows and must not be
   * clipped to the ordinary multiline-editor cap. */
  editorPriority?: boolean;
  /** User explicitly opened a clipped Todo "+N more" link. The card may borrow transcript rows while
   * the editor/status remain protected. */
  cardsPriority?: boolean;
  desired: {
    editor: number;
    queue: number;
    attachments: number;
    cards: number;
    subagents: number;
  };
  telemetryColumns?: number;
}

export interface LayoutBudget {
  compactFallback: boolean;
  terminalColumns: number;
  terminalRows: number;
  chatColumns: number;
  telemetryColumns: number;
  telemetryGutter: number;
  sections: LayoutSectionRows;
  rootRows: number;
}

/** Final root invariant: truncate ANSI-aware lines, discard overflow rows, and pad the working area to a
 * stable full-screen frame. Keeping this at the root protects pi-tui's diff renderer from any future child
 * component that accidentally returns an oversized line or a changing total height. */
export function constrainFrame(lines: string[], columns: number, terminalRows: number): string[] {
  const width = Math.max(0, Math.floor(columns));
  const height = Math.max(0, Math.floor(terminalRows));
  const frame = lines.slice(0, height).map((line) => {
    const clipped = truncateToWidth(line, width, '');
    return clipped + ' '.repeat(Math.max(0, width - visibleWidth(clipped)));
  });
  while (frame.length < height) frame.push(' '.repeat(width));
  return frame;
}

const rows = (value: number, cap = Number.POSITIVE_INFINITY): number =>
  Math.min(cap, Math.max(0, Math.floor(Number.isFinite(value) ? value : 0)));

function horizontalBudget(input: LayoutBudgetInput, columns: number): Pick<LayoutBudget, 'chatColumns' | 'telemetryColumns' | 'telemetryGutter'> {
  if (!input.telemetryRequested || !input.hasTranscript || columns < 104) {
    return { chatColumns: columns, telemetryColumns: 0, telemetryGutter: 0 };
  }
  const wanted = rows(input.telemetryColumns ?? TELEMETRY_DEFAULT_COLUMNS, 68);
  const panel = Math.min(Math.max(TELEMETRY_MIN_COLUMNS, wanted), Math.max(0, columns - RECOMMENDED_TUI_COLUMNS - TELEMETRY_GUTTER_COLUMNS));
  if (panel < TELEMETRY_MIN_COLUMNS) return { chatColumns: columns, telemetryColumns: 0, telemetryGutter: 0 };
  return {
    chatColumns: columns - panel - TELEMETRY_GUTTER_COLUMNS,
    telemetryColumns: panel,
    telemetryGutter: TELEMETRY_GUTTER_COLUMNS,
  };
}

/** Allocate every root section once. The allocator starts from the useful full presentation and, when
 * space is short, reduces it in the UI's declared order: multiline editor, queue, expanded cards/agents,
 * hints, then non-essential fixed rows. Whatever remains is the transcript viewport. */
export function computeLayoutBudget(input: LayoutBudgetInput): LayoutBudget {
  const terminalColumns = rows(input.columns);
  const terminalRows = rows(input.rows);
  const horizontal = horizontalBudget(input, terminalColumns);
  const compactFallback = terminalColumns < RECOMMENDED_TUI_COLUMNS || terminalRows < RECOMMENDED_TUI_ROWS;

  if (terminalRows === 0) {
    return {
      compactFallback: true,
      terminalColumns,
      terminalRows,
      ...horizontal,
      sections: { header: 0, transcript: 0, cards: 0, subagents: 0, queue: 0, attachments: 0, editor: 0, status: 0, hints: 0 },
      rootRows: 0,
    };
  }

  if (compactFallback) {
    const header = terminalRows >= 2 ? 1 : 0;
    const status = terminalRows >= 1 ? 1 : 0;
    const editorCap = input.editorPriority ? Math.max(0, terminalRows - header - status) : 3;
    const editor = Math.min(rows(input.desired.editor), Math.max(0, terminalRows - header - status), editorCap);
    const transcript = Math.max(0, terminalRows - header - status - editor);
    const sections: LayoutSectionRows = {
      header, transcript, cards: 0, subagents: 0, queue: 0, attachments: 0,
      editor, status, hints: 0,
    };
    return {
      compactFallback: true,
      terminalColumns,
      terminalRows,
      chatColumns: terminalColumns,
      telemetryColumns: 0,
      telemetryGutter: 0,
      sections,
      rootRows: Object.values(sections).reduce((sum, value) => sum + value, 0),
    };
  }

  const sections: LayoutSectionRows = {
    header: terminalRows > 0 ? 1 : 0,
    transcript: 0,
    cards: input.editorPriority ? 0 : rows(input.desired.cards, input.cardsPriority ? terminalRows : 6),
    subagents: input.editorPriority || input.cardsPriority ? 0 : rows(input.desired.subagents, 4),
    queue: input.editorPriority ? 0 : rows(input.desired.queue, 4),
    attachments: input.editorPriority ? 0 : (input.desired.attachments > 0 ? 1 : 0),
    // Ordinary composer: at most six content rows plus PI Editor's two horizontal rules.
    editor: rows(input.desired.editor, input.editorPriority ? Math.max(1, terminalRows - 3) : 8),
    status: terminalRows > 1 ? 1 : 0,
    hints: input.editorPriority || input.cardsPriority ? 0 : (terminalRows >= RECOMMENDED_TUI_ROWS ? 1 : 0),
  };
  const targetTranscript = input.hasTranscript ? Math.min(4, Math.max(1, terminalRows - sections.header - sections.status - 1)) : 0;
  const fixed = (): number => Object.entries(sections)
    .filter(([name]) => name !== 'transcript')
    .reduce((sum, [, value]) => sum + value, 0);
  let overflow = Math.max(0, fixed() + targetTranscript - terminalRows);
  const reduce = (name: Exclude<keyof LayoutSectionRows, 'header' | 'transcript' | 'status'>, minimum: number): void => {
    if (overflow <= 0) return;
    const available = Math.max(0, sections[name] - minimum);
    const amount = Math.min(available, overflow);
    sections[name] -= amount;
    overflow -= amount;
  };

  if (!input.editorPriority) reduce('editor', Math.min(sections.editor, 3));
  reduce('queue', Math.min(sections.queue, 1));
  if (overflow > 0 && !input.cardsPriority) {
    // Cards and sub-agents are one visual tier. Collapse both together so one expanded panel cannot use
    // the rows freed by collapsing its sibling and leave the bottom stack visually lopsided.
    sections.cards = Math.min(sections.cards, 1);
    sections.subagents = Math.min(sections.subagents, 1);
    overflow = Math.max(0, fixed() + targetTranscript - terminalRows);
  }
  reduce('hints', 0);
  reduce('queue', 0);
  if (!input.cardsPriority) reduce('cards', 0);
  reduce('subagents', 0);
  reduce('attachments', 0);
  reduce('cards', input.cardsPriority ? Math.min(sections.cards, 1) : 0);
  reduce('editor', Math.min(sections.editor, 1));

  sections.transcript = Math.max(0, terminalRows - fixed());
  const rootRows = Object.values(sections).reduce((sum, value) => sum + value, 0);
  return { compactFallback, terminalColumns, terminalRows, ...horizontal, sections, rootRows };
}
