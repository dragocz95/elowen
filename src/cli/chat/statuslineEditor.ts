import { visibleWidth } from '@earendil-works/pi-tui';
import type { Component, Editor, Focusable, TUI } from '@earendil-works/pi-tui';
import { isDownKey, isEnterKey, isEscapeKey, isKeyRelease, isUpKey } from './keys.js';
import { chatTheme, color, paintRow } from './theme.js';
import { padAnsi } from '../ui/text.js';
import { openCenteredModal } from './openCenteredModal.js';
import type { StatuslineConfig } from './brainClient.js';

/** The statusline toggles editable from the CLI (keys mirror plugins/statusline/elowen-plugin.json's
 *  configSchema). `showModel` is deliberately absent: the CLI status bar forces it off (the model name
 *  already sits in the meta line above the composer — chatComposition.ts hard-codes showModel:false), so a
 *  toggle here would be inert. It stays a web-dock-only setting, editable in the plugin's config UI. */
const STATUSLINE_FIELDS: readonly { key: keyof StatuslineConfig; label: string; hint: string }[] = [
  { key: 'showContext', label: 'Context usage', hint: 'how full the context window is (percent + tokens)' },
  { key: 'showTokens', label: 'Total tokens', hint: "the conversation's cumulative token count" },
  { key: 'showCost', label: 'Cost', hint: "the conversation's cost (subscriptions report $0)" },
];

export interface StatuslineEditorOpts {
  tui: TUI;
  /** The current display toggles (from the live BrainStatus.statusline), or null when the plugin is off. */
  current: StatuslineConfig | null;
  /** Restore focus + close the overlay on esc. */
  onClose(): void;
  /** Persist the new values (server-side plugin config) and refresh the live status bar. `onError` is
   *  invoked when the save fails, so the editor can roll back the optimistic toggle. */
  save(values: StatuslineConfig, onError: () => void): void;
}

/** The interactive /statusline editor: a checkbox list of what the bottom status bar shows. Space/Enter
 *  toggles the highlighted item; each change persists to the statusline plugin's config and live-applies
 *  to the bar. Mirrors the /keybinds editor's chrome and restore contract. */
export class StatuslineEditor implements Component, Focusable {
  private _focused = false;
  private selectedIndex = 0;
  private values: StatuslineConfig;
  /** Bumped on every toggle so a save's error callback can tell whether it is still the latest intent. */
  private saveGeneration = 0;

  constructor(private readonly opts: StatuslineEditorOpts) {
    this.values = { ...(opts.current ?? {}) };
  }

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; }
  invalidate(): void { /* stateless render from current fields */ }

  private move(delta: number): void {
    const n = STATUSLINE_FIELDS.length;
    this.selectedIndex = (this.selectedIndex + delta + n) % n;
    this.opts.tui.requestRender();
  }

  private toggle(): void {
    const key = STATUSLINE_FIELDS[this.selectedIndex]!.key;
    const previous = this.values;
    const generation = ++this.saveGeneration;
    this.values = { ...this.values, [key]: !this.values[key] };
    // Persist + live-apply optimistically; the server reply refreshes the authoritative bar. On a save
    // failure, roll back so the checkbox never shows a state that was not persisted — but only if no newer
    // toggle has since superseded this one, otherwise a stale error would revert to an out-of-date state.
    this.opts.save({ ...this.values }, () => {
      if (generation !== this.saveGeneration) return;
      this.values = previous;
      this.opts.tui.requestRender();
    });
    this.opts.tui.requestRender();
  }

  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    if (isEscapeKey(data)) { this.opts.onClose(); return; }
    if (isUpKey(data)) { this.move(-1); return; }
    if (isDownKey(data)) { this.move(1); return; }
    if (isEnterKey(data) || data === ' ') { this.toggle(); return; }
  }

  render(width: number): string[] {
    const bodyWidth = Math.max(1, width - 4);
    const pad = Math.max(...STATUSLINE_FIELDS.map((f) => f.label.length)) + 2;
    const line = (s: string): string => paintRow(chatTheme().modalBg, s, width);
    const out: string[] = [];
    out.push(line(`  ${color.bold(color.text('Statusline'))}${color.faint(`${' '.repeat(Math.max(1, bodyWidth - 14))}esc`)}`));
    out.push(line(''));

    STATUSLINE_FIELDS.forEach((f, i) => {
      const on = this.values[f.key] === true;
      const box = on ? '[x]' : '[ ]';
      if (i === this.selectedIndex) {
        const plain = `${box} ${f.label.padEnd(pad)}${f.hint}`;
        out.push(paintRow(chatTheme().modalBg, `  ${color.selected(padAnsi(plain, bodyWidth))}  `, width));
      } else {
        const boxText = on ? color.accent(box) : color.faint(box);
        out.push(line(`  ${boxText} ${color.text(f.label.padEnd(pad))}${color.faint(f.hint)}`));
      }
    });

    out.push(line(''));
    out.push(line(`  ${color.faint('space toggle · ↑↓ move · esc close')}`));
    return out;
  }
}

/** Show the interactive statusline editor as a centered, focus-capturing overlay (same chrome + restore
 *  contract as the pickers). `save` persists each toggle to the plugin config and refreshes the bar. */
export function openStatuslineEditor(o: {
  tui: TUI;
  editor: Editor;
  current: StatuslineConfig | null;
  save(values: StatuslineConfig, onError: () => void): void;
}): void {
  const longest = Math.max(...STATUSLINE_FIELDS.map((f) => f.hint.length + f.label.length + 6), visibleWidth('space toggle · ↑↓ move · esc close'));
  openCenteredModal({
    tui: o.tui,
    editor: o.editor,
    makeComponent: (close) => new StatuslineEditor({ tui: o.tui, current: o.current, onClose: close, save: o.save }),
    longest,
    minWidth: 52,
    pad: 20,
    maxHeight: 14,
  });
}
