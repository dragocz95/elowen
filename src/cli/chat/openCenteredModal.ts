import type { Component, Editor, Focusable, TUI } from '@earendil-works/pi-tui';

/** Open one of the CLI's centered, focus-capturing editor overlays (statusline, keybinds) with the shared
 *  restore/close choreography and adaptive width clamp. The caller supplies the component via `makeComponent`
 *  (built around the `close` callback it receives) plus its geometry: `longest` is the widest content line,
 *  clamped to `[minWidth, 90% of the terminal]` after adding `pad`. */
export function openCenteredModal(o: {
  tui: TUI;
  editor: Editor;
  makeComponent(close: () => void): Component & Focusable;
  longest: number;
  minWidth: number;
  pad: number;
  maxHeight: number;
}): void {
  const restore = (): void => { o.tui.setFocus(o.editor); o.tui.requestRender(); };
  let handle: ReturnType<TUI['showOverlay']> | null = null;
  const close = (): void => { handle?.hide(); handle = null; restore(); };
  const component = o.makeComponent(close);
  const width = Math.max(o.minWidth, Math.min(o.longest + o.pad, Math.floor(o.tui.terminal.columns * 0.9)));
  handle = o.tui.showOverlay(component, { anchor: 'center', width, maxHeight: o.maxHeight, margin: 2 });
  handle.focus();
  o.tui.requestRender();
}
