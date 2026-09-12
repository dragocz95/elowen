import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { compactNotice, parseCommand, pluginPickerRenderer, resolveThinkingLevel, wireSubmit } from '../../../src/cli/chat/commands.js';
import { loadPrefs } from '../../../src/cli/chat/prefs.js';
import { TranscriptModel } from '../../../src/brain/transcriptModel.js';
import { ChatState } from '../../../src/cli/chat/chatState.js';
import { ChatApplicationLifetime } from '../../../src/cli/chat/applicationLifetime.js';
import { LocalShellBuffer } from '../../../src/cli/chat/localShell.js';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  return { promise: new Promise<T>((done, fail) => { resolve = done; reject = fail; }), resolve, reject };
}

// wireSubmit deliberately trusts only the daemon-published catalog. These tests exercise local commands,
// so their runtime fixture must publish the same names instead of an impossible empty catalog.
const TEST_COMMAND_DEFS = ['maskot', 'goal', 'paste', 'reasoning', 'editor'].map((name) => ({ name })) as never;
const testAttachmentChips = () => ({ set: vi.fn() });

/** A plugin-declared picker exactly as `GET /brain/commands` publishes it: `kind: 'picker'`,
 *  `execution: 'surface-local'` and an owning plugin. Core carries neither name. */
const PLUGIN_PICKER_DEFS = [
  { name: 'sandbox', description: 'Inspect and manage Sandbox workspaces', kind: 'picker', execution: 'surface-local', plugin: 'sandbox' },
  { name: 'deployer', description: 'Pick a deployment target', kind: 'picker', execution: 'surface-local', plugin: 'deploy' },
  { name: 'tasks', description: 'Tasks', kind: 'picker', execution: 'surface-local' },
] as never;

/** The same `/sandbox` NAME, published by a plugin that owns none of the sandbox routes. Nothing stops a
 *  second plugin from registering that name, and the terminal's sandbox renderer drives the sandbox
 *  plugin's own endpoints — so this is the shape the CLI has to refuse to draw. */
const IMPOSTOR_PICKER_DEFS = [
  { name: 'sandbox', description: 'Pick a build sandbox', kind: 'picker', execution: 'surface-local', plugin: 'ci-runner' },
] as never;

describe('resolveThinkingLevel', () => {
  it('accepts canonical ids and provider-facing labels without leaking the label to PI', () => {
    const levels = ['low', 'high', 'xhigh', 'max'];
    const labels = { xhigh: 'ultra', max: 'max' };
    expect(resolveThinkingLevel('high', levels, labels)).toBe('high');
    expect(resolveThinkingLevel('Ultra', levels, labels)).toBe('xhigh');
    expect(resolveThinkingLevel('max', levels, labels)).toBe('max');
    expect(resolveThinkingLevel('minimal', levels, labels)).toBeNull();
  });
});

describe('parseCommand — /compact custom instructions', () => {
  it('captures free-text after /compact as the argument', () => {
    expect(parseCommand('/compact keep only the decisions')).toEqual({ cmd: 'compact', arg: 'keep only the decisions' });
  });

  it('a bare /compact carries no argument', () => {
    expect(parseCommand('/compact')).toEqual({ cmd: 'compact' });
  });
});

/** Without this route the TUI would fall through to the "unknown slash" path and SEND `/clear` as an
 *  ordinary message — the model would read the destructive command as a prompt. */
describe('parseCommand — /clear', () => {
  it('routes /clear as its own command rather than as chat text', () => {
    expect(parseCommand('/clear')).toEqual({ cmd: 'clear' });
  });
});

describe('parseCommand — /stats', () => {
  it('recognises a bare /stats with no argument', () => {
    expect(parseCommand('/stats')).toEqual({ cmd: 'stats' });
  });
});

describe('parseCommand — /tasks', () => {
  it('recognises a bare /tasks with no argument', () => {
    expect(parseCommand('/tasks')).toEqual({ cmd: 'tasks' });
  });
});

/** The parser must resolve a plugin-declared picker from the PUBLISHED catalog alone — no plugin name is
 *  written into it, so a plugin that is switched off simply stops publishing and the command stops
 *  resolving. */
describe('parseCommand — plugin-declared picker commands', () => {
  it('resolves any published surface-local picker owned by a plugin generically, carrying its owner', () => {
    expect(parseCommand('/sandbox', PLUGIN_PICKER_DEFS)).toEqual({ cmd: 'plugin-picker', name: 'sandbox', plugin: 'sandbox' });
    expect(parseCommand('/deployer', PLUGIN_PICKER_DEFS)).toEqual({ cmd: 'plugin-picker', name: 'deployer', plugin: 'deploy' });
  });

  it('returns null for a name the catalog does not publish', () => {
    expect(parseCommand('/sandbox', TEST_COMMAND_DEFS)).toBeNull();
    expect(parseCommand('/nosuchcommand', PLUGIN_PICKER_DEFS)).toBeNull();
  });

  it('never turns a built-in into a plugin picker, even when the published entry looks like one', () => {
    expect(parseCommand('/tasks', PLUGIN_PICKER_DEFS)).toEqual({ cmd: 'tasks' });
  });
});

describe('wireSubmit — plugin picker dispatch', () => {
  const submitWith = (text: string, pickers: Record<string, unknown>, defs: unknown = PLUGIN_PICKER_DEFS): ChatState => {
    let onSubmit: ((value: string) => void) | undefined;
    const editor = {
      addToHistory: vi.fn(), setText: vi.fn(),
      set onSubmit(fn: (value: string) => void) { onSubmit = fn; },
    };
    const state = new ChatState({ transcript: new TranscriptModel() });
    wireSubmit(
      state,
      {
        client: {}, editor, shellContext: new LocalShellBuffer(), attachmentChips: testAttachmentChips(),
        commandDefs: defs, tui: {}, lifetime: new ChatApplicationLifetime<'metadata'>(),
      } as never,
      { render: vi.fn() } as never,
      { stream: {}, pickers } as never,
    );
    onSubmit?.(text);
    return state;
  };

  it('opens the renderer the CLI registered for that published name', () => {
    const openSandboxModal = vi.fn();
    submitWith('/sandbox', { openSandboxModal });
    expect(openSandboxModal).toHaveBeenCalledOnce();
  });

  it('reports a published picker this terminal has no renderer for instead of opening an empty chooser', () => {
    const openSandboxModal = vi.fn();
    const state = submitWith('/deployer', { openSandboxModal });
    expect(openSandboxModal).not.toHaveBeenCalled();
    expect(state.notice).toContain('/deployer');
  });

  /** The renderer registry is keyed by the published name AND the plugin that owns it. Keyed by name
   *  alone, any plugin that registered `/sandbox` would have its command answered by the sandbox
   *  renderer — which posts to the SANDBOX plugin's own workspace routes, creating and removing Git
   *  worktrees on behalf of a command that plugin never declared. */
  it('refuses to draw the sandbox chooser for a /sandbox published by a different plugin', () => {
    const openSandboxModal = vi.fn();
    const state = submitWith('/sandbox', { openSandboxModal }, IMPOSTOR_PICKER_DEFS);
    expect(openSandboxModal).not.toHaveBeenCalled();
    expect(state.notice).toContain('/sandbox');
    expect(state.notice).toContain('ci-runner');
  });

  it('resolves the renderer only for the name AND owner it was registered for', () => {
    expect(pluginPickerRenderer('sandbox', 'sandbox')).toBeTypeOf('function');
    expect(pluginPickerRenderer('sandbox', 'ci-runner')).toBeNull();
    expect(pluginPickerRenderer('deployer', 'deploy')).toBeNull();
  });
});

describe('parseCommand — /context', () => {
  it('recognises the context-breakdown command', () => {
    expect(parseCommand('/context')).toEqual({ cmd: 'context' });
  });
});

describe('parseCommand — /cd', () => {
  it('captures the path, including one containing spaces', () => {
    expect(parseCommand('/cd ~/projects/api')).toEqual({ cmd: 'cd', arg: '~/projects/api' });
    expect(parseCommand('/cd /var/www/my project')).toEqual({ cmd: 'cd', arg: '/var/www/my project' });
    expect(parseCommand('/cd ../..')).toEqual({ cmd: 'cd', arg: '../..' });
  });

  it('a bare /cd carries no argument, so it can report instead of moving', () => {
    expect(parseCommand('/cd')).toEqual({ cmd: 'cd' });
  });
});

describe('parseCommand — work-mode commands', () => {
  it('recognizes /workflow alongside /plan and /build', () => {
    expect(parseCommand('/workflow')).toEqual({ cmd: 'workflow' });
    expect(parseCommand('/plan')).toEqual({ cmd: 'plan' });
    expect(parseCommand('/build')).toEqual({ cmd: 'build' });
  });

  it('captures a headless prompt after /workflow', () => {
    expect(parseCommand('/workflow ship the parser')).toEqual({ cmd: 'workflow', arg: 'ship the parser' });
  });
});

describe('parseCommand — /maskot', () => {
  it('recognises a bare toggle and explicit on/off', () => {
    expect(parseCommand('/maskot')).toEqual({ cmd: 'maskot' });
    expect(parseCommand('/maskot on')).toEqual({ cmd: 'maskot', arg: 'on' });
    expect(parseCommand('/maskot off')).toEqual({ cmd: 'maskot', arg: 'off' });
  });
});

describe('/maskot toggles and persists the mascot preference', () => {
  it('flips state.showMascot, writes it to cli-prefs.json and reads back after a reload', () => {
    const home = mkdtempSync(join(tmpdir(), 'elowen-maskot-'));
    const priorHome = process.env.HOME;
    process.env.HOME = home;
    try {
      let onSubmit: ((text: string) => void) | undefined;
      const editor = {
        addToHistory: vi.fn(), setText: vi.fn(),
        set onSubmit(fn: (text: string) => void) { onSubmit = fn; },
      };
      const render = vi.fn();
      const state = new ChatState({ transcript: new TranscriptModel() });
      expect(state.showMascot).toBe(true); // product default: shown until the user hides it
      wireSubmit(
        state,
        {
          client: {}, editor, shellContext: new LocalShellBuffer(), attachmentChips: testAttachmentChips(), commandDefs: TEST_COMMAND_DEFS, tui: {},
          lifetime: new ChatApplicationLifetime<'metadata'>(),
        } as never,
        { render } as never,
        { stream: {}, pickers: {} } as never,
      );
      const env = { HOME: home } as NodeJS.ProcessEnv;

      onSubmit?.('/maskot');
      expect(state.showMascot).toBe(false);
      expect(loadPrefs(env).showMascot).toBe(false); // persisted → survives a CLI restart

      onSubmit?.('/maskot');
      expect(state.showMascot).toBe(true);
      expect(loadPrefs(env).showMascot).toBe(true);

      onSubmit?.('/maskot off'); // explicit form forces the state regardless of the current value
      expect(state.showMascot).toBe(false);
      expect(loadPrefs(env).showMascot).toBe(false);
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('compactNotice', () => {
  it('a real compaction shows no local notice — the daemon stream owns the status', () => {
    expect(compactNotice({ compacted: true })).toBeNull();
    expect(compactNotice({ compacted: true, message: 'ignored' })).toBeNull();
  });

  it('a benign no-op surfaces the server message (it emits no stream event to announce itself)', () => {
    expect(compactNotice({ compacted: false, message: 'Nothing to compact yet.' })).toBe('Nothing to compact yet.');
  });

  // The no-op wording is written once, by the daemon's runCompaction. A local fallback covered only one
  // of its two cases and told an already-compacted session it had nothing to compact yet.
  it('shows nothing of its own when the server sent no message', () => {
    expect(compactNotice({ compacted: false })).toBeNull();
  });
});

describe('sub-agent child submit echo', () => {
  it('does not append a local user turn; the child daemon stream is the sole echo authority', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elowen-child-submit-'));
    const priorHome = process.env.HOME;
    process.env.HOME = home;
    try {
      let onSubmit: ((text: string) => void) | undefined;
      const editor = {
        addToHistory: vi.fn(), setText: vi.fn(),
        set onSubmit(fn: (text: string) => void) { onSubmit = fn; },
      };
      const subagentSend = vi.fn(async () => {});
      const childTranscript = new TranscriptModel();
      const render = vi.fn();
      const state = new ChatState({ transcript: new TranscriptModel() });
      state.childView = { sessionId: 'brain-ch-subagent-child', transcript: childTranscript, loading: false };
      wireSubmit(
        state,
        {
          client: { subagentSend }, editor, shellContext: new LocalShellBuffer(), attachmentChips: testAttachmentChips(),
          commandDefs: TEST_COMMAND_DEFS, tui: {}, lifetime: new ChatApplicationLifetime<'metadata'>(),
        } as never,
        { render } as never,
        { stream: {}, pickers: {} } as never,
      );
      const before = childTranscript.revision;
      onSubmit?.('guide the child');
      await Promise.resolve();

      expect(subagentSend).toHaveBeenCalledWith('brain-ch-subagent-child', 'guide the child');
      expect(childTranscript.revision).toBe(before);
      expect(childTranscript.turnCount).toBe(0);
      expect(render).toHaveBeenCalledOnce(); // only flushes the cleared editor
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('delivers pending image attachments to the VIEWED child and clears the chips', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elowen-child-attach-'));
    const priorHome = process.env.HOME;
    process.env.HOME = home;
    try {
      let onSubmit: ((text: string) => void) | undefined;
      const editor = {
        addToHistory: vi.fn(), setText: vi.fn(),
        set onSubmit(fn: (text: string) => void) { onSubmit = fn; },
      };
      const subagentSend = vi.fn(async () => {});
      const render = vi.fn();
      const attachmentChips = testAttachmentChips();
      const state = new ChatState({ transcript: new TranscriptModel() });
      state.childView = { sessionId: 'brain-ch-subagent-child', transcript: new TranscriptModel(), loading: false };
      state.pendingImages = [{ name: 'shot.png', data: 'aGk=', mimeType: 'image/png' } as never];
      wireSubmit(
        state,
        {
          client: { subagentSend }, editor, shellContext: new LocalShellBuffer(), attachmentChips,
          commandDefs: TEST_COMMAND_DEFS, tui: {}, lifetime: new ChatApplicationLifetime<'metadata'>(),
        } as never,
        { render } as never,
        { stream: {}, pickers: {} } as never,
      );

      onSubmit?.('what is in this screenshot');
      await Promise.resolve();

      expect(subagentSend).toHaveBeenCalledWith('brain-ch-subagent-child', 'what is in this screenshot',
        [{ data: 'aGk=', mimeType: 'image/png' }]);
      expect(state.pendingImages).toEqual([]);
      expect(attachmentChips.set).toHaveBeenCalledWith([]);
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('focused-child slash routing', () => {
  function childCommandHarness(commandDefs: unknown[]) {
    let onSubmit: ((text: string) => void) | undefined;
    const editor = {
      addToHistory: vi.fn(), setText: vi.fn(),
      set onSubmit(fn: (text: string) => void) { onSubmit = fn; },
    };
    const state = new ChatState({ transcript: new TranscriptModel() });
    state.childView = { sessionId: 'brain-ch-subagent-child', transcript: new TranscriptModel(), loading: false } as never;
    const render = vi.fn();
    const exitSubagent = vi.fn();
    const command = vi.fn(async () => ({ message: 'parent changed' }));
    const setFast = vi.fn(async () => ({ fast: true, fastAvailable: true }));
    const pickers = {
      openThinkingPicker: vi.fn(), openTasksModal: vi.fn(), openModelPicker: vi.fn(),
      openStatsModal: vi.fn(), applyModelArg: vi.fn(),
    };
    wireSubmit(
      state,
      {
        client: { command, setFast }, editor, shellContext: new LocalShellBuffer(), attachmentChips: testAttachmentChips(),
        commandDefs, tui: {}, lifetime: new ChatApplicationLifetime<'metadata'>(), termSettings: null,
      } as never,
      { render } as never,
      { stream: { exitSubagent }, pickers } as never,
    );
    return { onSubmit, state, exitSubagent, command, setFast, pickers };
  }

  it('explicitly refuses parent-scoped session commands instead of exiting and mutating the hidden parent', async () => {
    const h = childCommandHarness([{ name: 'clear' }, { name: 'reasoning' }, { name: 'tasks' }] as never);

    h.onSubmit?.('/clear');
    h.onSubmit?.('/reasoning high');
    h.onSubmit?.('/tasks');
    await Promise.resolve();

    expect(h.exitSubagent).not.toHaveBeenCalled();
    expect(h.command).not.toHaveBeenCalled();
    expect(h.pickers.openThinkingPicker).not.toHaveBeenCalled();
    expect(h.pickers.openTasksModal).not.toHaveBeenCalled();
    expect(h.state.notice).toContain('unavailable while viewing a sub-agent');
  });

  it('disables /fast in the child view without calling the parent-bound Fast API', async () => {
    const h = childCommandHarness([{ name: 'fast' }] as never);

    h.onSubmit?.('/fast on');
    await Promise.resolve();

    expect(h.setFast).not.toHaveBeenCalled();
    expect(h.exitSubagent).not.toHaveBeenCalled();
    expect(h.state.notice).toContain('unavailable while viewing a sub-agent');
  });

  it('disables /stats and /context without opening the hidden parent status modal', () => {
    const h = childCommandHarness([{ name: 'stats' }, { name: 'context' }] as never);

    h.onSubmit?.('/stats');
    h.onSubmit?.('/context');

    expect(h.pickers.openStatsModal).not.toHaveBeenCalled();
    expect(h.exitSubagent).not.toHaveBeenCalled();
    expect(h.state.notice).toContain('unavailable while viewing a sub-agent');
  });

  it('keeps /model inside the child view and routes the picker without exiting', () => {
    const h = childCommandHarness([{ name: 'model' }] as never);
    h.onSubmit?.('/model next-model');
    expect(h.pickers.applyModelArg).toHaveBeenCalledWith('next-model');
    expect(h.exitSubagent).not.toHaveBeenCalled();
  });
});

describe('/stop — targets the session the user is LOOKING at', () => {
  /** The catalog the daemon publishes for these tests must carry `/stop` — an unpublished name is
   *  treated as chat text, which is exactly the routing under test here. */
  const STOP_COMMAND_DEFS = [...TEST_COMMAND_DEFS, { name: 'stop' }] as never;

  function stopHarness(childThinking: boolean) {
    let onSubmit: ((text: string) => void) | undefined;
    const editor = {
      addToHistory: vi.fn(), setText: vi.fn(),
      set onSubmit(fn: (text: string) => void) { onSubmit = fn; },
    };
    const abort = vi.fn(async () => {});
    const killCommands = vi.fn(async () => ({ killed: 1 }));
    const render = vi.fn();
    const state = new ChatState({ transcript: new TranscriptModel() });
    const childTranscript = new TranscriptModel();
    if (childThinking) childTranscript.apply({ type: 'tool_authoring', name: 'Bash', detail: 'long build' } as never);
    state.childView = { sessionId: 'brain-ch-subagent-child', transcript: childTranscript, loading: false };
    wireSubmit(
      state,
      {
        client: { abort, killCommands }, editor, shellContext: new LocalShellBuffer(), attachmentChips: testAttachmentChips(),
        commandDefs: STOP_COMMAND_DEFS, tui: {}, lifetime: new ChatApplicationLifetime<'metadata'>(),
      } as never,
      { render } as never,
      { stream: {}, pickers: {} } as never,
    );
    return { onSubmit, abort, killCommands, state, childTranscript };
  }

  it('a running viewed child is stopped by explicit session — the hidden parent stays untouched', async () => {
    const { onSubmit, abort } = stopHarness(true);
    onSubmit?.('/stop');
    await Promise.resolve();
    expect(abort).toHaveBeenCalledWith('brain-ch-subagent-child');
  });

  it('reports nothing running when the VIEWED child is idle, even if the parent runs', () => {
    const { onSubmit, abort, state } = stopHarness(false);
    state.transcript.apply({ type: 'tool_authoring', name: 'Bash', detail: 'long build' } as never); // parent busy, but it is NOT in view
    onSubmit?.('/stop');
    expect(abort).not.toHaveBeenCalled();
    expect(state.notice).toContain('nothing is running');
  });

  it('a repeated /stop escalates to a kill of THAT child\'s command, never the parent\'s', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      const { onSubmit, abort, killCommands, state } = stopHarness(true);
      // A running foreground command is what could pin the aborted child turn.
      state.childView!.processes = [{
        id: 'p-child', command: 'child build', cwd: '/w', startedAt: '2026-09-12T10:00:00.000Z',
        sessionId: 'brain-ch-subagent-child', running: true, exitCode: null, completionMode: 'foreground',
      } as never];
      state.processes = [{
        id: 'p-parent', command: 'parent build', cwd: '/w', startedAt: '2026-09-12T10:00:00.000Z',
        sessionId: 'brain-parent', running: true, exitCode: null, completionMode: 'foreground',
      } as never];

      onSubmit?.('/stop'); // first press: graceful abort of the child, escalation armed
      await Promise.resolve();
      expect(abort).toHaveBeenCalledTimes(1);
      expect(abort).toHaveBeenCalledWith('brain-ch-subagent-child');
      expect(killCommands).not.toHaveBeenCalled();
      expect(state.notice).toContain('again to kill');

      vi.setSystemTime(10_500); // still inside the confirmation window; the child stayed pinned
      onSubmit?.('/stop'); // second press: hard-kill the CHILD's foreground command
      await Promise.resolve();
      expect(killCommands).toHaveBeenCalledOnce();
      expect(killCommands).toHaveBeenCalledWith({ session: 'brain-ch-subagent-child' });
      // Still exactly one abort: the escalation replaced the stop, it did not re-send it.
      expect(abort).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a fresh drill resets the ladder — the escalation never fires for the wrong child', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      const { onSubmit, abort, killCommands, state } = stopHarness(true);
      state.childView!.processes = [{
        id: 'p-b', command: 'b build', cwd: '/w', startedAt: '2026-09-12T10:00:00.000Z',
        sessionId: 'brain-ch-subagent-child', running: true, exitCode: null, completionMode: 'foreground',
      } as never];
      onSubmit?.('/stop'); // abort B, ladder armed for B
      await Promise.resolve();

      // Drill into B's grandchild C: the viewed session changed, so the very next /stop must ABORT C —
      // B's abort marker must not turn it into a kill of C's (or anyone else's) command.
      const childCTranscript = new TranscriptModel();
      childCTranscript.apply({ type: 'tool_authoring', name: 'Bash', detail: 'c build' } as never);
      state.childView = { sessionId: 'brain-ch-subagent-grandchild', transcript: childCTranscript, loading: false, processes: [] } as never;
      onSubmit?.('/stop');
      await Promise.resolve();
      expect(abort).toHaveBeenLastCalledWith('brain-ch-subagent-grandchild');
      expect(killCommands).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a settled child run resets the ladder — the next run starts with a graceful stop again', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      const { onSubmit, abort, killCommands, state, childTranscript } = stopHarness(true);
      state.childView!.processes = [{
        id: 'p-child', command: 'child build', cwd: '/w', startedAt: '2026-09-12T10:00:00.000Z',
        sessionId: 'brain-ch-subagent-child', running: true, exitCode: null, completionMode: 'foreground',
      } as never];
      onSubmit?.('/stop'); // abort; escalation armed for this run
      await Promise.resolve();

      // The run settles (idle reaches the child lane), then the child starts a NEW run.
      childTranscript.apply({ type: 'idle' } as never);
      onSubmit?.('/stop');
      expect(state.notice).toContain('nothing is running'); // idle observed → ladder cleared
      childTranscript.apply({ type: 'user', text: 'next run' } as never); // a fresh run is thinking again
      onSubmit?.('/stop');
      expect(abort).toHaveBeenCalledTimes(2); // graceful again — no stale kill
      expect(killCommands).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('application lifetime for local input work', () => {
  it('shows a goal as active while the kickoff request is still running instead of sticking on starting', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elowen-goal-command-'));
    const priorHome = process.env.HOME;
    process.env.HOME = home;
    try {
      let onSubmit: ((text: string) => void) | undefined;
      const editor = {
        addToHistory: vi.fn(), setText: vi.fn(),
        set onSubmit(fn: (text: string) => void) { onSubmit = fn; },
      };
      const pending = deferred<{
        session_id: string; user_id: number; status: 'done'; goal: string; draft: string; subgoals: string;
        turns_used: number; turn_budget: number; last_verdict: string; last_evidence: string;
        paused_reason: string; created_at: string; updated_at: string;
      }>();
      const render = vi.fn();
      const state = new ChatState({ transcript: new TranscriptModel() });
      wireSubmit(
        state,
        {
          client: { setGoal: () => pending.promise }, editor,
          shellContext: new LocalShellBuffer(), attachmentChips: testAttachmentChips(), commandDefs: TEST_COMMAND_DEFS, tui: {},
          lifetime: new ChatApplicationLifetime<'metadata'>(),
        } as never,
        { render } as never,
        { stream: {}, pickers: {} } as never,
      );

      onSubmit?.('/goal Ship the clean goal indicator');

      expect(state.goal).toMatchObject({ status: 'active', goal: 'Ship the clean goal indicator' });
      expect(state.notice).not.toMatch(/starting persistent goal/i);
      pending.resolve({
        session_id: 'brain-1', user_id: 1, status: 'done', goal: 'Ship the clean goal indicator',
        draft: '', subgoals: '[]', turns_used: 1, turn_budget: 8, last_verdict: 'done',
        last_evidence: 'verified', paused_reason: '',
        created_at: '2026-07-12 10:00:00', updated_at: '2026-07-12 10:00:01',
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(state.goal?.status).toBe('done');
      expect(state.notice).not.toMatch(/starting persistent goal/i);
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('does not let a delayed kickoff response overwrite a newer streamed terminal goal state', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elowen-goal-ordering-'));
    const priorHome = process.env.HOME;
    process.env.HOME = home;
    try {
      let onSubmit: ((text: string) => void) | undefined;
      const editor = {
        addToHistory: vi.fn(), setText: vi.fn(),
        set onSubmit(fn: (text: string) => void) { onSubmit = fn; },
      };
      const pending = deferred<NonNullable<ChatState['goal']>>();
      const state = new ChatState({ transcript: new TranscriptModel() });
      wireSubmit(
        state,
        {
          client: { setGoal: () => pending.promise }, editor,
          shellContext: new LocalShellBuffer(), attachmentChips: testAttachmentChips(), commandDefs: TEST_COMMAND_DEFS, tui: {},
          lifetime: new ChatApplicationLifetime<'metadata'>(),
        } as never,
        { render: vi.fn() } as never,
        { stream: {}, pickers: {} } as never,
      );

      onSubmit?.('/goal Preserve the terminal state');
      const active = state.goal!;
      const done = { ...active, user_id: 1, status: 'done' as const, turns_used: 2, last_verdict: 'done' };
      state.setGoal(done); // authoritative SSE arrived before the old HTTP request settled
      pending.resolve({ ...active, user_id: 1 }); // adversarial stale response
      await Promise.resolve();
      await Promise.resolve();

      expect(state.goal).toEqual(done);
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('refetches authoritative goal state when kickoff fails instead of restoring the previous goal', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elowen-goal-failure-'));
    const priorHome = process.env.HOME;
    process.env.HOME = home;
    try {
      let onSubmit: ((text: string) => void) | undefined;
      const editor = {
        addToHistory: vi.fn(), setText: vi.fn(),
        set onSubmit(fn: (text: string) => void) { onSubmit = fn; },
      };
      const previous = {
        session_id: 'brain-1', user_id: 1, status: 'active' as const, goal: 'Previous goal',
        draft: '', subgoals: '[]', turns_used: 1, turn_budget: 8, last_verdict: '',
        last_evidence: '', paused_reason: '',
        created_at: '2026-07-12 09:00:00', updated_at: '2026-07-12 09:00:01',
      };
      const paused = {
        ...previous, goal: 'Replacement goal', status: 'paused' as const, last_verdict: 'error',
        paused_reason: 'provider failed', updated_at: '2026-07-12 10:00:01',
      };
      const client = {
        setGoal: vi.fn(async () => { throw new Error('provider failed'); }),
        goal: vi.fn(async () => paused),
      };
      const state = new ChatState({ transcript: new TranscriptModel(), goal: previous });
      wireSubmit(
        state,
        {
          client, editor, shellContext: new LocalShellBuffer(), attachmentChips: testAttachmentChips(), commandDefs: TEST_COMMAND_DEFS, tui: {},
          lifetime: new ChatApplicationLifetime<'metadata'>(),
        } as never,
        { render: vi.fn() } as never,
        { stream: {}, pickers: {} } as never,
      );

      onSubmit?.('/goal Replacement goal');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(client.goal).toHaveBeenCalledOnce();
      expect(state.goal).toEqual(paused);
      expect(state.notice).toMatch(/provider failed/i);
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('applies a post-failure goal refetch over an earlier streamed active state', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elowen-goal-failure-stream-race-'));
    const priorHome = process.env.HOME;
    process.env.HOME = home;
    try {
      let onSubmit: ((text: string) => void) | undefined;
      const editor = {
        addToHistory: vi.fn(), setText: vi.fn(),
        set onSubmit(fn: (text: string) => void) { onSubmit = fn; },
      };
      const refetch = deferred<NonNullable<ChatState['goal']>>();
      const state = new ChatState({ transcript: new TranscriptModel() });
      wireSubmit(
        state,
        {
          client: {
            setGoal: vi.fn(async () => { throw new Error('kickoff failed'); }),
            goal: vi.fn(() => refetch.promise),
          },
          editor, shellContext: new LocalShellBuffer(), attachmentChips: testAttachmentChips(), commandDefs: TEST_COMMAND_DEFS, tui: {},
          lifetime: new ChatApplicationLifetime<'metadata'>(),
        } as never,
        { render: vi.fn() } as never,
        { stream: {}, pickers: {} } as never,
      );

      onSubmit?.('/goal Reconcile the failure');
      await Promise.resolve();
      const streamedActive = { ...state.goal!, user_id: 1, status: 'active' as const, turns_used: 1 };
      state.setGoal(streamedActive); // SSE admission landed while the failed POST was being reconciled
      const paused = {
        ...streamedActive, status: 'paused' as const, last_verdict: 'error', paused_reason: 'kickoff failed',
      };
      refetch.resolve(paused); // this GET completed after that SSE and is therefore the newer authority
      await Promise.resolve();
      await Promise.resolve();

      expect(state.goal).toEqual(paused);
      expect(state.notice).toMatch(/kickoff failed/i);
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('clears an unverified optimistic goal when both kickoff and authoritative refetch fail', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elowen-goal-double-failure-'));
    const priorHome = process.env.HOME;
    process.env.HOME = home;
    try {
      let onSubmit: ((text: string) => void) | undefined;
      const editor = {
        addToHistory: vi.fn(), setText: vi.fn(),
        set onSubmit(fn: (text: string) => void) { onSubmit = fn; },
      };
      const state = new ChatState({ transcript: new TranscriptModel() });
      wireSubmit(
        state,
        {
          client: {
            setGoal: vi.fn(async () => { throw new Error('kickoff offline'); }),
            goal: vi.fn(async () => { throw new Error('status offline'); }),
          },
          editor, shellContext: new LocalShellBuffer(), attachmentChips: testAttachmentChips(), commandDefs: TEST_COMMAND_DEFS, tui: {},
          lifetime: new ChatApplicationLifetime<'metadata'>(),
        } as never,
        { render: vi.fn() } as never,
        { stream: {}, pickers: {} } as never,
      );

      onSubmit?.('/goal Do not leave a fake timer');
      expect(state.goal?.status).toBe('active');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(state.goal).toBeNull();
      expect(state.notice).toMatch(/kickoff offline/i);
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('ignores a stale goal failure after a newer goal command took ownership', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elowen-goal-stale-failure-'));
    const priorHome = process.env.HOME;
    process.env.HOME = home;
    try {
      let onSubmit: ((text: string) => void) | undefined;
      const editor = {
        addToHistory: vi.fn(), setText: vi.fn(),
        set onSubmit(fn: (text: string) => void) { onSubmit = fn; },
      };
      const first = deferred<NonNullable<ChatState['goal']>>();
      const state = new ChatState({ transcript: new TranscriptModel() });
      const replacement = {
        session_id: 'brain-1', user_id: 1, status: 'done' as const, goal: 'New command wins',
        draft: '', subgoals: '[]', turns_used: 1, turn_budget: 8, last_verdict: 'done',
        last_evidence: 'verified', paused_reason: '',
        created_at: '2026-07-12 10:00:00', updated_at: '2026-07-12 10:00:01',
      };
      const setGoal = vi.fn()
        .mockImplementationOnce(() => first.promise)
        .mockResolvedValueOnce(replacement);
      wireSubmit(
        state,
        {
          client: { setGoal, goal: vi.fn(async () => { throw new Error('stale status failure'); }) },
          editor, shellContext: new LocalShellBuffer(), attachmentChips: testAttachmentChips(), commandDefs: TEST_COMMAND_DEFS, tui: {},
          lifetime: new ChatApplicationLifetime<'metadata'>(),
        } as never,
        { render: vi.fn() } as never,
        { stream: {}, pickers: {} } as never,
      );

      onSubmit?.('/goal Old command');
      onSubmit?.('/goal New command wins');
      await Promise.resolve();
      await Promise.resolve();
      first.reject(new Error('old kickoff failed'));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(state.goal).toEqual(replacement);
      expect(state.notice).not.toMatch(/old kickoff|stale status/i);
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps pause feedback when the streamed state arrives before the action response', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elowen-goal-action-ordering-'));
    const priorHome = process.env.HOME;
    process.env.HOME = home;
    try {
      let onSubmit: ((text: string) => void) | undefined;
      const editor = {
        addToHistory: vi.fn(), setText: vi.fn(),
        set onSubmit(fn: (text: string) => void) { onSubmit = fn; },
      };
      const active = {
        session_id: 'brain-1', user_id: 1, status: 'active' as const, goal: 'Pause cleanly',
        draft: '', subgoals: '[]', turns_used: 1, turn_budget: 8, last_verdict: '',
        last_evidence: '', paused_reason: '',
        created_at: '2026-07-12 10:00:00', updated_at: '2026-07-12 10:00:01',
      };
      const paused = { ...active, status: 'paused' as const, paused_reason: 'paused by user' };
      const response = deferred<typeof paused>();
      const state = new ChatState({ transcript: new TranscriptModel(), goal: active });
      wireSubmit(
        state,
        {
          client: { goalAction: () => response.promise }, editor,
          shellContext: new LocalShellBuffer(), attachmentChips: testAttachmentChips(), commandDefs: TEST_COMMAND_DEFS, tui: {},
          lifetime: new ChatApplicationLifetime<'metadata'>(),
        } as never,
        { render: vi.fn() } as never,
        { stream: {}, pickers: {} } as never,
      );

      onSubmit?.('/goal pause');
      state.setGoal(paused);
      response.resolve(paused);
      await Promise.resolve();
      await Promise.resolve();

      expect(state.goal).toEqual(paused);
      expect(state.notice).toMatch(/goal paused|paused by user/i);
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('kills publication from an unfinished !cmd after the chat stops', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elowen-local-lifetime-'));
    const priorHome = process.env.HOME;
    process.env.HOME = home;
    try {
      let onSubmit: ((text: string) => void) | undefined;
      const editor = {
        addToHistory: vi.fn(), setText: vi.fn(),
        set onSubmit(fn: (text: string) => void) { onSubmit = fn; },
      };
      const pending = deferred<{ command: string; output: string; exitCode: number; truncated: boolean }>();
      const runLocal = vi.fn((_command: string, _cwd: string, _signal: AbortSignal) => pending.promise);
      const lifetime = new ChatApplicationLifetime<'metadata'>();
      const transcript = new TranscriptModel();
      const shellContext = new LocalShellBuffer();
      const render = vi.fn();
      const state = new ChatState({ transcript });
      wireSubmit(
        state,
        { client: {}, editor, shellContext, attachmentChips: testAttachmentChips(), commandDefs: TEST_COMMAND_DEFS, tui: {}, lifetime } as never,
        { render } as never,
        { stream: {}, pickers: {}, runLocalShell: runLocal } as never,
      );

      onSubmit?.('!printf pending');
      expect(runLocal).toHaveBeenCalledWith('printf pending', process.cwd(), lifetime.signal);
      const revision = transcript.revision;
      lifetime.stop();
      pending.resolve({ command: 'printf pending', output: 'late', exitCode: 0, truncated: false });
      await Promise.resolve();
      await Promise.resolve();

      expect(transcript.revision).toBe(revision);
      expect(shellContext.pending).toBe(false);
      expect(render).toHaveBeenCalledOnce();
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('does not attach a clipboard result that arrives after the chat stops', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elowen-clipboard-lifetime-'));
    const priorHome = process.env.HOME;
    process.env.HOME = home;
    try {
      let onSubmit: ((text: string) => void) | undefined;
      const editor = {
        addToHistory: vi.fn(), setText: vi.fn(),
        set onSubmit(fn: (text: string) => void) { onSubmit = fn; },
      };
      const pending = deferred<{ image?: { name: string; data: string; mimeType: string; bytes: number }; error?: string }>();
      const readClipboard = vi.fn((_signal: AbortSignal) => pending.promise);
      const lifetime = new ChatApplicationLifetime<'metadata'>();
      const render = vi.fn();
      const state = new ChatState({ transcript: new TranscriptModel() });
      wireSubmit(
        state,
        {
          client: {}, editor, shellContext: new LocalShellBuffer(),
          attachmentChips: { set: vi.fn() }, commandDefs: TEST_COMMAND_DEFS, tui: {}, lifetime,
        } as never,
        { render } as never,
        { stream: {}, pickers: {}, readClipboardImage: readClipboard } as never,
      );

      onSubmit?.('/paste');
      expect(readClipboard).toHaveBeenCalledWith(lifetime.signal);
      lifetime.stop();
      pending.resolve({ image: { name: 'late.png', data: 'iVBORw0KGgo=', mimeType: 'image/png', bytes: 8 } });
      await Promise.resolve();
      await Promise.resolve();

      expect(state.pendingImages).toEqual([]);
      expect(render).toHaveBeenCalledOnce();
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('does not publish a session command response into the next conversation', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elowen-session-epoch-'));
    const priorHome = process.env.HOME;
    process.env.HOME = home;
    try {
      let onSubmit: ((text: string) => void) | undefined;
      const editor = {
        addToHistory: vi.fn(), setText: vi.fn(),
        set onSubmit(fn: (text: string) => void) { onSubmit = fn; },
      };
      const response = deferred<{ thinkingLevel: string }>();
      const lifetime = new ChatApplicationLifetime<'metadata'>();
      const render = vi.fn();
      const state = new ChatState({
        transcript: new TranscriptModel(),
        thinkingLevel: 'low',
        thinkingLevels: ['low', 'high'],
      });
      wireSubmit(
        state,
        {
          client: { setThinkingLevel: () => response.promise }, editor,
          shellContext: new LocalShellBuffer(), attachmentChips: testAttachmentChips(), commandDefs: TEST_COMMAND_DEFS, tui: {}, lifetime,
        } as never,
        { render } as never,
        { stream: {}, pickers: {} } as never,
      );

      onSubmit?.('/reasoning high');
      lifetime.invalidate();
      response.resolve({ thinkingLevel: 'high' });
      await Promise.resolve();
      await Promise.resolve();

      expect(state.thinkingLevel).toBe('low');
      expect(state.notice).toBe('');
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('/editor terminal handoff', () => {
  it('always resumes the terminal and keeps the draft when editor setup rejects', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elowen-editor-resume-'));
    const priorHome = process.env.HOME;
    const priorEditor = process.env.EDITOR;
    process.env.HOME = home;
    process.env.EDITOR = 'elowen-test-editor-that-does-not-exist';
    try {
      let onSubmit: ((text: string) => void) | undefined;
      const editor = {
        addToHistory: vi.fn(), setText: vi.fn(), getExpandedText: () => 'draft survives',
        set onSubmit(fn: (text: string) => void) { onSubmit = fn; },
      };
      const edit = vi.fn(async () => { throw new Error('temp directory unavailable'); });
      const lifetime = new ChatApplicationLifetime<'metadata'>();
      const suspendTerminal = vi.fn();
      const resumeTerminal = vi.fn();
      const renderForced = vi.fn();
      const state = new ChatState({ transcript: new TranscriptModel() });
      wireSubmit(
        state,
        {
          client: {}, editor, shellContext: new LocalShellBuffer(), attachmentChips: testAttachmentChips(),
          commandDefs: TEST_COMMAND_DEFS, tui: {}, lifetime,
        } as never,
        { render: vi.fn(), renderForced, suspendTerminal, resumeTerminal } as never,
        { stream: {}, pickers: {}, editTextExternally: edit } as never,
      );

      onSubmit?.('/editor');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(edit).toHaveBeenCalledWith({ text: 'draft survives', signal: lifetime.signal });
      expect(suspendTerminal).toHaveBeenCalledOnce();
      expect(resumeTerminal).toHaveBeenCalledOnce();
      expect(editor.setText).toHaveBeenLastCalledWith('draft survives');
      expect(state.notice).toContain('draft kept');
      expect(renderForced).toHaveBeenCalledWith('external-editor:return');
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      if (priorEditor === undefined) delete process.env.EDITOR;
      else process.env.EDITOR = priorEditor;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

/** Drilled A→B→C, explicit navigation commands may leave the whole drill-in. Session-local commands
 *  either stay on C through a validated child route or are refused before touching the hidden parent. */
describe('slash inside a deep drill-in', () => {
  function deepHarness(command: string, defs: unknown) {
    let onSubmit: ((text: string) => void) | undefined;
    const editor = {
      addToHistory: vi.fn(), setText: vi.fn(),
      set onSubmit(fn: (text: string) => void) { onSubmit = fn; },
    };
    const render = vi.fn();
    const state = new ChatState({ transcript: new TranscriptModel() });
    // Viewing C with B retained on the trail — the deepest level a drill-in reaches.
    state.childTrail = [{ sessionId: 'brain-ch-subagent-B', transcript: new TranscriptModel() }];
    state.childView = { sessionId: 'brain-ch-subagent-C', transcript: new TranscriptModel(), loading: false } as never;
    const stream = {
      exitSubagent: vi.fn(() => { state.childView = null; state.childTrail = []; }),
      closeSubagent: vi.fn(),
      switchTo: vi.fn(async () => {}),
    };
    const pickers = { applyModelArg: vi.fn(), openModelPicker: vi.fn() };
    wireSubmit(
      state,
      {
        client: {}, editor, shellContext: new LocalShellBuffer(), attachmentChips: testAttachmentChips(),
        commandDefs: defs, tui: {}, lifetime: new ChatApplicationLifetime<'metadata'>(),
      } as never,
      { render } as never,
      { stream, pickers } as never,
    );
    return { onSubmit, state, stream, pickers };
  }

  const DEEP_DEFS = [...TEST_COMMAND_DEFS, { name: 'model' }] as never;

  it('/model stays on the grandchild and lets the picker use the delegated model route', () => {
    const { onSubmit, state, stream, pickers } = deepHarness('/model gpt-9', DEEP_DEFS);
    onSubmit?.('/model gpt-9');
    expect(stream.exitSubagent).not.toHaveBeenCalled();
    expect(stream.closeSubagent).not.toHaveBeenCalled();
    expect(state.childView?.sessionId).toBe('brain-ch-subagent-C');
    expect(pickers.applyModelArg).toHaveBeenCalledWith('gpt-9');
  });

  it('/new from the deepest level re-targets the whole CLI to a fresh parent conversation', () => {
    const { onSubmit, stream } = deepHarness('/new', [...TEST_COMMAND_DEFS, { name: 'new' }] as never);
    onSubmit?.('/new');
    expect(stream.exitSubagent).toHaveBeenCalledOnce();
    expect(stream.switchTo).toHaveBeenCalledWith({ fresh: true });
  });
});
