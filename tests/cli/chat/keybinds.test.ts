import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  chordFromInput, createKeymap, createLeaderState, keybindDefault, keybindRows, parseKeybind, KEYBIND_ACTIONS,
} from '../../../src/cli/chat/keys.js';
import {
  bottomHints, INTERRUPT_CONFIRM_MS, interruptPress, startScreenHints, quitHint,
} from '../../../src/cli/chat/shell.js';

// Raw bytes the terminal sends for the chords under test.
const CTRL = (letter: string): string => String.fromCharCode(letter.charCodeAt(0) - 96);

describe('parseKeybind — chord syntax', () => {
  it('parses ctrl-letter chords into normalized ids', () => {
    const p = parseKeybind('CTRL+T');
    expect(p).toEqual({ ok: true, bindings: [{ leader: false, chord: { mods: ['ctrl'], base: 't', id: 'ctrl+t' } }] });
  });

  it('parses shift+tab, f-keys and comma-separated alternatives', () => {
    const p = parseKeybind('shift+tab,ctrl+tab');
    expect(p.ok && p.bindings.map((b) => b.chord.id)).toEqual(['shift+tab', 'ctrl+tab']);
    expect(parseKeybind('f2').ok).toBe(true);
    expect(parseKeybind('pageup').ok).toBe(true);
  });

  it('parses leader sequences with plain letters', () => {
    const p = parseKeybind('leader t');
    expect(p).toEqual({ ok: true, bindings: [{ leader: true, chord: { mods: [], base: 't', id: 't' } }] });
  });

  it('"none" unbinds', () => {
    expect(parseKeybind('none')).toEqual({ ok: true, bindings: [] });
  });

  it('rejects unknown or unparseable chords', () => {
    expect(parseKeybind('ctrl+').ok).toBe(false);
    expect(parseKeybind('meta+x').ok).toBe(false);
    expect(parseKeybind('ctrl+bogus').ok).toBe(false);
    expect(parseKeybind('leader').ok).toBe(false); // a bare "leader" token is not a binding
  });

  it('rejects direct bindings that would shadow typing or structural keys', () => {
    expect(parseKeybind('t').ok).toBe(false); // plain letters only behind the leader
    expect(parseKeybind('enter').ok).toBe(false);
    expect(parseKeybind('shift+t').ok).toBe(false);
    expect(parseKeybind('alt+t').ok).toBe(true); // a real modifier makes it safe
  });

  it('rejects leader-of-leader and esc after the leader', () => {
    expect(parseKeybind('leader x', { forLeader: true }).ok).toBe(false);
    expect(parseKeybind('leader escape').ok).toBe(false);
  });
});

describe('stream interrupt + shell row budget', () => {
  it('requires a second Esc inside the confirmation window and expires cleanly', () => {
    const first = interruptPress(0, 10_000);
    expect(first).toEqual({ armedUntil: 10_000 + INTERRUPT_CONFIRM_MS, abort: false });
    expect(interruptPress(first.armedUntil, 10_500)).toEqual({ armedUntil: 0, abort: true });
    expect(interruptPress(first.armedUntil, first.armedUntil)).toEqual({
      armedUntil: first.armedUntil + INTERRUPT_CONFIRM_MS,
      abort: false,
    });
  });

  it('changes the thinking footer while interrupt is armed', () => {
    const map = createKeymap();
    expect(bottomHints(map, 'thinking', false, false)).toContain('esc interrupt');
    expect(bottomHints(map, 'thinking', false, true)).toContain('esc again to interrupt');
  });

});

describe('chordFromInput — raw keypress → chord spec', () => {
  const CTRL = (letter: string): string => String.fromCharCode(letter.charCodeAt(0) - 96);

  it('decodes ctrl chords, shift+tab and f-keys into their spec strings', () => {
    expect(chordFromInput(CTRL('t'))).toBe('ctrl+t');
    expect(chordFromInput('\x1b[Z')).toBe('shift+tab');
    expect(chordFromInput('\x1bOQ')).toBe('f2');
  });

  it('returns the plain key for a bare letter (only bindable behind the leader — parseKeybind gates it)', () => {
    expect(chordFromInput('t')).toBe('t');
    expect(parseKeybind('t').ok).toBe(false); // still rejected as a direct binding
  });

  it('returns null for input that can never be a binding (mouse / unrecognized)', () => {
    expect(chordFromInput('\x1b[<0;10;10M')).toBeNull(); // mouse report
    expect(chordFromInput('')).toBeNull();
  });

  it('round-trips through parseKeybind for the capturable chords', () => {
    for (const raw of [CTRL('t'), '\x1b[Z', '\x1bOQ']) {
      const spec = chordFromInput(raw)!;
      expect(parseKeybind(spec).ok).toBe(true);
    }
  });
});

describe('keybindDefault', () => {
  it('returns the stock spec per action', () => {
    expect(keybindDefault('reasoning_cycle')).toBe('ctrl+r');
    expect(keybindDefault('theme_picker')).toBe('leader t');
  });
});

describe('createKeymap — defaults and overrides', () => {
  it('default chords match the raw terminal sequences', () => {
    const keymap = createKeymap();
    expect(keymap.matches('reasoning_cycle', CTRL('r'))).toBe(true);
    expect(keymap.matches('quit', CTRL('c'))).toBe(true);
    expect(keymap.matches('stash', CTRL('s'))).toBe(true);
    expect(keymap.matches('subagent_cycle', CTRL('o'))).toBe(true);
    expect(keymap.matches('telemetry_toggle', CTRL('p'))).toBe(true);
    expect(keymap.isLeader(CTRL('x'))).toBe(true);
    expect(keymap.warnings).toEqual([]);
  });

  it('a valid override replaces the default and is marked custom', () => {
    const keymap = createKeymap({ reasoning_cycle: 'ctrl+t' });
    expect(keymap.matches('reasoning_cycle', CTRL('t'))).toBe(true);
    expect(keymap.matches('reasoning_cycle', CTRL('r'))).toBe(false);
    expect(keymap.isCustom('reasoning_cycle')).toBe(true);
    expect(keymap.isCustom('stash')).toBe(false);
    expect(keymap.chordLabel('reasoning_cycle')).toBe('ctrl+t');
  });

  it('an invalid override warns and keeps the default', () => {
    const keymap = createKeymap({ reasoning_cycle: 'ctrl+', bogus_action: 'ctrl+t', stash: 42 });
    expect(keymap.warnings).toHaveLength(3);
    expect(keymap.matches('reasoning_cycle', CTRL('r'))).toBe(true); // default kept
    expect(keymap.isCustom('reasoning_cycle')).toBe(false);
    expect(keymap.matches('stash', CTRL('s'))).toBe(true);
  });

  it('warns when two actions resolve to the same direct chord (later one unreachable)', () => {
    // subagent_cycle (earlier in KEYBIND_ACTIONS) grabs ctrl+p, the default telemetry_toggle chord.
    const keymap = createKeymap({ subagent_cycle: 'ctrl+p' });
    expect(keymap.warnings.some((w) =>
      w.includes('telemetry_toggle') && w.includes('subagent_cycle') && w.includes('ctrl+p') && w.includes('unreachable'))).toBe(true);
    // Resolution order is untouched — the earlier action still wins, the collision is only surfaced.
    expect(keymap.directAction(CTRL('p'))).toBe('subagent_cycle');
  });

  it('warns when two actions resolve to the same leader sequence', () => {
    // help (earlier) owns "leader h"; model_picker rebound onto it becomes unreachable.
    const keymap = createKeymap({ model_picker: 'leader h' });
    expect(keymap.warnings.some((w) =>
      w.includes('model_picker') && w.includes('help') && w.includes('leader h') && w.includes('unreachable'))).toBe(true);
    expect(keymap.leaderAction('h')).toBe('help');
  });

  it('does not warn when an action lists the same chord twice (self, not a collision)', () => {
    expect(createKeymap({ reasoning_cycle: 'ctrl+t,ctrl+t' }).warnings).toEqual([]);
  });

  it('"none" unbinds an action', () => {
    const keymap = createKeymap({ stash: 'none' });
    expect(keymap.matches('stash', CTRL('s'))).toBe(false);
    expect(keymap.chordLabel('stash')).toBeNull();
  });

  it('directAction resolves direct chords but never leader sequences or quit', () => {
    const keymap = createKeymap({ theme_picker: 'f2' });
    expect(keymap.directAction(CTRL('r'))).toBe('reasoning_cycle');
    expect(keymap.directAction('\x1bOQ')).toBe('theme_picker'); // f2, rebound to a direct chord
    expect(keymap.directAction(CTRL('c'))).toBeNull(); // quit has its own unconditional check
    expect(keymap.directAction('t')).toBeNull(); // "leader t" only fires through leaderAction
  });

  it('leaderAction resolves the key after the leader, including rebound shortcuts', () => {
    const keymap = createKeymap({ reasoning_cycle: 'leader r' });
    expect(keymap.leaderAction('t')).toBe('theme_picker');
    expect(keymap.leaderAction('h')).toBe('help');
    expect(keymap.leaderAction('r')).toBe('reasoning_cycle');
    expect(keymap.leaderAction('z')).toBeNull();
    expect(keymap.matches('reasoning_cycle', CTRL('r'))).toBe(false); // moved behind the leader
  });

  it('chordLabel renders leader sequences through the effective leader chord', () => {
    expect(createKeymap().chordLabel('theme_picker')).toBe('ctrl+x t');
    expect(createKeymap({ leader: 'ctrl+a' }).chordLabel('theme_picker')).toBe('ctrl+a t');
  });
});

describe('leader state machine', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('leader → bound key fires the action and closes the window', () => {
    const leader = createLeaderState(createKeymap(), { onExpire: () => {} });
    expect(leader.pending()).toBe(false);
    leader.arm();
    expect(leader.pending()).toBe(true);
    expect(leader.resolve('t')).toBe('theme_picker');
    expect(leader.pending()).toBe(false);
  });

  it('esc and unbound keys cancel without an action', () => {
    const leader = createLeaderState(createKeymap(), { onExpire: () => {} });
    leader.arm();
    expect(leader.resolve('\x1b')).toBeNull();
    expect(leader.pending()).toBe(false);
    leader.arm();
    expect(leader.resolve('z')).toBeNull();
    expect(leader.pending()).toBe(false);
  });

  it('times out after the leader window and notifies for a re-render', () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const leader = createLeaderState(createKeymap(), { onExpire, timeoutMs: 2000 });
    leader.arm();
    vi.advanceTimersByTime(1999);
    expect(leader.pending()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(leader.pending()).toBe(false);
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(leader.resolve('t')).toBeNull(); // the window is gone
  });

  it('re-arming resets the window instead of stacking timers', () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const leader = createLeaderState(createKeymap(), { onExpire, timeoutMs: 2000 });
    leader.arm();
    vi.advanceTimersByTime(1500);
    leader.arm();
    vi.advanceTimersByTime(1500);
    expect(leader.pending()).toBe(true);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(leader.pending()).toBe(false);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });
});

describe('/keybinds listing', () => {
  it('lists every action and marks custom binds', () => {
    const rows = keybindRows(createKeymap({ stash: 'ctrl+g', theme_picker: 'none' }));
    expect(rows.map((r) => r.action)).toEqual([...KEYBIND_ACTIONS]);
    const byAction = new Map(rows.map((r) => [r.action, r]));
    expect(byAction.get('stash')).toEqual({ action: 'stash', chord: 'ctrl+g', custom: true });
    expect(byAction.get('theme_picker')).toEqual({ action: 'theme_picker', chord: null, custom: true });
    expect(byAction.get('reasoning_cycle')).toEqual({ action: 'reasoning_cycle', chord: 'ctrl+r', custom: false });
  });

  it('routes the /keybinds slash command', async () => {
    const { parseCommand } = await import('../../../src/cli/chat/commands.js');
    expect(parseCommand('/keybinds')).toEqual({ cmd: 'keybinds' });
  });
});

describe('hint lines reflect the keymap', () => {
  it('default hints advertise the stock chords', () => {
    const keymap = createKeymap();
    expect(bottomHints(keymap, 'idle')).toBe(
      '⏎ send   ·   / slash   ·   @ files   ·   ! shell   ·   ctrl+s stash   ·   shift+tab mode   ·   ctrl+r reasoning   ·   ctrl+p telemetry');
    expect(bottomHints(keymap, 'thinking')).toBe('esc interrupt   ·   /help commands   ·   ctrl+r reasoning');
    expect(bottomHints(keymap, 'thinking', true)).toContain('ctrl+o subagents');
    expect(bottomHints(keymap, 'child')).toBe('⏎ message the sub-agent   ·   esc back   ·   ctrl+o next session');
    expect(startScreenHints(keymap)).toBe('⏎ send · / commands · @ files · ! shell · ↑ history · shift+tab mode');
    expect(quitHint(keymap)).toBe('ctrl+c quit');
  });

  it('overrides and unbinds show truthfully', () => {
    const keymap = createKeymap({ reasoning_cycle: 'ctrl+t', stash: 'none', quit: 'none' });
    const idle = bottomHints(keymap, 'idle');
    expect(idle).toContain('ctrl+t reasoning');
    expect(idle).not.toContain('stash');
    expect(quitHint(keymap)).toBe('');
    expect(startScreenHints(createKeymap({ mode_toggle: 'f2' }))).toContain('f2 mode');
  });
});
