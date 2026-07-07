import { SelectList, Editor, matchesKey } from '@earendil-works/pi-tui';
import type { SelectItem, TUI } from '@earendil-works/pi-tui';
import { getSelectListTheme } from '@earendil-works/pi-coding-agent';
import { color } from './theme.js';
import { padAnsi } from '../ui/text.js';
import { printableInput } from '../ui/prompts.js';

/** The Editor with an Esc hook: Esc aborts the streaming turn (unless the autocomplete popup is open —
 *  then Esc closes it, handled by the base class). */
export class ChatEditor extends Editor {
  /** Esc handler that returns whether it actually consumed the key. Returning false (e.g. nothing is
   *  streaming to interrupt) lets Esc fall through to the base Editor instead of being silently swallowed. */
  onEscape?: () => boolean;
  override handleInput(data: string): void {
    if (matchesKey(data, 'escape') && !this.isShowingAutocomplete() && this.onEscape?.()) {
      return;
    }
    super.handleInput(data);
  }
}

/** Shape the stored conversations for the /resume picker (most recent first, as listed). */
export function sessionItems(sessions: { id: string; title: string; model: string; updated_at: string; active: boolean }[]): SelectItem[] {
  return sessions.map((s) => ({
    value: s.id,
    label: `${s.active ? '▸ ' : ''}${s.title || '(untitled)'}`,
    description: `${s.model}${s.updated_at ? ` · ${s.updated_at.slice(0, 16)}` : ''}`,
  }));
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

  constructor(
    private readonly title: string,
    items: SelectItem[],
    private readonly onPick: (value: string) => void,
    private readonly onCancel: () => void,
    private readonly footer = 'enter select · esc close',
    private readonly onInput?: (data: string, selected: SelectItem | null, close: () => void) => boolean,
  ) {
    this.list = new SelectList(items, 12, getSelectListTheme(), {
      minPrimaryColumnWidth: 30,
      maxPrimaryColumnWidth: 34,
    });
    this.list.onSelect = (item) => this.onPick(item.value);
    this.list.onCancel = this.onCancel;
  }

  invalidate(): void { this.list.invalidate(); }
  handleInput(data: string): void {
    // A caller hook (ctrl+d delete, ctrl+r rename, …) wins first.
    if (this.onInput?.(data, this.list.getSelectedItem(), this.onCancel)) return;
    // Type-to-filter — the footer advertises it, so it must actually work. Printable characters (incl.
    // pastes / kitty-protocol keys, via the shared decoder) narrow the list; backspace widens it.
    if (matchesKey(data, 'backspace')) {
      this.filter = this.filter.slice(0, -1);
      this.list.setFilter(this.filter);
      return;
    }
    const printable = printableInput(data);
    if (printable) {
      this.filter += printable;
      this.list.setFilter(this.filter);
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
  handle = o.tui.showOverlay(modal, {
    anchor: 'center',
    width: 60,
    maxHeight: 22,
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
    if (matchesKey(data, 'escape')) { this.onCancel(); return; }
    if (matchesKey(data, 'enter')) { this.onSubmit(this.value); return; }
    if (matchesKey(data, 'backspace') || data === '\x7f') { this.value = this.value.slice(0, -1); return; }
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
  handle = o.tui.showOverlay(modal, { anchor: 'center', width: 64, maxHeight: 8, margin: 2 });
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
    if (matchesKey(data, 'escape') || matchesKey(data, 'enter') || data === 'q') { this.onClose(); return; }
    const maxScroll = Math.max(0, this.lines.length - this.viewport);
    if (data === '\x1b[B' || matchesKey(data, 'down')) this.scroll = Math.min(maxScroll, this.scroll + 1);
    else if (data === '\x1b[A' || matchesKey(data, 'up')) this.scroll = Math.max(0, this.scroll - 1);
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
  handle = o.tui.showOverlay(modal, { anchor: 'center', width: 66, maxHeight: 24, margin: 2 });
  handle.focus();
  o.tui.requestRender();
}
