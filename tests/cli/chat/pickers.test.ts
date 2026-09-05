import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { TranscriptModel } from '../../../src/brain/transcriptModel.js';
import { ChatState } from '../../../src/cli/chat/chatState.js';
import { createPickers } from '../../../src/cli/chat/pickers.js';
import { SandboxRouteError } from '../../../src/cli/chat/brainClient.js';
import { setChatTheme } from '../../../src/cli/chat/theme.js';
import { ChatApplicationLifetime } from '../../../src/cli/chat/applicationLifetime.js';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  return { promise: new Promise<T>((done, fail) => { resolve = done; reject = fail; }), resolve, reject };
}

let testHome: string | null = null;

afterEach(() => {
  setChatTheme('elowen');
  vi.unstubAllEnvs();
  if (testHome) rmSync(testHome, { recursive: true, force: true });
  testHome = null;
});

describe('picker theme application', () => {
  it.each([
    { name: 'mono', termSettings: null },
    {
      name: 'custom',
      termSettings: {
        theme: 'custom',
        palette: { foreground: '#eeeeee', background: '#111111', cyan: '#22ccbb' },
      },
    },
  ])('reopens the panel through reshowPanel after applying $name without owning visibility', ({ name, termSettings }) => {
    testHome = mkdtempSync(join(tmpdir(), 'elowen-pickers-'));
    vi.stubEnv('HOME', testHome);
    const render = vi.fn();
    const editor = { borderColor: (text: string) => text };
    const state = new ChatState({ transcript: new TranscriptModel() });
    const resources = {
      client: {}, tui: {}, editor, termSettings, cwdLabel: '', branchLabel: '', commandDefs: [],
    };
    const reshowPanel = vi.fn();
    const pickers = createPickers(
      state,
      resources as never,
      { render, refreshMeta: async () => {} },
      {} as never,
      { reshowPanel, reloadKeymap: vi.fn() },
    );

    expect(pickers.applyTheme(name)).toBe(true);
    expect(reshowPanel).toHaveBeenCalledOnce();
    expect(reshowPanel).toHaveBeenCalledWith();
    expect(render).toHaveBeenCalledOnce();
  });
});

describe('picker application lifetime', () => {
  it.each([
    { outcome: 'success', expectedRestarts: 1 },
    { outcome: 'failure', expectedRestarts: 0 },
  ])('restarts the parent stream only after a $outcome model switch', async ({ outcome, expectedRestarts }) => {
    const lifetime = new ChatApplicationLifetime<'metadata'>();
    const restartStream = vi.fn();
    let modal: { handleInput(data: string): void } | null = null;
    const overlayHandle = {
      hide: vi.fn(), setHidden: vi.fn(), isHidden: () => false,
      focus: vi.fn(), unfocus: vi.fn(), isFocused: () => true,
    };
    const tui = {
      terminal: { columns: 80, rows: 24 },
      showOverlay: vi.fn((component: { handleInput(data: string): void }) => {
        modal = component;
        return overlayHandle;
      }),
      setFocus: vi.fn(), requestRender: vi.fn(),
    };
    const setModel = vi.fn(async () => {
      if (outcome === 'failure') throw new Error('model switch failed');
      return { model: 'next-model' };
    });
    const state = new ChatState({ transcript: new TranscriptModel(), modelName: 'old-model' });
    const pickers = createPickers(
      state,
      {
        client: {
          models: async () => [{ provider: 'mock', providerLabel: 'Mock', model: 'next-model' }],
          setModel,
        },
        tui, editor: {}, termSettings: null, cwdLabel: '', branchLabel: '', commandDefs: [], lifetime,
      } as never,
      { render: vi.fn(), refreshMeta: async () => {} },
      { restartStream } as never,
      { reshowPanel: vi.fn(), reloadKeymap: vi.fn() },
    );

    pickers.openModelPicker();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(modal).not.toBeNull();
    (modal as unknown as { handleInput(data: string): void }).handleInput('\r');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(setModel).toHaveBeenCalledWith({ provider: 'mock', model: 'next-model' });
    expect(restartStream).toHaveBeenCalledTimes(expectedRestarts);
    await lifetime.stop();
  });

  it('opens the task actions straight from a task id and mirrors the change back through the shared card mapper', async () => {
    initTheme(); // the picker's SelectList paints through pi's theme
    const lifetime = new ChatApplicationLifetime<'metadata'>();
    let modal: { handleInput(data: string): void; render(width: number): string[] } | null = null;
    const tui = {
      terminal: { columns: 120, rows: 40 },
      showOverlay: vi.fn((component: typeof modal) => {
        modal = component;
        return { hide: vi.fn(), setHidden: vi.fn(), isHidden: () => false, focus: vi.fn(), unfocus: vi.fn(), isFocused: () => true };
      }),
      setFocus: vi.fn(), requestRender: vi.fn(),
    };
    const before = [
      { id: '7', subject: 'Wire the card', description: 'private', activeForm: 'Wiring the card', status: 'in_progress', startedAt: 4_000, owner: 'filip', blockedBy: [], blocks: ['8'] },
      { id: '8', subject: 'Ship it', description: 'private too', status: 'pending', blockedBy: ['7'], blocks: [] },
    ];
    const after = [
      { ...before[0]!, status: 'completed', startedAt: undefined },
      { ...before[1]!, status: 'in_progress', activeForm: 'Shipping it', startedAt: 9_000 },
    ];
    const updateSessionTask = vi.fn(async () => ({ task: after[1]!, tasks: after }));
    const state = new ChatState({ transcript: new TranscriptModel() });
    const pickers = createPickers(
      state,
      {
        client: { sessionTasks: async () => before, updateSessionTask },
        tui, editor: {}, termSettings: null, cwdLabel: '', branchLabel: '', commandDefs: [], lifetime,
      } as never,
      { render: vi.fn(), refreshMeta: async () => {} },
      {} as never,
      { reshowPanel: vi.fn(), reloadKeymap: vi.fn() },
    );

    // A clicked card row hands over a bare task id — there is no list level in between to carry the task.
    pickers.openTaskActions('8');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const plain = (): string => modal!.render(80).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain()).toContain('Task #8');
    expect(plain()).toContain('In progress');

    modal!.handleInput('\x1b[B'); // Back → Pending
    modal!.handleInput('\x1b[B'); // → In progress
    modal!.handleInput('\r');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(updateSessionTask).toHaveBeenCalledWith('8', 'in_progress');

    // The todo plugin does NOT re-emit its card from the HTTP routes, so the picker rebuilds it — through
    // the one shared mapper, which is why the structured fields and the running row's clock survive.
    const card = state.cards.find((c) => c.id === 'todos');
    expect(card?.items).toEqual([
      { text: '#7 Wire the card — filip', status: 'completed', id: '7', label: 'Wire the card', owner: 'filip' },
      { text: '#8 Shipping it', status: 'in_progress', startedAt: 9_000, id: '8', label: 'Shipping it' },
    ]);

    // A row whose task the agent deleted between render and click reports that instead of opening a sheet.
    tui.showOverlay.mockClear();
    pickers.openTaskActions('404');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tui.showOverlay).not.toHaveBeenCalled();
    expect(state.notice).toContain('task #404 no longer exists');
    await lifetime.stop();
  });

  /** The `/sandbox` overlay drives the sandbox plugin's own routes and always takes the SAFE removal path
   *  (no `discard`, no `force`). When the plugin refuses, the reason has to reach the user in words and
   *  the workspace has to stay exactly as it was — a silent "deleted" here would be a lie about a worktree
   *  that still holds the user's work. */
  it('reports a refused workspace removal by its coded reason and removes nothing', async () => {
    initTheme();
    const lifetime = new ChatApplicationLifetime<'metadata'>();
    let modal: { handleInput(data: string): void; render(width: number): string[] } | null = null;
    const tui = {
      terminal: { columns: 120, rows: 40 },
      showOverlay: vi.fn((component: typeof modal) => {
        modal = component;
        return { hide: vi.fn(), setHidden: vi.fn(), isHidden: () => false, focus: vi.fn(), unfocus: vi.fn(), isFocused: () => true };
      }),
      setFocus: vi.fn(), requestRender: vi.fn(),
    };
    const workspace = {
      id: 'ws_1', userId: 1, projectId: 1, label: 'Feature Alpha', path: '/data/ws/feature-alpha',
      branch: 'elowen/u1/feature-alpha', baseRef: 'main', lifecycle: 'active', orphanReason: null,
      accessible: true,
      status: { head: 'abc', branch: 'elowen/u1/feature-alpha', upstream: '', ahead: 0, behind: 0, dirty: 2, untracked: 1, clean: false },
      files: [], uniqueCommits: 0, activeProcesses: 0, bindings: [],
    };
    const sandboxOverview = vi.fn(async () => ({
      projects: [{ id: 1, slug: 'demo', path: '/var/www/demo' }],
      sessions: [],
      workspaces: [workspace],
    }));
    const sandboxRemovalPreview = vi.fn(async () => ({
      workspaceId: 'ws_1', head: 'abc', dirty: 2, untracked: 1, uniqueCommits: 0, activeProcesses: 0,
      files: [], previewHash: 'hash', phrase: 'discard Feature Alpha',
    }));
    const sandboxRemoveWorkspace = vi.fn(async () => {
      throw new SandboxRouteError('workspace_not_clean', 'workspace removal requires a clean tree with no unpushed commits');
    });
    const state = new ChatState({ transcript: new TranscriptModel() });
    const pickers = createPickers(
      state,
      {
        client: { boundSession: 'brain-1', sandboxOverview, sandboxRemovalPreview, sandboxRemoveWorkspace },
        tui, editor: {}, termSettings: null, cwdLabel: '', branchLabel: '', commandDefs: [], lifetime,
      } as never,
      { render: vi.fn(), refreshMeta: async () => {} },
      {} as never,
      { reshowPanel: vi.fn(), reloadKeymap: vi.fn() },
    );
    const plain = (): string => modal!.render(100).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    pickers.openSandboxModal();
    await settle();
    expect(plain()).toContain('Feature Alpha');
    expect(plain()).toContain('elowen/u1/feature-alpha');

    // One step, because the list holds workspaces and the create row only — refreshing and returning are
    // keys now, so nothing sits between the create row and the first real worktree.
    modal!.handleInput('\x1b[B'); // + New workspace → the workspace row
    modal!.handleInput('\r');
    await settle();
    expect(plain()).toContain('Workspace Feature Alpha');

    modal!.handleInput('\x1b[B'); // Back → Use in this conversation
    modal!.handleInput('\x1b[B'); // → Delete
    modal!.handleInput('\r');
    await settle();
    expect(sandboxRemovalPreview).toHaveBeenCalledWith('ws_1');
    expect(plain()).toContain('Delete workspace "Feature Alpha"?');

    modal!.handleInput('\x1b[B'); // Cancel → Delete
    modal!.handleInput('\r');
    await settle();

    expect(sandboxRemoveWorkspace).toHaveBeenCalledWith('ws_1'); // safe path only — no discard, no force
    expect(state.notice).toContain('workspace kept');
    expect(state.notice).toContain('uncommitted changes');
    await lifetime.stop();
  });

  /** Creating a workspace CREATES it, on both surfaces. The CLI used to bind the conversation to the new
   *  worktree whenever one was open while the web drawer did not, so the same button moved the working
   *  directory in one place and not in the other. The switch is now the separate `workspaces/use` step
   *  everywhere, and the create payload is the proof: exactly the project, the name and the base ref.
   *
   *  The web half of this parity is asserted in web/tests/modules/advisor/SandboxModal.test.tsx
   *  ("creates a workspace without binding this conversation"), which pins the identical payload. */
  it('creates a workspace without binding this conversation, matching the web drawer', async () => {
    initTheme();
    const lifetime = new ChatApplicationLifetime<'metadata'>();
    let modal: { handleInput(data: string): void; render(width: number): string[] } | null = null;
    const tui = {
      terminal: { columns: 120, rows: 40 },
      showOverlay: vi.fn((component: typeof modal) => {
        modal = component;
        return { hide: vi.fn(), setHidden: vi.fn(), isHidden: () => false, focus: vi.fn(), unfocus: vi.fn(), isFocused: () => true };
      }),
      setFocus: vi.fn(), requestRender: vi.fn(),
    };
    const sandboxCreateWorkspace = vi.fn(async () => ({
      id: 'ws_9', label: 'Refunds', path: '/data/ws/refunds', branch: 'elowen/u1/refunds', baseRef: 'develop',
    }));
    const state = new ChatState({ transcript: new TranscriptModel() });
    const pickers = createPickers(
      state,
      {
        client: {
          // A conversation IS open — the case in which the CLI used to bind on create.
          boundSession: 'brain-1',
          sandboxOverview: async () => ({
            projects: [{ id: 4, slug: 'demo', path: '/var/www/demo', defaultRef: 'develop' }],
            sessions: [], workspaces: [],
          }),
          sandboxCreateWorkspace,
        },
        tui, editor: {}, termSettings: null, cwdLabel: '', branchLabel: '', commandDefs: [], lifetime,
      } as never,
      { render: vi.fn(), refreshMeta: async () => {} },
      {} as never,
      { reshowPanel: vi.fn(), reloadKeymap: vi.fn() },
    );
    const plain = (): string => modal!.render(100).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    pickers.openSandboxModal();
    await settle();
    // The list says up front that creating does not move the conversation.
    expect(plain()).toContain('this conversation stays where it is');

    modal!.handleInput('\r'); // + New workspace
    await settle();
    modal!.handleInput('\r'); // the only project
    await settle();
    for (const ch of 'Refunds') modal!.handleInput(ch);
    modal!.handleInput('\r');
    await settle();

    // The base ref is offered as the project's OWN default branch, never a guessed one.
    expect(plain()).toContain('develop');
    modal!.handleInput('\r');
    await settle();

    expect(sandboxCreateWorkspace).toHaveBeenCalledTimes(1);
    expect(sandboxCreateWorkspace.mock.calls[0]![0]).toEqual({ projectId: 4, label: 'Refunds', baseRef: 'develop' });
    // …and the confirmation states what did NOT happen, so nobody assumes the conversation moved.
    expect(state.notice).toContain('this conversation still works where it did');
    expect(state.notice).toContain('Use in this conversation');
    await lifetime.stop();
  });

  /** With no authoritative default branch the field stays EMPTY and the ref is asked for. The old
   *  fallback typed `main` into it, which silently branched from a name that need not exist. */
  it('leaves the base ref empty and creates nothing when the project states no default branch', async () => {
    initTheme();
    const lifetime = new ChatApplicationLifetime<'metadata'>();
    let modal: { handleInput(data: string): void; render(width: number): string[] } | null = null;
    const tui = {
      terminal: { columns: 120, rows: 40 },
      showOverlay: vi.fn((component: typeof modal) => {
        modal = component;
        return { hide: vi.fn(), setHidden: vi.fn(), isHidden: () => false, focus: vi.fn(), unfocus: vi.fn(), isFocused: () => true };
      }),
      setFocus: vi.fn(), requestRender: vi.fn(),
    };
    const sandboxCreateWorkspace = vi.fn(async () => ({ id: 'ws_x', label: 'x', path: '/x' }));
    const state = new ChatState({ transcript: new TranscriptModel() });
    const pickers = createPickers(
      state,
      {
        client: {
          boundSession: 'brain-1',
          sandboxOverview: async () => ({
            projects: [{ id: 7, slug: 'bare', path: '/var/www/bare', defaultRef: null }],
            sessions: [], workspaces: [],
          }),
          sandboxCreateWorkspace,
        },
        tui, editor: {}, termSettings: null, cwdLabel: '', branchLabel: '', commandDefs: [], lifetime,
      } as never,
      { render: vi.fn(), refreshMeta: async () => {} },
      {} as never,
      { reshowPanel: vi.fn(), reloadKeymap: vi.fn() },
    );
    const plain = (): string => modal!.render(100).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    pickers.openSandboxModal();
    await settle();
    modal!.handleInput('\r'); // + New workspace
    await settle();
    modal!.handleInput('\r'); // the only project
    await settle();
    for (const ch of 'Spike') modal!.handleInput(ch);
    modal!.handleInput('\r');
    await settle();

    // Empty field, and the title says why it is empty.
    expect(plain()).toContain('(empty)');
    expect(plain()).toContain('states no default branch');

    modal!.handleInput('\r'); // submitting nothing must not invent a ref
    await settle();
    expect(sandboxCreateWorkspace).not.toHaveBeenCalled();
    expect(state.notice).toContain('a base ref is required');
    await lifetime.stop();
  });

  /** "Return to project" is the inverse of a switch and it must undo one WITHOUT destroying anything: the
   *  overlay calls the plugin's release route, which drops the conversation's binding rows only. The
   *  workspace is still listed afterwards, and a refusal — a process is running in it — has to reach the
   *  user in words, because "returned" over a conversation that is still in the worktree is a lie.
   *
   *  The web half of this parity is asserted in web/tests/modules/advisor/SandboxModal.test.tsx
   *  ("returns this conversation to its project directory through the conversation id"), which pins the
   *  identical payload — the conversation id and nothing else. */
  it('returns this conversation to its project directory and reports a refusal, matching the web drawer', async () => {
    initTheme();
    const lifetime = new ChatApplicationLifetime<'metadata'>();
    let modal: { handleInput(data: string): void; render(width: number): string[] } | null = null;
    const tui = {
      terminal: { columns: 120, rows: 40 },
      showOverlay: vi.fn((component: typeof modal) => {
        modal = component;
        return { hide: vi.fn(), setHidden: vi.fn(), isHidden: () => false, focus: vi.fn(), unfocus: vi.fn(), isFocused: () => true };
      }),
      setFocus: vi.fn(), requestRender: vi.fn(),
    };
    const bound = {
      id: 'ws_1', userId: 1, projectId: 1, label: 'Feature Alpha', path: '/data/ws/feature-alpha',
      branch: 'elowen/u1/feature-alpha', baseRef: 'main', lifecycle: 'active', orphanReason: null,
      accessible: true,
      status: { head: 'abc', branch: 'elowen/u1/feature-alpha', upstream: '', ahead: 0, behind: 0, dirty: 0, untracked: 0, clean: true },
      files: [], uniqueCommits: 0, activeProcesses: 0,
      bindings: [{ sessionId: 'brain-1', updatedAt: '2026-09-01' }],
    };
    const sandboxReleaseWorkspaces = vi.fn(async () => ({ released: 1 }));
    const state = new ChatState({ transcript: new TranscriptModel() });
    const pickers = createPickers(
      state,
      {
        client: {
          boundSession: 'brain-1',
          sandboxOverview: async () => ({
            projects: [{ id: 1, slug: 'demo', path: '/var/www/demo', defaultRef: 'main' }],
            sessions: [], workspaces: [bound],
          }),
          sandboxReleaseWorkspaces,
        },
        tui, editor: {}, termSettings: null, cwdLabel: '', branchLabel: '', commandDefs: [], lifetime,
      } as never,
      { render: vi.fn(), refreshMeta: async () => {} },
      {} as never,
      { reshowPanel: vi.fn(), reloadKeymap: vi.fn() },
    );
    const plain = (): string => modal!.render(100).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    pickers.openSandboxModal();
    await settle();
    // Advertised in the footer, not as a row: the list is worktrees, and a command about the list reading
    // like one more worktree to open is exactly the confusion this replaced.
    expect(plain()).toContain('ctrl+p return to project');
    expect(plain()).not.toContain('Return to project');

    modal!.handleInput('\x10'); // ctrl+p
    await settle();

    // The conversation id is the whole payload: no workspace is named, so nothing can be destroyed.
    expect(sandboxReleaseWorkspaces).toHaveBeenCalledTimes(1);
    expect(sandboxReleaseWorkspaces.mock.calls[0]![0]).toBe('brain-1');
    expect(state.notice).toContain('project directory again');
    expect(state.notice).toContain('the workspace is kept');

    // A refusal leaves the conversation where it was and says why, in words rather than as a code.
    sandboxReleaseWorkspaces.mockRejectedValueOnce(
      new SandboxRouteError('workspace_in_use', 'workspace is in use by an active process'),
    );
    modal!.handleInput('\x10'); // ctrl+p again
    await settle();
    expect(state.notice).toContain('still working in the workspace');
    expect(state.notice).toContain('a process is still running in it');
    await lifetime.stop();
  });

  /** Refreshing the list and returning to the project are commands ABOUT the modal, not worktrees to open.
   *  As rows they sat above the real workspaces and read like two more of them. They are keys now, named in
   *  the footer, and the list is nothing but the create row and actual workspaces.
   *
   *  The keys must not cost the modal anything it already had: plain letters still filter, and a ctrl chord
   *  is consumed as a command rather than typed into that filter. */
  it('exposes refresh and return as footer keys, keeps the list to workspaces, and still filters by typing', async () => {
    initTheme();
    const lifetime = new ChatApplicationLifetime<'metadata'>();
    let modal: { handleInput(data: string): void; render(width: number): string[] } | null = null;
    let handle: { hide: ReturnType<typeof vi.fn> } | null = null;
    const tui = {
      terminal: { columns: 120, rows: 40 },
      showOverlay: vi.fn((component: typeof modal) => {
        modal = component;
        handle = { hide: vi.fn(), setHidden: vi.fn(), isHidden: () => false, focus: vi.fn(), unfocus: vi.fn(), isFocused: () => true };
        return handle;
      }),
      setFocus: vi.fn(), requestRender: vi.fn(),
    };
    const workspace = (id: string, label: string) => ({
      id, userId: 1, projectId: 1, label, path: `/data/ws/${id}`,
      branch: `elowen/u1/${id}`, baseRef: 'main', lifecycle: 'active', orphanReason: null, accessible: true,
      status: { head: 'abc', branch: `elowen/u1/${id}`, upstream: '', ahead: 0, behind: 0, dirty: 0, untracked: 0, clean: true },
      // No bindings anywhere: this conversation is NOT working in either worktree.
      files: [], uniqueCommits: 0, activeProcesses: 0, bindings: [],
    });
    const sandboxOverview = vi.fn(async () => ({
      projects: [{ id: 1, slug: 'demo', path: '/var/www/demo', defaultRef: 'main' }],
      sessions: [],
      workspaces: [workspace('ws_1', 'Feature Alpha'), workspace('ws_2', 'Billing')],
    }));
    const sandboxReleaseWorkspaces = vi.fn(async () => ({ released: 1 }));
    const state = new ChatState({ transcript: new TranscriptModel() });
    const pickers = createPickers(
      state,
      {
        client: { boundSession: 'brain-1', sandboxOverview, sandboxReleaseWorkspaces },
        tui, editor: {}, termSettings: null, cwdLabel: '', branchLabel: '', commandDefs: [], lifetime,
      } as never,
      { render: vi.fn(), refreshMeta: async () => {} },
      {} as never,
      { reshowPanel: vi.fn(), reloadKeymap: vi.fn() },
    );
    const plain = (): string => modal!.render(100).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    pickers.openSandboxModal();
    await settle();

    // Neither action is a row any more, and the footer is where both are named.
    expect(plain()).not.toContain('Refresh');
    expect(plain()).not.toContain('Return to project');
    expect(plain()).toContain('ctrl+r refresh');
    expect(plain()).toContain('ctrl+p return to project');
    // What IS listed: the create row and the two worktrees, nothing else.
    expect(plain()).toContain('+ New workspace');
    expect(plain()).toContain('Feature Alpha');
    expect(plain()).toContain('Billing');

    // ctrl+p with nothing bound says so instead of calling a route that could only answer "already there".
    modal!.handleInput('\x10');
    await settle();
    expect(sandboxReleaseWorkspaces).not.toHaveBeenCalled();
    expect(state.notice).toContain('already works in its project directory');

    // ctrl+r re-reads the list exactly once per press.
    expect(sandboxOverview).toHaveBeenCalledTimes(1);
    modal!.handleInput('\x12');
    await settle();
    expect(sandboxOverview).toHaveBeenCalledTimes(2);

    // Neither chord was typed into the filter: both workspaces are still listed after them.
    expect(plain()).toContain('Feature Alpha');
    expect(plain()).toContain('Billing');

    // Plain letters still filter, which is the thing the footer has always promised.
    modal!.handleInput('B');
    expect(plain()).toContain('Billing');
    expect(plain()).not.toContain('Feature Alpha');

    // Esc still closes, and picking is still Enter on a real workspace row.
    modal!.handleInput('\x1b');
    expect(handle!.hide).toHaveBeenCalledTimes(1);
    await lifetime.stop();
  });

  it('does not publish a model response after the chat has stopped', async () => {
    const models = deferred<never[]>();
    const lifetime = new ChatApplicationLifetime<'metadata'>();
    const render = vi.fn();
    const state = new ChatState({ transcript: new TranscriptModel(), notice: 'before-stop' });
    const pickers = createPickers(
      state,
      {
        client: { models: () => models.promise }, tui: {}, editor: {}, termSettings: null,
        cwdLabel: '', branchLabel: '', commandDefs: [], lifetime,
      } as never,
      { render, refreshMeta: async () => {} },
      {} as never,
      { reshowPanel: vi.fn(), reloadKeymap: vi.fn() },
    );

    pickers.openModelPicker();
    lifetime.stop();
    models.resolve([]);
    await Promise.resolve();
    await Promise.resolve();

    expect(state.notice).toBe('before-stop');
    expect(render).not.toHaveBeenCalled();
  });

  it('does not open /stats or publish an abort error after stop', async () => {
    const status = deferred<never>();
    const goal = deferred<never>();
    const lifetime = new ChatApplicationLifetime<'metadata'>();
    const render = vi.fn();
    const tui = { showOverlay: vi.fn(), setFocus: vi.fn() };
    const state = new ChatState({ transcript: new TranscriptModel(), notice: 'stable' });
    const pickers = createPickers(
      state,
      {
        client: {
          status: () => status.promise,
          goal: () => goal.promise,
          usageByModel: async () => [],
          contextBreakdown: async () => null,
        }, tui, editor: {}, termSettings: null,
        cwdLabel: '', branchLabel: '', commandDefs: [], lifetime,
      } as never,
      { render, refreshMeta: async () => {} },
      {} as never,
      { reshowPanel: vi.fn(), reloadKeymap: vi.fn() },
    );

    pickers.openStatsModal();
    lifetime.stop();
    status.reject(new Error('late status abort'));
    goal.resolve(null as never);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(state.notice).toBe('stable');
    expect(tui.showOverlay).not.toHaveBeenCalled();
    expect(tui.setFocus).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
  });
});
