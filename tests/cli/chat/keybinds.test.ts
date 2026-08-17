import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  chordFromInput, createKeymap, createLeaderState, keybindDefault, keybindRows, parseKeybind, KEYBIND_ACTIONS,
} from '../../../src/cli/chat/keys.js';
import {
  escalationPress, INTERRUPT_CONFIRM_MS, interruptPress, noticeAction, resolveInterruptConfirmMs,
} from '../../../src/cli/chat/chatComposition.js';
import {
  bottomHintItems, modelMetaLine, quitHint, startScreenHintItems,
} from '../../../src/cli/chat/composeLines.js';

// The live footer/start screen render through `*Items` + `fitSegments`; these mirror the removed
// convenience joiners so the content assertions below still exercise the keymap-driven item builders.
const bottomHints = (...args: Parameters<typeof bottomHintItems>): string =>
  bottomHintItems(...args).map((s) => s.text).join('   ·   ');
const startScreenHints = (...args: Parameters<typeof startScreenHintItems>): string =>
  startScreenHintItems(...args).map((s) => s.text).join(' · ');

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

  // The window is a per-user setting the CLI reads at boot, so the value arrives from a daemon whose
  // version this build does not control and is held inside the CLI's own bounds before it is used.
  it('holds the configured confirmation window inside the CLI-side bounds', () => {
    expect(resolveInterruptConfirmMs(2_500)).toBe(2_500);
    expect(resolveInterruptConfirmMs(500)).toBe(500);
    expect(resolveInterruptConfirmMs(5_000)).toBe(5_000);
    expect(resolveInterruptConfirmMs(0)).toBe(500);          // a zero window would disarm before a hand can follow
    expect(resolveInterruptConfirmMs(60_000)).toBe(5_000);   // an arm outliving its turn would abort the next one
    expect(resolveInterruptConfirmMs(1_234.6)).toBe(1_235);  // whole milliseconds, like the daemon's clamp
    expect(resolveInterruptConfirmMs(undefined)).toBe(INTERRUPT_CONFIRM_MS); // offline / older daemon
    expect(resolveInterruptConfirmMs(Number.NaN)).toBe(INTERRUPT_CONFIRM_MS);
  });

  // Submitting the next message used to be the only general clear, so a confirmation sat above the
  // composer indefinitely — the frame loop now expires it on a clock instead.
  it('arms an expiry for a transient notice, and only once per assignment', () => {
    expect(noticeAction('reasoning effort: max', '', false)).toBe('arm');
    // Already seen: its timer is running. Re-arming every frame would keep pushing the expiry away for as
    // long as anything else redraws — i.e. never expire during a streaming turn.
    expect(noticeAction('reasoning effort: max', 'reasoning effort: max', false)).toBe('idle');
  });

  it('leaves a sticky notice alone, and expires whatever replaces it', () => {
    expect(noticeAction('$ npm test · running locally…', '', true)).toBe('cancel');
    // The flag describes one assignment. The shell consumes it on sight, so the outcome that replaces a
    // pending status arrives unsticky and expires normally — its writer resets nothing.
    expect(noticeAction('done', '$ npm test · running locally…', false)).toBe('arm');
  });

  it('cancels rather than arms when the slot is cleared', () => {
    expect(noticeAction('', 'reasoning effort: max', false)).toBe('cancel');
  });

  // The escalating stop: arm → abort → kill. PI's agent loop only re-checks its abort signal between
  // tool calls, so a turn still thinking after the abort is pinned by a long foreground command and the
  // next press must hard-kill that command instead of re-sending an abort the loop cannot act on.
  it('escalates to a kill once a stop was already requested for the turn', () => {
    // No stop requested yet: behaves exactly like the two-press interrupt contract.
    expect(escalationPress(false, 0, 10_000)).toEqual({ armedUntil: 10_000 + INTERRUPT_CONFIRM_MS, action: 'arm' });
    expect(escalationPress(false, 10_000 + INTERRUPT_CONFIRM_MS, 10_500)).toEqual({ armedUntil: 0, action: 'abort' });
    // Stop already requested: the press is the escalation, regardless of any armed window.
    expect(escalationPress(true, 0, 10_000)).toEqual({ armedUntil: 0, action: 'kill' });
    expect(escalationPress(true, 99_999, 10_000)).toEqual({ armedUntil: 0, action: 'kill' });
  });

  it('changes the thinking footer while interrupt is armed', () => {
    const map = createKeymap();
    expect(bottomHints(map, 'thinking', false, false)).toContain('esc interrupt');
    expect(bottomHints(map, 'thinking', false, true)).toContain('esc again to interrupt');
    expect(bottomHints(map, 'thinking', false, false, true)).toContain('esc inject queued');
  });

  it('names the Ctrl+B background hint for whichever foreground work is waiting', () => {
    const map = createKeymap();
    // No foreground work → no background hint at all.
    expect(bottomHints(map, 'thinking', false, false, false, false, false)).not.toContain('background');
    // A foreground delegate names the sub-agent; a foreground command names the command.
    expect(bottomHints(map, 'thinking', false, false, false, true, false)).toContain('background sub-agent');
    expect(bottomHints(map, 'thinking', false, false, false, false, true)).toContain('background command');
    // A delegate takes precedence in the label when both are foreground (the chord detaches both).
    expect(bottomHints(map, 'thinking', false, false, false, true, true)).toContain('background sub-agent');
  });

  it('advertises the kill escalation once a stop was requested and a command still runs', () => {
    const map = createKeymap();
    expect(bottomHints(map, 'thinking', false, false, false, false, true, true)).toContain('esc kill command');
    // Without a running foreground command there is nothing to kill — keep the plain interrupt hint.
    expect(bottomHints(map, 'thinking', false, false, false, false, false, true)).toContain('esc interrupt');
    // A queued message still wins: injecting what the user just typed beats re-advertising the kill.
    expect(bottomHints(map, 'thinking', false, false, true, false, true, true)).toContain('esc inject queued');
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
    expect(keymap.matches('quit', CTRL('z'))).toBe(true); // ctrl+z also quits (SIGTSTP is disabled in raw mode)
    expect(keymap.matches('stash', CTRL('s'))).toBe(true);
    expect(keymap.matches('subagent_cycle', CTRL('o'))).toBe(true);
    expect(keymap.matches('subagent_background', CTRL('b'))).toBe(true);
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

describe('modelMetaLine', () => {
  // The line carries ANSI colour; strip it so the assertions are about order, not styling.
  const plain = (s: string) => s.replace(/\[[0-9;]*m/g, '').trim();

  it('puts the activity chip directly after the mode label', () => {
    // The spinner is the one element that appears and disappears mid-turn. Next to the fixed-width mode
    // label it holds still; at the far end of the line it drifts with the model name's length.
    const line = plain(modelMetaLine('build', 'anthropic/claude-opus-4-8', 'off', '* 19s', true, false, null));
    expect(line).toBe('Build * 19s · anthropic · claude-opus-4-8 off YOLO');
    expect(line.indexOf('19s')).toBeLessThan(line.indexOf('claude-opus-4-8'));
  });

  it('closes the gap when no turn is running', () => {
    // Idle must not leave a stray separator or a double space where the chip was.
    expect(plain(modelMetaLine('plan', 'anthropic/claude-opus-4-8', '', undefined, false, false, null)))
      .toBe('Plan · anthropic · claude-opus-4-8');
  });

  // The provider qualifies the model, so it reads in the order the identity is written and typed. The dot
  // is what stops the two from running together as one long name — and a bare model id, having nothing to
  // qualify, must NOT pick up a stray separator.
  it('leads with the provider, separated by the same faint dot', () => {
    const qualified = plain(modelMetaLine('build', 'anthropic/claude-opus-4-8', '', undefined, false, false, null));
    expect(qualified).toBe('Build · anthropic · claude-opus-4-8');
    expect(qualified.indexOf('anthropic')).toBeLessThan(qualified.indexOf('claude-opus-4-8'));

    expect(plain(modelMetaLine('build', 'k3', '', undefined, false, false, null))).toBe('Build · k3');
  });

  it('keeps a bare model id and the goal chips intact', () => {
    expect(plain(modelMetaLine('workflow', 'k3', 'max', '* 2s', false, false, { primary: 'goal', suffix: 'ship it' })))
      .toBe('Workflow * 2s · goal · k3 max ship it');
  });
});
