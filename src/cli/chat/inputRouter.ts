import type { TUI } from '@earendil-works/pi-tui';
import type { ChatState } from './chatState.js';
import type { ChatEditor } from './picker.js';
import type { StreamCoordinatorPort } from './streamCoordinator.js';
import type { KeybindAction, Keymap } from './keys.js';
import {
  isDownKey, isEnterKey, isEscapeKey, isKeyRelease, isPageDownKey, isPageUpKey, isTabByte, isUpKey,
} from './keys.js';
import { mouseClick, mouseEvent, mouseWheel } from './terminalProtocol.js';
import type { ChatViewport } from './chatViewport.js';
import type { CardPanel, SubagentPanel } from './components.js';
import type { TelemetryPanel } from './telemetryPanel.js';
import type { LayoutBudget } from './layoutBudget.js';
import type { MentionOverlay, SlashOverlay } from './suggestionOverlay.js';
import { TOP_RULE_ROWS } from './startScreen.js';
import type { AnimationController } from './animationController.js';
import { color } from './theme.js';

export type InputRouteResult = { consume: boolean } | undefined;

interface LeaderInputState {
  pending(): boolean;
  resolve(data: string): KeybindAction | null;
  arm(): void;
}

export interface ChatInputContext {
  state: ChatState;
  term: { columns: number; write(data: string): void };
  editor: ChatEditor;
  stream: StreamCoordinatorPort;
  quit(): void;
  renderForced(reason?: string): void;
  keymap(): Keymap;
  leader(): LeaderInputState;
  dispatchAction(action: KeybindAction): void;
  render(reason?: string): void;
  animations: AnimationController;
  hasMessages(): boolean;
  activeViewport(): ChatViewport;
  panelVisible(): boolean;
  panelLeftEdge(): number;
  setPanelWidth(width: number): void;
  telemetry: TelemetryPanel;
  killProcess(id: string): void;
  openWorkflowModal(workflowId: string): void;
  rowBudget(): LayoutBudget;
  subPanel: SubagentPanel;
  cardPanel: CardPanel;
  chatWidth(): number;
  slashOverlay(): SlashOverlay | null;
  mentionOverlay(): MentionOverlay | null;
  closeSlash(): void;
  closeMention(): void;
  openSlash(): void;
  openMention(): void;
  insertMention(value: string): void;
}

/** Owns the single global listener and all raw key/mouse hit testing. Shell components expose geometry and
 * actions through ChatInputContext; no second module interprets terminal mouse sequences. */
export class InputRouter {
  private removeListener: (() => void) | null = null;
  private resizingPanel = false;
  private draggingHistory = false;
  private draggedViewport: ChatViewport | null = null;
  private historyTimer: ReturnType<typeof setTimeout> | null = null;
  private lastScrollDragRow = 0;

  constructor(private readonly tui: TUI, private readonly context: ChatInputContext) {}

  attach(): void {
    if (this.removeListener) return;
    this.removeListener = this.tui.addInputListener((data) => this.route(data));
  }

  stop(): void {
    this.cancelHistoryDrag();
    this.resizingPanel = false;
    this.removeListener?.();
    this.removeListener = null;
  }

  cancelPanelResize(): void { this.resizingPanel = false; }

  /** Row index inside the compact fallback stack (sub-agents + cards) for a 1-based screen row `y`, or a
   * negative value when `y` sits above it. The fallback panels render flush under the transcript; the
   * telemetry rail owns its own hit testing. Shared by the click and wheel routes so both agree on the
   * panel band. */
  private fallbackPanelRow(y: number): number {
    const panelsTop = TOP_RULE_ROWS + this.context.rowBudget().sections.transcript + 1;
    return y - panelsTop;
  }

  private route(data: string): InputRouteResult {
    // pi-tui negotiates the Kitty keyboard protocol with flag 2 ("report event types"), so a terminal
    // that supports it (notably VS Code's integrated terminal) delivers a separate RELEASE event for
    // every keypress. We bind on the press only — without this guard each key would fire twice (a single
    // ↑/↓ moves two rows, one ctrl+r cycles reasoning twice). Held-key REPEAT events are kept so
    // arrow-scroll still auto-repeats; pi-tui's own Editor/SelectList filter releases the same way.
    if (isKeyRelease(data)) return { consume: true };
    const context = this.context;
    const { state: rt, stream, editor, term } = context;
    const keymap = context.keymap();
    const event = mouseEvent(data);
    if (event) {
      const release = !event.down || event.code === 3;
      const primaryDrag = event.down && (event.code === 0 || event.code === 32);
      if (this.draggingHistory && release) { this.cancelHistoryDrag(); return { consume: true }; }
      if (this.draggingHistory && primaryDrag) {
        context.render('scroll:drag');
        context.animations.nudgeMascot(this.lastScrollDragRow - event.y);
        this.lastScrollDragRow = event.y;
        const pending = this.draggedViewport?.updateScrollbarDrag(event.y) ?? false;
        this.scheduleHistoryContinuation(pending);
        return { consume: true };
      }
      if (primaryDrag && context.hasMessages() && context.activeViewport().isScrollbarHit(event.x, event.y)) {
        this.draggingHistory = true;
        this.lastScrollDragRow = event.y;
        this.draggedViewport = context.activeViewport();
        context.render('scroll:drag-start');
        this.scheduleHistoryContinuation(this.draggedViewport.beginScrollbarDrag(event.y));
        return { consume: true };
      }
      if (context.panelVisible()) {
        const edge = context.panelLeftEdge();
        if (this.resizingPanel && release) { this.resizingPanel = false; return { consume: true }; }
        if (this.resizingPanel && event.down) {
          context.setPanelWidth(Math.max(36, Math.min(68, term.columns - event.x + 1)));
          context.renderForced('geometry:telemetry-resize');
          return { consume: true };
        }
        if (event.down && event.code === 0 && Math.abs(event.x - edge) <= 1) {
          this.resizingPanel = true;
          return { consume: true };
        }
      }
    }

    const noModal = editor.focused && !context.slashOverlay() && !context.mentionOverlay() && context.hasMessages();
    const click = mouseClick(data);
    if (click && noModal && context.panelVisible() && click.x > context.panelLeftEdge()) {
      const localRow = click.y - TOP_RULE_ROWS - 1;
      const localX = click.x - context.panelLeftEdge();
      if (context.telemetry.isWorkflowHeaderRow(localRow)) {
        context.telemetry.toggleWorkflows();
        context.render('input:workflow-toggle');
        return { consume: true };
      }
      const workflow = context.telemetry.workflowAt(localRow);
      if (workflow) { context.openWorkflowModal(workflow); return { consume: true }; }
      if (context.telemetry.isSubagentHeaderRow(localRow)) {
        context.telemetry.toggleSubagents();
        context.render('input:subagents-toggle');
        return { consume: true };
      }
      const subagent = context.telemetry.subagentAt(localRow);
      if (subagent) { void stream.openSubagent(subagent); return { consume: true }; }
      if (context.telemetry.isProcessHeaderRow(localRow)) {
        context.telemetry.toggleProcesses();
        context.render('input:process-toggle');
        return { consume: true };
      }
      const killId = context.telemetry.processKillAt(localRow, localX);
      if (killId) { context.killProcess(killId); return { consume: true }; }
    }
    if (click && noModal && !rt.childView) {
      const subagent = context.activeViewport().subagentAt(click.x, click.y);
      if (subagent) { void stream.openSubagent(subagent); return { consume: true }; }
      // The transcript marker reuses the rail's modal verbatim — and is the only way back into a workflow
      // that has already finished, since the rail carries running ones only.
      const workflow = context.activeViewport().workflowAt(click.x, click.y);
      if (workflow) { context.openWorkflowModal(workflow); return { consume: true }; }
    }
    if (click && noModal && context.activeViewport().isExpandableRow(click.x, click.y)) {
      context.activeViewport().toggleExpandable(click.y);
      // Thoughts, tool output and diff toggles all change transcript height. Treat them as geometry
      // transitions so PI drops its old diff surface instead of reconciling rows at stale positions.
      context.renderForced('geometry:transcript-expand');
      return { consume: true };
    }
    if (click && noModal) {
      const subRelative = this.fallbackPanelRow(click.y);
      const renderedSubRows = context.subPanel.render(context.chatWidth()).length;
      if (subRelative >= 0 && context.subPanel.isHeaderRow(subRelative)) {
        context.subPanel.toggleCollapsed();
        context.render('input:subagents-toggle');
        return { consume: true };
      }
      const target = subRelative >= 0 ? context.subPanel.targetAt(subRelative) : null;
      if (target) { void stream.openSubagent(target); return { consume: true }; }
      const cardRelative = subRelative - renderedSubRows;
      if (cardRelative >= 0 && context.cardPanel.isMoreRow(cardRelative)) {
        context.cardPanel.toggleExpanded();
        context.renderForced('geometry:todos-expand');
        return { consume: true };
      }
      if (cardRelative >= 0 && context.cardPanel.isHeaderRow(cardRelative)) {
        context.cardPanel.toggleCollapsed();
        context.render('input:todos-toggle');
        return { consume: true };
      }
    }
    const wheel = mouseWheel(data);
    if (wheel && noModal && event && context.panelVisible() && event.x > context.panelLeftEdge()
      && context.telemetry.canScrollWorkflows()) {
      if (context.telemetry.scrollWorkflows(wheel)) context.render('scroll:workflow');
      return { consume: true };
    }
    if (wheel && noModal && event && context.panelVisible() && event.x > context.panelLeftEdge()
      && context.telemetry.canScrollSubagents()) {
      if (context.telemetry.scrollSubagents(wheel)) context.render('scroll:subagents');
      // Keep wheel ownership stable at both ends of the list: reaching its boundary must not suddenly
      // start moving the transcript underneath the pointer.
      return { consume: true };
    }
    // Narrow terminals drop the rail and render the sub-agent list as a compact fallback under the
    // transcript (subPanel is populated only then — the two are mutually exclusive). Give that panel the
    // same wheel ownership while the pointer sits over it, instead of leaking the scroll to the transcript.
    if (wheel && noModal && event && context.subPanel.canScroll()) {
      const subRelative = this.fallbackPanelRow(event.y);
      const renderedSubRows = context.subPanel.render(context.chatWidth()).length;
      if (subRelative >= 0 && subRelative < renderedSubRows) {
        if (context.subPanel.scroll(wheel)) context.render('scroll:subagents');
        return { consume: true };
      }
    }
    if (wheel && noModal) {
      context.render('scroll:wheel');
      context.activeViewport().scroll(wheel);
      context.animations.nudgeMascot(Math.sign(wheel));
      return { consume: true };
    }
    if (event && noModal) {
      if (event.down && event.code === 0 && context.activeViewport().beginSelect(event.x, event.y)) return { consume: true };
      if (event.down && event.code === 32 && context.activeViewport().hasSelection()) {
        context.activeViewport().dragSelect(event.y);
        context.render('input:copy-drag');
        return { consume: true };
      }
      if ((!event.down || event.code === 3) && context.activeViewport().hasSelection()) {
        const text = context.activeViewport().takeSelection();
        context.render('input:copy-release');
        if (text) {
          term.write(`\x1b]52;c;${Buffer.from(text.slice(0, 100_000)).toString('base64')}\x07`);
          const count = text.split('\n').length;
          rt.notice = color.success(`✓ Copied ${count} line${count === 1 ? '' : 's'}`);
          context.render('input:copied');
          context.animations.scheduleVisual('copy-notice', 1_800, () => {
            if (rt.notice.includes('Copied')) { rt.notice = ''; context.render('state:copy-notice-clear'); }
          });
        }
        return { consume: true };
      }
    }

    if (keymap.matches('quit', data)) { context.quit(); return { consume: true }; }
    const leader = context.leader();
    if (leader.pending() && !event) {
      const action = leader.resolve(data);
      context.render('input:leader-resolve');
      if (action) context.dispatchAction(action);
      return { consume: true };
    }
    const mention = context.mentionOverlay();
    if (editor.focused && mention) {
      if (isEscapeKey(data)) { context.closeMention(); return { consume: true }; }
      if (isUpKey(data)) { mention.moveSelection(-1); context.render('input:mention-up'); return { consume: true }; }
      if (isDownKey(data)) { mention.moveSelection(1); context.render('input:mention-down'); return { consume: true }; }
      if (isTabByte(data) || isEnterKey(data)) {
        const value = mention.selectedValue();
        if (value) { context.insertMention(value); return { consume: true }; }
        context.closeMention();
        return isTabByte(data) ? { consume: true } : undefined;
      }
    }
    const slash = context.slashOverlay();
    if (editor.focused && slash) {
      if (isEscapeKey(data)) { context.closeSlash(); return { consume: true }; }
      if (isUpKey(data)) { slash.moveSelection(-1); context.render('input:slash-up'); return { consume: true }; }
      if (isDownKey(data)) { slash.moveSelection(1); context.render('input:slash-down'); return { consume: true }; }
      if (isTabByte(data)) {
        const value = slash.selectedValue();
        context.closeSlash();
        if (value) { editor.setText(`${value} `); context.render('input:slash-complete'); }
        return { consume: true };
      }
      if (isEnterKey(data)) {
        const value = slash.selectedValue();
        context.closeSlash();
        if (value) { editor.setText(''); editor.onSubmit?.(value); return { consume: true }; }
        return undefined;
      }
    }

    const editing = editor.focused && !slash && !mention;
    if (editing && keymap.isLeader(data)) { leader.arm(); context.render('input:leader-arm'); return { consume: true }; }
    const action = editing ? keymap.directAction(data) : null;
    // Ctrl+B is also the editor's standard backward-character chord. Claim it only while a real
    // foreground delegate can be detached; otherwise PI's editor keeps its native cursor behavior.
    if (action === 'subagent_background'
      && !stream.subagentStates().some((agent) => agent.status === 'running' && agent.background !== true)) {
      return undefined;
    }
    if (action) { context.dispatchAction(action); return { consume: true }; }
    if (editing && editor.getText() === '' && data === '/') {
      context.openSlash();
      return undefined;
    }
    if (editing && data === '@' && !rt.childView) {
      const cursor = editor.getCursor();
      const line = editor.getLines()[cursor.line] ?? '';
      const previous = cursor.col > 0 ? line[cursor.col - 1]! : '';
      if (!previous || /\s/.test(previous)) context.openMention();
      return undefined;
    }
    if (noModal && isPageUpKey(data)) {
      context.render('scroll:page-up');
      context.activeViewport().scroll(4);
      context.animations.nudgeMascot(1);
      return { consume: true };
    }
    if (noModal && isPageDownKey(data)) {
      context.render('scroll:page-down');
      context.activeViewport().scroll(-4);
      context.animations.nudgeMascot(-1);
      return { consume: true };
    }
    return undefined;
  }

  private cancelHistoryDrag(): void {
    if (this.historyTimer) clearTimeout(this.historyTimer);
    this.historyTimer = null;
    this.draggedViewport?.endScrollbarDrag();
    this.draggedViewport = null;
    this.draggingHistory = false;
  }

  private scheduleHistoryContinuation(needed: boolean): void {
    if (!needed || !this.draggingHistory || !this.draggedViewport) {
      if (this.historyTimer) clearTimeout(this.historyTimer);
      this.historyTimer = null;
      return;
    }
    if (this.historyTimer) return;
    this.historyTimer = setTimeout(() => {
      this.historyTimer = null;
      if (!this.draggingHistory || !this.draggedViewport) return;
      this.context.render('scroll:drag-index');
      const pending = this.draggedViewport.continueScrollbarDrag();
      this.scheduleHistoryContinuation(pending);
    }, 16);
  }
}
