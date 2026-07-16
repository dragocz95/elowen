import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { Component, Editor, Focusable, TUI } from '@earendil-works/pi-tui';
import { isDownKey, isEnterKey, isEscapeKey, isKeyRelease, isUpKey } from './keys.js';
import { chatTheme, color, paintRow } from './theme.js';
import { formatDuration, formatK, padAnsi, terminalInlineText } from '../ui/text.js';
import type { WorkflowState, WorkflowNode } from '../../brain/transcript.js';

const glyph = (status: WorkflowNode['status']): string =>
  status === 'running' ? color.warning('●')
    : status === 'done' ? color.success('✓')
      : status === 'error' ? color.error('✗')
        : color.faint('⏸');

interface WorkflowModalOpts {
  tui: TUI;
  /** Live source of truth — read fresh every render so the modal tracks the workflow as its nodes run.
   *  Returns undefined once the workflow leaves the transcript projection (the modal then closes). */
  getWorkflow(): WorkflowState | undefined;
  /** Restore focus + close on esc / when the workflow is gone. */
  onClose(): void;
  /** Drill into a node's child transcript (reuses the sub-agent transcript viewer). */
  onDrill(sessionId: string): void;
}

/** The navigable workflow modal: a selectable list of DAG nodes with a master/detail box below. Arrows
 *  move the selection, Enter opens the selected node's transcript (when it has started), Esc closes.
 *  Renders live — each frame reads the current snapshot, so statuses/tokens update in place while nodes
 *  run. A standalone focus-capturing overlay with the same chrome + restore contract as the pickers. */
class WorkflowModal implements Component, Focusable {
  private _focused = false;
  private selectedIndex = 0;

  constructor(private readonly opts: WorkflowModalOpts) {}

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; }
  invalidate(): void { /* stateless render from the live workflow */ }

  private nodes(): WorkflowNode[] { return this.opts.getWorkflow()?.nodes ?? []; }

  private move(delta: number): void {
    const n = this.nodes().length;
    if (n === 0) return;
    this.selectedIndex = (this.selectedIndex + delta + n) % n;
    this.opts.tui.requestRender();
  }

  handleInput(data: string): void {
    if (isKeyRelease(data)) return; // Kitty release edge — navigate/open on the press only
    if (isEscapeKey(data)) { this.opts.onClose(); return; }
    if (isUpKey(data)) { this.move(-1); return; }
    if (isDownKey(data)) { this.move(1); return; }
    if (isEnterKey(data)) {
      const node = this.nodes()[this.selectedIndex];
      if (node?.sessionId) this.opts.onDrill(node.sessionId);
      return;
    }
  }

  render(width: number): string[] {
    const wf = this.opts.getWorkflow();
    const line = (s: string): string => paintRow(chatTheme().modalBg, s, width);
    const bodyWidth = Math.max(1, width - 4);
    if (!wf || wf.nodes.length === 0) return [line(`  ${color.faint('workflow finished — press esc')}`)];
    const nodes = wf.nodes;
    if (this.selectedIndex >= nodes.length) this.selectedIndex = nodes.length - 1;

    const out: string[] = [];
    const title = wf.title || `${nodes.length}-node workflow`;
    const statusText = wf.status === 'running' ? color.warning('running')
      : wf.status === 'done' ? color.success('done')
        : wf.status === 'error' ? color.error('error') : color.faint(wf.status);
    const head = `  ${color.bold(color.text('Workflow'))} ${color.dim(truncateToWidth(terminalInlineText(title), Math.max(8, bodyWidth - 20), '…'))}  ${statusText}`;
    out.push(line(padAnsi(head, width)));
    out.push(line(`  ${color.faint(`${' '.repeat(Math.max(0, bodyWidth - 3))}esc`)}`));
    out.push(line(''));

    // Node list — status glyph, id, deps and live counters; the selected row is highlighted.
    const idPad = Math.min(24, Math.max(...nodes.map((n) => n.id.length), 4) + 1);
    nodes.forEach((n, i) => {
      const deps = n.deps.length ? `deps: ${n.deps.join(', ')}` : 'root';
      const meta = [
        n.model ? terminalInlineText(n.model) : '',
        n.tokens ? `${formatK(n.tokens)} tok` : '',
        n.seconds !== undefined ? formatDuration(n.seconds) : '',
      ].filter(Boolean).join(' · ');
      const left = `${glyph(n.status)} ${n.id.padEnd(idPad)} ${color.faint(truncateToWidth(deps, Math.max(8, Math.floor(bodyWidth * 0.4)), '…'))}`;
      const metaText = color.faint(meta);
      const gap = Math.max(1, bodyWidth - visibleWidth(left) - visibleWidth(metaText));
      const rowText = `${left}${' '.repeat(gap)}${metaText}`;
      if (i === this.selectedIndex) {
        out.push(paintRow(chatTheme().modalBg, `  ${color.selected(padAnsi(rowText, bodyWidth))}  `, width));
      } else {
        out.push(line(`  ${rowText}`));
      }
    });

    // Detail box for the selected node.
    const sel = nodes[this.selectedIndex]!;
    out.push(line(''));
    out.push(line(`  ${color.faint('─'.repeat(Math.max(1, bodyWidth)))}`));
    const detailMeta = [
      sel.status,
      sel.model ? `model ${terminalInlineText(sel.model)}` : '',
      sel.tokens ? `${formatK(sel.tokens)} tok` : '',
      sel.seconds !== undefined ? formatDuration(sel.seconds) : '',
    ].filter(Boolean).join(' · ');
    out.push(line(`  ${glyph(sel.status)} ${color.text(sel.id)}  ${color.faint(detailMeta)}`));
    for (const wrapped of wrapTextWithAnsi(color.dim(terminalInlineText(sel.task)), bodyWidth).slice(0, 4)) {
      out.push(line(`  ${wrapped}`));
    }
    if (sel.detail) out.push(line(`  ${color.faint(`▸ ${truncateToWidth(terminalInlineText(sel.detail), bodyWidth - 2, '…')}`)}`));

    out.push(line(''));
    const hint = sel.sessionId ? 'enter open node transcript · ↑↓ move · esc close' : '↑↓ move · esc close (node not started)';
    out.push(line(`  ${color.faint(hint)}`));
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
  const width = Math.max(64, Math.min(110, Math.floor(o.tui.terminal.columns * 0.9)));
  handle = o.tui.showOverlay(modal, { anchor: 'center', width, maxHeight: 30, margin: 2 });
  handle.focus();
  o.tui.requestRender();
}
