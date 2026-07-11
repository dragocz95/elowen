import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { TUI, ProcessTerminal, Container } from '@earendil-works/pi-tui';
import { initTheme, getMarkdownTheme, getSelectListTheme } from '@earendil-works/pi-coding-agent';
import { color, glyph, isChatThemeName, setChatTheme, setCustomChatTheme } from './theme.js';
import { initKeymap } from './keys.js';
import { loadPrefs } from './prefs.js';
import { loadPromptHistory, PromptStash } from './promptHistory.js';
import { LocalShellBuffer } from './localShell.js';
import { AttachmentChips, QueuedMessages } from './components.js';
import { FileIndex, loadMentionFrecency } from './mentions.js';
import { ChatEditor } from './picker.js';
import { BrainClient } from './brainClient.js';
import { createFlows } from './flows.js';
import { createStreamController } from './streamController.js';
import { createShell } from './shell.js';
import { createPickers } from './pickers.js';
import { wireSubmit } from './commands.js';
import type { ChatRuntime } from './runtime.js';
import { groupToolItems, type ChatView } from '../../brain/transcript.js';
import { TranscriptModel } from '../../brain/transcriptModel.js';
import { commandsFor } from '../../brain/slashCommands.js';
import { createTuiDiagnostics } from './tuiDiagnostics.js';
import { TerminalLifecycle } from './terminalLifecycle.js';
import { SnapshotHydrator, SnapshotTimeoutError } from './snapshotHydrator.js';
import type { BrainEvent } from '../../brain/events.js';
import type { BrainMessageView } from '../../brain/messageView.js';

/** Boot history uses the same bounded hydrator instance as reconnect/compaction/child drill-in. A dead
 * daemon cannot keep first paint pending forever, and a transport that ignores abort is fenced by the
 * lane generation before its late result can escape. */
export async function loadInitialTranscript<E>(
  client: Pick<BrainClient, 'history'>,
  hydrator: SnapshotHydrator<E>,
  lifecycle: AbortSignal,
): Promise<{ history: BrainMessageView[]; notice: string }> {
  let history: BrainMessageView[] = [];
  let notice = '';
  const lane = hydrator.openLane('parent', lifecycle, { onOverflow: () => {} });
  await lane.hydrate(
    (signal) => client.history(undefined, signal),
    {
      commit: (loaded) => { history = loaded; },
      retain: (_replay, error) => {
        notice = color.error(error instanceof SnapshotTimeoutError
          ? 'conversation transcript history timed out'
          : `could not load the conversation transcript: ${error instanceof Error ? error.message : String(error)}`);
      },
    },
  );
  return { history, notice };
}

/** Plain-text rendering of the view — used for the non-TTY fallback and unit tests (no ANSI, so it's
 *  deterministic to assert on). The rich terminal path uses pi-tui components instead. */
export function viewToPlainText(view: ChatView): string[] {
  const lines: string[] = [];
  for (const turn of view.turns) {
    if (turn.role === 'you') {
      lines.push('you');
      lines.push(...turn.text.split('\n').map((l) => `  ${l}`));
    } else if (turn.role === 'divider') {
      lines.push('— context compacted —');
    } else {
      lines.push(`${glyph.whale} elowen`);
      for (const seg of turn.segments) {
        if (seg.kind === 'tools') {
          // Same consecutive-same-tool collapse as the rich renderer, so the plain/test path matches.
          for (const group of groupToolItems(seg.items)) {
            const item = group.item;
            const count = group.count > 1 ? ` ×${group.count}` : '';
            lines.push(`  ${glyph.tool} ${item.name}${item.detail ? ` ${item.detail}` : ''}${count}`);
            if (item.diff) lines.push(...item.diff.replace(/\n+$/, '').split('\n').map((l) => `    ${l}`));
            if (item.output) lines.push(...item.output.text.split('\n').map((l) => `    ${l}`));
          }
        } else if (seg.kind === 'reasoning') {
          lines.push(...seg.text.split('\n').map((l) => `  ${glyph.think} ${l}`));
        } else {
          lines.push(...seg.text.split('\n').map((l) => `  ${l}`));
        }
      }
    }
    lines.push('');
  }
  return lines;
}

function prettyCwd(cwd = process.cwd()): string {
  const home = homedir();
  return cwd.startsWith(`${home}/`) ? `~/${cwd.slice(home.length + 1)}` : cwd;
}

function gitBranch(cwd = process.cwd()): string {
  try {
    const branch = execFileSync('git', ['branch', '--show-current'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (branch) return branch;
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** Install the process-level terminal guards for ONE chat run and return a disposer. On a SIGTERM/SIGHUP
 *  the terminal is restored (`teardown` — raw-mode/alt-screen) and the mouse disabled before exiting;
 *  the `exit` guard only needs the mouse (teardown already ran on the normal path). The disposer detaches
 *  all three so a menu → chat → menu loop never stacks listeners (`MaxListenersExceededWarning`). */
export function installExitGuards(teardown: () => void, disableMouse: () => void): () => void {
  const onSignal = (code: number) => (): void => { teardown(); disableMouse(); process.exit(code); };
  const onSigTerm = onSignal(143);
  const onSigHup = onSignal(129);
  // Monitor runs before Node's default uncaught-exception report. Restore the active alternate screen
  // first, then let Node keep its normal fatal-error semantics and print into the primary buffer.
  const onFatal = (): void => { teardown(); disableMouse(); };
  process.once('exit', disableMouse);
  process.once('SIGTERM', onSigTerm);
  process.once('SIGHUP', onSigHup);
  process.once('uncaughtExceptionMonitor', onFatal);
  return (): void => {
    process.off('exit', disableMouse);
    process.off('SIGTERM', onSigTerm);
    process.off('SIGHUP', onSigHup);
    process.off('uncaughtExceptionMonitor', onFatal);
  };
}

/** Idempotent Ctrl+C / `/quit` coordinator. Terminal cleanup is synchronous (never leave raw mode or the
 *  alternate screen up), while the bound server session gets one best-effort stop before runChat resolves.
 *  The timeout prevents a dead daemon from keeping the CLI process alive after its terminal is restored. */
export function createQuitCoordinator(o: {
  teardown(): void;
  removeExitGuards(): void;
  stopBoundSession(signal: AbortSignal): Promise<void>;
  done(): void;
  timeoutMs?: number;
}): () => void {
  let quitting = false;
  return (): void => {
    if (quitting) return;
    quitting = true;
    o.teardown();
    o.removeExitGuards();
    const stopAc = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        // Abort the losing fetch, not only our wait for it. A fetch whose daemon/socket never settles can
        // otherwise keep Node's event loop alive after `done()` returned control to the menu/process.
        stopAc.abort();
        resolve();
      }, o.timeoutMs ?? 750);
    });
    void Promise.race([
      Promise.resolve().then(() => o.stopBoundSession(stopAc.signal)).catch(() => { /* already idle / daemon gone */ }),
      timeout,
    ]).finally(() => {
      if (timer) clearTimeout(timer);
      o.done();
    });
  };
}

export interface RunChatOpts {
  base: string;
  token: string;
  model?: string;
  /** Open a brand-new conversation instead of resuming the last one. */
  fresh?: boolean;
  /** Resume this stored conversation id. */
  session?: string;
  /** Injected for tests; defaults to a real BrainClient. */
  client?: BrainClient;
}

/** Launch the interactive Elowen chat TUI — an opencode-style layout (user blocks with a teal rail,
 *  markdown replies with a metadata line, a bottom status bar) rendered on pi-tui + pi's markdown theme.
 *  Conversations are server-side: /new opens one, /sessions + /resume switch between them.
 *
 *  This is the entry that owns the shared ChatRuntime and wires the focused modules together:
 *  flows (ask/approval/plan modals), streamController (event stream + sub-agent taps), shell
 *  (layout/render/input), pickers (modal surface) and commands (the submit dispatcher). */
export async function runChat(opts: RunChatOpts): Promise<void> {
  if (!process.stdout.isTTY) {
    process.stderr.write('elowen chat needs an interactive terminal (a TTY).\n');
    return;
  }
  initTheme();
  // Restore the last-used chat theme before any component reads chatTheme() — otherwise every launch
  // silently reverted to the default.
  const prefs0 = loadPrefs();
  if (prefs0.theme && isChatThemeName(prefs0.theme)) setChatTheme(prefs0.theme);
  // Keybinds resolve like the theme: local per-machine prefs over defaults, initialized before the
  // shell reads chord labels for its hint lines. Invalid entries keep their defaults (warned below).
  const keymap = initKeymap(prefs0.keybinds);
  // Thought-row visibility — the per-USER server setting wins (Account → Terminal / `/reasoning show`
  // on any device); the local pref is the offline fallback until termSettings load below.
  let showThoughts = prefs0.showThoughts !== false;
  const mdTheme = getMarkdownTheme();

  const client = opts.client ?? new BrainClient({ base: opts.base, token: opts.token });
  await client.start({ provider: opts.model, session: opts.session, fresh: opts.fresh });
  const hydrator = new SnapshotHydrator<BrainEvent>();
  const bootHydrationAc = new AbortController();
  // Everything after session resolution is independent I/O. Fetch it concurrently so first paint pays
  // one localhost round trip instead of five serial ones; the transcript's own Markdown stays tail-lazy.
  const [boot, bootProcesses, termSettings, initialTranscript, serverCommands] = await Promise.all([
    client.status().catch(() => null),
    // Boot-seed owner-only background processes; live changes ride the `process` stream afterwards.
    client.processes().catch(() => []),
    client.terminalSettings().catch(() => null),
    loadInitialTranscript(client, hydrator, bootHydrationAc.signal),
    client.commands().catch(() => commandsFor('cli', true)),
  ]);
  bootHydrationAc.abort();
  const history0 = initialTranscript.history;
  // Cross-device colors: a CUSTOM web Account → Terminal palette drives the CLI chat theme — but only
  // when THIS machine has no explicit /theme pick saved. A local pick must win, otherwise the web
  // setting silently clobbered it on every launch ("/theme doesn't stick"). Picking "Custom (web)"
  // in /theme stores theme:'custom', which is not a preset name, so the palette applies again here.
  const localPick = !!(prefs0.theme && isChatThemeName(prefs0.theme));
  if (!localPick && termSettings?.theme === 'custom' && termSettings.palette) setCustomChatTheme(termSettings.palette);
  if (typeof termSettings?.showThoughtsCli === 'boolean') showThoughts = termSettings.showThoughtsCli;
  let commandDefs = serverCommands;
  if (commandDefs.length === 0) commandDefs = commandsFor('cli', true);
  // /keybinds is CLI-local (the keymap lives in this terminal's prefs, like /theme's palette), so the
  // TUI surfaces it itself instead of the server's command list.
  if (!commandDefs.some((c) => c.name === 'keybinds')) {
    commandDefs = [...commandDefs, { name: 'keybinds', description: 'List keyboard shortcuts and where to customize them', kind: 'info', surfaces: ['cli'] }];
  }

  const term = new ProcessTerminal();
  const tui = new TUI(term);
  const diagnostics = createTuiDiagnostics(process.env);
  // The shell now keeps a strict row budget, but a forced/modal structural shrink should still clear the
  // dependency renderer's historical working area instead of ever exposing a stale status row.
  tui.setClearOnShrink(true);
  const cwdLabel = prettyCwd();
  const branchLabel = gitBranch();
  const editor = new ChatEditor(tui, { borderColor: color.faint, selectList: getSelectListTheme() }, {});
  // ↑-recall persists per project: seed the editor's history navigation (oldest → newest) from disk;
  // onSubmit appends both in-session and to the file. The walk itself (back/forward, draft restore,
  // edit-exits-recall) is the editor's built-in history mode — recall only triggers on an empty input
  // or at the very start of the draft, so ↑/↓ inside a multiline draft keep moving the cursor.
  for (const entry of loadPromptHistory(process.cwd())) editor.addToHistory(entry);
  const attachmentChips = new AttachmentChips();
  const queuedMessages = new QueuedMessages();
  const editorSlot = new Container();
  editorSlot.addChild(editor);
  const inputStack = new Container();
  // Pending mid-turn queue sits on top of the stack, then pending image chips, then the composer.
  inputStack.addChild(queuedMessages);
  inputStack.addChild(attachmentChips);
  inputStack.addChild(editorSlot);
  let rateLimitRefreshGeneration = 0;
  let metadataRefreshGeneration = 0;
  let asyncStateActive = true;

  /** The shared runtime: all mutable chat state + the render/refreshMeta/quit callbacks, threaded
   *  through every module factory below (see ChatRuntime). */
  const transcript = new TranscriptModel(history0);
  const rt: ChatRuntime = {
    client, tui, term, editor, editorSlot, inputStack, attachmentChips, queuedMessages,
    promptStash: new PromptStash(),
    shellContext: new LocalShellBuffer(),
    mentionIndex: new FileIndex(process.cwd()),
    commandDefs, termSettings, cwdLabel, branchLabel,
    transcript,
    get view() { return transcript.view; },
    childView: null,
    childAc: null,
    streamAc: new AbortController(),
    // Warn ONCE about broken keybind overrides — the binds themselves fell back to their defaults.
    notice: [
      keymap.warnings.length ? color.warning(`keybinds: ${keymap.warnings.join(' · ')} (see /keybinds)`) : '',
      initialTranscript.notice,
    ].filter(Boolean).join(' · '),
    modelName: boot?.model || opts.model || '',
    conversationTitle: boot?.title ?? '',
    lineCfg: boot?.statusline ?? null,
    usage: boot?.usage ?? null,
    thinkingLevel: boot?.thinkingLevel ?? '',
    thinkingLevels: boot?.thinkingLevels ?? [],
    thinkingLevelLabels: boot?.thinkingLevelLabels ?? {},
    fastOn: boot?.fast ?? false,
    fastAvailable: boot?.fastAvailable ?? false,
    lspEnabled: boot?.lspEnabled ?? null,
    yoloOn: boot?.yolo ?? false,
    mcpList: null,
    rateLimits: null,
    workMode: 'build',
    cards: boot?.cards ?? [],
    queued: boot?.queued ?? [],
    processes: bootProcesses,
    listed: [],
    showThoughts,
    pendingImages: [],
    mentionFrecency: loadMentionFrecency(process.cwd()),
    terminalLifecycle: null,
    render: () => { /* wired to the shell below */ },
    renderForced: () => { /* wired to the shell below */ },
    quit: () => { /* wired below, after the shell exists */ },
    refreshRateLimits: async (): Promise<void> => {
      const generation = ++rateLimitRefreshGeneration;
      try {
        const limits = await client.rateLimits();
        // A rapid session/model switch can finish requests out of order. Only the latest refresh may
        // replace the rail, otherwise an old OpenAI session can flash over a newer provider's null state.
        if (asyncStateActive && generation === rateLimitRefreshGeneration) {
          rt.rateLimits = limits;
          rt.render();
        }
      } catch {
        // The API itself marks a cached provider snapshot `stale`; an arbitrary client-side snapshot from
        // the previous session/model is not safe to retain when the current request failed.
        if (asyncStateActive && generation === rateLimitRefreshGeneration) { rt.rateLimits = null; rt.render(); }
      }
    },
    refreshMeta: async (): Promise<void> => {
      const generation = ++metadataRefreshGeneration;
      // Deliberately not awaited: a slow provider usage request must never hold up status, model switches,
      // or the first TUI paint. Its own completion schedules a render when a snapshot is available.
      void rt.refreshRateLimits();
      const [st, mcp] = await Promise.all([
        client.status().catch(() => null),
        client.mcpServers().catch(() => null),
      ]);
      if (!asyncStateActive || generation !== metadataRefreshGeneration) return;
      if (st) { rt.modelName = st.model || rt.modelName; rt.conversationTitle = st.title ?? rt.conversationTitle; rt.lineCfg = st.statusline; rt.usage = st.usage; rt.thinkingLevel = st.thinkingLevel ?? ''; rt.thinkingLevels = st.thinkingLevels ?? []; rt.thinkingLevelLabels = st.thinkingLevelLabels ?? {}; rt.fastOn = st.fast ?? false; rt.fastAvailable = st.fastAvailable ?? false; rt.cards = st.cards ?? []; rt.queued = st.queued ?? []; rt.lspEnabled = st.lspEnabled ?? null; rt.yoloOn = st.yolo ?? rt.yoloOn; }
      rt.mcpList = mcp;
    },
    invalidateAsyncState: (): void => {
      metadataRefreshGeneration += 1;
      rateLimitRefreshGeneration += 1;
    },
  };
  await rt.refreshMeta();

  const flows = createFlows(rt);
  const stream = createStreamController(rt, flows, hydrator);
  const shell = createShell(rt, stream, mdTheme, diagnostics);
  rt.render = shell.render;
  rt.renderForced = shell.renderForced;
  const terminalLifecycle = new TerminalLifecycle({
    term,
    tui,
    scheduler: {
      pause: shell.pauseRendering,
      resume: shell.resumeRendering,
      stop: shell.stopRendering,
    },
    forceRender: shell.renderForced,
    beforeStop: shell.hideOverlays,
  });
  rt.terminalLifecycle = terminalLifecycle;
  const pickers = createPickers(rt, stream, { reshowPanel: shell.reshowPanel, reloadKeymap: shell.reloadKeymap });
  wireSubmit(rt, { stream, pickers });

  let done!: () => void;
  const finished = new Promise<void>((r) => { done = r; });
  // Terminal teardown shared by the normal quit path and the signal handlers, guarded so a SIGTERM
  // that races quit() (or vice-versa) never double-stops the TUI or leaves raw-mode/alt-screen up.
  let tornDown = false;
  const teardown = (): void => {
    if (tornDown) return;
    tornDown = true;
    asyncStateActive = false;
    rt.invalidateAsyncState();
    stream.stop();
    diagnostics.record({ type: 'lifecycle', action: 'stop' });
    terminalLifecycle.stop();
    void diagnostics.close();
  };
  // Mouse-reporting hygiene: quit() disables it on the normal path, but an uncaught throw or a
  // SIGTERM/SIGHUP would otherwise leave the user's shell spewing `[<35;…M` on every mouse move — and
  // strand them on a blank alternate screen. Leave both here so the crash/signal path recovers cleanly.
  const disableMouse = (): void => terminalLifecycle.stop();
  // Registered per-run and detached in quit(): menu.ts relaunches runChat in a loop, so leaving these
  // on `process` would stack listeners (MaxListenersExceededWarning bleeding into the menu, plus each
  // dead handler pinning the previous session's closure) on every chat open/close.
  const removeExitGuards = installExitGuards(teardown, disableMouse);
  rt.quit = createQuitCoordinator({
    teardown,
    removeExitGuards,
    stopBoundSession: (signal) => client.stopSession(signal),
    done,
  });
  shell.attachInput({
    cycleThinkingLevel: pickers.cycleThinkingLevel,
    openHelpModal: pickers.openHelpModal,
    openThemePicker: pickers.openThemePicker,
    openModelPicker: pickers.openModelPicker,
    openSessionsModal: pickers.openSessionsModal,
  });

  // Enter the alternate screen BEFORE the first paint: pi-tui's first render assumes a clean buffer, and
  // `?1049h` gives it exactly that (cleared, cursor home), fully isolated from the shell's scrollback.
  try {
    diagnostics.record({ type: 'lifecycle', action: 'start' });
    terminalLifecycle.start();
    stream.openStream(rt.streamAc);
    // Reconnect restore: if a question was already parked when this client attached (daemon restart, second
    // client), re-render its picker instead of leaving the turn silently hanging until the timeout.
    if (boot?.pendingAsk) flows.launchAsk(boot.pendingAsk.id, boot.pendingAsk.questions, boot.pendingAsk.kind);
    await finished;
  } finally {
    teardown();
    removeExitGuards();
  }
}
