import { SelectList, Text, Container, Editor, matchesKey } from '@earendil-works/pi-tui';
import type { SelectItem, TUI } from '@earendil-works/pi-tui';
import { getSelectListTheme } from '@earendil-works/pi-coding-agent';
import { color } from './theme.js';

/** The Editor with an Esc hook: Esc aborts the streaming turn (unless the autocomplete popup is open —
 *  then Esc closes it, handled by the base class). */
export class ChatEditor extends Editor {
  onEscape?: () => void;
  override handleInput(data: string): void {
    if (matchesKey(data, 'escape') && !this.isShowingAutocomplete() && this.onEscape) {
      this.onEscape();
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
  /** The layout slot normally holding the editor; the picker temporarily replaces it. */
  slot: Container;
  editor: Editor;
  items: SelectItem[];
  title: string;
  onPick: (value: string) => void;
}

/** Show an arrow-key picker in place of the editor (the pi modal pattern: swap the slot's child and
 *  move focus). Enter picks, Esc restores the editor untouched. */
export function openPicker(o: PickerOpts): void {
  const restore = (): void => {
    o.slot.clear();
    o.slot.addChild(o.editor);
    o.tui.setFocus(o.editor);
    o.tui.requestRender();
  };
  if (o.items.length === 0) { restore(); return; }
  const list = new SelectList(o.items, 10, getSelectListTheme());
  list.onSelect = (item) => { restore(); o.onPick(item.value); };
  list.onCancel = restore;
  o.slot.clear();
  o.slot.addChild(new Text(`  ${color.bold(o.title)}  ${color.faint('↑↓ select · ⏎ confirm · esc cancel')}`, 1, 0));
  o.slot.addChild(list);
  o.tui.setFocus(list);
  o.tui.requestRender();
}
