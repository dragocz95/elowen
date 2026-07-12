import type { TUI } from '@earendil-works/pi-tui';
import type { ChatState } from './chatState.js';
import type { ChatEditor } from './picker.js';
import type { StreamCoordinatorPort } from './streamCoordinator.js';
import type { KeybindAction, Keymap } from './keys.js';
import {
  isDownKey, isEnterKey, isEscapeKey, isPageDownKey, isPageUpKey, isTabByte, isUpKey,
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

  private route(data: string): InputRouteResult {
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
    }
    if (click && noModal && context.activeViewport().isThoughtRow(click.x, click.y)) {
      context.activeViewport().toggleThought(click.y);
      context.render('input:thought-toggle');
      return { consume: true };
    }
    if (click && noModal) {
      const budget = context.rowBudget();
      const panelsTop = TOP_RULE_ROWS + budget.sections.transcript + 1;
      const subRelative = click.y - panelsTop;
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
