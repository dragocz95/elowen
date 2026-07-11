import type { Component, OverlayHandle, OverlayOptions, TUI } from '@earendil-works/pi-tui';
import { terminalSafeComponent } from '../ui/text.js';
import type { LayoutBudget } from './layoutBudget.js';
import { startScreenBox, startScreenInputTop, TOP_RULE_ROWS } from './startScreen.js';

export interface SuggestionGeometry {
  columns: number;
  rows: number;
  hasMessages: boolean;
  panelReserve: number;
  input: Component;
  notice: string;
  budget: LayoutBudget | null;
}

export type OverlayOptionsSource = OverlayOptions | (() => OverlayOptions);

interface ManagedOverlay {
  readonly name?: string;
  readonly component: Component;
  readonly options: () => OverlayOptions | undefined;
  readonly handle: OverlayHandle;
  native: OverlayHandle;
  hidden: boolean;
  closed: boolean;
}

/** Sole overlay boundary. Every named or intercepted generic overlay becomes one stable managed record.
 * Native PI handles may be replaced on resize, while callers keep a stable handle that always targets the
 * current native overlay. This makes teardown and responsive geometry deterministic for picker overlays too. */
export class OverlayController {
  private readonly nativeShowOverlay: TUI['showOverlay'];
  private readonly records = new Set<ManagedOverlay>();
  private readonly named = new Map<string, ManagedOverlay>();
  private stopped = false;

  constructor(private readonly tui: TUI, private readonly forceRender: (reason: string) => void) {
    this.nativeShowOverlay = tui.showOverlay.bind(tui);
    tui.showOverlay = ((component, options) => this.open(component, options)) as TUI['showOverlay'];
  }

  show(name: string, component: Component, options: OverlayOptionsSource): OverlayHandle {
    this.hide(name);
    return this.open(component, options, name);
  }

  showSuggestion(
    name: 'slash' | 'mention',
    overlay: Component,
    geometry: () => SuggestionGeometry,
  ): OverlayHandle {
    return this.show(name, overlay, () => this.suggestionOptions(overlay, geometry()));
  }

  get(name: string): OverlayHandle | null { return this.named.get(name)?.handle ?? null; }

  hide(name: string): void { this.named.get(name)?.handle.hide(); }

  /** Reopen every live overlay against fresh terminal dimensions/options. Stable public handles remain
   * valid, hidden state survives, and the previously focused overlay is restored after the full stack. */
  reflow(): void {
    if (this.stopped || this.records.size === 0) return;
    const records = [...this.records];
    const focused = [...records].reverse().find((record) => record.native.isFocused());
    for (const record of records) {
      record.hidden = record.hidden || record.native.isHidden();
      record.native.hide();
      record.native = this.openNative(record);
      if (record.hidden) record.native.setHidden(true);
    }
    if (focused && !focused.hidden && !focused.closed) focused.native.focus();
    this.forceRender('overlay:reflow');
  }

  hideAll(): void {
    for (const record of [...this.records]) this.close(record);
    this.named.clear();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.hideAll();
    this.tui.showOverlay = this.nativeShowOverlay;
  }

  private open(component: Component, source?: OverlayOptionsSource, name?: string): OverlayHandle {
    const options = typeof source === 'function' ? source : () => source;
    let record!: ManagedOverlay;
    const handle: OverlayHandle = {
      hide: () => this.close(record),
      setHidden: (hidden) => {
        if (record.closed || record.hidden === hidden) return;
        record.hidden = hidden;
        record.native.setHidden(hidden);
        this.forceRender(hidden ? 'overlay:hide' : 'overlay:show');
      },
      isHidden: () => record.hidden || record.native.isHidden(),
      focus: () => { if (!record.closed && !record.hidden) record.native.focus(); },
      unfocus: (unfocusOptions) => { if (!record.closed) record.native.unfocus(unfocusOptions); },
      isFocused: () => !record.closed && record.native.isFocused(),
    };
    record = {
      ...(name ? { name } : {}), component, options, handle,
      native: null as unknown as OverlayHandle,
      hidden: false,
      closed: false,
    };
    record.native = this.openNative(record);
    this.records.add(record);
    if (name) this.named.set(name, record);
    this.forceRender('overlay:open');
    return handle;
  }

  private close(record: ManagedOverlay): void {
    if (record.closed) return;
    record.closed = true;
    this.records.delete(record);
    if (record.name && this.named.get(record.name) === record) this.named.delete(record.name);
    record.native.hide();
    this.forceRender('overlay:close');
  }

  private openNative(record: ManagedOverlay): OverlayHandle {
    return this.nativeShowOverlay(
      terminalSafeComponent(record.component),
      this.constrainOptions(record.options()),
    );
  }

  private suggestionOptions(overlay: Component, geometry: SuggestionGeometry): OverlayOptions {
    const constrainRows = (value: number): number => {
      const maxRows = Math.max(1, Math.floor(value));
      (overlay as Component & { setMaxRows?: (rows: number) => void }).setMaxRows?.(maxRows);
      return maxRows;
    };
    if (!geometry.hasMessages) {
      const { boxWidth, leftPad } = startScreenBox(geometry.columns);
      const screenRows = Math.max(1, geometry.rows - TOP_RULE_ROWS);
      const inputRows = Math.min(geometry.input.render(boxWidth).length, Math.max(0, screenRows - 1));
      const noticeRows = geometry.notice ? geometry.notice.split('\n').length : 0;
      const top = TOP_RULE_ROWS + startScreenInputTop(screenRows, inputRows, noticeRows) + inputRows;
      const maxHeight = constrainRows(Math.min(15, Math.max(1, geometry.rows - top)));
      return {
        anchor: 'top-left', width: boxWidth, maxHeight,
        margin: { top, left: leftPad, right: 0, bottom: 0 }, nonCapturing: true,
      };
    }

    const budget = geometry.budget;
    const bottom = budget
      ? budget.sections.queue + budget.sections.attachments + budget.sections.editor
        + budget.sections.status + budget.sections.hints
      : 1;
    const available = Math.max(1, geometry.rows - TOP_RULE_ROWS - bottom);
    const maxHeight = constrainRows(Math.min(15, available));
    return {
      anchor: 'bottom-left',
      width: Math.max(1, geometry.columns - geometry.panelReserve - 1),
      maxHeight,
      margin: { top: TOP_RULE_ROWS, left: 0, right: geometry.panelReserve, bottom },
      nonCapturing: true,
    };
  }

  /** Numeric values are preferred sizes, not terminal snapshots. Re-clamp the original request against
   * current dimensions on every open/reflow; percentage values remain PI-native and resolve per frame. */
  private constrainOptions(options: OverlayOptions | undefined): OverlayOptions | undefined {
    if (!options) return undefined;
    const terminal = (this.tui as TUI & { terminal?: { columns: number; rows: number } }).terminal;
    const columns = Math.max(1, Math.floor(terminal?.columns ?? Number.MAX_SAFE_INTEGER));
    const rows = Math.max(1, Math.floor(terminal?.rows ?? Number.MAX_SAFE_INTEGER));
    const margin = this.constrainMargin(options.margin, columns, rows);
    const horizontalMargin = typeof margin === 'number'
      ? margin * 2
      : (margin?.left ?? 0) + (margin?.right ?? 0);
    const verticalMargin = typeof margin === 'number'
      ? margin * 2
      : (margin?.top ?? 0) + (margin?.bottom ?? 0);
    const availableWidth = Math.max(1, columns - horizontalMargin);
    const availableHeight = Math.max(1, rows - verticalMargin);
    const width = typeof options.width === 'number'
      ? Math.max(1, Math.min(options.width, availableWidth))
      : options.width;
    const maxHeight = typeof options.maxHeight === 'number'
      ? Math.max(1, Math.min(options.maxHeight, availableHeight))
      : options.maxHeight;
    return {
      ...options,
      ...(margin === undefined ? {} : { margin }),
      ...(width === undefined ? {} : { width }),
      ...(options.minWidth === undefined ? {} : { minWidth: Math.max(1, Math.min(options.minWidth, availableWidth)) }),
      ...(maxHeight === undefined ? {} : { maxHeight }),
      ...(typeof options.row === 'number' ? { row: Math.max(0, Math.min(options.row, rows - 1)) } : {}),
      ...(typeof options.col === 'number' ? { col: Math.max(0, Math.min(options.col, columns - 1)) } : {}),
    };
  }

  private constrainMargin(
    margin: OverlayOptions['margin'],
    columns: number,
    rows: number,
  ): OverlayOptions['margin'] {
    if (margin === undefined) return undefined;
    if (typeof margin === 'number') return Math.max(0, Math.min(margin, Math.floor((Math.min(columns, rows) - 1) / 2)));
    return {
      top: Math.max(0, Math.min(margin.top ?? 0, rows - 1)),
      right: Math.max(0, Math.min(margin.right ?? 0, columns - 1)),
      bottom: Math.max(0, Math.min(margin.bottom ?? 0, rows - 1)),
      left: Math.max(0, Math.min(margin.left ?? 0, columns - 1)),
    };
  }
}
