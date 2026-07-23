import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { Component, Editor, Focusable, TUI } from '@earendil-works/pi-tui';
import { isDownKey, isEnterKey, isEscapeKey, isKeyRelease, isPageDownKey, isPageUpKey, isUpKey } from './keys.js';
import { chatTheme, color, paintRow } from './theme.js';
import { formatDuration, formatK, padAnsi, terminalInlineText } from '../ui/text.js';
import { workflowTitle } from './components.js';
import type { WorkflowState, WorkflowNode } from '../../brain/transcript.js';

// The workflow modal follows the active chat theme (resolved at CALL time, so a /theme switch recolours
// it live) instead of owning a fixed palette: it is Elowen's surface and should read as part of the same
// design language as the pickers behind it, not a detached black plane. Backgrounds come from
// `chatTheme().modalBg` and are painted per ROW (see paintRow); selection reuses the shared
// `color.selected` (theme accent background, black text) that every other themed modal already uses.
const ROW = (t: string, width: number): string => paintRow(chatTheme().modalBg, t, width);

const STATUS_GLYPH: Record<WorkflowNode['status'], string> = { running: '●', done: '✓', error: '✗', pending: '⏸' };
/** Status → themed ink. These hold the `color.*` helpers (stable references) which resolve the ACTIVE
 *  theme when invoked, so the modal recolours on /theme without a rebuild. */
const STATUS_INK: Record<WorkflowNode['status'], (t: string) => string> = {
  running: color.warning,
  done: color.success,
  error: color.error,
  pending: color.faint,
};
/** Identity on the selected row (which color.selected inverts whole), the real ink everywhere else. */
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
const CHROME_ROWS = 6;   // title, summary, column header, rule, blank, footer

/** One source of truth for the modal's geometry. maxHeight used to be hardcoded at the call site and
 *  never reached render(), so the list's capacity and the real row budget disagreed and a long DAG
 *  silently lost its bottom rows. Both sides now compute from the same terminal.
 *
 *  The 12-row floor is a minimum to render INTO, not a promise the terminal can honour: the overlay clamps
 *  the frame to `rows - 4` regardless, so under ~16 rows the modal is taller than its window and gets
 *  trimmed. That is the floor doing its job — a modal squeezed below its chrome has nothing left to show. */
function modalGeometry(terminal: { columns: number; rows: number }): { width: number; maxHeight: number } {
  return {
    width: Math.max(64, Math.min(110, Math.floor(terminal.columns * 0.9))),
    maxHeight: Math.max(12, Math.min(30, terminal.rows - 4)), // margin: 2 top + bottom
  };
}

/** A node placed in the dependency tree: its row prefix is the branch art leading to it. */
interface TreeRow { node: WorkflowNode; branch: string }

/** Lay the DAG out as a tree so the list SHOWS what depends on what instead of only saying it.
 *
 *  A DAG is not a tree: a node may depend on several others, and only one of them can hold it in an
 *  indented list. Each node therefore hangs under its FIRST dependency, and the detail column carries the
 *  full dep list — the shape stays readable rather than the layout quietly implying a node has one parent
 *  when it has three.
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
    out.push({ node, branch: root ? '' : `${prefix}${last ? '└─' : '├─'} ` });
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

/** The navigable workflow modal: nodes on the left, the selected node's detail on the right, with a
 *  summary strip tracking the whole run. Arrows move the selection, Enter opens that node's transcript,
 *  Esc closes. Renders live — each frame reads the current snapshot, so statuses/tokens update in place
 *  while nodes run. A standalone focus-capturing overlay in the same chrome geometry + restore contract
 *  as the pickers, sharing their themed palette. */
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
   *  so color.selected can invert the whole cell as one accent-background block. */
  private listCell(row: TreeRow, selected: boolean, width: number): string {
    const { node } = row;
    const meta = node.tokens ? `${formatK(node.tokens)} tok` : '';
    const idRoom = Math.max(4, width - visibleWidth(row.branch) - 2 - (meta ? visibleWidth(meta) + 1 : 0));
    const head = `${ink(selected, color.faint)(row.branch)}${ink(selected, STATUS_INK[node.status])(STATUS_GLYPH[node.status])} `
      + `${ink(selected, color.text)(truncateToWidth(terminalInlineText(node.id), idRoom, '…'))}`;
    const tail = meta ? ink(selected, color.faint)(meta) : '';
    const gap = Math.max(1, width - visibleWidth(head) - visibleWidth(tail));
    return fit(`${head}${' '.repeat(gap)}${tail}`, width);
  }

  /** The selected node's detail column: a bold id header, its vitals as aligned key/value rows, the task
   *  body, and its current tool. The FULL dep list belongs here — the tree can only draw one parent per
   *  node, so this is where a node that waits on several stops being a half-truth. */
  private detailBlock(node: WorkflowNode, width: number, maxRows: number): string[] {
    const rows: string[] = [];
    rows.push(`${STATUS_INK[node.status](STATUS_GLYPH[node.status])} ${color.bold(color.text(terminalInlineText(node.id)))}`);
    const label = (key: string): string => `  ${color.faint(key.padEnd(8))}`;
    rows.push(`${label('status')}${STATUS_INK[node.status](terminalInlineText(node.status))}`);
    if (node.model) rows.push(`${label('model')}${color.text(terminalInlineText(node.model))}`);
    if (node.tokens != null) {
      const dur = node.seconds !== undefined ? color.faint(` · ${formatDuration(node.seconds)}`) : '';
      rows.push(`${label('tokens')}${color.text(formatK(node.tokens))}${color.faint(' tok')}${dur}`);
    }
    rows.push(`${label('deps')}${node.deps.length ? color.text(terminalInlineText(node.deps.join(', '))) : color.faint('root')}`);
    rows.push(`  ${color.faint('─'.repeat(Math.max(4, Math.min(16, width - 4))))}`);
    const headerCount = rows.length;

    const task = wrapTextWithAnsi(color.text(terminalInlineText(node.task)), width);
    const detailReserve = node.detail ? 2 : 0;
    const room = Math.max(1, maxRows - headerCount - detailReserve);
    // The "+N more" line costs a row of `room` itself. Counting it as free overran maxRows by one, and the
    // overlay trims from the BOTTOM — so a long task silently ate the footer's keybind hint.
    if (task.length > room) rows.push(...task.slice(0, room - 1), color.faint(`… +${task.length - room + 1} more`));
    else rows.push(...task);
    if (node.detail) {
      rows.push('');
      rows.push(color.accent(`▸ ${terminalInlineText(node.detail)}`));
    }
    // The header has no upper bound of its own, so on a very short budget it alone can outgrow maxRows.
    // Cede the overflow here rather than at the caller: the overlay trims from the bottom, and losing the
    // tail of a detail beats losing the footer that says which keys work.
    return rows.slice(0, Math.max(1, maxRows));
  }

  /** The whole-run strip under the title: a progress bar, per-status counts, and the run's totals. Gives
   *  the DAG a headline — "how far along is this?" — without reading a single row. */
  private summaryLine(wf: WorkflowState): string {
    const total = wf.nodes.length;
    const countOf = (s: WorkflowNode['status']): number => wf.nodes.reduce((n, x) => n + (x.status === s ? 1 : 0), 0);
    const done = countOf('done');
    const running = countOf('running');
    const error = countOf('error');
    const pending = countOf('pending');
    const finished = done + error;

    const barW = 8;
    const filled = total ? Math.round((finished / total) * barW) : 0;
    const bar = color.accent('▰'.repeat(filled)) + color.faint('▱'.repeat(barW - filled));
    const counts = [
      done ? color.success(`✓${done}`) : '',
      running ? color.warning(`●${running}`) : '',
      error ? color.error(`✗${error}`) : '',
      pending ? color.faint(`⏸${pending}`) : '',
    ].filter(Boolean).join(' ');
    const totalTok = wf.nodes.reduce((s, n) => s + (n.tokens ?? 0), 0);
    const maxSec = wf.nodes.reduce((m, n) => Math.max(m, n.seconds ?? 0), 0);
    const extras = [
      totalTok ? `${color.text(formatK(totalTok))}${color.faint(' tok')}` : '',
      maxSec ? color.text(formatDuration(maxSec)) : '',
    ].filter(Boolean).join(color.faint(' · '));
    return `  ${bar} ${color.text(`${finished}/${total}`)}`
      + (counts ? ` ${color.faint('·')} ${counts}` : '')
      + (extras ? ` ${color.faint('·')} ${extras}` : '');
  }

  /** Full-chrome message frame — an empty modal should still read as this modal, not a broken one. */
  private messageFrame(width: number, message: string): string[] {
    return [
      ROW(`  ${color.bold(color.accent('⚙ WORKFLOW'))}`, width),
      ROW('', width),
      ROW(`  ${color.faint(message)}`, width),
      ROW('', width),
      ROW(`  ${color.faint('esc close')}`, width),
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
    // Side by side, the columns overlap in the row budget and cost max(list, detail). Stacked, they sit ON
    // TOP of one another (plus a rule between), so they must SHARE it — billing both the full capacity
    // overran the frame by a whole column's worth of rows, and the overlay trimmed the detail and footer
    // away to pay for it.
    const listRoom = twoColumn ? capacity : Math.max(2, Math.ceil((capacity - 1) / 2));
    const detailRoom = twoColumn ? capacity : Math.max(1, capacity - listRoom - 1);

    // Window derived from the selection, never stored: the formula is total over every selectedIndex, so
    // move()'s modulo wrap (last→first) needs no special case and `selectedIndex` stays the only state.
    const start = Math.max(0, Math.min(this.selectedIndex - listRoom + 1, tree.length - listRoom));
    const window = tree.slice(start, start + listRoom);

    const out: string[] = [];
    // Title row: brand · name on the left, the run's status pill and esc hint right-aligned.
    const wfInk = wf.status === 'running' ? color.warning
      : wf.status === 'done' ? color.success
        : wf.status === 'error' ? color.error : color.faint;
    const wfGlyph = wf.status === 'running' ? '●' : wf.status === 'done' ? '✓' : wf.status === 'error' ? '✗' : '–';
    const title = terminalInlineText(workflowTitle(wf));
    const right = `${wfInk(`${wfGlyph} ${wf.status}`)}  ${color.faint('esc')}`;
    const left = `  ${color.accent('⚙ WORKFLOW')} ${color.faint('·')} `
      + color.text(truncateToWidth(title, Math.max(8, bodyWidth - 34), '…'));
    const titleGap = Math.max(2, width - visibleWidth(left) - visibleWidth(right));
    out.push(ROW(`${left}${' '.repeat(titleGap)}${right}`, width));
    out.push(ROW(this.summaryLine(wf), width));

    const range = tree.length > listRoom
      ? `${start + 1}–${Math.min(tree.length, start + listRoom)}/${tree.length} ↕`
      : `${tree.length}`;
    const listHeader = `${color.faint('NODES')}  ${color.faint(range)}`;
    const selected = tree[this.selectedIndex]!;
    const detail = this.detailBlock(selected.node, detailWidth, detailRoom);

    if (twoColumn) {
      // ONE paintRow per row, at the OUTER level: painting the columns separately would emit a mid-row
      // reset and drop the background for the remainder of the line.
      const join = (leftCell: string, rightCell: string): string =>
        ROW(`  ${leftCell}${color.faint(' │ ')}${fit(rightCell, detailWidth)}  `, width);
      out.push(join(fit(listHeader, listWidth), color.faint(terminalInlineText(selected.node.id))));
      out.push(ROW(`  ${color.faint(`${'─'.repeat(listWidth)}─┼─${'─'.repeat(detailWidth)}`)}  `, width));
      const rows = Math.max(window.length, detail.length);
      for (let i = 0; i < rows; i += 1) {
        const row = window[i];
        const isSelected = row !== undefined && start + i === this.selectedIndex;
        const cell = row ? this.listCell(row, isSelected, listWidth) : ' '.repeat(listWidth);
        out.push(join(isSelected ? color.selected(cell) : cell, detail[i] ?? ''));
      }
    } else {
      out.push(ROW(`  ${fit(listHeader, bodyWidth)}  `, width));
      for (const [i, row] of window.entries()) {
        const isSelected = start + i === this.selectedIndex;
        const cell = this.listCell(row, isSelected, bodyWidth);
        out.push(ROW(`  ${isSelected ? color.selected(cell) : cell}  `, width));
      }
      out.push(ROW(`  ${color.faint('─'.repeat(bodyWidth))}  `, width));
      for (const line of detail) out.push(ROW(`  ${fit(line, bodyWidth)}  `, width));
    }

    out.push(ROW('', width));
    const hint = selected.node.sessionId
      ? 'enter open node transcript · ↑↓ move · esc close'
      : '↑↓ move · esc close (node not started)';
    out.push(ROW(`  ${this.notice ? color.warning(this.notice) : color.faint(hint)}`, width));
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
