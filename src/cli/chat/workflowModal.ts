import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { Component, Editor, Focusable, TUI } from '@earendil-works/pi-tui';
import { isDownKey, isEnterKey, isEscapeKey, isKeyRelease, isLeftKey, isRightKey, isTabKey, isUpKey } from './keys.js';
import { chatTheme, color, paintRow } from './theme.js';
import { formatDuration, formatK, padAnsi, terminalInlineText } from '../ui/text.js';
import { spinnerFrame, workflowTitle } from './components.js';
import { CARD_W, STATUS_GLYPH, STATUS_INK, canvasSize, drawCircuit, layoutCircuit, paintCanvas } from './workflowCanvas.js';
import type { Placement } from './workflowCanvas.js';
import type { WorkflowState, WorkflowNode } from '../../brain/transcript.js';

// The workflow modal follows the active chat theme (resolved at CALL time, so a /theme switch recolours
// it live) instead of owning a fixed palette: it is Elowen's surface and should read as part of the same
// design language as the pickers behind it, not a detached black plane. Backgrounds come from
// `chatTheme().modalBg` and are painted per ROW (see paintRow).
const ROW = (t: string, width: number): string => paintRow(chatTheme().modalBg, t, width);

/** Fit text to exactly `width` columns. The explicit '…' is load-bearing: padAnsi's own overflow branch
 *  calls truncateToWidth WITHOUT an ellipsis argument, so it would render ASCII "..." here while every
 *  other string in the modal elides with '…'. Truncate first, then pad. */
const fit = (text: string, width: number): string =>
  padAnsi(truncateToWidth(text, Math.max(0, width), '…'), Math.max(0, width));

/** title, summary, blank, dock rule, 3 dock rows, footer. */
const CHROME_ROWS = 8;
/** Below this body width the canvas cannot seat two columns plus a gutter — fall back to the wave list. */
const MIN_CANVAS_BODY = 72;
/** Animation cadence for the energy dots (the braille spinner has its own 120ms clock). */
const TICK_MS = 150;

/** One source of truth for the modal's geometry: near-fullscreen, and both the call-site overlay request
 *  and render()'s own row budget compute from the same terminal so they can never disagree. The overlay
 *  re-clamps against the live terminal on every reflow regardless. */
function modalGeometry(terminal: { columns: number; rows: number }): { width: number; maxHeight: number } {
  return {
    width: Math.max(64, Math.floor(terminal.columns * 0.95)),
    maxHeight: Math.max(12, terminal.rows - 4),
  };
}

const glyphOf = (node: WorkflowNode, spinner: string): string =>
  node.status === 'running' ? spinner : STATUS_GLYPH[node.status];
const firstLine = (s: string): string => terminalInlineText(s.split('\n')[0] ?? '');

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

/** The workflow DAG as a navigable spatial canvas: waves become columns, ←→ crosses them, ↑↓ walks a
 *  column, and the selected/running nodes grow into full cards while the rest stay compact. A dock under
 *  the canvas carries the selected node's vitals (or, on Tab, a live activity feed), and energy dots flow
 *  along the edges into running nodes. Renders live — each frame reads the current snapshot — and owns a
 *  single self-arming timer for the animation while any node runs. On a terminal too narrow for the
 *  canvas the same DAG renders as a wave-grouped list with identical keys. */
class WorkflowModal implements Component, Focusable {
  private _focused = false;
  /** Selection is the node ID, not an index: nodes can be appended mid-run (WorkflowAddNodes) and the
   *  wave layout reorders as statuses change — the id keeps the selection pinned to the same node. */
  private selectedId: string | null = null;
  private dock: 'detail' | 'activity' = 'detail';
  /** Transient footer message (e.g. Enter on a node that has not started). Cleared by any navigation, so
   *  it lives exactly as long as the state it describes. */
  private notice = '';
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: WorkflowModalOpts) {}

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; }
  invalidate(): void { /* stateless render from the live workflow */ }

  /** Stop the animation timer — the factory calls this from close(), so a hidden modal never keeps
   *  repainting the app behind it. */
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** One-shot, re-armed per render while anything runs: render → timer → requestRender → render. When
   *  the workflow settles the chain simply stops re-arming and the last frame stays put. */
  private syncAnimation(active: boolean): void {
    if (active && this.timer === null) {
      this.timer = setTimeout(() => { this.timer = null; this.opts.tui.requestRender(); }, TICK_MS);
      this.timer.unref?.();
    }
    if (!active && this.timer) this.dispose();
  }

  private nodes(): readonly WorkflowNode[] {
    return this.opts.getWorkflow()?.nodes ?? [];
  }

  /** The selected node's id, revalidated against the live snapshot (the node may have gone). */
  private selection(nodes: readonly WorkflowNode[]): string | null {
    if (this.selectedId && nodes.some((n) => n.id === this.selectedId)) return this.selectedId;
    this.selectedId = nodes[0]?.id ?? null;
    return this.selectedId;
  }

  private placements(): Placement[] {
    const nodes = this.nodes();
    return layoutCircuit(nodes, this.selection(nodes));
  }

  private capacity(): number {
    return Math.max(3, modalGeometry(this.opts.tui.terminal).maxHeight - CHROME_ROWS);
  }

  private canvasMode(): boolean {
    return modalGeometry(this.opts.tui.terminal).width - 4 >= MIN_CANVAS_BODY;
  }

  private select(id: string | undefined): void {
    if (id !== undefined) this.selectedId = id;
    this.notice = '';
    this.opts.tui.requestRender();
  }

  /** ↑↓: the column's stack in canvas mode, the flat wave order in list mode. Clamped, not wrapped —
   *  the canvas is a space, and falling off the top onto the bottom reads as teleporting. */
  private moveVertical(delta: number): void {
    const placements = this.placements();
    const current = placements.find((p) => p.node.id === this.selectedId);
    if (!current) { this.select(placements[0]?.node.id); return; }
    const lane = this.canvasMode() ? placements.filter((p) => p.col === current.col) : placements;
    const index = lane.findIndex((p) => p.node.id === current.node.id);
    this.select(lane[Math.max(0, Math.min(lane.length - 1, index + delta))]?.node.id);
  }

  /** ←→: the neighbouring wave, landing on the node closest to the current row so the selection moves
   *  the way the eye does — sideways, not to an arbitrary list position. */
  private moveHorizontal(delta: number): void {
    const placements = this.placements();
    const current = placements.find((p) => p.node.id === this.selectedId);
    if (!current) { this.select(placements[0]?.node.id); return; }
    const cols = [...new Set(placements.map((p) => p.col))].sort((a, b) => a - b);
    const at = cols.indexOf(current.col);
    const target = cols[Math.max(0, Math.min(cols.length - 1, at + delta))];
    if (target === undefined || target === current.col) return;
    const nearest = placements.filter((p) => p.col === target)
      .reduce((best, p) => (Math.abs(p.y - current.y) < Math.abs(best.y - current.y) ? p : best));
    this.select(nearest.node.id);
  }

  handleInput(data: string): void {
    if (isKeyRelease(data)) return; // Kitty release edge — navigate/open on the press only
    if (isEscapeKey(data)) { this.opts.onClose(); return; }
    if (isUpKey(data)) { this.moveVertical(-1); return; }
    if (isDownKey(data)) { this.moveVertical(1); return; }
    if (isLeftKey(data)) { this.moveHorizontal(-1); return; }
    if (isRightKey(data)) { this.moveHorizontal(1); return; }
    if (isTabKey(data)) {
      this.dock = this.dock === 'detail' ? 'activity' : 'detail';
      this.opts.tui.requestRender();
      return;
    }
    if (isEnterKey(data)) {
      const node = this.nodes().find((n) => n.id === this.selectedId);
      if (node?.sessionId) { this.opts.onDrill(node.sessionId); return; }
      // Pressing Enter here used to do nothing at all, which reads as a broken key rather than as "there
      // is nothing to open yet".
      this.notice = node ? `${terminalInlineText(node.id)} has not started yet — no transcript to open` : 'no node selected';
      this.opts.tui.requestRender();
      return;
    }
  }

  /** Live elapsed seconds: a running node ticks from its startedAt between snapshots, everything else
   *  shows what the engine last reported. */
  private seconds(node: WorkflowNode, now: number): number | undefined {
    if (node.status === 'running' && node.startedAt !== undefined) {
      return Math.max(node.seconds ?? 0, Math.round((now - node.startedAt) / 1000));
    }
    return node.seconds;
  }

  /** The whole-run strip under the title: a progress bar, per-status counts, the run's totals and the
   *  scroll affordances. Gives the DAG a headline without reading a single card. */
  private summaryLine(wf: WorkflowState, now: number, clipped: { h: boolean; v: boolean }): string {
    const countOf = (s: WorkflowNode['status']): number => wf.nodes.reduce((n, x) => n + (x.status === s ? 1 : 0), 0);
    const done = countOf('done');
    const running = countOf('running');
    const error = countOf('error');
    const pending = countOf('pending');
    const finished = done + error;
    const total = wf.nodes.length;

    const barW = 10;
    const filled = total ? Math.round((finished / total) * barW) : 0;
    const bar = color.accent('▰'.repeat(filled)) + color.faint('▱'.repeat(barW - filled));
    const counts = [
      done ? color.success(`✓${done}`) : '',
      running ? color.warning(`●${running}`) : '',
      error ? color.error(`✗${error}`) : '',
      pending ? color.faint(`⏸${pending}`) : '',
    ].filter(Boolean).join(' ');
    const totalTok = wf.nodes.reduce((s, n) => s + (n.tokens ?? 0), 0);
    const maxSec = wf.nodes.reduce((m, n) => Math.max(m, this.seconds(n, now) ?? 0), 0);
    const extras = [
      totalTok ? `${color.text(formatK(totalTok))}${color.faint(' tok')}` : '',
      maxSec ? color.text(formatDuration(maxSec)) : '',
    ].filter(Boolean).join(color.faint(' · '));
    const scroll = [clipped.h ? '↔' : '', clipped.v ? '↕' : ''].filter(Boolean).join(' ');
    return `  ${bar} ${color.text(`${finished}/${total}`)}`
      + (counts ? ` ${color.faint('·')} ${counts}` : '')
      + (extras ? ` ${color.faint('·')} ${extras}` : '')
      + (scroll ? ` ${color.faint('·')} ${color.faint(scroll)}` : '');
  }

  /** The wave-grouped list a narrow terminal falls back to: `─ wave N ─` rules with the same nodes,
   *  selection and keys as the canvas — only the geometry is gone, never the information. */
  private listRows(placements: readonly Placement[], bodyWidth: number, spinner: string, now: number): string[] {
    const rows: string[] = [];
    let selectedRow = 0;
    let lastCol = -1;
    for (const p of placements) {
      if (p.col !== lastCol) {
        lastCol = p.col;
        const label = `─ wave ${p.col + 1} `;
        rows.push(color.faint(`${label}${'─'.repeat(Math.max(0, bodyWidth - label.length))}`));
      }
      const { node } = p;
      const selected = node.id === this.selectedId;
      if (selected) selectedRow = rows.length;
      const meta = [
        node.tokens !== undefined ? `${formatK(node.tokens)} tok` : '',
        this.seconds(node, now) !== undefined ? formatDuration(this.seconds(node, now)!) : '',
      ].filter(Boolean).join(' · ');
      const mid = node.status === 'running' ? (node.detail ?? '') : node.status === 'pending' ? `waits: ${node.deps.join(', ') || '—'}` : '';
      const idW = 16;
      const midW = Math.max(0, bodyWidth - idW - 3 - (meta ? visibleWidth(meta) + 1 : 0));
      if (selected) {
        rows.push(color.selected(fit(` ${glyphOf(node, spinner)} ${fit(terminalInlineText(node.id), idW)} ${fit(terminalInlineText(mid), midW)}${meta ? ` ${meta}` : ''}`, bodyWidth)));
      } else {
        const midInk = node.status === 'running' ? color.accentSoft : color.faint;
        rows.push(fit(` ${STATUS_INK[node.status](glyphOf(node, spinner))} ${color.text(fit(terminalInlineText(node.id), idW))} ${midInk(fit(terminalInlineText(mid), midW))}${meta ? ` ${color.faint(meta)}` : ''}`, bodyWidth));
      }
    }
    const cap = this.capacity();
    if (rows.length <= cap) return rows;
    const start = Math.max(0, Math.min(selectedRow - Math.floor(cap / 2), rows.length - cap));
    return rows.slice(start, start + cap);
  }

  /** The dock's three content rows for the selected node: vitals, the task, and the outcome line that
   *  the new snapshot fields exist for — the live tool while running, the result/error once terminal. */
  private detailDock(node: WorkflowNode, width: number, spinner: string, now: number): string[] {
    const secs = this.seconds(node, now);
    const vitals = [
      `${STATUS_INK[node.status](glyphOf(node, spinner))} ${STATUS_INK[node.status](node.status)}`,
      node.model ? `${color.faint('model ')}${color.text(terminalInlineText(node.model))}` : '',
      node.tokens !== undefined ? `${color.text(formatK(node.tokens))}${color.faint(' tok')}` : '',
      secs !== undefined ? color.text(formatDuration(secs)) : '',
      `${color.faint('deps ')}${color.text(terminalInlineText(node.deps.join(', ')) || 'root')}`,
    ].filter(Boolean).join(color.faint('  ·  '));
    const outcome = node.status === 'running' ? color.accent(`▸ ${terminalInlineText(node.detail ?? 'working…')}`)
      : node.status === 'done' ? color.dim(`▸ ${firstLine(node.result ?? '') || 'no output reported'}`)
        : node.status === 'error' ? color.error(`✗ ${firstLine(node.error ?? '') || 'failed'}`)
          : color.faint('not started yet');
    return [
      fit(vitals, width),
      fit(color.dim(terminalInlineText(node.task)), width),
      fit(outcome, width),
    ];
  }

  /** The dock's activity mode: every running node's live tool line, then the freshest finished nodes —
   *  a whole-run pulse that needs no navigation. */
  private activityDock(nodes: readonly WorkflowNode[], width: number, spinner: string): string[] {
    const rows: string[] = [];
    for (const n of nodes.filter((x) => x.status === 'running')) {
      rows.push(fit(`${color.warning(spinner)} ${color.text(fit(terminalInlineText(n.id), 16))} ${color.accentSoft(terminalInlineText(n.detail ?? '…'))}`, width));
    }
    for (const n of [...nodes].reverse().filter((x) => x.status === 'done' || x.status === 'error')) {
      if (rows.length >= 3) break;
      const glyphed = n.status === 'done'
        ? `${color.success('✓')} ${color.text(fit(terminalInlineText(n.id), 16))} ${color.faint(firstLine(n.result ?? '') || 'done')}`
        : `${color.error('✗')} ${color.text(fit(terminalInlineText(n.id), 16))} ${color.error(firstLine(n.error ?? '') || 'failed')}`;
      rows.push(fit(glyphed, width));
    }
    while (rows.length < 3) rows.push(fit(color.faint(rows.length === 0 ? 'nothing has run yet' : ''), width));
    return rows.slice(0, 3);
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
    if (!wf) { this.syncAnimation(false); return this.messageFrame(width, 'workflow is no longer in the live view — press esc'); }
    if (wf.nodes.length === 0) return this.messageFrame(width, 'no nodes yet — the plan is still being built');

    const now = Date.now();
    const spinner = spinnerFrame(now);
    const running = wf.nodes.some((n) => n.status === 'running');
    this.syncAnimation(running);

    const bodyWidth = Math.max(1, width - 4);
    const selectedId = this.selection(wf.nodes);
    const placements = layoutCircuit(wf.nodes, selectedId);
    const selected = placements.find((p) => p.node.id === selectedId) ?? placements[0]!;
    const capacity = this.capacity();

    let body: string[];
    let clipped = { h: false, v: false };
    if (this.canvasMode()) {
      const grid = drawCircuit(placements, {
        selectedId,
        tick: Math.floor(now / TICK_MS),
        spinner,
        seconds: (node) => this.seconds(node, now),
      });
      const { width: cw, height: ch } = canvasSize(placements);
      const vh = Math.min(capacity, ch);
      clipped = { h: cw > bodyWidth, v: ch > capacity };
      // A canvas smaller than the viewport floats centered (negative offset renders as margin); a larger
      // one scrolls to keep the selected card in view — derived from the selection, never stored.
      const vx = cw <= bodyWidth
        ? -Math.floor((bodyWidth - cw) / 2)
        : Math.max(0, Math.min(selected.x + Math.floor(CARD_W / 2) - Math.floor(bodyWidth / 2), cw - bodyWidth));
      const vy = ch <= vh ? 0 : Math.max(0, Math.min(selected.y - Math.floor(vh / 2), ch - vh));
      body = paintCanvas(grid, { x: vx, y: vy, w: bodyWidth, h: vh });
    } else {
      body = this.listRows(placements, bodyWidth, spinner, now);
    }

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
    out.push(ROW(this.summaryLine(wf, now, clipped), width));
    out.push(ROW('', width));
    for (const row of body) out.push(ROW(`  ${fit(row, bodyWidth)}  `, width));

    // Dock: a titled rule, then the selected node's detail or the run's activity feed.
    const dockTitle = this.dock === 'detail' ? ` ${terminalInlineText(selected.node.id)} ` : ' activity ';
    const rule = `─${color.accentSoft(dockTitle)}`;
    out.push(ROW(`  ${color.faint('─')}${color.accentSoft(dockTitle)}${color.faint('─'.repeat(Math.max(0, bodyWidth - visibleWidth(rule))))}  `, width));
    const dockRows = this.dock === 'detail'
      ? this.detailDock(selected.node, bodyWidth, spinner, now)
      : this.activityDock(wf.nodes, bodyWidth, spinner);
    for (const row of dockRows) out.push(ROW(`  ${row}  `, width));

    const hint = selected.node.sessionId
      ? `enter open node transcript · ←→↑↓ move · tab ${this.dock === 'detail' ? 'activity' : 'detail'} · esc close`
      : '←→↑↓ move · esc close (node not started)';
    out.push(ROW(`  ${this.notice ? color.warning(terminalInlineText(this.notice)) : color.faint(hint)}`, width));
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
  let modal: WorkflowModal | null = null;
  const close = (): void => { modal?.dispose(); handle?.hide(); handle = null; restore(); };
  modal = new WorkflowModal({
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
