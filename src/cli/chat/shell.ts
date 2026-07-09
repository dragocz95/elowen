import { Container } from '@earendil-works/pi-tui';
import type { Component, MarkdownTheme, TUI } from '@earendil-works/pi-tui';
import { color } from './theme.js';
import { StatusBar, CardPanel, SubagentPanel, spinnerFrame } from './components.js';
import { MascotFloat } from './mascotFloat.js';
import { activeMention, CLIPBOARD_MENTION, imageMimeFor, rankMentionFiles, bumpMentionFrecency, mentionInsertText } from './mentions.js';
import { isSlashCommandDraft } from './commands.js';
import {
  activeKeymap, createLeaderState, isDownKey, isEnterKey, isEscapeKey,
  isPageDownKey, isPageUpKey, isTabByte, isUpKey,
} from './keys.js';
import type { Keymap, KeybindAction } from './keys.js';
import { formatDuration, formatK } from '../ui/text.js';
import { ELOWEN_CLI_VERSION } from '../version.js';
import {
  ChatViewport,
  MainColumn,
  mouseClick,
  mouseEvent,
  mouseWheel,
  MentionOverlay,
  PANEL_GUTTER_COLUMNS,
  SlashOverlay,
  StartScreen,
  startScreenBox,
  startScreenInputTop,
  TelemetryPanel,
  TOP_RULE_ROWS,
  TopRule,
} from './layout.js';
import type { BrainWorkMode } from './brainClient.js';
import type { ChatRuntime } from './runtime.js';
import type { StreamController } from './streamController.js';

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
export function bottomHints(keymap: Keymap, state: 'child' | 'thinking' | 'idle', hasSubagents = false): string {
  const k = (action: KeybindAction, label: string): string => {
    const chord = keymap.chordLabel(action);
    return chord ? `${chord} ${label}` : '';
  };
  const parts = state === 'child'
    ? ['⏎ message the sub-agent', 'esc back', k('subagent_cycle', 'next session')]
    : state === 'thinking'
      ? ['esc interrupt', '/help commands', k('reasoning_cycle', 'reasoning'), hasSubagents ? k('subagent_cycle', 'subagents') : '']
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

function modelMetaLine(mode: BrainWorkMode, modelName: string, thinkingLevel: string, generating?: string, yolo?: boolean): string {
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
    // Warning-toned so auto-approved tool asks are never invisible (session /yolo or the persisted default).
    yolo ? color.warning('YOLO') : '',
    generating ?? '',
  ].filter(Boolean).join(' ');
}

/** What keybind actions need from the picker surface — wired in runChat, after the pickers exist. */
interface ShellInputDeps {
  cycleThinkingLevel(): void;
  openHelpModal(): void;
  openThemePicker(): void;
  openModelPicker(): void;
  openSessionsModal(): void;
}

export interface Shell {
  render(): void;
  showPanel(hidden?: boolean): void;
  /** Re-open the telemetry panel so it picks up freshly applied theme colors, keeping its hidden state. */
  reshowPanel(): void;
  /** Register the global key/mouse listener. Called once in runChat, after the pickers exist. */
  attachInput(deps: ShellInputDeps): void;
  /** Swap the running session onto the freshly-built active keymap (after a /keybinds rebind) — no
   *  restart: dispatch resolution and every hint line pick up the new bindings on the next keypress. */
  reloadKeymap(): void;
  /** Hide every owned overlay (telemetry panel + suggestion popups) — the quit path. */
  hideOverlays(): void;
}

/** The render shell: layout composition (chat stack vs start screen, telemetry panel), the render()
 *  pass, the slash/mention suggestion overlays, and the global mouse/key input routing. */
export function createShell(rt: ChatRuntime, stream: StreamController, mdTheme: MarkdownTheme): Shell {
  const { client, tui, term, editor, inputStack, attachmentChips, cwdLabel, branchLabel } = rt;

  // `let`, not `const`: the /keybinds editor swaps the live keymap (and its leader window) in place via
  // reloadKeymap below. Every closure here — the input dispatcher, the hint lines, the leader chip —
  // reads these bindings, so reassigning them applies a rebind everywhere without restarting the chat.
  let keymap = activeKeymap();
  // The leader window: after the leader chord, the next keypress resolves leader-bound actions. The
  // expiry re-render clears the "waiting" chip from the meta line.
  let leader = createLeaderState(keymap, { onExpire: () => render() });
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
  let resizingPanel = false;
  let draggingHistoryScroll = false;
  // Screen row of the last scrollbar-drag sample — its delta gives the drag direction for the mascot float.
  let lastScrollDragRow = 0;

  // The right-panel flame's eased drift-on-scroll. A pure spring-damper (mascotFloat) is nudged on each
  // scroll and integrated by a self-canceling ~30fps ticker that stops the moment the motion settles, so
  // an idle session pays zero CPU — mirroring app.ts's thinking-only render timer.
  const FLOAT_TICK_MS = 33;
  const mascotFloat = new MascotFloat();
  let floatTimer: ReturnType<typeof setInterval> | null = null;
  const armFloat = (): void => {
    if (floatTimer) return;
    floatTimer = setInterval(() => {
      mascotFloat.tick(FLOAT_TICK_MS);
      tui.requestRender();
      if (mascotFloat.settled()) {
        if (floatTimer) { clearInterval(floatTimer); floatTimer = null; }
        tui.requestRender(); // one final paint at the rest position
      }
    }, FLOAT_TICK_MS);
  };
  // Nudge the flame in a scroll direction, but only when the panel is actually on screen (≥104 cols +
  // a conversation) — on a narrow terminal there is no flame to float, so the spring stays at rest.
  const nudgeFloat = (dir: number): void => {
    if (!panelVisible()) return;
    mascotFloat.impulse(dir);
    armFloat();
  };
  /** An empty conversation renders the centered start screen instead of the chat stack + panel. */
  const hasMessages = (): boolean => rt.view.turns.length > 0;
  const panelVisible = (): boolean => term.columns >= 104 && hasMessages() && !panelHandle?.isHidden();
  const panelReserve = (): number => panelVisible() ? panelWidth + PANEL_GUTTER_COLUMNS : 0;
  const chatWidth = (): number => Math.max(24, term.columns - panelReserve());
  const panelLeftEdge = (): number => term.columns - panelWidth;
  const fixedRows = (): number => {
    const cardRows = cardPanel.render(Math.max(24, chatWidth())).length;
    const subRows = subPanel.render(Math.max(24, chatWidth())).length;
    const inputRows = inputStack.render(Math.max(24, chatWidth())).length;
    return TOP_RULE_ROWS + cardRows + subRows + inputRows + 2;
  };

  const viewport = new ChatViewport(
    { view: rt.view, notice: rt.notice, modelName: rt.modelName, thinkingSeconds: 0 },
    mdTheme,
    () => Math.max(8, term.rows - fixedRows()),
    () => TOP_RULE_ROWS + 1,
    chatWidth,
  );
  let currentRunSeconds = 0;
  const telemetry = new TelemetryPanel(() => ({
    usage: rt.usage,
    cwd: cwdLabel,
    branch: branchLabel,
    mcp: rt.mcpList,
    lspEnabled: rt.lspEnabled,
    floatOffset: mascotFloat.value(),
  }));
  const startScreen = new StartScreen(
    inputStack,
    () => Math.max(12, term.rows - TOP_RULE_ROWS),
    () => ({
      modelLine: modelMetaLine(rt.workMode, rt.modelName, rt.thinkingLevel, undefined, rt.yoloOn) + leaderChip(),
      hints: color.faint(startScreenHints(keymap)),
      tip: `${color.warning('●')} ${color.bold(color.text('Tip'))} ${color.dim('ask anything — try')} ${color.text('"What is the tech stack of this project?"')}`,
      notice: rt.notice,
      statusLeft: `${color.dim(cwdLabel)}${branchLabel ? color.faint(` · ${branchLabel}`) : ''}`,
      version: ELOWEN_CLI_VERSION,
    }),
  );

  const showPanel = (hidden = false): void => {
    panelHandle?.hide();
    panelHandle = tui.showOverlay(telemetry, {
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

  let thinkStart = 0;
  const render = (): void => {
    if (rt.view.thinking) {
      if (!thinkStart) thinkStart = Date.now();
    } else {
      thinkStart = 0;
    }
    currentRunSeconds = thinkStart ? Math.max(0, Math.round((Date.now() - thinkStart) / 1000)) : 0;
    viewport.setState({
      view: rt.childView?.view ?? rt.view,
      notice: rt.childView ? color.dim('· sub-agent session — your messages go to this agent') : rt.notice,
      modelName: rt.modelName,
      thinkingSeconds: currentRunSeconds,
      showThoughts: rt.showThoughts,
    });
    // Contextual footer: while streaming, Esc interrupts; inside a sub-agent view, input steers the child.
    const footerState = rt.childView ? 'child' : rt.view.thinking ? 'thinking' : 'idle';
    bottomBar.setLeft(color.faint(`  ${bottomHints(keymap, footerState, stream.subagentSessions().length > 0)}`)
      + (footerState === 'idle' && rt.shellContext.pending ? `   ${color.warning('· ! output → next message')}` : ''));
    const projectLine = `${color.dim(cwdLabel)}${branchLabel ? color.faint(` · ${branchLabel}`) : ''}`;
    const line = statusline(rt.lineCfg ? { ...rt.lineCfg, showModel: false } : null, rt.usage, rt.modelName);
    promptMeta.setLeft(modelMetaLine(rt.workMode, rt.modelName, rt.thinkingLevel, rt.view.thinking ? generatingChip(currentRunSeconds) : undefined, rt.yoloOn) + leaderChip());
    promptMeta.setRight(panelVisible() || !line ? projectLine : `${color.faint(line)} ${color.faint('·')} ${projectLine}`);
    cardPanel.set(rt.cards);
    subPanel.set(stream.subagentStates());
    // Pending mid-turn queue strip above the composer (with the remove-last keybind hint when bound).
    const removeChord = keymap.chordLabel('queue_remove');
    rt.queuedMessages.set(rt.queued, rt.queued.length && removeChord ? `${removeChord} removes the last queued message` : null);
    tui.requestRender();
  };

  // Live-apply a rebind from the /keybinds editor: point `keymap` at the freshly-built active map and
  // rebuild the leader window around it (the old one may hold a stale keymap + pending timer). The
  // bottom-bar quit label is the one hint rendered once at construction rather than per-render, so
  // refresh it here too; every other hint recomputes from `keymap` on the next render().
  const reloadKeymap = (): void => {
    keymap = activeKeymap();
    leader.cancel();
    leader = createLeaderState(keymap, { onExpire: () => render() });
    const q = quitHint(keymap);
    bottomBar.setRight(q ? color.faint(`${q}  `) : '');
    render();
  };

  const closeSlash = (): void => {
    slashHandle?.hide();
    slashHandle = null;
    slashOverlay = null;
    tui.requestRender();
  };

  /** Anchor a NON-capturing suggestion popup (slash commands, @ mentions) above the input — under the
   *  centered box on the start screen, at the bottom-of-screen slot otherwise. Shared geometry so the
   *  two overlays can never drift apart. */
  const showSuggestions = (overlay: Component): ReturnType<TUI['showOverlay']> => {
    // Tallest render: top + hint + blank + 10 items + counter + bottom = 15 rows. One less would clip
    // the bottom border whenever the counter row shows (which, with 20+ commands, is always).
    if (!hasMessages()) {
      // Start screen: the input is vertically centered, so anchor the suggestions right UNDER it
      // (aligned to the box) — the normal bottom-of-screen slot would float rows below the input.
      const { boxWidth, leftPad } = startScreenBox(term.columns);
      const inputRows = inputStack.render(boxWidth).length;
      const noticeRows = rt.notice ? rt.notice.split('\n').length : 0;
      const top = TOP_RULE_ROWS + startScreenInputTop(Math.max(12, term.rows - TOP_RULE_ROWS), inputRows, noticeRows) + inputRows;
      return tui.showOverlay(overlay, {
        anchor: 'top-left',
        width: boxWidth,
        maxHeight: 15,
        margin: { top, left: leftPad, right: 0, bottom: 0 },
        nonCapturing: true,
      });
    }
    const reserve = panelReserve();
    return tui.showOverlay(overlay, {
      anchor: 'bottom-left',
      width: Math.max(50, term.columns - reserve - 1),
      maxHeight: 15,
      margin: { top: TOP_RULE_ROWS, left: 0, right: reserve, bottom: fixedRows() },
      nonCapturing: true,
    });
  };

  /** Open the slash suggestions as a NON-capturing overlay: the editor keeps focus (and the typed text,
   *  including the leading '/'), while the overlay just mirrors it as a filter via editor.onChange. */
  const openSlash = (): void => {
    closeSlash();
    const overlay = new SlashOverlay(slashItems);
    overlay.setFilter(editor.getText());
    slashOverlay = overlay;
    slashHandle = showSuggestions(overlay);
    tui.requestRender();
  };

  const closeMention = (): void => {
    mentionHandle?.hide();
    mentionHandle = null;
    mentionOverlay = null;
    tui.requestRender();
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
    tui.requestRender();
  };

  /** Open the file-mention suggestions (same non-capturing pattern as the slash overlay). */
  const openMention = (): void => {
    closeMention();
    rt.mentionIndex.refreshIfStale(); // a new mention re-lists a stale index; keystrokes stay cached
    const overlay = new MentionOverlay();
    overlay.setItems(mentionItems(''));
    mentionOverlay = overlay;
    mentionHandle = showSuggestions(overlay);
    tui.requestRender();
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
    tui.requestRender();
  };

  // The slash overlay is a live suggestion popup driven by the input text: it filters while the text can
  // still be a command name and closes the moment it can't be one anymore (a space for arguments, a
  // second '/' as in /var/www/x, or the leading '/' deleted) — the text itself always stays in the input.
  editor.onChange = (text: string): void => {
    if (slashHandle && slashOverlay) {
      if (isSlashCommandDraft(text)) {
        slashOverlay.setFilter(text);
        tui.requestRender();
      } else {
        closeSlash();
      }
    }
    // The mention overlay mirrors the `@` token at the cursor the same way — re-ranked on every
    // keystroke, closed the moment the token ends (whitespace, deleted '@', closing quote).
    if (mentionHandle && mentionOverlay) updateMention();
  };

  // Esc closes an open sub-agent view first; while a turn streams it aborts server-side (agent_end →
  // idle winds the spinner down). When idle it drops any pending image attachments (the chip row's
  // advertised "esc to drop"), then falls through to the base editor.
  editor.onEscape = (): boolean => {
    if (rt.childView) { stream.closeSubagent(); return true; }
    if (rt.view.thinking) {
      void client.abort().catch(() => { /* already idle */ });
      return true;
    }
    if (rt.pendingImages.length > 0) {
      rt.pendingImages = [];
      attachmentChips.set([]);
      rt.notice = color.dim('image attachments dropped');
      render();
      return true;
    }
    return false;
  };

  const root = new Container();
  root.addChild(new TopRule(() => rt.conversationTitle));
  const chatStack = [viewport, cardPanel, subPanel, inputStack, promptMeta, bottomBar];
  root.addChild(new MainColumn(panelReserve, () => hasMessages() ? chatStack : [startScreen]));
  tui.addChild(root);
  tui.setFocus(editor);
  showPanel(false);

  const attachInput = (deps: ShellInputDeps): void => {
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
          resizingPanel = false;
          render();
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
          render();
          return;
        }
        // Cycle main conversation → each sub-agent session → back to main (opencode-style).
        case 'subagent_cycle': stream.cycleSubagent(); return;
        // Drop the most recent pending mid-turn queued message. Optimistic local pop; the server's `queue`
        // snapshot reconciles (and is authoritative if the item was already delivered in the meantime).
        case 'queue_remove': {
          const last = rt.queued.at(-1);
          if (!last) { rt.notice = color.dim('no queued messages'); render(); return; }
          rt.queued = rt.queued.slice(0, -1);
          void client.queueRemove(last.id).catch((e: Error) => { rt.notice = color.error(`error: ${e.message}`); render(); });
          render();
          return;
        }
        case 'mode_toggle': {
          rt.workMode = rt.workMode === 'plan' ? 'build' : 'plan';
          rt.notice = color.dim(rt.workMode === 'plan'
            ? 'plan mode: Elowen will reason through approach, risks and tests before editing'
            : 'build mode: Elowen can implement with tools');
          render();
          return;
        }
        case 'help': deps.openHelpModal(); return;
        case 'theme_picker': deps.openThemePicker(); return;
        case 'model_picker': deps.openModelPicker(); return;
        case 'sessions_picker': deps.openSessionsModal(); return;
      }
    };
    tui.addInputListener((data) => {
      const ev = mouseEvent(data);
      if (ev) {
        const isRelease = !ev.down || ev.code === 3;
        const isPrimaryDrag = ev.down && (ev.code === 0 || ev.code === 32);
        if (draggingHistoryScroll && isRelease) {
          draggingHistoryScroll = false;
          return { consume: true };
        }
        if (draggingHistoryScroll && isPrimaryDrag) {
          nudgeFloat(lastScrollDragRow - ev.y); // drag up (y falls) scrolls into history → flame lifts
          lastScrollDragRow = ev.y;
          viewport.setScrollFromRow(ev.y);
          tui.requestRender();
          return { consume: true };
        }
        if (isPrimaryDrag && hasMessages() && viewport.isScrollbarHit(ev.x, ev.y)) {
          draggingHistoryScroll = true;
          lastScrollDragRow = ev.y;
          viewport.setScrollFromRow(ev.y);
          tui.requestRender();
          return { consume: true };
        }
        if (panelVisible()) {
          const edge = panelLeftEdge();
          if (resizingPanel && isRelease) {
            resizingPanel = false;
            return { consume: true };
          }
          if (resizingPanel && ev.down) {
            panelWidth = Math.max(36, Math.min(68, term.columns - ev.x + 1));
            showPanel(false);
            if (slashHandle) openSlash();
            // Re-anchor an open mention overlay to the new geometry, keeping its items/selection.
            if (mentionHandle && mentionOverlay) { mentionHandle.hide(); mentionHandle = showSuggestions(mentionOverlay); }
            tui.requestRender(true);
            return { consume: true };
          }
          if (ev.down && ev.code === 0 && Math.abs(ev.x - edge) <= 1) {
            resizingPanel = true;
            return { consume: true };
          }
        }
      }
      // Background transcript/card interactions must not fire while a modal owns focus (a picker, the rename
      // input, the ask dock — which unfocus the editor — or the inline slash overlay): otherwise a click or
      // scroll inside the overlay would toggle the Todos checklist / scroll the transcript hidden underneath.
      // The start screen has no transcript, so those interactions also need a rendered chat stack.
      const noModal = editor.focused && !slashHandle && !mentionHandle && hasMessages();
      const click = mouseClick(data);
      // A sub-agent row opens the child transcript (its own registry — these rows don't expand in place).
      if (click && noModal && !rt.childView) {
        const subId = viewport.subagentAt(click.x, click.y);
        if (subId) { void stream.openSubagent(subId); return { consume: true }; }
      }
      if (click && noModal && viewport.isThoughtRow(click.x, click.y)) {
        viewport.toggleThought(click.y);
        tui.requestRender();
        return { consume: true };
      }
      // Click the Todos header to collapse/expand the checklist. The card panel sits directly below the
      // viewport in the fixed stack, so its first row is TOP_RULE_ROWS + viewport-height + 1 (1-based).
      // The Sub-agents panel renders right below it — a click on one of its rows opens that child.
      if (click && noModal) {
        const cardTop = TOP_RULE_ROWS + Math.max(8, term.rows - fixedRows()) + 1;
        const rel = click.y - cardTop;
        if (rel >= 0 && cardPanel.isHeaderRow(rel)) {
          cardPanel.toggleCollapsed();
          tui.requestRender();
          return { consume: true };
        }
        const subRel = rel - cardPanel.render(Math.max(24, chatWidth())).length;
        if (subRel >= 0 && subPanel.isHeaderRow(subRel)) {
          subPanel.toggleCollapsed();
          tui.requestRender();
          return { consume: true };
        }
        const target = subRel >= 0 ? subPanel.targetAt(subRel) : null;
        if (target) { void stream.openSubagent(target); return { consume: true }; }
      }
      const wheel = mouseWheel(data);
      if (wheel && noModal) {
        viewport.scroll(wheel);
        nudgeFloat(Math.sign(wheel)); // flame follows the content, then eases back
        tui.requestRender();
        return { consume: true };
      }
      // Drag-to-copy: a press on plain transcript text anchors a line selection (interactive rows above
      // consumed their presses already), dragging extends + highlights it, and release copies the lines
      // to the system clipboard via OSC 52 (works over SSH too). A no-drag click just clears quietly.
      if (ev && noModal) {
        if (ev.down && ev.code === 0 && viewport.beginSelect(ev.x, ev.y)) return { consume: true };
        if (ev.down && ev.code === 32 && viewport.hasSelection()) {
          viewport.dragSelect(ev.y);
          tui.requestRender();
          return { consume: true };
        }
        if ((!ev.down || ev.code === 3) && viewport.hasSelection()) {
          const text = viewport.takeSelection();
          tui.requestRender();
          if (text) {
            term.write(`\x1b]52;c;${Buffer.from(text.slice(0, 100_000)).toString('base64')}\x07`);
            const n = text.split('\n').length;
            rt.notice = color.success(`✓ Copied ${n} line${n === 1 ? '' : 's'}`);
            render();
            setTimeout(() => { if (rt.notice.includes('Copied')) { rt.notice = ''; render(); } }, 1800);
          }
          return { consume: true };
        }
      }
      if (keymap.matches('quit', data)) { rt.quit(); return { consume: true }; }
      // Leader window open: the NEXT keypress resolves leader-bound actions. Esc and unbound keys
      // cancel quietly; either way the key is swallowed (it must not type into the editor). Mouse
      // traffic is ignored so a stray wheel event can't eat the sequence.
      if (leader.pending() && !ev) {
        const action = leader.resolve(data);
        render(); // clear the waiting chip
        if (action) dispatchAction(action);
        return { consume: true };
      }
      // Mention suggestions: like the slash overlay, the editor keeps focus — only the navigation keys
      // are stolen (↑/↓ must steer the list, NOT the prompt-history recall, while it is open).
      if (editor.focused && mentionHandle && mentionOverlay) {
        if (isEscapeKey(data)) { closeMention(); return { consume: true }; }
        if (isUpKey(data)) { mentionOverlay.moveSelection(-1); tui.requestRender(); return { consume: true }; }
        if (isDownKey(data)) { mentionOverlay.moveSelection(1); tui.requestRender(); return { consume: true }; }
        // Tab/Enter insert the highlighted path as an `@` token. Enter with NO match falls through —
        // the "@something" the user typed is deliberate text, send it as-is.
        if (isTabByte(data) || isEnterKey(data)) {
          const value = mentionOverlay.selectedValue();
          if (value) { insertMention(value); return { consume: true }; }
          closeMention();
          return isTabByte(data) ? { consume: true } : undefined;
        }
      }
      // Slash suggestions: the editor KEEPS focus while the overlay is open (typing keeps landing in the
      // input line), so only the overlay-navigation keys are stolen here — everything else falls through.
      if (editor.focused && slashHandle && slashOverlay) {
        if (isEscapeKey(data)) { closeSlash(); return { consume: true }; }
        if (isUpKey(data)) { slashOverlay.moveSelection(-1); tui.requestRender(); return { consume: true }; }
        if (isDownKey(data)) { slashOverlay.moveSelection(1); tui.requestRender(); return { consume: true }; }
        // Tab COMPLETES the highlighted command into the input (ready for arguments); Enter runs it.
        if (isTabByte(data)) {
          const value = slashOverlay.selectedValue();
          closeSlash();
          if (value) { editor.setText(`${value} `); tui.requestRender(); }
          return { consume: true };
        }
        if (isEnterKey(data)) {
          const value = slashOverlay.selectedValue();
          closeSlash();
          if (value) { editor.setText(''); editor.onSubmit?.(value); return { consume: true }; }
          // No matching command: let Enter fall through and send the text as-is.
          return undefined;
        }
      }
      // Global chat shortcuts only fire while the MAIN editor is focused and the slash suggestions are
      // closed. Input listeners run before the focused component, so without this guard ctrl+r/ctrl+p/'/'/
      // shift+tab would hijack an open modal (a picker, the rename input, the ask-question dock) instead
      // of reaching it.
      const editing = editor.focused && !slashHandle && !mentionHandle;
      // The leader chord opens the two-key window (chip in the meta line; see the pending block above).
      if (editing && keymap.isLeader(data)) {
        leader.arm();
        render();
        return { consume: true };
      }
      // Every other bindable shortcut resolves through the keymap — one lookup instead of a predicate
      // per action, so user overrides and defaults take the same path.
      const action = editing ? keymap.directAction(data) : null;
      if (action) {
        dispatchAction(action);
        return { consume: true };
      }
      // '/' at an empty prompt opens the command suggestions but is NOT consumed — it falls through to the
      // editor, so the typed text (a command or a path like /var/www/x) always lives in the input line.
      if (editing && editor.getText() === '' && data === '/') {
        openSlash();
        return undefined;
      }
      // '@' at a word start (line start or after whitespace) opens the file-mention suggestions — also
      // not consumed, so the '@' lands in the input. Mid-word '@'s (emails) never trigger.
      if (editing && data === '@' && !rt.childView) {
        const cur = editor.getCursor();
        const lineText = editor.getLines()[cur.line] ?? '';
        const prev = cur.col > 0 ? lineText[cur.col - 1]! : '';
        if (!prev || /\s/.test(prev)) openMention();
        return undefined;
      }
      if (noModal && isPageUpKey(data)) {
        viewport.scroll(4);
        nudgeFloat(1);
        tui.requestRender();
        return { consume: true };
      }
      if (noModal && isPageDownKey(data)) {
        viewport.scroll(-4);
        nudgeFloat(-1);
        tui.requestRender();
        return { consume: true };
      }
      return undefined;
    });
  };

  const hideOverlays = (): void => {
    if (floatTimer) { clearInterval(floatTimer); floatTimer = null; } // no dangling ticker on quit
    panelHandle?.hide();
    slashHandle?.hide();
    mentionHandle?.hide();
  };

  return { render, showPanel, reshowPanel, attachInput, hideOverlays, reloadKeymap };
}
