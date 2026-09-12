import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatComposition } from '../../../src/cli/chat/chatComposition.js';
import { TranscriptModel } from '../../../src/brain/transcriptModel.js';
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
  composition.resume();
  return composition;
};

/** A focused child with a foreground command of its own; the parent carries a DIFFERENT one, so any
 *  cross-session leak in the routing below shows up as a call against the wrong (or no) session. */
const focusChild = (h: Harness): void => {
  h.rt.processes = [{
    id: 'p-parent', command: 'parent build', cwd: '/w', startedAt: '2026-09-12T10:00:00.000Z',
    sessionId: 'brain-parent', running: true, exitCode: null, completionMode: 'foreground',
  } as never];
  h.rt.childView = {
    sessionId: 'brain-ch-subagent-B',
    transcript: new TranscriptModel(),
    processes: [{
      id: 'p-child', command: 'child build', cwd: '/w', startedAt: '2026-09-12T10:00:00.000Z',
      sessionId: 'brain-ch-subagent-B', running: true, exitCode: null, completionMode: 'foreground',
    } as never],
  } as never;
};

const backgroundClient = (h: Harness) => {
  const calls = { subagents: [] as (string | undefined)[], commands: [] as (string | undefined)[], workflows: [] as (string | undefined)[] };
  Object.assign(h.resources.client, {
    backgroundSubagents: async (session?: string) => { calls.subagents.push(session); return { detached: 0 }; },
    backgroundCommands: async (session?: string) => { calls.commands.push(session); return { detached: 0 }; },
    backgroundWorkflows: async (session?: string) => { calls.workflows.push(session); return { detached: 0 }; },
  });
  return calls;
};

describe('drill-in routing — keyboard control follows the LOOKED-AT session', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('Ctrl+B detaches the VIEWED child\'s foreground command by explicit session, never the parent\'s', () => {
    const h = compositionHarness({ columns: 100, rows: 24, turns: 6 });
    focusChild(h);
    const calls = backgroundClient(h);
    const composition = makeComposition(h);

    h.tui.emit('\x02'); // ctrl+b

    // The focused child's own command is what gets released — addressed by session, with no CLI
    // binding riding along (a child is authorized through the durable ancestry instead).
    expect(calls.commands).toEqual(['brain-ch-subagent-B']);
    expect(calls.subagents).toEqual([]);
    composition.dispose();
  });

  it('Ctrl+B counts nothing while focused on an idle child — the hidden parent\'s command is out of scope', () => {
    const h = compositionHarness({ columns: 100, rows: 24, turns: 6 });
    focusChild(h);
    h.rt.childView!.processes = []; // the viewed child runs nothing foreground
    const calls = backgroundClient(h);
    const composition = makeComposition(h);

    h.tui.emit('\x02'); // ctrl+b — falls through to the editor's backward-character chord

    expect(calls.commands).toEqual([]);
    expect(calls.subagents).toEqual([]);
    composition.dispose();
  });

  it('mode and queued-message shortcuts refuse instead of mutating hidden parent session state', async () => {
    const h = compositionHarness({ columns: 100, rows: 24, turns: 6 });
    focusChild(h);
    h.rt.workMode = 'build';
    h.rt.queued = [{ id: 'parent-q', text: 'hidden parent follow-up' }];
    const queueRecall = vi.fn(async () => ({ text: 'hidden parent follow-up' }));
    Object.assign(h.resources.client, { queueRecall });
    const composition = makeComposition(h);

    h.tui.emit('\x1b[Z'); // shift+tab: mode toggle
    expect(h.rt.workMode).toBe('build');
    expect(h.rt.notice).toContain('unavailable while viewing a sub-agent');

    h.tui.emit('\x18'); // ctrl+x leader
    h.tui.emit('x'); // queue remove
    await Promise.resolve();
    expect(queueRecall).not.toHaveBeenCalled();
    expect(h.rt.queued).toEqual([{ id: 'parent-q', text: 'hidden parent follow-up' }]);
    composition.dispose();
  });

  it('Esc in a focused view navigates back one level (closeSubagent) and never stops a turn', () => {
    const h = compositionHarness({ columns: 100, rows: 24, turns: 6 });
    focusChild(h);
    // The child is mid-turn: Esc stays navigation even then — stopping is /stop, not a view key.
    h.rt.childView!.transcript.apply({ type: 'tool_authoring', name: 'Bash', detail: 'long build' } as never);
    const closeSubagent = vi.fn();
    const abort = vi.fn(async () => {});
    Object.assign(h.stream, { closeSubagent });
    Object.assign(h.resources.client, { abort });
    const composition = makeComposition(h);

    h.tui.emit('\x1b');

    expect(closeSubagent).toHaveBeenCalledOnce();
    expect(abort).not.toHaveBeenCalled();
    composition.dispose();
  });
});
