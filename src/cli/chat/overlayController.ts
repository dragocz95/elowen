import type { Component, OverlayOptions, TUI } from '@earendil-works/pi-tui';
import { terminalSafeComponent } from '../ui/text.js';
import type { LayoutBudget } from './layoutBudget.js';
import { startScreenBox, startScreenInputTop, TOP_RULE_ROWS } from './startScreen.js';

type OverlayHandle = ReturnType<TUI['showOverlay']>;

export interface SuggestionGeometry {
  columns: number;
  rows: number;
  hasMessages: boolean;
  panelReserve: number;
  input: Component;
  notice: string;
  budget: LayoutBudget | null;
}

/** Sole overlay boundary. It terminal-projects every overlay (including pickers opened outside the chat
 * shell), records structural forced paints and owns named overlay handles for deterministic teardown. */
export class OverlayController {
  private readonly nativeShowOverlay: TUI['showOverlay'];
  private readonly handles = new Map<string, OverlayHandle>();
  private stopped = false;

  constructor(private readonly tui: TUI, private readonly forceRender: (reason: string) => void) {
    this.nativeShowOverlay = tui.showOverlay.bind(tui);
    tui.showOverlay = ((component, options) => this.open(component, options)) as TUI['showOverlay'];
  }

  show(name: string, component: Component, options: OverlayOptions): OverlayHandle {
    this.hide(name);
    const handle = this.open(component, options, name);
    this.handles.set(name, handle);
    return handle;
  }

  showSuggestion(name: 'slash' | 'mention', overlay: Component, geometry: SuggestionGeometry): OverlayHandle {
    const constrain = (value: number): number => {
      const maxRows = Math.max(1, Math.floor(value));
      (overlay as Component & { setMaxRows?: (rows: number) => void }).setMaxRows?.(maxRows);
      return maxRows;
    };
    if (!geometry.hasMessages) {
      const { boxWidth, leftPad } = startScreenBox(geometry.columns);
      const inputRows = geometry.input.render(boxWidth).length;
      const noticeRows = geometry.notice ? geometry.notice.split('\n').length : 0;
      const screenRows = Math.max(1, geometry.rows - TOP_RULE_ROWS);
      const shownInputRows = Math.min(inputRows, Math.max(0, screenRows - 1));
      const top = TOP_RULE_ROWS + startScreenInputTop(screenRows, inputRows, noticeRows) + shownInputRows;
      const maxHeight = constrain(Math.min(15, Math.max(1, geometry.rows - top)));
      return this.show(name, overlay, {
        anchor: 'top-left', width: boxWidth, maxHeight,
        margin: { top, left: leftPad, right: 0, bottom: 0 }, nonCapturing: true,
      });
    }

    const budget = geometry.budget;
    const bottom = budget
      ? budget.sections.queue + budget.sections.attachments + budget.sections.editor
        + budget.sections.status + budget.sections.hints
      : 1;
    const available = Math.max(1, geometry.rows - TOP_RULE_ROWS - bottom);
    const maxHeight = constrain(Math.min(15, available));
    return this.show(name, overlay, {
      anchor: 'bottom-left',
      width: Math.max(1, geometry.columns - geometry.panelReserve - 1),
      maxHeight,
      margin: { top: TOP_RULE_ROWS, left: 0, right: geometry.panelReserve, bottom },
      nonCapturing: true,
    });
  }

  get(name: string): OverlayHandle | null { return this.handles.get(name) ?? null; }

  hide(name: string): void { this.handles.get(name)?.hide(); }

  hideAll(): void {
    for (const handle of [...this.handles.values()]) handle.hide();
    this.handles.clear();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.hideAll();
    this.tui.showOverlay = this.nativeShowOverlay;
  }

  private open(component: Component, options?: OverlayOptions, name?: string): OverlayHandle {
    const native = this.nativeShowOverlay(terminalSafeComponent(component), options);
    this.forceRender('overlay:open');
    let closed = false;
    const wrapped: OverlayHandle = {
      ...native,
      hide: () => {
        if (closed) return;
        closed = true;
        native.hide();
        if (name && this.handles.get(name) === wrapped) this.handles.delete(name);
        this.forceRender('overlay:close');
      },
      setHidden: (hidden: boolean) => {
        const changed = native.isHidden() !== hidden;
        native.setHidden(hidden);
        if (changed) this.forceRender(hidden ? 'overlay:hide' : 'overlay:show');
      },
    };
    return wrapped;
  }
}
