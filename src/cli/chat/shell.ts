import { Container, visibleWidth } from '@earendil-works/pi-tui';
import type { Component, MarkdownTheme, TUI } from '@earendil-works/pi-tui';
import { color } from './theme.js';
import { StatusBar, CardPanel, SubagentPanel, spinnerFrame } from './components.js';
import { activeMention, CLIPBOARD_MENTION, imageMimeFor, rankMentionFiles, bumpMentionFrecency, mentionInsertText } from './mentions.js';
import { isSlashCommandDraft } from './commands.js';
import { activeKeymap, createLeaderState } from './keys.js';
import type { Keymap, KeybindAction } from './keys.js';
import { formatDuration, formatK, padAnsi, terminalSafeAnsi } from '../ui/text.js';
import { ELOWEN_CLI_VERSION } from '../version.js';
import type { LayoutBudget } from './layoutBudget.js';
import type { TuiDiagnostics } from './tuiDiagnostics.js';
import {
  ChatViewport,
} from './chatViewport.js';
import {
  MainColumn, PANEL_GUTTER_COLUMNS, StartScreen,
  TOP_RULE_ROWS, TopRule,
} from './startScreen.js';
import { TelemetryPanel } from './telemetryPanel.js';
import { MentionOverlay, SlashOverlay } from './suggestionOverlay.js';
import type { BrainWorkMode } from './brainClient.js';
import type { ChatRuntime } from './runtime.js';
import type { StreamController } from './streamController.js';
import { AnimationController } from './animationController.js';
import { InputRouter } from './inputRouter.js';
import { OverlayController } from './overlayController.js';
import { RenderShell } from './renderShell.js';
import { ChatApplication } from './chatApplication.js';
import type { ShellInputDeps } from './chatApplication.js';

/** Render the bottom statusline from the plugin's display toggles + live usage. Empty string when the
 *  statusline plugin is disabled or nothing is toggled on. Pure — unit-testable without a TTY. */
export function statusline(
  cfg: { showModel?: boolean; showContext?: boolean; showTokens?: boolean; showCost?: boolean } | null,
  usage: { tokens: number | null; contextWindow: number; percent: number | null; totalTokens: number; cost: number } | null,
  model: string,
): string {
  if (!cfg) return '';
  const parts: string[] = [];
  if (cfg.showModel && model) parts.push(model);
  if (cfg.showContext && usage && usage.percent != null) {
    parts.push(`context ${Math.round(usage.percent)}% (${formatK(usage.tokens ?? 0)}/${formatK(usage.contextWindow)})`);
  }
  if (cfg.showTokens && usage) parts.push(`Σ ${formatK(usage.totalTokens)} tok`);
  if (cfg.showCost && usage) parts.push(`$${usage.cost.toFixed(2)}`);
  return parts.join('  ·  ');
}

/** The animated "model is generating" chip for the prompt meta line — a subtle spinner + elapsed
 *  seconds next to the reasoning level, replacing the old `thinking… Ns` transcript line (which kept
 *  pushing the conversation around). Time-based frame so every render advances it. */
function generatingChip(seconds: number): string {
  return `${color.accent(spinnerFrame())} ${color.faint(formatDuration(seconds))}`;
}

/** The bottom-bar hint line for the given chat state, rendered from the ACTIVE keymap — hints must
 *  stay truthful when the user rebinds a shortcut. Unbound actions drop their segment. Pure. */
export function bottomHints(
  keymap: Keymap,
  state: 'child' | 'thinking' | 'idle',
  hasSubagents = false,
  interruptArmed = false,
): string {
  const k = (action: KeybindAction, label: string): string => {
    const chord = keymap.chordLabel(action);
    return chord ? `${chord} ${label}` : '';
  };
  const parts = state === 'child'
    ? ['⏎ message the sub-agent', 'esc back', k('subagent_cycle', 'next session')]
    : state === 'thinking'
      ? [interruptArmed ? 'esc again to interrupt' : 'esc interrupt', '/help commands', k('reasoning_cycle', 'reasoning'), hasSubagents ? k('subagent_cycle', 'subagents') : '']
      : ['⏎ send', '/ slash', '@ files', '! shell', k('stash', 'stash'), k('mode_toggle', 'mode'), k('reasoning_cycle', 'reasoning'), k('telemetry_toggle', 'telemetry')];
  return parts.filter(Boolean).join('   ·   ');
}

/** The start-screen hint line — same keymap-driven contract as bottomHints. Pure. */
export function startScreenHints(keymap: Keymap): string {
  const mode = keymap.chordLabel('mode_toggle');
  return ['⏎ send', '/ commands', '@ files', '! shell', '↑ history', mode ? `${mode} mode` : ''].filter(Boolean).join(' · ');
}

/** The bottom-bar right side ("ctrl+c quit"), empty when quit is unbound. Pure. */
export function quitHint(keymap: Keymap): string {
  const chord = keymap.chordLabel('quit');
  return chord ? `${chord} quit` : '';
}

export const INTERRUPT_CONFIRM_MS = 1_800;

/** Pure half of the double-Esc contract. The shell owns the expiry timer; this function makes the
 *  boundary deterministic in focused tests and prevents an old armed window from aborting a later turn. */
export function interruptPress(armedUntil: number, now: number, windowMs = INTERRUPT_CONFIRM_MS): { armedUntil: number; abort: boolean } {
  return armedUntil > now
    ? { armedUntil: 0, abort: true }
    : { armedUntil: now + windowMs, abort: false };
}

function modelMetaLine(mode: BrainWorkMode, modelName: string, thinkingLevel: string, generating?: string, yolo?: boolean, fast?: boolean): string {
  const raw = modelName || '—';
  const slash = raw.indexOf('/');
  const provider = slash > 0 ? raw.slice(0, slash) : '';
  const model = slash > 0 ? raw.slice(slash + 1) : raw;
  return [
    `  ${color.accent(mode === 'plan' ? 'Plan' : 'Build')}`,
    color.faint('·'),
    color.text(model),
    provider ? color.dim(provider) : '',
    thinkingLevel ? color.warning(thinkingLevel) : '',
    fast ? color.accent('FAST') : '',
    // Warning-toned so auto-approved tool asks are never invisible (session /yolo or the persisted default).
    yolo ? color.warning('YOLO') : '',
    generating ?? '',
  ].filter(Boolean).join(' ');
}

/** The render shell: layout composition (chat stack vs start screen, telemetry panel), the render()
 *  pass, the slash/mention suggestion overlays, and the global mouse/key input routing. */
export function createShell(rt: ChatRuntime, stream: StreamController, mdTheme: MarkdownTheme, diagnostics: TuiDiagnostics): ChatApplication {
  const { client, tui, term, editor, editorSlot, inputStack, attachmentChips, cwdLabel, branchLabel } = rt;
  let renderOwner!: RenderShell;
  const render = (reason = 'state'): void => renderOwner.scheduleRender(reason);
  const renderForced = (reason = 'geometry'): void => renderOwner.scheduleForcedRender(reason);

  // `let`, not `const`: the /keybinds editor swaps the live keymap (and its leader window) in place via
  // reloadKeymap below. Every closure here — the input dispatcher, the hint lines, the leader chip —
  // reads these bindings, so reassigning them applies a rebind everywhere without restarting the chat.
  let keymap = activeKeymap();
  // The leader window: after the leader chord, the next keypress resolves leader-bound actions. The
  // expiry re-render clears the "waiting" chip from the meta line.
  let leader = createLeaderState(keymap, { onExpire: () => render('input:leader-expired') });
  /** The subtle "leader pressed, waiting for the second key" chip appended to the meta line. */
  const leaderChip = (): string =>
    leader.pending() ? ` ${color.accent('⌘')} ${color.faint(`${keymap.chordLabel('leader') ?? 'leader'} —`)}` : '';

  const cardPanel = new CardPanel();
  const subPanel = new SubagentPanel();
  const promptMeta = new StatusBar('', '');
  const quitLabel = quitHint(keymap);
  const bottomBar = new StatusBar(color.faint(`  ${bottomHints(keymap, 'idle')}`), quitLabel ? color.faint(`${quitLabel}  `) : '');

  const slashItems = rt.commandDefs.map((cmd) => ({
    value: `/${cmd.name}`,
    label: `/${cmd.name}`,
    description: cmd.description,
  }));
  // No PI autocomplete provider: '/' commands and '@' file mentions both use Elowen's own overlays
  // (a second popup fighting over Tab/Enter would be chaos).

  let panelHandle: ReturnType<TUI['showOverlay']> | null = null;
  let slashHandle: ReturnType<TUI['showOverlay']> | null = null;
  let slashOverlay: SlashOverlay | null = null;
  let mentionHandle: ReturnType<TUI['showOverlay']> | null = null;
  let mentionOverlay: MentionOverlay | null = null;
  let panelWidth = 46;
  let inputRouter: InputRouter | null = null;
  let overlayController!: OverlayController;
  /** An empty conversation renders the centered start screen instead of the chat stack + panel. */
  const hasMessages = (): boolean => rt.view.turns.length > 0;
  const panelVisible = (): boolean => term.columns >= 104 && hasMessages() && !panelHandle?.isHidden();
  const panelReserve = (): number => panelVisible() ? panelWidth + PANEL_GUTTER_COLUMNS : 0;
  const chatWidth = (): number => Math.max(1, term.columns - panelReserve());
  const panelLeftEdge = (): number => term.columns - panelWidth;
  const animations = new AnimationController({
    render,
    canAnimateMascot: () => panelVisible() && !rt.view.thinking && !rt.childView?.view.thinking,
  });
  const cancelFloat = (): void => animations.cancelMascot();
  let currentBudget: LayoutBudget | null = null;
  let preparedInput: { width: number; queue: string[]; attachments: string[]; editor: string[] } | null = null;
  const activeInputComponent = (): (Component & { setMaxRows?: (rows: number | null) => void }) | undefined =>
    editorSlot.children[0] as (Component & { setMaxRows?: (rows: number | null) => void }) | undefined;
  const hasPriorityInput = (): boolean => activeInputComponent() !== editor;
  const budgetedInput: Component = {
    invalidate: () => { inputStack.invalidate?.(); preparedInput = null; },
    render: (width: number): string[] => {
      const budget = currentBudget;
      if (!budget) return [];
      const cached = preparedInput?.width === width ? preparedInput : {
        width,
        queue: rt.queuedMessages.render(width),
        attachments: attachmentChips.render(width),
        editor: editorSlot.render(width),
      };
      rt.queuedMessages.setMaxRows(budget.sections.queue);
      const queue = budget.sections.queue > 0 ? rt.queuedMessages.render(width) : [];
      const attachments = cached.attachments.slice(0, budget.sections.attachments);
      const editorRows = budget.sections.editor > 0 ? cached.editor.slice(-budget.sections.editor) : [];
      return [...queue, ...attachments, ...editorRows];
    },
  };
  const refreshLayoutBudget = (): LayoutBudget => {
    const width = chatWidth();
    // Desired queue height is uncapped; computeLayoutBudget is the sole presentation cap.
    rt.queuedMessages.setMaxRows(null);
    activeInputComponent()?.setMaxRows?.(null);
    preparedInput = {
      width,
      queue: rt.queuedMessages.render(width),
      attachments: attachmentChips.render(width),
      editor: editorSlot.render(width),
    };
    const budget = renderOwner.allocateLayout({
      columns: term.columns,
      rows: term.rows,
      hasTranscript: hasMessages(),
      telemetryRequested: panelVisible(),
      editorPriority: hasPriorityInput(),
      cardsPriority: cardPanel.isExpanded(),
      telemetryColumns: panelWidth,
      desired: {
        editor: preparedInput.editor.length,
        queue: preparedInput.queue.length,
        attachments: preparedInput.attachments.length,
        cards: cardPanel.desiredRows(width),
        subagents: subPanel.desiredRows(),
      },
    });
    currentBudget = budget;
    activeInputComponent()?.setMaxRows?.(budget.sections.editor);
    preparedInput.editor = editorSlot.render(width);
    cardPanel.setMaxRows(budget.sections.cards);
    subPanel.setMaxRows(budget.sections.subagents);
    return budget;
  };
  const rowBudget = (): LayoutBudget => currentBudget ?? refreshLayoutBudget();

  const parentViewport = new ChatViewport(
    { transcript: rt.transcript, transcriptNotice: rt.view.notice, notice: rt.notice, modelName: rt.modelName, thinkingSeconds: 0 },
    mdTheme,
    () => rowBudget().sections.transcript,
    () => TOP_RULE_ROWS + 1,
    chatWidth,
  );
  let childViewport: ChatViewport | null = null;
  let childViewportSession = '';
  const newChildViewport = (): ChatViewport => new ChatViewport(
    {
      transcript: rt.childView?.transcript ?? rt.transcript,
      transcriptNotice: (rt.childView?.view ?? rt.view).notice,
      notice: '', modelName: rt.modelName, thinkingSeconds: 0,
    },
    mdTheme,
    () => rowBudget().sections.transcript,
    () => TOP_RULE_ROWS + 1,
    chatWidth,
  );
  const activeViewport = (): ChatViewport => rt.childView ? (childViewport ?? parentViewport) : parentViewport;
  let currentRunSeconds = 0;
  const telemetry = new TelemetryPanel(() => ({
    usage: rt.usage,
    cwd: cwdLabel,
    branch: branchLabel,
    mcp: rt.mcpList,
    lspEnabled: rt.lspEnabled,
    processes: rt.processes,
    rateLimits: rt.rateLimits,
    floatOffset: animations.mascotOffset,
  }));
  const startScreen = new StartScreen(
    inputStack,
    () => Math.max(1, term.rows - TOP_RULE_ROWS),
    () => ({
      modelLine: modelMetaLine(rt.workMode, rt.modelName, rt.thinkingLevelLabels[rt.thinkingLevel] ?? rt.thinkingLevel, undefined, rt.yoloOn, rt.fastOn) + leaderChip(),
      hints: color.faint(startScreenHints(keymap)),
      tip: `${color.warning('●')} ${color.bold(color.text('Tip'))} ${color.dim('ask anything — try')} ${color.text('"What is the tech stack of this project?"')}`,
      notice: rt.notice,
      statusLeft: `${color.dim(cwdLabel)}${branchLabel ? color.faint(` · ${branchLabel}`) : ''}`,
      version: ELOWEN_CLI_VERSION,
    }),
  );
  const compactNotice: Component = {
    invalidate: () => {},
    render: (width: number): string[] => {
      const count = rowBudget().sections.transcript;
      if (count <= 0) return [];
      const size = `${term.columns}×${term.rows}`;
      const lines = [
        color.warning('Terminal too small for the full chat UI'),
        color.faint(`${size} · recommended at least 32×12`),
      ].slice(0, count).map((line) => padAnsi(line, width));
      while (lines.length < count) lines.push(' '.repeat(width));
      return lines;
    },
  };
  const optionalHints: Component = {
    invalidate: () => bottomBar.invalidate(),
    render: (width: number): string[] => rowBudget().sections.hints > 0 ? bottomBar.render(width) : [],
  };

  const showPanel = (hidden = false): void => {
    panelHandle?.hide();
    panelHandle = overlayController.show('telemetry', telemetry, {
      anchor: 'top-right',
      width: panelWidth,
      maxHeight: Math.max(1, term.rows - TOP_RULE_ROWS),
      margin: { top: TOP_RULE_ROWS, right: 0, bottom: 0, left: 0 },
      // The panel only exists alongside a running conversation — the start screen hides it entirely.
      visible: (width) => width >= 104 && hasMessages(),
      nonCapturing: true,
    });
    panelHandle.setHidden(hidden);
  };
  const reshowPanel = (): void => { showPanel(panelHandle?.isHidden() ?? false); };

  // Kill a background process from the panel's ✕. Fire-and-forget: no optimistic local removal — the
  // daemon's `process` snapshot event is the single source of truth and drops it once the kill lands.
  const killProcess = (id: string): void => {
    void client.killProcess(id).then((killed) => {
      // Already gone → no `process` snapshot will fire, so refetch to drop the stale row the user clicked.
      if (!killed) {
        rt.notice = color.dim('process already finished');
        void client.processes().then((p) => { rt.processes = p; render('process:refresh-after-kill'); }).catch(() => { /* offline */ });
      }
    }).catch((e: Error) => { rt.notice = color.error(`could not kill process: ${e.message}`); render('process:kill-error'); });
  };

  let thinkStart = 0;
  let interruptArmedUntil = 0;
  const clearInterruptArm = (): void => {
    interruptArmedUntil = 0;
    animations.cancelVisual('interrupt-arm');
  };
  const prepareFrame = (): void => {
    if (!panelVisible()) cancelFloat();
    if (rt.view.thinking) {
      if (!thinkStart) thinkStart = Date.now();
    } else {
      thinkStart = 0;
      clearInterruptArm();
    }
    const animateThinking = rt.view.thinking || !!rt.childView?.view.thinking;
    animations.updateThinking(animateThinking);
    currentRunSeconds = thinkStart ? Math.max(0, Math.round((Date.now() - thinkStart) / 1000)) : 0;
    parentViewport.setState({
      transcript: rt.transcript,
      transcriptNotice: rt.view.notice,
      notice: rt.notice,
      modelName: rt.modelName,
      thinkingSeconds: currentRunSeconds,
      showThoughts: rt.showThoughts,
    });
    if (rt.childView) {
      if (!childViewport || childViewportSession !== rt.childView.sessionId) {
        childViewport = newChildViewport();
        childViewportSession = rt.childView.sessionId;
      }
      childViewport.setState({
        transcript: rt.childView.transcript,
        transcriptNotice: rt.childView.view.notice,
        notice: rt.childView.loading
          ? color.dim('· loading sub-agent transcript…')
          : (rt.notice || color.dim('· sub-agent session — your messages go to this agent')),
        modelName: rt.modelName,
        thinkingSeconds: currentRunSeconds,
        showThoughts: rt.showThoughts,
      });
    } else if (childViewport) {
      // Parent and child keep independent scroll/expand registries. Closing a child discards only its
      // viewport state; reopening starts clean and can never inherit the parent's scroll anchor.
      childViewport = null;
      childViewportSession = '';
    }
    // Contextual footer: while streaming, Esc interrupts; inside a sub-agent view, input steers the child.
    const footerState = rt.childView ? 'child' : rt.view.thinking ? 'thinking' : 'idle';
    const agents = stream.subagentStates(); // one transcript scan per frame (formerly two)
    bottomBar.setLeft(color.faint(`  ${bottomHints(keymap, footerState, agents.length > 0, interruptArmedUntil > Date.now())}`)
      + (footerState === 'idle' && rt.shellContext.pending ? `   ${color.warning('· ! output → next message')}` : ''));
    const projectLine = `${color.dim(cwdLabel)}${branchLabel ? color.faint(` · ${branchLabel}`) : ''}`;
    const line = statusline(rt.lineCfg ? { ...rt.lineCfg, showModel: false } : null, rt.usage, rt.modelName);
    promptMeta.setLeft(modelMetaLine(rt.workMode, rt.modelName, rt.thinkingLevelLabels[rt.thinkingLevel] ?? rt.thinkingLevel, rt.view.thinking ? generatingChip(currentRunSeconds) : undefined, rt.yoloOn, rt.fastOn) + leaderChip());
    promptMeta.setRight(panelVisible() || !line ? projectLine : `${color.faint(line)} ${color.faint('·')} ${projectLine}`);
    // Drop the terminal plugin's pinned `bg-processes` card only while the dedicated right rail is
    // actually visible. Narrow terminals cannot fit that rail; retaining the compact card there avoids
    // making background work disappear entirely while still preventing duplicates on wide layouts.
    cardPanel.set(rt.cards.filter((c) => c.id !== 'bg-processes' || !panelVisible()));
    subPanel.set(agents);
    // Pending mid-turn queue strip above the composer (with the remove-last keybind hint when bound).
    const removeChord = keymap.chordLabel('queue_remove');
    rt.queuedMessages.set(rt.queued, rt.queued.length && removeChord ? `${removeChord} removes the last queued message` : null);
  };
  renderOwner = new RenderShell({
    tui,
    term,
    prepare: () => {
      currentBudget = null;
      preparedInput = null;
      prepareFrame();
    },
    onFlush: (frame) => diagnostics.record({
      type: 'scheduler', action: 'flush', reasons: frame.reasons, forced: frame.forced,
    }),
  });
  overlayController = new OverlayController(tui, renderForced);

  // Live-apply a rebind from the /keybinds editor: point `keymap` at the freshly-built active map and
  // rebuild the leader window around it (the old one may hold a stale keymap + pending timer). The
  // bottom-bar quit label is the one hint rendered once at construction rather than per-render, so
  // refresh it here too; every other hint recomputes from `keymap` on the next render().
  const reloadKeymap = (): void => {
    keymap = activeKeymap();
    leader.cancel();
    leader = createLeaderState(keymap, { onExpire: () => render('input:leader-expired') });
    const q = quitHint(keymap);
    bottomBar.setRight(q ? color.faint(`${q}  `) : '');
    render('input:keymap-reload');
  };

  const closeSlash = (): void => {
    slashHandle?.hide();
    slashHandle = null;
    slashOverlay = null;
    render('overlay:slash-close');
  };

  /** Anchor a NON-capturing suggestion popup (slash commands, @ mentions) above the input — under the
   *  centered box on the start screen, at the bottom-of-screen slot otherwise. Shared geometry so the
   *  two overlays can never drift apart. */
  const showSuggestions = (name: 'slash' | 'mention', overlay: Component): ReturnType<TUI['showOverlay']> => {
    return overlayController.showSuggestion(name, overlay, {
      columns: term.columns,
      rows: term.rows,
      hasMessages: hasMessages(),
      panelReserve: panelReserve(),
      input: inputStack,
      notice: rt.notice,
      budget: hasMessages() ? rowBudget() : null,
    });
  };

  /** Open the slash suggestions as a NON-capturing overlay: the editor keeps focus (and the typed text,
   *  including the leading '/'), while the overlay just mirrors it as a filter via editor.onChange. */
  const openSlash = (): void => {
    closeSlash();
    const overlay = new SlashOverlay(slashItems);
    overlay.setFilter(editor.getText());
    slashOverlay = overlay;
    slashHandle = showSuggestions('slash', overlay);
    render('overlay:slash-open');
  };

  const closeMention = (): void => {
    mentionHandle?.hide();
    mentionHandle = null;
    mentionOverlay = null;
    render('overlay:mention-close');
  };

  /** The `@` token being typed at the cursor (word-start only — see activeMention), or null. */
  const mentionAtCursor = (): { query: string; start: number; line: number } | null => {
    const cur = editor.getCursor();
    const lineText = editor.getLines()[cur.line] ?? '';
    const m = activeMention(lineText, cur.col);
    return m ? { ...m, line: cur.line } : null;
  };

  /** Ranked suggestions for a mention query: fuzzy + frecency over the project index, with the
   *  `@clipboard` pseudo-file pinned on top while the query still matches it. */
  const mentionItems = (query: string): { value: string; label: string; description?: string }[] => {
    const items = rankMentionFiles(rt.mentionIndex.files(), query, rt.mentionFrecency)
      .map((path) => ({ value: path, label: path, description: imageMimeFor(path) ? 'image' : undefined }));
    if (CLIPBOARD_MENTION.startsWith(query.toLowerCase())) {
      items.unshift({ value: CLIPBOARD_MENTION, label: CLIPBOARD_MENTION, description: 'attach the clipboard image' });
    }
    return items;
  };

  /** Re-rank the mention suggestions from the editor text; closes the overlay when the token ended. */
  const updateMention = (): void => {
    if (!mentionHandle || !mentionOverlay) return;
    const m = mentionAtCursor();
    if (!m) { closeMention(); return; }
    mentionOverlay.setItems(mentionItems(m.query));
    render('input:mention-filter');
  };

  /** Open the file-mention suggestions (same non-capturing pattern as the slash overlay). */
  const openMention = (): void => {
    closeMention();
    rt.mentionIndex.refreshIfStale(); // a new mention re-lists a stale index; keystrokes stay cached
    const overlay = new MentionOverlay();
    overlay.setItems(mentionItems(''));
    mentionOverlay = overlay;
    mentionHandle = showSuggestions('mention', overlay);
    render('overlay:mention-open');
  };

  /** Replace the active `@` token with the picked path (quoted when it has spaces) and bump its
   *  frecency so it ranks first next time. */
  const insertMention = (path: string): void => {
    const cur = editor.getCursor();
    const lines = editor.getLines();
    const lineText = lines[cur.line] ?? '';
    const m = activeMention(lineText, cur.col);
    closeMention();
    if (!m) return;
    const nextLine = `${lineText.slice(0, m.start)}${mentionInsertText(path)} ${lineText.slice(cur.col)}`;
    editor.setText([...lines.slice(0, cur.line), nextLine, ...lines.slice(cur.line + 1)].join('\n'));
    if (path !== CLIPBOARD_MENTION) rt.mentionFrecency = bumpMentionFrecency(process.cwd(), path);
    render('input:mention-insert');
  };

  // The slash overlay is a live suggestion popup driven by the input text: it filters while the text can
  // still be a command name and closes the moment it can't be one anymore (a space for arguments, a
  // second '/' as in /var/www/x, or the leading '/' deleted) — the text itself always stays in the input.
  editor.onChange = (text: string): void => {
    if (slashHandle && slashOverlay) {
      if (isSlashCommandDraft(text)) {
        slashOverlay.setFilter(text);
        render('input:slash-filter');
      } else {
        closeSlash();
      }
    }
    // The mention overlay mirrors the `@` token at the cursor the same way — re-ranked on every
    // keystroke, closed the moment the token ends (whitespace, deleted '@', closing quote).
    if (mentionHandle && mentionOverlay) updateMention();
  };

  // Esc closes an open sub-agent view first. A parent turn deliberately takes TWO presses: the first arms
  // a short confirmation window (truthfully shown in the footer), the second aborts server-side. This makes
  // an accidental Esc harmless without changing one-Esc dismissal for overlays/attachments/child drill-in.
  editor.onEscape = (): boolean => {
    if (rt.childView) { stream.closeSubagent(); return true; }
    if (rt.view.thinking) {
      const next = interruptPress(interruptArmedUntil, Date.now());
      interruptArmedUntil = next.armedUntil;
      animations.cancelVisual('interrupt-arm');
      if (next.abort) {
        void client.abort().catch(() => { /* already idle */ });
      } else {
        const armed = interruptArmedUntil;
        animations.scheduleVisual('interrupt-arm', INTERRUPT_CONFIRM_MS, () => {
          if (interruptArmedUntil === armed) { clearInterruptArm(); render('input:interrupt-expired'); }
        });
      }
      render('input:interrupt-arm');
      return true;
    }
    if (rt.pendingImages.length > 0) {
      rt.pendingImages = [];
      attachmentChips.set([]);
      rt.notice = color.dim('image attachments dropped');
      render('input:attachments-dropped');
      return true;
    }
    return false;
  };

  const root = new Container();
  root.addChild(new TopRule(() => rt.conversationTitle));
  root.addChild(new MainColumn(panelReserve, () => {
    if (!hasMessages()) return [startScreen];
    const budget = refreshLayoutBudget(); // one authoritative geometry/state preparation per root frame
    if (budget.compactFallback) return [compactNotice, budgetedInput, promptMeta];
    // Todos stay immediately above the composer; background Processes moved into the right telemetry rail.
    return [activeViewport(), subPanel, cardPanel, budgetedInput, promptMeta, optionalHints];
  }));
  const measuredRoot: Component = {
    invalidate: () => root.invalidate(),
    render: (width: number): string[] => {
      const renderStartedAt = performance.now();
      const rawLines = root.render(width).map(terminalSafeAnsi);
      // Final defense at the single root boundary. A custom child must never make pi-tui write a wrapping
      // line or a frame taller than the alternate screen, even if its own local sizing regresses later.
      const lines = renderOwner.composeRoot(rawLines, width, term.rows);
      const reverseSpans = diagnostics.enabled
        ? (['raw', 'constrained'] as const).flatMap((stage) => {
          const source = stage === 'raw' ? rawLines : lines;
          return source.flatMap((line, row) => {
            const start = line.indexOf('\x1b[7m');
            if (start < 0) return [];
            const reset = line.indexOf('\x1b[0m', start + 4);
            const end = reset < 0 ? line.length : reset;
            return [{ stage, row, from: visibleWidth(line.slice(0, start)), to: visibleWidth(line.slice(0, end)) }];
          });
        })
        : undefined;
      const transcript = hasMessages() ? activeViewport().metrics() : null;
      const frame = renderOwner.takeFrame();
      const sections = currentBudget?.sections ?? {
        header: TOP_RULE_ROWS,
        transcript: Math.max(0, term.rows - TOP_RULE_ROWS),
        cards: 0, subagents: 0, queue: 0, attachments: 0, editor: 0, status: 1, hints: 0,
      };
      diagnostics.record({
        type: 'frame',
        reasons: frame ? [...frame.reasons] : ['pi-tui:unscheduled'],
        forced: frame?.forced ?? false,
        prepareMs: frame?.prepareMs ?? 0,
        transcriptMs: transcript?.renderMs ?? 0,
        totalMs: performance.now() - (frame?.requestedAt ?? renderStartedAt),
        transcriptRows: transcript?.transcriptRows ?? 0,
        transcriptRowsExact: transcript?.transcriptRowsExact ?? true,
        visibleRows: transcript?.visibleRows ?? 0,
        renderedTurns: transcript?.renderedTurns ?? 0,
        indexedTurns: transcript?.indexedTurns ?? 0,
        cachedRows: transcript?.cachedRows ?? 0,
        terminal: { columns: term.columns, rows: term.rows },
        sections: { ...sections },
        rootRows: lines.length,
        reverseSpans,
      });
      return lines;
    },
  };
  tui.addChild(measuredRoot);
  tui.setFocus(editor);
  showPanel(false);

  const attachInput = (deps: ShellInputDeps): void => {
    if (inputRouter) return;
    /** Run one keybind action. Fired by its direct chord (while the main editor is focused) or as a
     *  resolved leader sequence — one dispatcher so both paths share guards and behavior. */
    const dispatchAction = (action: KeybindAction): void => {
      switch (action) {
        case 'leader': return; // the leader only prefixes — it is never an action of its own
        case 'quit': rt.quit(); return;
        // No telemetry panel on the start screen — a toggle there would silently pre-hide it for later.
        case 'telemetry_toggle': {
          if (!hasMessages()) return;
          panelHandle?.setHidden(!panelHandle.isHidden());
          if (panelHandle?.isHidden()) cancelFloat();
          inputRouter?.cancelPanelResize();
          render('input:telemetry-toggle');
          return;
        }
        case 'reasoning_cycle': deps.cycleThinkingLevel(); return;
        // Stash the current draft (LIFO, session-local); on an empty input, pop the latest one back.
        case 'stash': {
          const draft = editor.getText();
          const stashChord = keymap.chordLabel('stash') ?? '/keybinds';
          if (draft.trim()) {
            rt.promptStash.push(draft);
            editor.setText('');
            rt.notice = color.dim(`Draft stashed — ${stashChord} to restore${rt.promptStash.size > 1 ? ` (${rt.promptStash.size} stashed)` : ''}`);
          } else {
            const restored = rt.promptStash.pop();
            if (restored != null) { editor.setText(restored); rt.notice = color.dim('Stashed draft restored'); }
            else rt.notice = color.dim(`no stashed draft — ${stashChord} with text stashes it`);
          }
          render('input:stash');
          return;
        }
        // Cycle main conversation → each sub-agent session → back to main (opencode-style).
        case 'subagent_cycle': stream.cycleSubagent(); return;
        // Drop the most recent pending mid-turn queued message. Optimistic local pop; the server's `queue`
        // snapshot reconciles (and is authoritative if the item was already delivered in the meantime).
        case 'queue_remove': {
          const last = rt.queued.at(-1);
          if (!last) { rt.notice = color.dim('no queued messages'); render('input:queue-remove-empty'); return; }
          rt.queued = rt.queued.slice(0, -1); // optimistic; the queue_update snapshot reconciles
          void client.queueRemove(last.id).catch((e: Error) => { rt.notice = color.error(`error: ${e.message}`); render('input:queue-remove-error'); });
          render('input:queue-remove');
          return;
        }
        case 'mode_toggle': {
          rt.workMode = rt.workMode === 'plan' ? 'build' : 'plan';
          rt.notice = color.dim(rt.workMode === 'plan'
            ? 'plan mode: Elowen will reason through approach, risks and tests before editing'
            : 'build mode: Elowen can implement with tools');
          render('input:mode-toggle');
          return;
        }
        case 'help': deps.openHelpModal(); return;
        case 'theme_picker': deps.openThemePicker(); return;
        case 'model_picker': deps.openModelPicker(); return;
        case 'sessions_picker': deps.openSessionsModal(); return;
      }
    };
    inputRouter = new InputRouter(tui, {
      rt,
      stream,
      keymap: () => keymap,
      leader: () => leader,
      dispatchAction,
      render,
      animations,
      hasMessages,
      activeViewport,
      panelVisible,
      panelLeftEdge,
      setPanelWidth: (width) => { panelWidth = width; },
      reflowPanel: () => {
        showPanel(false);
        if (slashHandle) openSlash();
        if (mentionHandle && mentionOverlay) {
          mentionHandle.hide();
          mentionHandle = showSuggestions('mention', mentionOverlay);
        }
      },
      telemetry,
      killProcess,
      rowBudget,
      subPanel,
      cardPanel,
      chatWidth,
      slashOverlay: () => slashOverlay,
      mentionOverlay: () => mentionOverlay,
      closeSlash,
      closeMention,
      openSlash,
      openMention,
      insertMention,
    });
    inputRouter.attach();
  };

  const cleanup = (): void => {
    clearInterruptArm();
    panelHandle = null;
    slashHandle = null;
    slashOverlay = null;
    mentionHandle = null;
    mentionOverlay = null;
  };

  return new ChatApplication({
    term,
    tui,
    renderOwner,
    animations,
    overlays: overlayController,
    inputRouter: () => inputRouter,
    render,
    renderForced,
    showPanel,
    reshowPanel,
    attachInput,
    reloadKeymap,
    cleanup,
  });
}
