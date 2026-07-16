import { matchesKey, visibleWidth } from '@earendil-works/pi-tui';
import type { Component, Editor, Focusable, TUI } from '@earendil-works/pi-tui';
import {
  KEYBIND_ACTIONS, activeKeymap, chordFromInput, createKeymap, initKeymap, isDownKey, isEnterKey,
  isEscapeKey, isKeyRelease, isUpKey, keybindDefault, keybindRows, parseKeybind,
} from './keys.js';
import type { KeybindAction, KeybindRow, Keymap } from './keys.js';
import { loadPrefs, savePrefs } from './prefs.js';
import { chatTheme, color, paintRow } from './theme.js';
import { padAnsi } from '../ui/text.js';

/** The editor's state machine: browsing the list, or waiting to capture the next keypress as a chord
 *  (`capture`) / the second key of a leader sequence (`capture2`). */
type Mode = 'list' | 'capture' | 'capture2';

/** Canonicalize a chord spec to a stable string ("ctrl+t", "leader t", "shift+tab,ctrl+tab") for
 *  equality checks — null when the spec is invalid. Lets the editor tell "rebound to the default" from
 *  a genuine customization without depending on the raw text the user (or file) happened to type. */
function canon(spec: string, action: KeybindAction): string | null {
  const p = parseKeybind(spec, { forLeader: action === 'leader' });
  return p.ok ? p.bindings.map((b) => (b.leader ? `leader ${b.chord.id}` : b.chord.id)).join(',') : null;
}

export interface KeybindsEditorOpts {
  tui: TUI;
  /** Restore focus here (and close the overlay) on esc. */
  onClose(): void;
  /** Apply the just-persisted keymap to the running session without a restart (shell.reloadKeymap). */
  reload(): void;
}

/** The interactive /keybinds editor: an arrow-key list of every rebindable action with its live chord.
 *  Enter captures the next keypress as the new binding (pressing the leader first composes a leader
 *  sequence); x unbinds, r resets to default. Every change persists to cli-prefs.json AND live-applies
 *  through initKeymap + reload, so the new shortcut works the instant it is set. */
export class KeybindsEditor implements Component, Focusable {
  private _focused = false;
  private selectedIndex = 0;
  private mode: Mode = 'list';
  private error: string | null = null;
  /** The persisted overrides map — the single source we save; live keymap is derived from it. */
  private overrides: Record<string, string>;
  private keymap: Keymap;
  private rows: KeybindRow[];

  constructor(private readonly opts: KeybindsEditorOpts) {
    this.overrides = { ...(loadPrefs().keybinds ?? {}) };
    this.keymap = activeKeymap();
    this.rows = keybindRows(this.keymap);
  }

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; }
  invalidate(): void { /* stateless render from current fields */ }

  private currentAction(): KeybindAction { return KEYBIND_ACTIONS[this.selectedIndex]!; }

  private move(delta: number): void {
    const n = KEYBIND_ACTIONS.length;
    this.selectedIndex = (this.selectedIndex + delta + n) % n;
    this.opts.tui.requestRender();
  }

  /** Rebuild the persisted map from a single-action change, then persist + live-apply. Passing null for
   *  `spec` resets the action (drops the override); a spec equal to the default is pruned the same way. */
  private setBinding(action: KeybindAction, spec: string | null): void {
    const next = { ...this.overrides };
    if (spec === null || canon(spec, action) === canon(keybindDefault(action), action)) delete next[action];
    else next[action] = spec;
    this.overrides = next;
    // Persist first, then swap the module-level active keymap and reload the running shell around it.
    savePrefs({ keybinds: this.overrides });
    initKeymap(this.overrides);
    this.keymap = activeKeymap();
    this.rows = keybindRows(this.keymap);
    this.opts.reload();
    this.opts.tui.requestRender();
  }

  private capture(data: string): void {
    if (isEscapeKey(data)) { this.mode = 'list'; this.opts.tui.requestRender(); return; }
    const action = this.currentAction();
    // Pressing the leader chord (for any action but the leader itself) composes a leader sequence — the
    // next key becomes the one bound behind the leader (so theme_picker → "leader t" interactively).
    if (action !== 'leader' && this.keymap.isLeader(data)) {
      this.mode = 'capture2';
      this.opts.tui.requestRender();
      return;
    }
    const spec = chordFromInput(data);
    if (!spec) { this.fail('unrecognized key — try a ctrl/alt chord, an f-key, or the leader then a key'); return; }
    const parsed = parseKeybind(spec, { forLeader: action === 'leader' });
    if (!parsed.ok) { this.fail(`${spec}: ${parsed.error}`); return; }
    this.mode = 'list';
    this.error = null;
    this.setBinding(action, spec);
  }

  private capture2(data: string): void {
    if (isEscapeKey(data)) { this.mode = 'list'; this.opts.tui.requestRender(); return; }
    const key = chordFromInput(data);
    if (!key) { this.fail('unrecognized key for the leader sequence'); return; }
    const action = this.currentAction();
    const spec = `leader ${key}`;
    const parsed = parseKeybind(spec, { forLeader: action === 'leader' });
    if (!parsed.ok) { this.fail(`${spec}: ${parsed.error}`); return; }
    this.mode = 'list';
    this.error = null;
    this.setBinding(action, spec);
  }

  private fail(message: string): void {
    this.mode = 'list';
    this.error = message;
    this.opts.tui.requestRender();
  }

  handleInput(data: string): void {
    if (isKeyRelease(data)) return; // Kitty release edge — capture and navigation act on the press only
    if (this.mode === 'capture') { this.capture(data); return; }
    if (this.mode === 'capture2') { this.capture2(data); return; }
    if (isEscapeKey(data)) { this.opts.onClose(); return; }
    if (isUpKey(data)) { this.move(-1); return; }
    if (isDownKey(data)) { this.move(1); return; }
    if (isEnterKey(data)) { this.error = null; this.mode = 'capture'; this.opts.tui.requestRender(); return; }
    if (data === 'r') { this.error = null; this.setBinding(this.currentAction(), null); return; }
    if (data === 'x' || matchesKey(data, 'delete')) { this.error = null; this.setBinding(this.currentAction(), 'none'); return; }
  }

  render(width: number): string[] {
    const bodyWidth = Math.max(1, width - 4);
    const pad = Math.max(...KEYBIND_ACTIONS.map((a) => a.length)) + 2;
    const line = (s: string): string => paintRow(chatTheme().modalBg, s, width);
    const out: string[] = [];
    out.push(line(`  ${color.bold(color.text('Keybinds'))}${color.faint(`${' '.repeat(Math.max(1, bodyWidth - 12))}esc`)}`));
    out.push(line(''));

    this.rows.forEach((r, i) => {
      const chordText = (r.chord ?? '—').padEnd(16);
      const markerText = r.chord === null ? 'unbound' : r.custom ? 'custom' : 'default';
      if (i === this.selectedIndex) {
        const plain = `${r.action.padEnd(pad)}${chordText}${markerText}`;
        out.push(paintRow(chatTheme().modalBg, `  ${color.selected(padAnsi(plain, bodyWidth))}  `, width));
      } else {
        const chord = r.chord ? color.accent(chordText) : color.faint(chordText);
        const marker = r.chord === null ? color.faint('unbound') : r.custom ? color.warning('custom') : color.faint('default');
        out.push(line(`  ${color.text(r.action.padEnd(pad))}${chord}${marker}`));
      }
    });

    out.push(line(''));
    const action = this.currentAction();
    if (this.mode === 'capture') {
      out.push(line(`  ${color.accent(`press a chord for ${action}…`)}  ${color.faint('press the leader first for a leader sequence · esc cancel')}`));
    } else if (this.mode === 'capture2') {
      const lead = this.keymap.chordLabel('leader') ?? 'leader';
      out.push(line(`  ${color.accent(`${lead} … now press the second key for ${action}`)}  ${color.faint('esc cancel')}`));
    } else if (this.error) {
      out.push(line(`  ${color.error(`! ${this.error}`)}`));
    } else {
      out.push(line(`  ${color.faint('enter rebind · x unbind · r reset · ↑↓ move · esc close')}`));
    }

    if (this.keymap.warnings.length) {
      out.push(line(''));
      for (const w of this.keymap.warnings) out.push(line(`  ${color.error(`! ${w}`)}`));
    }
    return out;
  }
}

/** Show the interactive keybind editor as a centered, focus-capturing overlay (same chrome + restore
 *  contract as the pickers). `reload` live-applies each rebind to the running session. */
export function openKeybindsEditor(o: { tui: TUI; editor: Editor; reload(): void }): void {
  const restore = (): void => { o.tui.setFocus(o.editor); o.tui.requestRender(); };
  let handle: ReturnType<TUI['showOverlay']> | null = null;
  const close = (): void => { handle?.hide(); handle = null; restore(); };
  const editor = new KeybindsEditor({ tui: o.tui, onClose: close, reload: o.reload });
  // Wide enough for the longest chord label / warning line, clamped to [60, 90% of the terminal].
  const longest = Math.max(
    ...keybindRows(createKeymap()).map((r) => (r.chord ?? '').length),
    ...createKeymap().warnings.map((w) => w.length),
    visibleWidth('enter rebind · x unbind · r reset · ↑↓ move · esc close'),
  );
  const width = Math.max(60, Math.min(longest + 40, Math.floor(o.tui.terminal.columns * 0.9)));
  handle = o.tui.showOverlay(editor, { anchor: 'center', width, maxHeight: 26, margin: 2 });
  handle.focus();
  o.tui.requestRender();
}
