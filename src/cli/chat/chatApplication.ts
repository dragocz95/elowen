import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { Container, ProcessTerminal, TUI } from '@earendil-works/pi-tui';
import type { MarkdownTheme } from '@earendil-works/pi-tui';
import { getMarkdownTheme, getSelectListTheme, initTheme } from '@earendil-works/pi-coding-agent';
import type { BrainEvent } from '../../brain/events.js';
import { commandsFor } from '../../brain/slashCommands.js';
import { TranscriptModel } from '../../brain/transcriptModel.js';
import { AsyncPublicationFence } from './asyncPublicationFence.js';
import { BrainClient } from './brainClient.js';
import type { BrainStatus } from './brainClient.js';
import type { ChatApplicationActions, ChatApplicationResources } from './chatCapabilities.js';
import { ChatState } from './chatState.js';
import { createChatComposition } from './chatComposition.js';
import type { ChatComposition } from './chatComposition.js';
import { AttachmentChips, QueuedMessages } from './components.js';
import { wireSubmit } from './commands.js';
import { createFlows } from './flows.js';
import { HydrationNoticeOwner } from './hydrationNoticeOwner.js';
import { loadInitialTranscript } from './initialTranscriptHydration.js';
import { initKeymap } from './keys.js';
import { LocalShellBuffer } from './localShell.js';
import { FileIndex, loadMentionFrecency } from './mentions.js';
import { ChatEditor } from './picker.js';
import { createPickers } from './pickers.js';
import { loadPrefs } from './prefs.js';
import { loadPromptHistory, PromptStash } from './promptHistory.js';
import { SnapshotHydrator } from './snapshotHydrator.js';
import { StreamCoordinator } from './streamCoordinator.js';
import type { StreamCoordinatorPort } from './streamCoordinator.js';
import { TerminalLifecycle, createQuitCoordinator, installExitGuards } from './terminalLifecycle.js';
import { color, isChatThemeName, setChatTheme, setCustomChatTheme } from './theme.js';
import { createTuiDiagnostics } from './tuiDiagnostics.js';
import type { TuiDiagnostics } from './tuiDiagnostics.js';

export interface ChatLaunchOptions {
  base: string;
  token: string;
  model?: string;
  fresh?: boolean;
  session?: string;
  client?: BrainClient;
}

function prettyCwd(cwd = process.cwd()): string {
  const home = homedir();
  return cwd.startsWith(`${home}/`) ? `~/${cwd.slice(home.length + 1)}` : cwd;
}

function gitBranch(cwd = process.cwd()): string {
  try {
    const branch = execFileSync('git', ['branch', '--show-current'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (branch) return branch;
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
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
  private publicationFence = new AsyncPublicationFence<'metadata' | 'rate-limits'>();
  private removeExitGuards: (() => void) | null = null;
  private quitImpl: () => void = () => { this.stop(); };
  private launchPendingAsk: (() => void) | null = null;
  private stopped = false;

  constructor(options: ChatLaunchOptions) {
    this.launch = options;
    this.actions = {
      render: (reason) => this.composition?.render(reason),
      renderForced: (reason) => this.composition?.renderForced(reason),
      refreshRateLimits: () => this.refreshRateLimits(),
      refreshMeta: () => this.refreshMeta(),
      invalidateAsyncState: () => this.publicationFence.invalidate(),
      quit: () => this.quitImpl(),
      suspendTerminal: () => this.suspend(),
      resumeTerminal: () => this.resume(),
    };
  }

  /** Boot, start the terminal/stream and resolve only after the user quits. */
  async run(): Promise<void> {
    if (this.stopped) throw new Error('stopped ChatApplication cannot be restarted');
    try {
      await this.bootstrap(this.launch);
      const client = this.resources.client;
      let done!: () => void;
      const finished = new Promise<void>((resolve) => { done = resolve; });
      const teardown = (): void => this.stop();
      this.removeExitGuards = installExitGuards(teardown, teardown);
      this.quitImpl = createQuitCoordinator({
        teardown,
        removeExitGuards: () => this.detachExitGuards(),
        stopBoundSession: (signal) => client.stopSession(signal),
        done,
      });
      this.start();
      this.coordinator!.openStream(this.state.streamAc);
      this.launchPendingAsk?.();
      this.launchPendingAsk = null;
      await finished;
    } finally {
      this.stop();
      this.detachExitGuards();
    }
  }

  private start(): void {
    if (this.stopped || this.lifecycle?.state !== 'new') return;
    this.diagnostics?.record({ type: 'lifecycle', action: 'start' });
    this.lifecycle?.start();
  }

  private suspend(): void { this.lifecycle?.suspend(); }
  private resume(): void { this.lifecycle?.resume(); }

  /** Idempotently stop every child owner before restoring the primary terminal buffer. */
  private stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.publicationFence.stop();
    this.coordinator?.stop();
    this.hydrator?.stop();
    this.diagnostics?.record({ type: 'lifecycle', action: 'stop' });
    this.lifecycle?.stop();
    this.detachExitGuards();
    void this.diagnostics?.close();
  }

  private async bootstrap(options: ChatLaunchOptions): Promise<void> {
    const hydrator = new SnapshotHydrator<BrainEvent>();
    this.hydrator = hydrator;
    initTheme();
    const prefs = loadPrefs();
    if (prefs.theme && isChatThemeName(prefs.theme)) setChatTheme(prefs.theme);
    const keymap = initKeymap(prefs.keybinds);
    let showThoughts = prefs.showThoughts !== false;
    const client = options.client ?? new BrainClient({ base: options.base, token: options.token });
    await client.start({ provider: options.model, session: options.session, fresh: options.fresh });
    const bootHydration = new AbortController();
    const [boot, processes, termSettings, initialTranscript, serverCommands] = await Promise.all([
      client.status().catch(() => null),
      client.processes().catch(() => []),
      client.terminalSettings().catch(() => null),
      loadInitialTranscript(client, hydrator, bootHydration.signal),
      client.commands().catch(() => commandsFor('cli', true)),
    ]);
    bootHydration.abort();
    const localPick = !!(prefs.theme && isChatThemeName(prefs.theme));
    if (!localPick && termSettings?.theme === 'custom' && termSettings.palette) setCustomChatTheme(termSettings.palette);
    if (typeof termSettings?.showThoughtsCli === 'boolean') showThoughts = termSettings.showThoughtsCli;
    let commandDefs = serverCommands.length ? serverCommands : commandsFor('cli', true);
    if (!commandDefs.some((command) => command.name === 'keybinds')) {
      commandDefs = [...commandDefs, {
        name: 'keybinds', description: 'List keyboard shortcuts and where to customize them',
        kind: 'info', surfaces: ['cli'],
      }];
    }

    const term = new ProcessTerminal();
    const tui = new TUI(term);
    tui.setClearOnShrink(true);
    const editor = new ChatEditor(tui, { borderColor: color.faint, selectList: getSelectListTheme() }, {});
    for (const entry of loadPromptHistory(process.cwd())) editor.addToHistory(entry);
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
      mentionFrecency: loadMentionFrecency(process.cwd()),
    });
    const resources: ChatApplicationResources = {
      client, tui, term, editor, editorSlot, inputStack, attachmentChips, queuedMessages,
      promptStash: new PromptStash(),
      shellContext: new LocalShellBuffer(),
      mentionIndex: new FileIndex(process.cwd()),
      commandDefs, termSettings,
      cwdLabel: prettyCwd(),
      branchLabel: gitBranch(),
    };
    this.state = state;
    this.resources = resources;
    // Complete all awaited boot I/O before mounting the render graph. Mounting opens the managed telemetry
    // overlay and schedules a zero-delay frame; with no await after that point, run() enters the alternate
    // screen synchronously before the scheduler can flush into the user's primary buffer.
    await this.refreshMeta();
    const flows = createFlows(state, resources, this.actions);
    const pendingAsk = boot?.pendingAsk;
    if (pendingAsk) {
      this.launchPendingAsk = () => flows.launchAsk(pendingAsk.id, pendingAsk.questions, pendingAsk.kind);
    }
    const coordinator = new StreamCoordinator(state, resources, this.actions, flows, hydrator, notices);
    this.coordinator = coordinator;
    this.mountComposition(getMarkdownTheme(), createTuiDiagnostics(process.env));
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

  private async refreshRateLimits(): Promise<void> {
    if (!this.resources) return;
    const publication = this.publicationFence.begin('rate-limits');
    try {
      const limits = await this.resources.client.rateLimits();
      this.publicationFence.commit(publication, () => {
        this.state.rateLimits = limits;
        this.actions.render('metadata:rate-limits');
      });
    } catch {
      this.publicationFence.commit(publication, () => {
        this.state.rateLimits = null;
        this.actions.render('metadata:rate-limits-error');
      });
    }
  }

  private async refreshMeta(): Promise<void> {
    if (!this.resources) return;
    const publication = this.publicationFence.begin('metadata');
    void this.refreshRateLimits();
    const [status, mcp] = await Promise.all([
      this.resources.client.status().catch(() => null),
      this.resources.client.mcpServers().catch(() => null),
    ]);
    this.publicationFence.commit(publication, () => {
      if (status) this.applyStatus(status);
      this.state.mcpList = mcp;
    });
  }

  private applyStatus(status: BrainStatus): void {
    const state = this.state;
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
  }

  private pauseRendering(): void {
    this.composition?.pause();
  }

  private resumeRendering(): void { this.composition?.resume(); }

  private stopRendering(): void { this.composition?.stop(); }

  private detachExitGuards(): void {
    this.removeExitGuards?.();
    this.removeExitGuards = null;
  }
}
