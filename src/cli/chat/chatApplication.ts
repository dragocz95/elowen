// `TUI` is an interface since pi-tui 0.84: the concrete renderers are TuiMainScreen (regular terminal
// scrollback) and TuiAltScreen (fullscreen). The chat owns the terminal's scrollback, so it is the former.
import { Container, ProcessTerminal, TuiMainScreen } from '@earendil-works/pi-tui';
import type { MarkdownTheme } from '@earendil-works/pi-tui';
import { getMarkdownTheme, getSelectListTheme, initTheme } from '@earendil-works/pi-coding-agent';
import type { BrainEvent } from '../../brain/events.js';
import { commandsFor } from '../../brain/slashCommands.js';
import type { SlashCommandDef } from '../../shared/wireContract.js';
import { TranscriptModel } from '../../brain/transcriptModel.js';
import { ChatApplicationLifetime } from './applicationLifetime.js';
import { BrainClient } from './brainClient.js';
import { MASCOT_ART } from './mascot.js';
import type { BrainStatus } from './brainClient.js';
import type { ChatApplicationActions, ChatApplicationResources } from './chatCapabilities.js';
import { ChatState } from './chatState.js';
import { createChatComposition } from './chatComposition.js';
import type { ChatComposition } from './chatComposition.js';
import { AttachmentChips, QueuedMessages } from './components.js';
import { highlightBlock, langForFence } from './codeHighlight.js';
import { wireSubmit } from './commands.js';
import { createFlows } from './flows.js';
import { HydrationNoticeOwner } from './hydrationNoticeOwner.js';
import { loadInitialTranscript } from './initialTranscriptHydration.js';
import { gitBranch, prettyCwd } from './projectDir.js';
import { initKeymap } from './keys.js';
import { LocalShellBuffer, LOCAL_SHELL_TIMEOUT_MS } from './localShell.js';
import { FileIndex, loadMentionFrecency } from './mentions.js';
import { ChatEditor } from './picker.js';
import { createPickers } from './pickers.js';
import { loadPrefs, resolveLocale } from './prefs.js';
import { loadPromptHistory, PromptStash, resolvePromptHistoryDepth } from './promptHistory.js';
import { SnapshotHydrator } from './snapshotHydrator.js';
import { StreamCoordinator } from './streamCoordinator.js';
import type { StreamCoordinatorPort } from './streamCoordinator.js';
import { RATE_LIMIT_RUNNING_INTERVAL_MS, shouldRefreshRateLimits } from './rateLimitRefresh.js';
import { TerminalLifecycle, createShutdownCoordinator, installExitGuards } from './terminalLifecycle.js';
import { color, isChatThemeName, setChatTheme, setCustomChatTheme } from './theme.js';
import { createTuiDiagnostics } from './tuiDiagnostics.js';
import type { TuiDiagnostics } from './tuiDiagnostics.js';

/** The menu to fall back on when the daemon cannot be asked for it. Plugin-gated built-ins are dropped:
 *  the daemon is the only thing that knows which plugins are running, so offering `/skills` or `/mcp` on
 *  a guess would show a picker that can only fail. Everything else works without the server's blessing. */
function offlineCommands(): SlashCommandDef[] {
  return commandsFor('cli', true).filter((c) => !c.requiresPlugin);
}

export interface ChatLaunchOptions {
  base: string;
  token: string;
  model?: string;
  fresh?: boolean;
  session?: string;
  client?: BrainClient;
}

/** One chat process graph. The application owns bootstrap, one state/model, one hydrator/coordinator,
 * one render composition/scheduler and one terminal lifecycle from construction through teardown. */
export class ChatApplication {
  private hydrator?: SnapshotHydrator<BrainEvent>;
  private readonly actions: ChatApplicationActions;

  private state!: ChatState;
  private resources!: ChatApplicationResources;
  private readonly launch: ChatLaunchOptions;
  private coordinator: StreamCoordinatorPort | null = null;
  private composition: ChatComposition | null = null;
  private lifecycle: TerminalLifecycle | null = null;
  private diagnostics: TuiDiagnostics | null = null;
  private readonly lifetime = new ChatApplicationLifetime<'metadata' | 'rate-limits'>();
  private readonly client: BrainClient;
  private removeExitGuards: (() => void) | null = null;
  /** When the last rate-limit fetch went out (epoch ms), for the turn-settle throttle + running poll. */
  private rateLimitsFetchedAt = 0;
  /** The 5-minute "turn still running" poll. Armed when a turn starts, cancelled on settle/pause/dispose. */
  private rateLimitsPoll: ReturnType<typeof setInterval> | null = null;
  private quitImpl: () => void = () => {};
  private launchPendingAsk: (() => void) | null = null;
  private stopped = false;
  private localStop: Promise<void> | null = null;
  /** Last title pushed to the terminal window/tab via OSC, so an unchanged status refresh is a no-op. */
  private lastTerminalTitle: string | null = null;

  constructor(options: ChatLaunchOptions) {
    this.launch = options;
    this.client = options.client ?? new BrainClient({ base: options.base, token: options.token });
    this.client.bindLifetime(this.lifetime.signal);
    this.actions = {
      render: (reason) => this.composition?.render(reason),
      renderForced: (reason) => this.composition?.renderForced(reason),
      refreshRateLimits: () => this.refreshRateLimits(),
      onTurnSettled: () => this.onTurnSettled(),
      onTurnActive: () => this.startRateLimitsPoll(),
      refreshMeta: () => this.refreshMeta(),
      invalidateAsyncState: () => this.lifetime.invalidate(),
      quit: () => this.quitImpl(),
      suspendTerminal: () => this.suspend(),
      resumeTerminal: () => this.resume(),
    };
  }

  /** Boot, start the terminal/stream and resolve only after the user quits. */
  async run(): Promise<void> {
    if (this.stopped) throw new Error('stopped ChatApplication cannot be restarted');
    let done!: () => void;
    const finished = new Promise<void>((resolve) => { done = resolve; });
    // A repeat ctrl+c while the stop is in flight: the graceful stop is being waited out by a long
    // foreground command (PI only re-checks its abort signal between tool calls) — hard-kill it so the
    // wedged turn can unwind. `afterStop` skips the client-generation fence (stopSession has already
    // tombstoned this client's binding), and the own bounded signal bypasses the aborted app lifetime.
    const escalate = (): void => {
      void this.client.killCommands({ afterStop: true, signal: AbortSignal.timeout(2_000) }).catch(() => {});
    };
    const shutdown = createShutdownCoordinator({
      teardown: () => this.stopLocal(),
      stopBoundSession: (signal) => this.client.stopSession(signal),
      escalate,
    });
    this.quitImpl = () => { void shutdown().then(done); };
    this.removeExitGuards = installExitGuards({ shutdown, teardownNow: shutdown.teardownNow, escalate });
    try {
      await this.bootstrap(this.launch);
      if (this.stopped) return;
      this.start();
      this.syncTerminalTitle(this.state.conversationTitle);
      this.coordinator!.openStream(this.state.streamAc);
      this.launchPendingAsk?.();
      this.launchPendingAsk = null;
      await finished;
    } finally {
      await shutdown();
      this.detachExitGuards();
    }
  }

  private start(): void {
    if (this.stopped || this.lifecycle?.state !== 'new') return;
    this.diagnostics?.record({ type: 'lifecycle', action: 'start' });
    this.lifecycle?.start();
  }

  private suspend(): void { this.lifecycle?.suspend(); }
  private resume(): void {
    try {
      this.lifecycle?.resume();
    } catch (error) {
      // TerminalLifecycle has already restored/stopped its partial screen ownership. The application
      // still owns streams, timers and the `run()` completion promise, so an unrecoverable resume must
      // enter the same bounded shutdown transaction as an explicit quit before surfacing the error.
      this.quitImpl();
      throw error;
    }
  }

  /** Idempotently stop every child owner before restoring the primary terminal buffer. */
  private stopLocal(): Promise<void> {
    if (this.localStop) return this.localStop;
    this.stopped = true;
    if (this.lastTerminalTitle) this.syncTerminalTitle('');
    this.localStop = this.lifetime.stop();
    this.stopRateLimitsPoll();
    this.coordinator?.stop();
    this.hydrator?.stop();
    this.diagnostics?.record({ type: 'lifecycle', action: 'stop' });
    this.lifecycle?.stop();
    // Deliberately NOT detaching the exit guards here. stopLocal() is the synchronous first half of the
    // shutdown transaction and runs while the daemon stop is still in flight — dropping the signal
    // handlers now hands the next ctrl+c straight to Node's default, killing the process mid-release,
    // which is the exact wedge this path exists to prevent. `run()`'s finally detaches once shutdown has
    // settled, which is also what keeps listeners from stacking across a menu relaunch.
    void this.diagnostics?.close();
    return this.localStop;
  }

  private async bootstrap(options: ChatLaunchOptions): Promise<void> {
    const hydrator = new SnapshotHydrator<BrainEvent>();
    this.hydrator = hydrator;
    initTheme();
    const prefs = loadPrefs();
    if (prefs.theme && isChatThemeName(prefs.theme)) setChatTheme(prefs.theme);
    const keymap = initKeymap(prefs.keybinds);
    const locale = resolveLocale(prefs);
    let showThoughts = prefs.showThoughts !== false;
    // Local-only chrome: default shown, no server mirror (unlike showThoughts, which terminalSettings
    // can override below). Nobody's view changes until they run /maskot to hide it. The final value is
    // resolved after the boot fetch: a white-labeled daemon drops the built-in Elowen flame art
    // entirely — showing another product's mascot would defeat the rebrand.
    const mascotPref = prefs.showMascot !== false;
    const client = this.client;
    await client.start({ provider: options.model, session: options.session, fresh: options.fresh });
    if (this.stopped) return;
    const bootHydration = new AbortController();
    const [boot, processes, termSettings, initialTranscript, serverCommands, shellTimeoutMs, brand] = await Promise.all([
      client.status().catch(() => null),
      client.processes().catch(() => []),
      client.terminalSettings().catch(() => null),
      loadInitialTranscript(client, hydrator, bootHydration.signal),
      client.commands().catch(() => offlineCommands()),
      // The operator's `!` timeout. A failed/absent value keeps the built-in default — the local shell must
      // stay usable against an older daemon, and offline is not a reason to refuse to run a command.
      client.localShellTimeoutMs().catch(() => null),
      // White-label: the instance brand for the chat chrome (already default-safe on any failure).
      client.publicBrand(),
    ]);
    bootHydration.abort();
    if (this.stopped) return;
    const localPick = !!(prefs.theme && isChatThemeName(prefs.theme));
    if (!localPick && termSettings?.theme === 'custom' && termSettings.palette) setCustomChatTheme(termSettings.palette);
    if (typeof termSettings?.showThoughtsCli === 'boolean') showThoughts = termSettings.showThoughtsCli;
    const commandDefs = serverCommands.length ? serverCommands : offlineCommands();

    const term = new ProcessTerminal();
    const tui = new TuiMainScreen(term);
    tui.setClearOnShrink(true);
    const editor = new ChatEditor(tui, { borderColor: color.faint, selectList: getSelectListTheme() }, {});
    // The ↑-recall depth is the user's own (Account → Terminal) and travels with the account, while the
    // history file it caps is per-machine; an offline boot leaves the built-in default in force.
    const promptHistoryDepth = resolvePromptHistoryDepth(termSettings?.promptHistoryDepth);
    for (const entry of loadPromptHistory(process.cwd(), process.env, promptHistoryDepth)) editor.addToHistory(entry);
    const attachmentChips = new AttachmentChips();
    const queuedMessages = new QueuedMessages();
    const editorSlot = new Container();
    editorSlot.addChild(editor);
    const inputStack = new Container();
    inputStack.addChild(queuedMessages);
    inputStack.addChild(attachmentChips);
    inputStack.addChild(editorSlot);
    const notices = new HydrationNoticeOwner({
      base: keymap.warnings.length ? color.warning(`keybinds: ${keymap.warnings.join(' · ')} (see /keybinds)`) : '',
      parent: initialTranscript.notice,
    });
    const state = new ChatState({
      transcript: new TranscriptModel(initialTranscript.history),
      notice: notices.render(),
      modelName: boot?.model || options.model || '',
      provider: boot?.provider ?? '',
      providerLabel: boot?.providerLabel ?? '',
      usageProvider: boot?.usageProvider ?? '',
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
      workMode: 'build',
      cards: boot?.cards ?? [],
      queued: boot?.queued ?? [],
      processes,
      showThoughts,
      // A white-labeled instance shows ITS mascot when its theme ships one (mascot.ans) and nothing at
      // all when it does not — painting the Elowen flame over someone else's rebrand is the one outcome
      // that is always wrong. The stock brand keeps the built-in art.
      mascotArt: brand.themed ? brand.mascotArt : MASCOT_ART,
      showMascot: mascotPref && (brand.themed ? brand.mascotArt !== null : true),
      brand,
      locale,
      mentionFrecency: loadMentionFrecency(process.cwd()),
    });
    const resources: ChatApplicationResources = {
      client, tui, term, editor, editorSlot, inputStack, attachmentChips, queuedMessages,
      promptStash: new PromptStash(),
      shellContext: new LocalShellBuffer(),
      mentionIndex: new FileIndex(process.cwd()),
      commandDefs, termSettings, promptHistoryDepth,
      localShellTimeoutMs: shellTimeoutMs ?? LOCAL_SHELL_TIMEOUT_MS,
      cwdLabel: prettyCwd(),
      branchLabel: gitBranch(),
      lifetime: this.lifetime,
    };
    this.state = state;
    this.resources = resources;
    // Complete all awaited boot I/O before mounting the render graph. Mounting opens the managed telemetry
    // overlay and schedules a zero-delay frame; with no await after that point, run() enters the alternate
    // screen synchronously before the scheduler can flush into the user's primary buffer.
    await this.refreshMeta();
    if (this.stopped) return;
    const flows = createFlows(state, resources, this.actions);
    const pendingAsk = boot?.pendingAsk;
    if (pendingAsk) {
      this.launchPendingAsk = () => flows.launchAsk(pendingAsk.id, pendingAsk.questions, pendingAsk.kind);
    }
    const coordinator = new StreamCoordinator(state, resources, this.actions, flows, hydrator, notices);
    this.coordinator = coordinator;
    // shiki powers code fences with the same Monokai palette the diff renderer uses; a fence whose
    // grammar has not loaded yet keeps the stock codeBlock styling until the ready-invalidate lands.
    const baseMdTheme = getMarkdownTheme();
    const mdTheme: MarkdownTheme = {
      ...baseMdTheme,
      highlightCode: (code: string, lang?: string): string[] => {
        const fence = langForFence(lang);
        if (fence) {
          const highlighted = highlightBlock(code, fence);
          if (highlighted) return highlighted;
        }
        return code.split('\n').map((line) => baseMdTheme.codeBlock(line));
      },
    };
    this.mountComposition(mdTheme, createTuiDiagnostics(process.env));
    const pickers = createPickers(state, resources, this.actions, coordinator, {
      reshowPanel: () => this.composition?.reshowPanel(),
      reloadKeymap: () => this.composition?.reloadKeymap(),
    });
    wireSubmit(state, resources, this.actions, { stream: coordinator, pickers });
    this.composition!.attachInput({
      cycleThinkingLevel: pickers.cycleThinkingLevel,
      openHelpModal: pickers.openHelpModal,
      openThemePicker: pickers.openThemePicker,
      openModelPicker: pickers.openModelPicker,
      openSessionsModal: pickers.openSessionsModal,
    });
  }

  private mountComposition(mdTheme: MarkdownTheme, diagnostics: TuiDiagnostics): void {
    this.diagnostics = diagnostics;
    this.composition = createChatComposition(
      this.state, this.resources, this.actions, this.coordinator!, mdTheme, diagnostics,
    );
    this.lifecycle = new TerminalLifecycle({
      term: this.resources.term,
      tui: this.resources.tui,
      scheduler: {
        pause: () => this.pauseRendering(),
        resume: () => this.resumeRendering(),
        stop: () => this.stopRendering(),
      },
      forceRender: (reason) => this.actions.renderForced(reason),
      beforeStop: () => this.composition?.dispose(),
    });
  }

  /** A turn settled (parent lane idle). Refresh the rail's limits — throttled to the usage-cache TTL so
   *  a burst of short turns fetches once — and stop the long-turn poll now that the turn is over. */
  private onTurnSettled(): void {
    this.stopRateLimitsPoll();
    if (shouldRefreshRateLimits(this.rateLimitsFetchedAt, Date.now(), 'idle')) void this.refreshRateLimits();
  }

  /** Arm the 5-minute poll that keeps the rail fresh through a very long single turn. Idempotent; a
   *  tick fetches only when the interval has genuinely elapsed since the last fetch, so it never
   *  double-fetches on top of a turn-settle refresh. */
  private startRateLimitsPoll(): void {
    if (this.rateLimitsPoll || this.stopped) return;
    this.rateLimitsPoll = setInterval(() => {
      if (shouldRefreshRateLimits(this.rateLimitsFetchedAt, Date.now(), 'interval')) void this.refreshRateLimits();
    }, RATE_LIMIT_RUNNING_INTERVAL_MS);
    // A bare interval must not keep the event loop alive past shutdown.
    this.rateLimitsPoll.unref?.();
  }

  private stopRateLimitsPoll(): void {
    if (!this.rateLimitsPoll) return;
    clearInterval(this.rateLimitsPoll);
    this.rateLimitsPoll = null;
  }

  private async refreshRateLimits(): Promise<void> {
    if (!this.resources) return;
    this.rateLimitsFetchedAt = Date.now();
    const publication = this.lifetime.begin('rate-limits');
    try {
      const limits = await this.resources.client.rateLimitsAll();
      this.lifetime.commit(publication, () => {
        this.state.rateLimitsByProvider = limits;
        this.actions.render('metadata:rate-limits');
      });
    } catch {
      this.lifetime.commit(publication, () => {
        this.state.rateLimitsByProvider = {};
        this.actions.render('metadata:rate-limits-error');
      });
    }
  }

  private async refreshMeta(): Promise<void> {
    if (!this.resources) return;
    const publication = this.lifetime.begin('metadata');
    const goalRevisionAtRequest = this.state.goalRevision;
    const [status, mcp, goal] = await Promise.all([
      this.resources.client.status().catch(() => null),
      this.resources.client.mcpServers().catch(() => null),
      this.resources.client.goal().catch(() => undefined),
    ]);
    this.lifetime.commit(publication, () => {
      if (status) this.applyStatus(status);
      this.state.mcpList = mcp;
      // Goal lifecycle events are newer than a GET that was already in flight. A monotonic revision is
      // required here: reference/value comparison cannot detect a null → active → null ABA transition.
      if (goal !== undefined && this.state.goalRevision === goalRevisionAtRequest) this.state.setGoal(goal);
      // Fetch only after status commits so a provider switch cannot race a request keyed to stale UI state.
      void this.refreshRateLimits();
    });
  }

  private applyStatus(status: BrainStatus): void {
    const state = this.state;
    // The provider id and its label move TOGETHER — carrying a label over from a previous provider would
    // put the wrong name on the model line. An empty poll (no live session yet) keeps the last known pair
    // rather than blanking the line mid-conversation.
    if (status.provider) {
      state.provider = status.provider;
      state.providerLabel = status.providerLabel ?? '';
    }
    state.usageProvider = status.usageProvider ?? '';
    state.modelName = status.model || state.modelName;
    state.conversationTitle = status.title ?? state.conversationTitle;
    state.lineCfg = status.statusline;
    state.usage = status.usage;
    state.thinkingLevel = status.thinkingLevel ?? '';
    state.thinkingLevels = status.thinkingLevels ?? [];
    state.thinkingLevelLabels = status.thinkingLevelLabels ?? {};
    state.fastOn = status.fast ?? false;
    state.fastAvailable = status.fastAvailable ?? false;
    state.cards = status.cards ?? [];
    state.queued = status.queued ?? [];
    state.lspEnabled = status.lspEnabled ?? null;
    state.yoloOn = status.yolo ?? state.yoloOn;
    this.syncTerminalTitle(state.conversationTitle);
  }

  /** Mirror the conversation title into the terminal window/tab title via OSC 0 — what claude-code does in
   *  VSCode and terminal emulators, so a rename by the agent renames the tab too. Deduped so a status
   *  refresh with an unchanged title is a no-op; control chars are replaced so a crafted title cannot
   *  inject further escape sequences, and the length is capped. OSC 0 sets terminal state, not the screen,
   *  so writing it around the pi-tui frame is safe; an empty title clears it (used on shutdown). */
  private syncTerminalTitle(title: string): void {
    if (!process.stdout.isTTY) return;
    const clean = title.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 256);
    if (clean === this.lastTerminalTitle) return;
    this.lastTerminalTitle = clean;
    process.stdout.write(`\x1b]0;${clean}\x07`);
  }

  private pauseRendering(): void {
    // A paused terminal shows nothing and takes no turns — drop the long-turn poll until resume.
    this.stopRateLimitsPoll();
    this.composition?.pause();
  }

  private resumeRendering(): void { this.composition?.resume(); }

  private stopRendering(): void { this.composition?.stop(); }

  private detachExitGuards(): void {
    this.removeExitGuards?.();
    this.removeExitGuards = null;
  }
}
