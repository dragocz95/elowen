import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { Component, Editor, Focusable, TUI } from '@earendil-works/pi-tui';
import { isDownKey, isEnterKey, isEscapeKey, isKeyRelease, isPageDownKey, isPageUpKey, isUpKey } from './keys.js';
import { ansi, paintRow } from './theme.js';
import { formatDuration, formatK, padAnsi, terminalInlineText } from '../ui/text.js';
import type { WorkflowState, WorkflowNode } from '../../brain/transcript.js';

// A fixed, theme-independent palette: the workflow modal is deliberately its own surface — pure OLED
// black under white text — so a DAG reads as a separate plane from the themed chat behind it. This
// cannot go through `color.*`/`chatTheme()`, whose helpers resolve the active theme at CALL time: a
// /theme switch would drag the modal's palette along with it. Same reason, and the same shape, as the
// diff block's fixed GitHub green/red (see components.ts).
const OLED_BG = ansi.bg(0, 0, 0);
const WHITE = ansi.fg(255, 255, 255);
const GREY = ansi.fg(158, 158, 158);
const FAINT = ansi.fg(88, 88, 88);
const RUNNING = ansi.fg(255, 184, 0);
const DONE = ansi.fg(80, 220, 130);
const FAILED = ansi.fg(255, 95, 110);
/** Selection inverts to white-on-black. NOT `color.selected`, which hardcodes a black foreground on the
 *  theme's accent — on an OLED surface that fights the palette instead of reading as a highlight. */
const SELECTED = `${ansi.bg(255, 255, 255)};${ansi.fg(0, 0, 0)};1`;

const W = (t: string): string => ansi.sgr(WHITE, t);
const G = (t: string): string => ansi.sgr(GREY, t);
const F = (t: string): string => ansi.sgr(FAINT, t);
const BOLD = (t: string): string => `\x1b[1m${t}\x1b[22m`;
const ROW = (t: string, width: number): string => paintRow(OLED_BG, t, width);
/** Invert a row as ONE unit. Its text must arrive PLAIN: SGR has no stack, so any colour escape inside
 *  would reset the inversion mid-row — and paintRow only re-arms the BACKGROUND, not the foreground.
 *  That is the bug this replaces: the old selected row wrapped text that already carried a status
 *  glyph's own reset, so the highlight died one character in and looked like an unselected row. */
const SEL = (t: string): string => ansi.sgr(SELECTED, t);

const GLYPH: Record<WorkflowNode['status'], string> = { running: '●', done: '✓', error: '✗', pending: '⏸' };
const STATUS_INK: Record<WorkflowNode['status'], (t: string) => string> = {
  running: (t) => ansi.sgr(RUNNING, t),
  done: (t) => ansi.sgr(DONE, t),
  error: (t) => ansi.sgr(FAILED, t),
  pending: F,
};
/** Identity on the selected row (which SEL inverts whole), the real ink everywhere else. */
const ink = (selected: boolean, paint: (t: string) => string) =>
  (t: string): string => (selected ? t : paint(t));

/** Fit text to exactly `width` columns. The explicit '…' is load-bearing: padAnsi's own overflow branch
 *  calls truncateToWidth WITHOUT an ellipsis argument, so it would render ASCII "..." here while every
 *  other string in the modal elides with '…'. Truncate first, then pad. */
const fit = (text: string, width: number): string =>
  padAnsi(truncateToWidth(text, Math.max(0, width), '…'), Math.max(0, width));

const GUTTER = 3;        // ' │ '
const MIN_LIST = 26;
const MIN_DETAIL = 30;
const MIN_TWO_COL = MIN_LIST + GUTTER + MIN_DETAIL;
const CHROME_ROWS = 6;   // title, blank, column header, rule, blank, footer

/** One source of truth for the modal's geometry. maxHeight used to be hardcoded at the call site and
 *  never reached render(), so the list's capacity and the real row budget disagreed and a long DAG
 *  silently lost its bottom rows. Both sides now compute from the same terminal. */
function modalGeometry(terminal: { columns: number; rows: number }): { width: number; maxHeight: number } {
  return {
    width: Math.max(64, Math.min(110, Math.floor(terminal.columns * 0.9))),
    maxHeight: Math.max(12, Math.min(30, terminal.rows - 4)), // margin: 2 top + bottom
  };
}

/** A node placed in the dependency tree: its row prefix is the branch art leading to it. */
interface TreeRow { node: WorkflowNode; branch: string; extraDeps: string[] }

/** Lay the DAG out as a tree so the list SHOWS what depends on what instead of only saying it.
 *
 *  A DAG is not a tree: a node may depend on several others, and only one of them can hold it in an
 *  indented list. Each node therefore hangs under its FIRST dependency, and any others are reported as
 *  `extraDeps` — the shape stays readable and the full truth still shows in the detail column, rather
 *  than the layout quietly implying a node has one parent when it has three.
 *
 *  Total by construction: nodes are emitted at most once (`seen`), and anything the walk cannot reach —
 *  a dangling dependency, or a cycle the engine should have rejected — is emitted as its own root rather
 *  than silently vanishing from the list. */
function layoutTree(nodes: readonly WorkflowNode[]): TreeRow[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const node of nodes) {
    const parent = node.deps.find((dep) => byId.has(dep) && dep !== node.id);
    if (parent === undefined) roots.push(node.id);
    else children.set(parent, [...(children.get(parent) ?? []), node.id]);
  }

  const out: TreeRow[] = [];
  const seen = new Set<string>();
  const walk = (id: string, prefix: string, last: boolean, root: boolean): void => {
    const node = byId.get(id);
    if (!node || seen.has(id)) return;
    seen.add(id);
    out.push({
      node,
      branch: root ? '' : `${prefix}${last ? '└─' : '├─'} `,
      extraDeps: node.deps.filter((dep, i) => byId.has(dep) && i > 0),
    });
    const kids = children.get(id) ?? [];
    const next = root ? '' : `${prefix}${last ? '   ' : '│  '}`;
    kids.forEach((kid, i) => walk(kid, next, i === kids.length - 1, false));
  };
  roots.forEach((id, i) => walk(id, '', i === roots.length - 1, true));
  for (const node of nodes) walk(node.id, '', true, true); // unreachable (cycle / dangling dep)
  return out;
}

interface WorkflowModalOpts {
  tui: TUI;
  /** Live source of truth — read fresh every render so the modal tracks the workflow as its nodes run.
   *  Returns undefined once the workflow leaves the transcript projection. */
  getWorkflow(): WorkflowState | undefined;
  /** Restore focus + close on esc. */
  onClose(): void;
  /** Drill into a node's child transcript (reuses the sub-agent transcript viewer). */
  onDrill(sessionId: string): void;
}

/** The navigable workflow modal: nodes on the left, the selected node's detail on the right. Arrows move
 *  the selection, Enter opens that node's transcript, Esc closes. Renders live — each frame reads the
 *  current snapshot, so statuses/tokens update in place while nodes run. A standalone focus-capturing
 *  overlay with the same chrome geometry + restore contract as the pickers, deliberately diverging from
 *  them in one respect only: its fixed OLED palette. */
class WorkflowModal implements Component, Focusable {
  private _focused = false;
  private selectedIndex = 0;
  /** Transient footer message (e.g. Enter on a node that has not started). Cleared by any navigation, so
   *  it lives exactly as long as the state it describes — no timer to leak. */
  private notice = '';

  constructor(private readonly opts: WorkflowModalOpts) {}

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; }
  invalidate(): void { /* stateless render from the live workflow */ }

  /** The list in VISUAL order — the tree, not the DAG's declaration order — so arrows move down the rows
   *  the user is actually looking at and `selectedIndex` means the same thing to input and to render. */
  private rows(): TreeRow[] {
    const wf = this.opts.getWorkflow();
    return wf ? layoutTree(wf.nodes) : [];
  }

  private capacity(): number {
    return Math.max(3, modalGeometry(this.opts.tui.terminal).maxHeight - CHROME_ROWS);
  }

  private select(index: number): void {
    this.selectedIndex = index;
    this.notice = '';
    this.opts.tui.requestRender();
  }

  private move(delta: number): void {
    const n = this.rows().length;
    if (n === 0) return;
    this.select((this.selectedIndex + delta + n) % n); // wraps: ↑ on the first node lands on the last
  }

  /** Paging clamps where the arrows wrap — jumping a page should stop at the ends, not teleport across. */
  private page(delta: number): void {
    const n = this.rows().length;
    if (n === 0) return;
    this.select(Math.max(0, Math.min(n - 1, this.selectedIndex + delta)));
  }

  handleInput(data: string): void {
    if (isKeyRelease(data)) return; // Kitty release edge — navigate/open on the press only
    if (isEscapeKey(data)) { this.opts.onClose(); return; }
    if (isUpKey(data)) { this.move(-1); return; }
    if (isDownKey(data)) { this.move(1); return; }
    if (isPageUpKey(data)) { this.page(-this.capacity()); return; }
    if (isPageDownKey(data)) { this.page(this.capacity()); return; }
    if (isEnterKey(data)) {
      const node = this.rows()[this.selectedIndex]?.node;
      if (node?.sessionId) { this.opts.onDrill(node.sessionId); return; }
      // Pressing Enter here used to do nothing at all, which reads as a broken key rather than as "there
      // is nothing to open yet".
      this.notice = node ? `${node.id} has not started yet — no transcript to open` : 'no node selected';
      this.opts.tui.requestRender();
      return;
    }
  }

  /** One list row: branch art + status glyph + id, with tokens right-aligned. Built plain when selected
   *  so SEL can invert the whole cell (see SEL). */
  private listCell(row: TreeRow, selected: boolean, width: number): string {
    const { node } = row;
    const meta = node.tokens ? `${formatK(node.tokens)} tok` : '';
    const idRoom = Math.max(4, width - visibleWidth(row.branch) - 2 - (meta ? visibleWidth(meta) + 1 : 0));
    const head = `${ink(selected, F)(row.branch)}${ink(selected, STATUS_INK[node.status])(GLYPH[node.status])} `
      + `${ink(selected, W)(truncateToWidth(terminalInlineText(node.id), idRoom, '…'))}`;
    const tail = meta ? ink(selected, F)(meta) : '';
    const gap = Math.max(1, width - visibleWidth(head) - visibleWidth(tail));
    return fit(`${head}${' '.repeat(gap)}${tail}`, width);
  }

  /** The selected node's detail column: status line, deps, the task, and its current tool. The FULL dep
   *  list belongs here — the tree can only draw one parent per node, so this is where a node that waits
   *  on several stops being a half-truth. */
  private detailBlock(node: WorkflowNode, width: number, maxRows: number): string[] {
    const meta = [
      node.status,
      node.model ? terminalInlineText(node.model) : '',
      node.tokens ? `${formatK(node.tokens)} tok` : '',
      node.seconds !== undefined ? formatDuration(node.seconds) : '',
    ].filter(Boolean).join(' · ');
    const rows: string[] = [
      `${STATUS_INK[node.status](GLYPH[node.status])} ${W(terminalInlineText(node.id))}  ${F(meta)}`,
      F(node.deps.length ? `deps: ${node.deps.join(', ')}` : 'root'),
      '',
    ];
    const task = wrapTextWithAnsi(G(terminalInlineText(node.task)), width);
    const room = Math.max(1, maxRows - rows.length - (node.detail ? 2 : 0));
    rows.push(...task.slice(0, room));
    if (task.length > room) rows.push(F(`… +${task.length - room} more`));
    if (node.detail) {
      rows.push('');
      rows.push(F(`▸ ${terminalInlineText(node.detail)}`));
    }
    return rows;
  }

  /** Full-chrome message frame — an empty modal should still read as this modal, not a broken one. */
  private messageFrame(width: number, message: string): string[] {
    return [
      ROW(`  ${BOLD(W('Workflow'))}`, width),
      ROW('', width),
      ROW(`  ${F(message)}`, width),
      ROW('', width),
      ROW(`  ${F('esc close')}`, width),
    ];
  }

  render(width: number): string[] {
    const wf = this.opts.getWorkflow();
    if (!wf) return this.messageFrame(width, 'workflow is no longer in the live view — press esc');
    if (wf.nodes.length === 0) return this.messageFrame(width, 'no nodes yet — the plan is still being built');

    const tree = layoutTree(wf.nodes);
    if (this.selectedIndex >= tree.length) this.selectedIndex = tree.length - 1;
    const bodyWidth = Math.max(1, width - 4);
    const twoColumn = bodyWidth >= MIN_TWO_COL;
    const listWidth = twoColumn ? Math.max(MIN_LIST, Math.min(44, Math.floor(bodyWidth * 0.42))) : bodyWidth;
    const detailWidth = twoColumn ? bodyWidth - listWidth - GUTTER : bodyWidth;
    const capacity = this.capacity();

    // Window derived from the selection, never stored: the formula is total over every selectedIndex, so
    // move()'s modulo wrap (last→first) needs no special case and `selectedIndex` stays the only state.
    const start = Math.max(0, Math.min(this.selectedIndex - capacity + 1, tree.length - capacity));
    const window = tree.slice(start, start + capacity);

    const out: string[] = [];
    const statusInk = wf.status === 'running' ? (t: string) => ansi.sgr(RUNNING, t)
      : wf.status === 'done' ? (t: string) => ansi.sgr(DONE, t)
        : wf.status === 'error' ? (t: string) => ansi.sgr(FAILED, t) : F;
    const title = terminalInlineText(wf.title || `${tree.length}-node workflow`);
    const head = `  ${BOLD(W('Workflow'))}  ${G(truncateToWidth(title, Math.max(8, bodyWidth - 24), '…'))}  ${statusInk(wf.status)}`;
    out.push(ROW(head, width));
    out.push(ROW(`  ${F(`${' '.repeat(Math.max(0, bodyWidth - 3))}esc`)}`, width));

    const range = tree.length > capacity
      ? `${start + 1}–${Math.min(tree.length, start + capacity)}/${tree.length} ↕`
      : `${tree.length}`;
    const listHeader = `${F('NODES')}  ${F(range)}`;
    const selected = tree[this.selectedIndex]!;
    const detail = this.detailBlock(selected.node, detailWidth, capacity);

    if (twoColumn) {
      // ONE paintRow per row, at the OUTER level: painting the columns separately would emit a mid-row
      // reset and drop the background for the remainder of the line.
      const join = (left: string, right: string): string =>
        ROW(`  ${left}${F(' │ ')}${fit(right, detailWidth)}  `, width);
      out.push(join(fit(listHeader, listWidth), F(terminalInlineText(selected.node.id))));
      out.push(ROW(`  ${F(`${'─'.repeat(listWidth)}─┼─${'─'.repeat(detailWidth)}`)}  `, width));
      const rows = Math.max(window.length, detail.length);
      for (let i = 0; i < rows; i += 1) {
        const row = window[i];
        const isSelected = row !== undefined && start + i === this.selectedIndex;
        const cell = row ? this.listCell(row, isSelected, listWidth) : ' '.repeat(listWidth);
        out.push(join(isSelected ? SEL(cell) : cell, detail[i] ?? ''));
      }
    } else {
      out.push(ROW(`  ${fit(listHeader, bodyWidth)}  `, width));
      for (const [i, row] of window.entries()) {
        const isSelected = start + i === this.selectedIndex;
        const cell = this.listCell(row, isSelected, bodyWidth);
        out.push(ROW(`  ${isSelected ? SEL(cell) : cell}  `, width));
      }
      out.push(ROW(`  ${F('─'.repeat(bodyWidth))}  `, width));
      for (const line of detail) out.push(ROW(`  ${fit(line, bodyWidth)}  `, width));
    }

    out.push(ROW('', width));
    const hint = selected.node.sessionId
      ? 'enter open node transcript · ↑↓ move · esc close'
      : '↑↓ move · esc close (node not started)';
    out.push(ROW(`  ${this.notice ? ansi.sgr(RUNNING, this.notice) : F(hint)}`, width));
    return out;
  }
}

/** Show the workflow modal as a centered focus-capturing overlay. `getWorkflow` feeds it the live
 *  snapshot; `onDrill` hands a node session to the caller (which opens the sub-agent transcript viewer). */
export function openWorkflowModal(o: {
  tui: TUI;
  editor: Editor;
  getWorkflow(): WorkflowState | undefined;
  onDrill(sessionId: string): void;
}): void {
  const restore = (): void => { o.tui.setFocus(o.editor); o.tui.requestRender(); };
  let handle: ReturnType<TUI['showOverlay']> | null = null;
  const close = (): void => { handle?.hide(); handle = null; restore(); };
  const modal = new WorkflowModal({
    tui: o.tui,
    getWorkflow: o.getWorkflow,
    onClose: close,
    onDrill: (sessionId) => { close(); o.onDrill(sessionId); },
  });
  // The overlay controller re-clamps these numbers against the live terminal on every reflow, and
  // render() derives its own row budget from that same terminal — so the two stay in agreement without
  // the factory form (which only the runtime accepts; TUI['showOverlay'] is typed for a plain object).
  handle = o.tui.showOverlay(modal, { anchor: 'center', ...modalGeometry(o.tui.terminal), margin: 2 });
  handle.focus();
  o.tui.requestRender();
}
