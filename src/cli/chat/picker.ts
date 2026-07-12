import { CURSOR_MARKER, SelectList, Editor, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { isBackspaceKey, isDownKey, isEnterKey, isEscapeKey, isUpKey } from './keys.js';
import type { SelectItem, TUI } from '@earendil-works/pi-tui';
import { getSelectListTheme } from '@earendil-works/pi-coding-agent';
import { color } from './theme.js';
import { padAnsi } from '../ui/text.js';
import { printableInput } from '../ui/prompts.js';

/** The Editor with an Esc hook: Esc aborts the streaming turn (unless the autocomplete popup is open —
 *  then Esc closes it, handled by the base class). */
export class ChatEditor extends Editor {
  static readonly MAX_CONTENT_ROWS = 6;
  private maxRows: number | null = null;

  /** Esc handler that returns whether it actually consumed the key. Returning false (e.g. nothing is
   *  streaming to interrupt) lets Esc fall through to the base Editor instead of being silently swallowed. */
  onEscape?: () => boolean;

  /** The shell owns the physical row budget. `null` restores the normal six-content-row composer cap;
   *  smaller terminal allocations reduce it without cropping blindly from the bottom. */
  setMaxRows(rows: number | null): void {
    this.maxRows = rows == null ? null : Math.max(0, Math.floor(rows));
  }

  override render(width: number): string[] {
    const rendered = super.render(width);
    const normalRows = ChatEditor.MAX_CONTENT_ROWS + 2; // PI editor's top and bottom rules
    const totalRows = Math.min(normalRows, this.maxRows ?? normalRows);
    if (totalRows <= 0 || rendered.length === 0) return [];
    if (rendered.length <= totalRows) return rendered;

    const topRule = rendered[0] ?? '';
    const bottomRule = rendered.at(-1) ?? '';
    const content = rendered.slice(1, -1);
    const cursorIndex = Math.max(0, content.findIndex((line) =>
      line.includes(CURSOR_MARKER) || line.includes('\x1b[7m')));

    // On extremely short terminals retain the actual cursor row before decorative rules.
    if (totalRows === 1) return [content[cursorIndex] ?? topRule];
    if (totalRows === 2) return [content[cursorIndex] ?? '', bottomRule];

    const capacity = totalRows - 2;
    const start = Math.max(0, Math.min(cursorIndex - capacity + 1, content.length - capacity));
    const shown = content.slice(start, start + capacity);
    const priorUp = Number(/↑\s+(\d+)\s+more/.exec(topRule)?.[1] ?? 0);
    const priorDown = Number(/↓\s+(\d+)\s+more/.exec(bottomRule)?.[1] ?? 0);
    const rule = (direction: '↑' | '↓', hidden: number, fallback: string): string => {
      if (hidden <= 0) return fallback;
      const indicator = `─── ${direction} ${hidden} more `;
      return this.borderColor(truncateToWidth(
        indicator + '─'.repeat(Math.max(0, width - visibleWidth(indicator))),
        width,
        '',
      ));
    };
    return [
      rule('↑', priorUp + start, topRule),
      ...shown,
      rule('↓', priorDown + Math.max(0, content.length - start - shown.length), bottomRule),
    ];
  }

  override handleInput(data: string): void {
    if (isEscapeKey(data) && !this.isShowingAutocomplete() && this.onEscape?.()) {
      return;
    }
    super.handleInput(data);
  }
}

/** Shape the stored conversations for the /resume picker (most recent first, as listed). `currentId`
 *  (the CLI's own bound conversation) takes the ▸ marker — falling back to the server's active flag for
 *  callers without a binding. A conversation some OTHER client stream holds shows `· attached`, so the
 *  user sees which ones a second terminal / the web dock is working in before resuming one. */
export function sessionItems(sessions: { id: string; title: string; model: string; updated_at: string; active: boolean; attached?: number }[], currentId?: string): SelectItem[] {
  return sessions.map((s) => {
    const current = currentId ? s.id === currentId : s.active;
    const attached = !current && (s.attached ?? 0) > 0;
    return {
      value: s.id,
      label: `${current ? '▸ ' : ''}${s.title || '(untitled)'}`,
      description: `${s.model}${s.updated_at ? ` · ${s.updated_at.slice(0, 16)}` : ''}${attached ? ' · attached' : ''}`,
    };
  });
}

/** Shape the configured models for the /model picker: the current model floats to the top. */
export function modelItems(models: { provider: string; providerLabel: string; model: string }[], currentModel: string): SelectItem[] {
  const items = models.map((m) => ({
    value: `${m.provider} ${m.model}`,
    label: `${m.model === currentModel ? '▸ ' : ''}${m.model}`,
    description: m.providerLabel,
  }));
  return [...items.filter((i) => i.label.startsWith('▸ ')), ...items.filter((i) => !i.label.startsWith('▸ '))];
}

/** Split a model picker value back into its provider/model selection. */
export function parseModelValue(value: string): { provider: string; model: string } {
  const [provider = '', model = ''] = value.split(' ');
  return { provider, model };
}

export interface PickerOpts {
  tui: TUI;
  editor: Editor;
  items: SelectItem[];
  title: string;
  onPick: (value: string) => void;
  footer?: string;
  onInput?: (data: string, selected: SelectItem | null, close: () => void) => boolean;
}

class PickerModal {
  private list: SelectList;
  private filter = '';
  private readonly allItems: SelectItem[];

  constructor(
    private readonly title: string,
    items: SelectItem[],
    private readonly onPick: (value: string) => void,
    private readonly onCancel: () => void,
    private readonly footer = 'enter select · esc close',
    private readonly onInput?: (data: string, selected: SelectItem | null, close: () => void) => boolean,
  ) {
    this.allItems = items;
    this.list = this.buildList(items);
  }

  private buildList(items: SelectItem[]): SelectList {
    const list = new SelectList(items, 12, getSelectListTheme(), {
      minPrimaryColumnWidth: 30,
      maxPrimaryColumnWidth: 44,
    });
    list.onSelect = (item) => this.onPick(item.value);
    list.onCancel = this.onCancel;
    return list;
  }

  // Filter on the visible LABEL (+ description), not `value` — SelectList.setFilter matches `value`, which
  // for the conversations/model/theme pickers is a UUID / internal id, so typing would empty the list.
  // We own the filtering and rebuild the list from the matches (small lists — cheap).
  private applyFilter(): void {
    const q = this.filter.trim().toLowerCase();
    const items = q
      ? this.allItems.filter((i) => `${i.label ?? ''} ${i.description ?? ''}`.toLowerCase().includes(q))
      : this.allItems;
    this.list = this.buildList(items);
  }

  invalidate(): void { this.list.invalidate(); }
  handleInput(data: string): void {
    // A caller hook (ctrl+d delete, ctrl+r rename, …) wins first.
    if (this.onInput?.(data, this.list.getSelectedItem(), this.onCancel)) return;
    // Type-to-filter — the footer advertises it, so it must actually work. Printable characters (incl.
    // pastes / kitty-protocol keys, via the shared decoder) narrow the list; backspace widens it.
    if (isBackspaceKey(data)) {
      this.filter = this.filter.slice(0, -1);
      this.applyFilter();
      return;
    }
    const printable = printableInput(data);
    if (printable) {
      this.filter += printable;
      this.applyFilter();
      return;
    }
    this.list.handleInput(data);
  }

  render(width: number): string[] {
    const bodyWidth = Math.max(1, width - 4);
    const titleBar = this.filter
      ? `  ${color.bold(color.text(this.title))}  ${color.faint('filter')} ${color.accent(this.filter)}`
      : `  ${color.bold(color.text(this.title))}${color.faint(' '.repeat(Math.max(1, bodyWidth - visibleTitle(this.title))) + 'esc')}`;
    return [
      color.modalBg(padAnsi(titleBar, width)),
      color.modalBg(padAnsi('', width)),
      ...this.list.render(bodyWidth).map((line) => color.modalBg(`  ${padAnsi(line, bodyWidth)}  `)),
      color.modalBg(padAnsi('', width)),
      color.modalBg(padAnsi(`  ${color.text(this.footer)}`, width)),
    ];
  }
}

function visibleTitle(title: string): number {
  return Math.min(24, title.length + 6);
}

/** The width one picker needs to show every row untruncated: the SelectList label column (its 30–44
 *  clamp mirrored here) + the longest description + chrome, also bounded below by the title/footer
 *  rows. Adaptive so a small picker stays compact while long rows (LSP install hints) get room. */
export function pickerContentWidth(items: SelectItem[], title: string, footer?: string): number {
  const labelW = Math.min(44, Math.max(30, ...items.map((i) => visibleWidth(i.label ?? String(i.value)))));
  return Math.max(
    ...items.map((i) => labelW + 2 + visibleWidth(i.description ?? '')),
    visibleTitle(title) + 24,
    visibleWidth(footer ?? 'enter select · esc close'),
  ) + 10; // list gutter + modal side padding
}

/** Show an arrow-key picker as a centered modal. Enter picks, Esc restores editor focus untouched. */
export function openPicker(o: PickerOpts): void {
  const restore = (): void => {
    o.tui.setFocus(o.editor);
    o.tui.requestRender();
  };
  if (o.items.length === 0) { restore(); return; }
  let handle: ReturnType<TUI['showOverlay']> | null = null;
  const close = (): void => {
    handle?.hide();
    handle = null;
    restore();
  };
  const modal = new PickerModal(o.title, o.items, (value) => {
    close();
    o.onPick(value);
  }, close, o.footer, o.onInput);
  // Adaptive width: exactly what the content needs, clamped to [44, 90% of the terminal] — a theme
  // picker stays a slim column while the LSP modal's install hints fit without truncation.
  const width = Math.max(44, Math.min(pickerContentWidth(o.items, o.title, o.footer), Math.floor(o.tui.terminal.columns * 0.9)));
  handle = o.tui.showOverlay(modal, {
    anchor: 'center',
    width,
    maxHeight: 24,
    margin: 2,
  });
  handle.focus();
  o.tui.requestRender();
}

class TextInputModal {
  private value: string;
  constructor(
    private readonly title: string,
    initial: string,
    private readonly onSubmit: (value: string) => void,
    private readonly onCancel: () => void,
  ) { this.value = initial; }
  invalidate(): void { /* state driven */ }
  handleInput(data: string): void {
    if (isEscapeKey(data)) { this.onCancel(); return; }
    if (isEnterKey(data)) { this.onSubmit(this.value); return; }
    if (isBackspaceKey(data)) { this.value = this.value.slice(0, -1); return; }
    // Shared printable decoder → pasted titles and kitty-protocol keys land instead of being dropped for
    // starting with ESC (bracketed paste is one `\x1b[200~…` chunk).
    this.value += printableInput(data);
  }
  render(width: number): string[] {
    const bodyWidth = Math.max(1, width - 4);
    const shown = this.value || color.faint('(empty)');
    return [
      color.modalBg(padAnsi(`  ${color.bold(color.text(this.title))}${color.faint(' '.repeat(Math.max(1, bodyWidth - visibleTitle(this.title))) + 'esc')}`, width)),
      color.modalBg(padAnsi('', width)),
      color.modalBg(`  ${padAnsi(color.text(shown), bodyWidth)}  `),
      color.modalBg(padAnsi('', width)),
      color.modalBg(padAnsi(`  ${color.text('enter save')} ${color.faint('·')} ${color.text('esc cancel')}`, width)),
    ];
  }
}

export function openTextInput(o: { tui: TUI; editor: Editor; title: string; initial?: string; onSubmit: (value: string) => void }): void {
  const restore = (): void => { o.tui.setFocus(o.editor); o.tui.requestRender(); };
  let handle: ReturnType<TUI['showOverlay']> | null = null;
  const close = (): void => { handle?.hide(); handle = null; restore(); };
  const modal = new TextInputModal(o.title, o.initial ?? '', (value) => { close(); o.onSubmit(value); }, close);
  handle = o.tui.showOverlay(modal, { anchor: 'center', width: '60%', minWidth: 64, maxHeight: 8, margin: 2 });
  handle.focus();
  o.tui.requestRender();
}

/** A read-only, scrollable info modal (esc/enter/q closes) in the same chrome as the pickers. Each row
 *  is a pre-rendered, possibly-ANSI-coloured line. Used for /status and any "show me this data" panel. */
class InfoModal {
  private scroll = 0;
  constructor(
    private readonly title: string,
    private readonly lines: string[],
    private readonly onClose: () => void,
    private readonly footer = 'esc close',
    private readonly viewport = 16,
  ) {}
  invalidate(): void { /* state driven */ }
  handleInput(data: string): void {
    if (isEscapeKey(data) || isEnterKey(data) || data === 'q') { this.onClose(); return; }
    const maxScroll = Math.max(0, this.lines.length - this.viewport);
    if (isDownKey(data)) this.scroll = Math.min(maxScroll, this.scroll + 1);
    else if (isUpKey(data)) this.scroll = Math.max(0, this.scroll - 1);
  }
  render(width: number): string[] {
    const bodyWidth = Math.max(1, width - 4);
    const shown = this.lines.slice(this.scroll, this.scroll + this.viewport);
    const more = this.lines.length > this.viewport ? ` ${this.scroll + shown.length}/${this.lines.length}` : '';
    return [
      color.modalBg(padAnsi(`  ${color.bold(color.text(this.title))}${color.faint(' '.repeat(Math.max(1, bodyWidth - visibleTitle(this.title))) + 'esc')}`, width)),
      color.modalBg(padAnsi('', width)),
      ...shown.map((line) => color.modalBg(`  ${padAnsi(line, bodyWidth)}  `)),
      color.modalBg(padAnsi('', width)),
      color.modalBg(padAnsi(`  ${color.text(this.footer)}${color.faint(more)}`, width)),
    ];
  }
}

export function openInfoModal(o: { tui: TUI; editor: Editor; title: string; lines: string[]; footer?: string }): void {
  const restore = (): void => { o.tui.setFocus(o.editor); o.tui.requestRender(); };
  let handle: ReturnType<TUI['showOverlay']> | null = null;
  const close = (): void => { handle?.hide(); handle = null; restore(); };
  const modal = new InfoModal(o.title, o.lines.length ? o.lines : [color.faint('nothing to show')], close, o.footer);
  // Adaptive like the picker: as wide as the longest line, clamped to [50, 90% of the terminal].
  const width = Math.max(50, Math.min(
    Math.max(...o.lines.map((l) => visibleWidth(l)), 0, visibleTitle(o.title) + 24) + 8,
    Math.floor(o.tui.terminal.columns * 0.9),
  ));
  handle = o.tui.showOverlay(modal, { anchor: 'center', width, maxHeight: 26, margin: 2 });
  handle.focus();
  o.tui.requestRender();
}
