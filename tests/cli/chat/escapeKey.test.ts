import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isEscapeKey, isPageUpKey, isUpKey } from '../../../src/cli/chat/keys.js';
import { createChatComposition } from '../../../src/cli/chat/chatComposition.js';
import { terminalPlainText } from '../../../src/cli/ui/text.js';
import { compositionHarness } from './chatCompositionHarness.js';

type Harness = ReturnType<typeof compositionHarness>;

const noopInput = {
  cycleThinkingLevel: () => {},
  openHelpModal: () => {},
  openThemePicker: () => {},
  openModelPicker: () => {},
  openSessionsModal: () => {},
  openTaskActions: () => {},
};

const makeComposition = (h: Harness) => {
  const composition = createChatComposition(h.rt, h.resources, { quit: vi.fn() }, h.stream, h.mdTheme, h.diagnostics);
  composition.attachInput(noopInput);
  return composition;
};

/** The stop-flow client surface, as the harness provides plus the escalation RPC the kill branch calls. */
const stopClient = (h: Harness): { abort: ReturnType<typeof vi.fn>; killCommands: ReturnType<typeof vi.fn> } => {
  const abort = vi.fn(async () => {});
  const killCommands = vi.fn(async () => ({ killed: 0 }));
  Object.assign(h.resources.client, { abort, killCommands });
  return { abort, killCommands };
};

describe('ESC key recognition', () => {
  it('recognizes a lone Esc, a fast double-Esc chunk and the kitty CSI-u escape', () => {
    expect(isEscapeKey('\x1b')).toBe(true);
    // Two quick presses coalesce into one `\x1b\x1b` chunk — the consumer must still see an escape
    // (pi-tui alone would decode the pair as the ctrl+alt+[ chord and swallow both presses).
    expect(isEscapeKey('\x1b\x1b')).toBe(true);
    expect(isEscapeKey('\x1b[27;1u')).toBe(true);    // kitty CSI-u escape press (explicit mod 1)
    expect(isEscapeKey('\x1b[27;1:2u')).toBe(true);  // kitty repeat edge
  });

  it('never mistakes arrows, function keys or tab-shift for escape', () => {
    for (const seq of ['\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D', '\x1b[5~', '\x1b[6~', '\x1b[Z', '\x1bOP']) {
      expect(isEscapeKey(seq)).toBe(false);
    }
    expect(isUpKey('\x1b[A')).toBe(true);
    expect(isPageUpKey('\x1b[5~')).toBe(true);
  });

  it('does not treat extended escape sequences as escape', () => {
    // pi-tui re-splits a `\x1b\x1b` followed by a CSI introducer into ESC + CSI before we see it, but if
    // the pair ever arrives as one string with a tail, it is an arrow/CSI prefix, never two escapes.
    expect(isEscapeKey('\x1b\x1b[')).toBe(false);
    expect(isEscapeKey('\x1b\x1b[A')).toBe(false);
  });
});

describe('double-Esc stop flow through the editor', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  const thinking = (h: Harness): void => { h.rt.transcript.apply({ type: 'text', delta: 'working' }); };

  it('a fast double-Esc in one chunk arms then aborts — no waiting between presses', () => {
    const h = compositionHarness({ columns: 100, rows: 24, turns: 6 });
    thinking(h);
    const { abort, killCommands } = stopClient(h);
    const composition = makeComposition(h);
    composition.resume();

    h.tui.emit('\x1b\x1b'); // both presses arrive as one chunk

    // arm on the first press, abort on the second — a single chunk must behave like two spaced presses.
    expect(abort).toHaveBeenCalledOnce();
    expect(killCommands).not.toHaveBeenCalled();
    composition.dispose();
  });

  it('a single Esc only arms — a second, separate press is what aborts (one vs two stays distinct)', () => {
    const h = compositionHarness({ columns: 100, rows: 24, turns: 6 });
    thinking(h);
    const { abort, killCommands } = stopClient(h);
    const composition = makeComposition(h);
    composition.resume();

    h.tui.emit('\x1b');
    expect(abort).not.toHaveBeenCalled();
    expect(killCommands).not.toHaveBeenCalled();

    h.tui.emit('\x1b'); // within the 1800ms confirmation window
    expect(abort).toHaveBeenCalledOnce();
    composition.dispose();
  });

  // The window is the user's own (Account → Terminal). Shortening it must move the boundary a second
  // press is judged against — and nothing else: the same run still decodes an arrow key normally, since
  // reassembling `\x1b[A` is the stdin buffer's byte-driven job and never consults this value.
  it('judges the second press against the CONFIGURED window, leaving arrow keys alone', () => {
    const h = compositionHarness({ columns: 100, rows: 24, turns: 6, termSettings: { theme: 'auto', interruptConfirmMs: 600 } });
    thinking(h);
    const { abort } = stopClient(h);
    const composition = makeComposition(h);
    composition.resume();

    h.tui.emit('\x1b');
    vi.setSystemTime(1_000 + 900); // past 600 ms, but well inside the 1800 ms default
    h.tui.emit('\x1b');
    expect(abort).not.toHaveBeenCalled(); // the arm had already expired — this press only re-arms

    h.tui.emit('\x1b[A'); // an arrow between the presses is not an Esc and must not disarm anything
    vi.setSystemTime(1_000 + 900 + 400); // inside the configured 600 ms of the re-arm
    h.tui.emit('\x1b');
    expect(abort).toHaveBeenCalledOnce();
    composition.dispose();
  });

  it('holds a configured window that is out of range at the CLI-side bound', () => {
    const h = compositionHarness({ columns: 100, rows: 24, turns: 6, termSettings: { theme: 'auto', interruptConfirmMs: 0 } });
    thinking(h);
    const { abort } = stopClient(h);
    const composition = makeComposition(h);
    composition.resume();

    h.tui.emit('\x1b');
    vi.setSystemTime(1_000 + 400); // a zero window would have expired instantly; the 500 ms floor has not
    h.tui.emit('\x1b');
    expect(abort).toHaveBeenCalledOnce();
    composition.dispose();
  });

  it('a third press after the abort escalates to the foreground kill', () => {
    const h = compositionHarness({ columns: 100, rows: 24, turns: 6 });
    thinking(h);
    h.rt.processes = [{
      id: 'cmd-1', command: 'npm run build', cwd: '/w', startedAt: new Date().toISOString(),
      running: true, exitCode: null, sessionId: 'brain-1', completionMode: 'foreground',
    }];
    const { abort, killCommands } = stopClient(h);
    const composition = makeComposition(h);
    composition.resume();

    h.tui.emit('\x1b\x1b'); // arm + abort
    h.tui.emit('\x1b');     // stopRequested → escalation
    expect(abort).toHaveBeenCalledOnce();
    expect(killCommands).toHaveBeenCalledOnce();
    composition.dispose();
  });

  it('confirms the stop immediately and reports the settle once the abort RPC resolves', async () => {
    const h = compositionHarness({ columns: 100, rows: 24, turns: 6 });
    thinking(h);
    let resolveAbort!: () => void;
    const abort = vi.fn(() => new Promise<void>((resolve) => { resolveAbort = resolve; }));
    Object.assign(h.resources.client, { abort, killCommands: vi.fn(async () => ({ killed: 0 })) });
    const composition = makeComposition(h);
    composition.resume();

    h.tui.emit('\x1b\x1b');

    // The acknowledgement is synchronous — the visible turn end rides the daemon's SSE idle, a round
    // trip away, so the notice must not wait for it.
    expect(abort).toHaveBeenCalledOnce();
    expect(terminalPlainText(h.rt.notice)).toContain('stopping');

    resolveAbort();
    await Promise.resolve();
    await Promise.resolve();
    expect(terminalPlainText(h.rt.notice)).toContain('agent stopped');
    composition.dispose();
  });

  it('a turn pinned by a foreground command keeps the escalation hint instead of claiming the stop', async () => {
    const h = compositionHarness({ columns: 100, rows: 24, turns: 6 });
    thinking(h);
    h.rt.processes = [{
      id: 'cmd-1', command: 'npm run build', cwd: '/w', startedAt: new Date().toISOString(),
      running: true, exitCode: null, sessionId: 'brain-1', completionMode: 'foreground',
    }];
    let resolveAbort!: () => void;
    const abort = vi.fn(() => new Promise<void>((resolve) => { resolveAbort = resolve; }));
    Object.assign(h.resources.client, { abort, killCommands: vi.fn(async () => ({ killed: 0 })) });
    const composition = makeComposition(h);
    composition.resume();

    h.tui.emit('\x1b\x1b');
    expect(terminalPlainText(h.rt.notice)).toContain('esc again to kill');
    expect(terminalPlainText(h.rt.notice)).not.toContain('stopping');

    resolveAbort();
    await Promise.resolve();
    await Promise.resolve();
    expect(terminalPlainText(h.rt.notice)).toContain('esc again to kill');
    expect(terminalPlainText(h.rt.notice)).not.toContain('agent stopped');
    composition.dispose();
  });

  it('arrows and page keys never trigger the escape path', () => {
    const h = compositionHarness({ columns: 100, rows: 24, turns: 6 });
    thinking(h);
    const { abort } = stopClient(h);
    const composition = makeComposition(h);
    composition.resume();

    h.tui.emit('\x1b[A');  // up arrow
    h.tui.emit('\x1b[5~'); // page up
    expect(abort).not.toHaveBeenCalled();
    composition.dispose();
  });

  it('a fast double-Esc on an idle turn falls through both presses without side effects', () => {
    const h = compositionHarness({ columns: 100, rows: 24, turns: 6 });
    const { abort } = stopClient(h);
    const composition = makeComposition(h);
    composition.resume();

    h.tui.emit('\x1b\x1b');
    expect(abort).not.toHaveBeenCalled();
    composition.dispose();
  });
});
