import { isKeyRelease, matchesKey, parseKey } from '@earendil-works/pi-tui';
// Re-exported so every custom input handler filters key-RELEASE events from one place. The Kitty
// keyboard protocol (pi-tui negotiates flag 2) reports a release edge per keypress; a handler that acts
// on both edges fires twice (the VS Code integrated-terminal double-input). pi-tui's own Editor/SelectList
// already filter releases — our overlays must do the same.
export { isKeyRelease } from '@earendil-works/pi-tui';
import type { KeyId } from '@earendil-works/pi-tui';

/** The single seam for every key-string comparison in the chat TUI. Two layers live here:
 *  - fixed structural predicates (enter, esc, arrows, tab-complete, modal-local ctrl keys) that are
 *    NOT rebindable — they are load-bearing editor/picker mechanics;
 *  - the configurable keymap: user-facing shortcuts resolved through named actions whose chords come
 *    from `keybinds` in cli-prefs.json (defaults below), including opencode-style leader sequences. */

// ── fixed structural predicates ────────────────────────────────────────────────────────────────

/** Modal-local keys (rename/delete/load/uninstall/providers inside pickers) stay fixed on purpose:
 *  rebinding e.g. the global reasoning shortcut must not silently move "rename" in the sessions modal. */
export function isCtrlD(data: string): boolean { return matchesKey(data, 'ctrl+d'); }
export function isCtrlL(data: string): boolean { return matchesKey(data, 'ctrl+l'); }
export function isCtrlP(data: string): boolean { return matchesKey(data, 'ctrl+p'); }
export function isCtrlR(data: string): boolean { return matchesKey(data, 'ctrl+r'); }
export function isCtrlU(data: string): boolean { return matchesKey(data, 'ctrl+u'); }

export function isEscapeKey(data: string): boolean { return matchesKey(data, 'escape'); }
export function isEnterKey(data: string): boolean { return data === '\r' || matchesKey(data, 'enter'); }
export function isBackspaceKey(data: string): boolean { return matchesKey(data, 'backspace') || data === '\x7f'; }
export function isUpKey(data: string): boolean { return data === '\x1b[A' || matchesKey(data, 'up'); }
export function isDownKey(data: string): boolean { return data === '\x1b[B' || matchesKey(data, 'down'); }

/** The raw Tab byte only (also what ctrl+i sends) — used where Tab completes into the input and the
 *  broader `matchesKey('tab')` sequences must NOT trigger. */
export function isTabByte(data: string): boolean { return data === '\t'; }
/** Tab in any reported form (raw byte or kitty/modifyOtherKeys sequence). */
export function isTabKey(data: string): boolean { return data === '\t' || matchesKey(data, 'tab'); }

export function isPageUpKey(data: string): boolean { return data === '\x1b[5~'; }
export function isPageDownKey(data: string): boolean { return data === '\x1b[6~'; }

// ── configurable keybinds ──────────────────────────────────────────────────────────────────────

/** Every rebindable action in the chat TUI. The first block are the always-on shortcuts; the second
 *  are picker openers with leader-sequence defaults (press the leader, then the key). */
export type KeybindAction =
  | 'leader'
  | 'quit'
  | 'mode_toggle'
  | 'reasoning_cycle'
  | 'stash'
  | 'subagent_cycle'
  | 'subagent_background'
  | 'telemetry_toggle'
  | 'queue_remove'
  | 'help'
  | 'theme_picker'
  | 'model_picker'
  | 'sessions_picker';

/** Display/listing order for /keybinds. */
export const KEYBIND_ACTIONS: readonly KeybindAction[] = [
  'leader', 'quit', 'mode_toggle', 'reasoning_cycle', 'stash', 'subagent_cycle', 'subagent_background', 'telemetry_toggle',
  'queue_remove', 'help', 'theme_picker', 'model_picker', 'sessions_picker',
];

/** Default chord spec per action. Spec grammar (opencode-inspired):
 *  - comma-separated alternatives: `"shift+tab,ctrl+tab"`
 *  - a direct chord: modifiers `ctrl`/`shift`/`alt`/`super` + a base key (`ctrl+r`, `f2`, `pageup`)
 *  - a leader sequence: `"leader t"` — press the leader chord, then the key
 *  - `"none"` unbinds the action. */
const DEFAULT_KEYBINDS: Readonly<Record<KeybindAction, string>> = {
  leader: 'ctrl+x',
  quit: 'ctrl+c',
  mode_toggle: 'shift+tab,ctrl+tab',
  reasoning_cycle: 'ctrl+r',
  stash: 'ctrl+s',
  subagent_cycle: 'ctrl+o',
  subagent_background: 'ctrl+b',
  telemetry_toggle: 'ctrl+p',
  queue_remove: 'leader x',
  help: 'leader h',
  theme_picker: 'leader t',
  model_picker: 'leader m',
  sessions_picker: 'leader l',
};

/** The stock chord spec for an action — used by the interactive editor to prune overrides that were
 *  rebound back to their default (so the persisted map only ever holds genuine customizations). */
export function keybindDefault(action: KeybindAction): string { return DEFAULT_KEYBINDS[action]; }

const MODIFIER_NAMES = ['ctrl', 'shift', 'alt', 'super'] as const;
const SPECIAL_BASES = new Set([
  'escape', 'esc', 'enter', 'return', 'tab', 'space', 'backspace', 'delete', 'insert', 'clear',
  'home', 'end', 'pageup', 'pagedown', 'up', 'down', 'left', 'right',
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
]);
const SYMBOL_BASES = new Set([...'`-=[]\\;\',./!@#$%^&*()_|~{}:<>?']);
/** Bare (or shift-only) bases that are safe as DIRECT bindings — keys that never type text and are
 *  not structural editor keys. Everything else needs ctrl/alt/super, or must ride behind the leader. */
const BARE_DIRECT_BASES = new Set(['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12', 'pageup', 'pagedown', 'insert']);

interface ParsedChord {
  mods: string[];
  base: string;
  /** Normalized pi-tui key identifier ("ctrl+r", "shift+tab") — what matchesKey consumes. */
  id: string;
}

interface ParsedBinding {
  /** True for a leader sequence — the chord fires only as the key AFTER the leader. */
  leader: boolean;
  chord: ParsedChord;
}

export type KeybindParse = { ok: true; bindings: ParsedBinding[] } | { ok: false; error: string };

function parseChord(raw: string): ParsedChord | null {
  const parts = raw.split('+').map((p) => p.trim().toLowerCase());
  if (parts.length === 0 || parts.some((p) => !p)) return null;
  const base = parts[parts.length - 1]!;
  const mods = parts.slice(0, -1);
  if (mods.some((m) => !(MODIFIER_NAMES as readonly string[]).includes(m))) return null;
  if (new Set(mods).size !== mods.length) return null;
  if (!/^[a-z0-9]$/.test(base) && !SPECIAL_BASES.has(base) && !SYMBOL_BASES.has(base)) return null;
  // Canonical modifier order so the id doubles as the display label.
  const ordered = MODIFIER_NAMES.filter((m) => mods.includes(m));
  return { mods: ordered, base, id: [...ordered, base].join('+') };
}

/** A direct (non-leader) binding must not shadow typing or structural keys: it needs a real modifier
 *  (ctrl/alt/super), a non-typing base (f-keys, page keys, insert) — or the classic shift+tab. */
function directBindable(chord: ParsedChord): boolean {
  if (chord.mods.some((m) => m === 'ctrl' || m === 'alt' || m === 'super')) return true;
  if (BARE_DIRECT_BASES.has(chord.base)) return true;
  return chord.mods.length === 1 && chord.mods[0] === 'shift' && chord.base === 'tab';
}

/** Parse one action's chord spec (see DEFAULT_KEYBINDS grammar). `forLeader` restricts the spec to
 *  direct chords — the leader itself cannot be a leader sequence. */
export function parseKeybind(spec: string, opts: { forLeader?: boolean } = {}): KeybindParse {
  const trimmed = spec.trim();
  if (trimmed.toLowerCase() === 'none') return { ok: true, bindings: [] };
  if (!trimmed) return { ok: false, error: 'empty chord' };
  const bindings: ParsedBinding[] = [];
  for (const entry of trimmed.split(',')) {
    const tokens = entry.trim().split(/\s+/);
    if (tokens.length === 2 && tokens[0]!.toLowerCase() === 'leader') {
      if (opts.forLeader) return { ok: false, error: 'the leader itself cannot be a leader sequence' };
      const chord = parseChord(tokens[1]!);
      if (!chord) return { ok: false, error: `unknown chord "${tokens[1]!}"` };
      if (chord.base === 'escape' || chord.base === 'esc') return { ok: false, error: 'esc cancels the leader — it cannot follow it' };
      bindings.push({ leader: true, chord });
      continue;
    }
    if (tokens.length !== 1) return { ok: false, error: `unknown binding "${entry.trim()}"` };
    const chord = parseChord(tokens[0]!);
    if (!chord) return { ok: false, error: `unknown chord "${tokens[0]!}"` };
    if (!directBindable(chord)) return { ok: false, error: `"${chord.id}" would shadow typing — use a ctrl/alt chord or "leader ${chord.id}"` };
    bindings.push({ leader: false, chord });
  }
  return { ok: true, bindings };
}

/** Turn a raw terminal keypress into a chord spec string (via pi-tui's decoder) that `parseKeybind`
 *  can consume — the capture primitive behind the interactive /keybinds editor. Returns null for input
 *  that can never be a binding: mouse traffic and unrecognized sequences (parseKey → undefined), key
 *  RELEASE events (kitty flag 2 reports both edges — we bind on the press), and bare modifier keys. */
export function chordFromInput(data: string): string | null {
  if (isKeyRelease(data)) return null;
  const id = parseKey(data);
  if (!id) return null;
  const base = id.split('+').pop();
  if (!base || (MODIFIER_NAMES as readonly string[]).includes(base)) return null;
  return id;
}

export interface Keymap {
  /** Problems found in the user's overrides (unknown action, bad chord…) — each keeps its default. */
  readonly warnings: readonly string[];
  /** Does `data` match one of the action's DIRECT chords? Leader sequences never match here. */
  matches(action: KeybindAction, data: string): boolean;
  /** Resolve a direct chord to its action (leader and quit excluded — those have dedicated checks). */
  directAction(data: string): KeybindAction | null;
  /** Resolve the key pressed AFTER the leader to its leader-bound action. */
  leaderAction(data: string): KeybindAction | null;
  isLeader(data: string): boolean;
  /** Display label for the action's first binding ("ctrl+r", "ctrl+x t"), or null when unbound. */
  chordLabel(action: KeybindAction): string | null;
  /** True when the action's chord comes from a (valid) user override. */
  isCustom(action: KeybindAction): boolean;
}

function isKeybindAction(name: string): name is KeybindAction {
  return (KEYBIND_ACTIONS as readonly string[]).includes(name);
}

/** Build a keymap from the defaults plus (optionally) the user's `keybinds` prefs. Invalid overrides
 *  degrade to the default with a warning — a typo in cli-prefs.json must never brick a shortcut. */
export function createKeymap(overrides?: Record<string, unknown>): Keymap {
  const bindings = new Map<KeybindAction, ParsedBinding[]>();
  const custom = new Set<KeybindAction>();
  const warnings: string[] = [];
  for (const action of KEYBIND_ACTIONS) {
    const parsed = parseKeybind(DEFAULT_KEYBINDS[action], { forLeader: action === 'leader' });
    bindings.set(action, parsed.ok ? parsed.bindings : []);
  }
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (!isKeybindAction(name)) { warnings.push(`unknown action "${name}" — ignored`); continue; }
    if (typeof value !== 'string') { warnings.push(`${name}: chord must be a string — default kept`); continue; }
    const parsed = parseKeybind(value, { forLeader: name === 'leader' });
    if (!parsed.ok) { warnings.push(`${name}: ${parsed.error} — default kept`); continue; }
    bindings.set(name, parsed.bindings);
    custom.add(name);
  }

  // Collision detection: two actions resolving to the SAME chord means the later one (in
  // KEYBIND_ACTIONS order — exactly how directAction/leaderAction pick a winner) is unreachable. We
  // don't touch resolution order; we only warn so the startup notice and /keybinds can flag it. Direct
  // and leader chords live in separate namespaces (a leader sequence only fires after the leader), so
  // they never collide with each other.
  const directOwner = new Map<string, KeybindAction>();
  const leaderOwner = new Map<string, KeybindAction>();
  for (const action of KEYBIND_ACTIONS) {
    for (const b of bindings.get(action) ?? []) {
      const owners = b.leader ? leaderOwner : directOwner;
      const owner = owners.get(b.chord.id);
      if (owner === undefined) { owners.set(b.chord.id, action); continue; }
      if (owner === action) continue; // an action listing the same chord twice is not a collision
      const label = b.leader ? `leader ${b.chord.id}` : b.chord.id;
      warnings.push(`${action}: "${label}" already bound to ${owner} — unreachable`);
    }
  }

  const matchChord = (data: string, chord: ParsedChord): boolean => matchesKey(data, chord.id as KeyId);
  const matches = (action: KeybindAction, data: string): boolean =>
    (bindings.get(action) ?? []).some((b) => !b.leader && matchChord(data, b.chord));

  const leaderLabel = (): string => {
    const first = (bindings.get('leader') ?? [])[0];
    return first ? first.chord.id : 'leader';
  };

  return {
    warnings,
    matches,
    directAction: (data) => KEYBIND_ACTIONS.find((a) => a !== 'leader' && a !== 'quit' && matches(a, data)) ?? null,
    leaderAction: (data) => KEYBIND_ACTIONS.find(
      (a) => a !== 'leader' && (bindings.get(a) ?? []).some((b) => b.leader && matchChord(data, b.chord)),
    ) ?? null,
    isLeader: (data) => matches('leader', data),
    chordLabel: (action) => {
      const first = (bindings.get(action) ?? [])[0];
      if (!first) return null;
      return first.leader ? `${leaderLabel()} ${first.chord.id}` : first.chord.id;
    },
    isCustom: (action) => custom.has(action),
  };
}

/** One /keybinds listing row — pure data so the overlay content is unit-testable without a TTY. */
export interface KeybindRow { action: KeybindAction; chord: string | null; custom: boolean }
export function keybindRows(keymap: Keymap): KeybindRow[] {
  return KEYBIND_ACTIONS.map((action) => ({ action, chord: keymap.chordLabel(action), custom: keymap.isCustom(action) }));
}

// The active keymap is module-level state, mirroring how the chat theme works: runChat initializes it
// from prefs once, and every predicate/render consults it. Lazily defaults so tests and any code path
// that never calls initKeymap still see the stock bindings.
let active: Keymap | null = null;

export function initKeymap(overrides?: Record<string, unknown>): Keymap {
  active = createKeymap(overrides);
  return active;
}

export function activeKeymap(): Keymap {
  active ??= createKeymap();
  return active;
}

// ── leader sequence state machine ──────────────────────────────────────────────────────────────

const LEADER_TIMEOUT_MS = 2000;

export interface LeaderState {
  pending(): boolean;
  /** The leader chord was pressed: open the "waiting for the second key" window. */
  arm(): void;
  cancel(): void;
  /** Consume the key AFTER the leader: closes the window; returns the bound action, or null for
   *  esc/an unbound key (the keypress is swallowed either way — it never types into the editor). */
  resolve(data: string): KeybindAction | null;
}

export function createLeaderState(keymap: Keymap, opts: { onExpire(): void; timeoutMs?: number }): LeaderState {
  let pending = false;
  let timer: NodeJS.Timeout | null = null;
  const clear = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = false;
  };
  return {
    pending: () => pending,
    arm: (): void => {
      clear();
      pending = true;
      timer = setTimeout(() => { clear(); opts.onExpire(); }, opts.timeoutMs ?? LEADER_TIMEOUT_MS);
      timer.unref?.();
    },
    cancel: clear,
    resolve: (data): KeybindAction | null => {
      if (!pending) return null;
      clear();
      if (isEscapeKey(data)) return null;
      return keymap.leaderAction(data);
    },
  };
}
