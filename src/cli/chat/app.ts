import { TUI, ProcessTerminal, Text, Container, matchesKey, CombinedAutocompleteProvider } from '@earendil-works/pi-tui';
import { initTheme, getMarkdownTheme, getSelectListTheme } from '@earendil-works/pi-coding-agent';
import { chatTheme, chatThemeItems, color, glyph, isChatThemeName, setChatTheme } from './theme.js';
import { StatusBar, CardPanel } from './components.js';
import { ChatEditor, sessionItems, modelItems, parseModelValue, openPicker } from './picker.js';
import { runAskFlow } from './askFlow.js';
import { BrainClient } from './brainClient.js';
import { fromHistory, pushUser, beginAssistant, reduce, upsertCard, type ChatView } from '../../brain/transcript.js';
import { commandsFor } from '../../brain/slashCommands.js';
import type { AskQuestion, BrainCard } from '../../brain/events.js';
import {
  ChatViewport,
  DISABLE_MOUSE,
  ENABLE_MOUSE,
  MainColumn,
  mouseClick,
  mouseEvent,
  mouseWheel,
  PANEL_GUTTER_COLUMNS,
  SlashOverlay,
  TelemetryPanel,
  TOP_RULE_ROWS,
  TopRule,
} from './layout.js';

/** Plain-text rendering of the view — used for the non-TTY fallback and unit tests (no ANSI, so it's
 *  deterministic to assert on). The rich terminal path uses pi-tui components instead. */
export function viewToPlainText(view: ChatView): string[] {
  const lines: string[] = [];
  for (const turn of view.turns) {
    if (turn.role === 'you') {
      lines.push('you');
      lines.push(...turn.text.split('\n').map((l) => `  ${l}`));
    } else {
      lines.push(`${glyph.whale} orca`);
      for (const seg of turn.segments) {
        if (seg.kind === 'tools') {
          for (const item of seg.items) {
            lines.push(`  ${glyph.tool} ${item.name}${item.detail ? ` ${item.detail}` : ''}`);
            if (item.diff) lines.push(...item.diff.replace(/\n+$/, '').split('\n').map((l) => `    ${l}`));
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

/** Local slash-command routing: returns the recognized command (with its argument) or null for a
 *  regular chat message. Pure, so the command surface is unit-testable without a TTY. */
export function parseCommand(text: string): { cmd: 'quit' | 'new' | 'stop' | 'status' | 'restart' | 'sessions' | 'resume' | 'delete' | 'model' | 'think' | 'theme' | 'compact' | 'help'; arg?: string } | null {
  const m = /^\/(\w+)(?:\s+(.+))?$/.exec(text.trim());
  if (!m) return null;
  switch (m[1]) {
    case 'quit': case 'exit': return { cmd: 'quit' };
    case 'new': return { cmd: 'new' };
    case 'stop': return { cmd: 'stop' };
    case 'status': return { cmd: 'status' };
    case 'restart': return { cmd: 'restart' };
    case 'sessions': return { cmd: 'sessions' };
    case 'resume': return { cmd: 'resume', arg: m[2] };
    case 'delete': return { cmd: 'delete', arg: m[2] };
    case 'model': return { cmd: 'model' };
    case 'think': return { cmd: 'think', arg: m[2] };
    case 'theme': return { cmd: 'theme', arg: m[2] };
    case 'compact': return { cmd: 'compact' };
    case 'help': return { cmd: 'help' };
    default: return null;
  }
}

/** Compact token count: 999 → '999', 34 567 → '35k', 1 234 567 → '1.2M'. */
const fmtK = (n: number): string => n < 1000 ? String(n) : n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1_000_000).toFixed(1)}M`;

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
    parts.push(`context ${Math.round(usage.percent)}% (${fmtK(usage.tokens ?? 0)}/${fmtK(usage.contextWindow)})`);
  }
  if (cfg.showTokens && usage) parts.push(`Σ ${fmtK(usage.totalTokens)} tok`);
  if (cfg.showCost && usage) parts.push(`$${usage.cost.toFixed(2)}`);
  return parts.join('  ·  ');
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

// Built from the SHARED command registry so /help never drifts from the actual command set.
const HELP = commandsFor('cli', true).map((c) => `/${c.name} — ${c.description}`).join('\n');

/** Launch the interactive Orca chat TUI — an opencode-style layout (user blocks with a teal rail,
 *  markdown replies with a metadata line, a bottom status bar) rendered on pi-tui + pi's markdown theme.
 *  Conversations are server-side: /new opens one, /sessions + /resume switch between them. */
export async function runChat(opts: RunChatOpts): Promise<void> {
  if (!process.stdout.isTTY) {
    process.stderr.write('orca chat needs an interactive terminal (a TTY).\n');
    return;
  }
  initTheme();
  const mdTheme = getMarkdownTheme();

  const client = opts.client ?? new BrainClient({ base: opts.base, token: opts.token });
  await client.start({ provider: opts.model, session: opts.session, fresh: opts.fresh });
  const boot = await client.status().catch(() => null);
  let modelName = boot?.model || opts.model || '';
  let lineCfg = boot?.statusline ?? null;
  let usage = boot?.usage ?? null;
  let thinkingLevel = boot?.thinkingLevel ?? '';
  let thinkingLevels = boot?.thinkingLevels ?? [];
  let sessionTitle = '';
  const history0 = await client.history().catch(() => []);
  let view = fromHistory(history0);
  /** Live display cards (ctx.emitCard) — a persistent panel above the status bar, tracked outside the
   *  ChatView like `usage`. Seeded from status (survives reconnect) and updated on each `card` event. */
  let cards: BrainCard[] = boot?.cards ?? [];
  /** The last /sessions listing, so /resume <n> can address by number. */
  let listed: { id: string; title: string }[] = [];
  /** Transient system lines (help, session list, errors) rendered under the conversation. */
  let notice = '';

  const refreshMeta = async (): Promise<void> => {
    const [st, sessions] = await Promise.all([
      client.status().catch(() => null),
      client.sessions().catch(() => []),
    ]);
    if (st) { modelName = st.model || modelName; lineCfg = st.statusline; usage = st.usage; thinkingLevel = st.thinkingLevel ?? ''; thinkingLevels = st.thinkingLevels ?? []; cards = st.cards ?? []; }
    sessionTitle = sessions.find((s) => s.active)?.title ?? '';
  };
  await refreshMeta();

  const term = new ProcessTerminal();
  const tui = new TUI(term);
  const editor = new ChatEditor(tui, { borderColor: color.faint, selectList: getSelectListTheme() }, {});
  /** Ask-user-question still borrows this slot for its multi-step flow. Other pickers use modals. */
  const editorSlot = new Container();
  editorSlot.addChild(editor);
  /** Persistent card panel (ctx.emitCard — the todo checklist is the canonical one), pinned above the
   *  status line — lives in the fixed tree, NOT the rebuilt messages container, so it stays put across turns. */
  const cardPanel = new CardPanel();
  const statusUnder = new Text('', 1, 0);
  const bottomBar = new StatusBar(color.faint('  ⏎ send   ·   /help commands   ·   ctrl+r reasoning'), color.faint('ctrl+c quit  '));

  const slashItems = commandsFor('cli', true).map((cmd) => ({
    value: `/${cmd.name}`,
    label: `/${cmd.name}`,
    description: cmd.description,
  }));
  // Slash commands use Orca's custom overlay. Keep PI completion for files and @attachments only.
  editor.setAutocompleteProvider(new CombinedAutocompleteProvider([], process.cwd()));

  let panelHandle: ReturnType<TUI['showOverlay']> | null = null;
  let slashHandle: ReturnType<TUI['showOverlay']> | null = null;
  let panelWidth = 38;
  let resizingPanel = false;
  let draggingHistoryScroll = false;
  const panelVisible = (): boolean => term.columns >= 104 && !panelHandle?.isHidden();
  const panelReserve = (): number => panelVisible() ? panelWidth + PANEL_GUTTER_COLUMNS : 0;
  const chatWidth = (): number => Math.max(24, term.columns - panelReserve());
  const panelLeftEdge = (): number => term.columns - panelWidth;
  const fixedRows = (): number => {
    const cardRows = cardPanel.render(Math.max(24, chatWidth())).length;
    const inputRows = editorSlot.render(Math.max(24, chatWidth())).length;
    return TOP_RULE_ROWS + cardRows + inputRows + 2;
  };

  const viewport = new ChatViewport(
    { view, notice, modelName, thinkingSeconds: 0 },
    mdTheme,
    () => Math.max(8, term.rows - fixedRows()),
    () => TOP_RULE_ROWS + 1,
    chatWidth,
  );
  const telemetry = new TelemetryPanel(() => ({
    modelName,
    sessionTitle,
    usage,
    thinkingLevel,
    thinkingLevels,
    running: view.thinking,
    cards,
    themeLabel: chatTheme().label,
  }));

  const showPanel = (hidden = false): void => {
    panelHandle?.hide();
    panelHandle = tui.showOverlay(telemetry, {
      anchor: 'top-right',
      width: panelWidth,
      maxHeight: Math.max(1, term.rows - TOP_RULE_ROWS),
      margin: { top: TOP_RULE_ROWS, right: 0, bottom: 0, left: 0 },
      visible: (width) => width >= 104,
      nonCapturing: true,
    });
    panelHandle.setHidden(hidden);
  };

  let thinkStart = 0;
  const render = (): void => {
    if (view.thinking) {
      if (!thinkStart) thinkStart = Date.now();
    } else {
      thinkStart = 0;
    }
    const thinkingSeconds = thinkStart ? Math.max(0, Math.round((Date.now() - thinkStart) / 1000)) : 0;
    viewport.setState({ view, notice, modelName, thinkingSeconds });
    // Contextual footer: while streaming, Esc interrupts.
    bottomBar.setLeft(view.thinking
      ? color.faint('  esc interrupt   ·   /help commands   ·   ctrl+r reasoning')
      : color.faint('  ⏎ send   ·   / slash   ·   ctrl+r reasoning   ·   ctrl+p telemetry'));
    // The line above the input shows the model; the statusline plugin adds context/tokens when enabled,
    // and the active reasoning effort rides on the end when the model has one set.
    const line = statusline(lineCfg, usage, modelName);
    const think = thinkingLevel ? `think:${thinkingLevel}` : '';
    const base = line || (modelName || '—');
    const full = think ? `${base}  ·  ${think}` : base;
    statusUnder.setText(line ? color.faint(`  ${full}`) : `  ${color.accentDim(modelName || '—')}${think ? color.faint(`  ·  ${think}`) : ''}`);
    cardPanel.set(cards);
    tui.requestRender();
  };

  // Drive the interactive picker flow for a parked ask_user_question, POST the answer (Esc aborts the
  // turn). Shared by the live `ask` event and the reconnect restore (boot.pendingAsk).
  const launchAsk = (id: string, questions: AskQuestion[]): void => {
    runAskFlow({
      tui, slot: editorSlot, editor, questions,
      onComplete: (answers) => { void client.answer(id, answers).catch(() => { /* turn may have gone */ }); },
      onCancel: () => { void client.abort().catch(() => { /* already settled */ }); },
    });
  };

  const openThinkingPicker = (): void => {
    if (thinkingLevels.length === 0) { notice = color.dim('this model has no reasoning-effort levels'); render(); return; }
    const apply = (level: string): void => {
      void client.setThinkingLevel(level).then((r) => {
        thinkingLevel = r.thinkingLevel;
        notice = color.dim(`reasoning effort: ${r.thinkingLevel}`);
        render();
      }).catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
    };
    openPicker({
      tui, slot: editorSlot, editor, title: 'Reasoning effort',
      items: thinkingLevels.map((lv) => ({ value: lv, label: lv, description: lv === thinkingLevel ? 'current' : undefined })),
      onPick: (value) => apply(value),
    });
  };

  const applyTheme = (name: string): boolean => {
    if (!isChatThemeName(name)) return false;
    const theme = setChatTheme(name);
    editor.borderColor = color.faint;
    notice = color.dim(`theme: ${theme.label}`);
    showPanel(panelHandle?.isHidden() ?? false);
    render();
    return true;
  };

  const openThemePicker = (): void => {
    openPicker({
      tui, slot: editorSlot, editor, title: 'Terminal theme',
      items: chatThemeItems(),
      onPick: (value) => { applyTheme(value); },
    });
  };

  const closeSlash = (): void => {
    slashHandle?.hide();
    slashHandle = null;
    tui.setFocus(editor);
    tui.requestRender();
  };

  const openSlash = (): void => {
    closeSlash();
    const reserve = panelReserve();
    const width = Math.max(50, term.columns - reserve - 1);
    const overlay = new SlashOverlay(tui, slashItems, (value) => {
      closeSlash();
      editor.setText('');
      editor.onSubmit?.(value);
    }, closeSlash);
    slashHandle = tui.showOverlay(overlay, {
      row: Math.max(TOP_RULE_ROWS, term.rows - fixedRows() - 14),
      col: 0,
      width,
      maxHeight: 14,
      margin: { top: TOP_RULE_ROWS, left: 0, right: reserve, bottom: fixedRows() },
    });
    slashHandle.focus();
    tui.requestRender();
  };

  let streamAc = new AbortController();
  const openStream = (): void => {
    void client.stream((e) => {
      // ask_user_question parked the turn: drive the picker flow and skip the ChatView reducer (the
      // questions aren't a conversation segment).
      if (e.type === 'ask') { launchAsk(e.id, e.questions); return; }
      if (e.type === 'idle' && e.usage) usage = e.usage;
      if (e.type === 'card') cards = upsertCard(cards, e.card); // update the persistent panel (not part of the ChatView)
      view = reduce(view, e);
      render();
    }, streamAc.signal).catch(() => { /* aborted/gone */ });
  };

  /** Switch conversations: retarget the server session, then swap history + the event stream. */
  const switchTo = async (target: { session?: string; fresh?: boolean }): Promise<void> => {
    streamAc.abort();
    streamAc = new AbortController();
    await client.start(target);
    const hist = await client.history().catch(() => []);
    view = fromHistory(hist);
    await refreshMeta(); // also refreshes the card panel from the new conversation's status
    openStream();
    render();
  };

  editor.onSubmit = (text: string): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    editor.setText('');
    notice = '';
    const command = parseCommand(trimmed);
    if (command) {
      switch (command.cmd) {
        case 'quit': quit(); return;
        case 'help': notice = color.dim(HELP).split('\n').join('\n'); render(); return;
        case 'new':
          void switchTo({ fresh: true }).catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
          return;
        case 'sessions':
        case 'resume': {
          if (!command.arg) {
            // Both open the arrow-key picker over the stored conversations (select = resume).
            void client.sessions().then((list) => {
              listed = list.map((s) => ({ id: s.id, title: s.title }));
              if (list.length === 0) { notice = color.dim('no conversations'); render(); return; }
              openPicker({
                tui, slot: editorSlot, editor, title: 'Resume conversation', items: sessionItems(list),
                onPick: (id) => void switchTo({ session: id }).catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); }),
              });
            }).catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
            return;
          }
          const n = Number(command.arg);
          const target = Number.isInteger(n) && n >= 1 ? listed[n - 1]?.id : command.arg;
          if (!target) { notice = color.dim('use /resume and pick with the arrows'); render(); return; }
          void switchTo({ session: target }).catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
          return;
        }
        case 'model': {
          void client.models().then((models) => {
            if (models.length === 0) { notice = color.dim('no models configured'); render(); return; }
            openPicker({
              tui, slot: editorSlot, editor, title: 'Switch model', items: modelItems(models, modelName),
              onPick: (value) => {
                notice = color.dim('switching model…');
                render();
                void client.setModel(parseModelValue(value)).then(async (r) => {
                  modelName = r.model;
                  // The server rebuilt the session — the old event stream is dead, reopen it.
                  streamAc.abort();
                  streamAc = new AbortController();
                  openStream();
                  await refreshMeta();
                  notice = color.dim(`switched to ${r.model}`);
                  render();
                }).catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
              },
            });
          }).catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
          return;
        }
        case 'think': {
          if (thinkingLevels.length === 0) { notice = color.dim('this model has no reasoning-effort levels'); render(); return; }
          const apply = (level: string): void => {
            void client.setThinkingLevel(level).then((r) => {
              thinkingLevel = r.thinkingLevel;
              notice = color.dim(`reasoning effort: ${r.thinkingLevel}`);
              render();
            }).catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
          };
          // A bare "/think high" applies directly; "/think" opens the picker over the model's levels.
          if (command.arg && thinkingLevels.includes(command.arg.trim())) { apply(command.arg.trim()); return; }
          openThinkingPicker();
          return;
        }
        case 'theme': {
          const wanted = command.arg?.trim();
          if (wanted) {
            if (!applyTheme(wanted)) { notice = color.error(`unknown theme: ${wanted}`); render(); }
            return;
          }
          openThemePicker();
          return;
        }
        case 'delete': {
          const doDelete = (target: string): void => {
            void client.deleteSession(target)
              .then(() => { listed = listed.filter((s) => s.id !== target); notice = color.dim('conversation deleted'); render(); })
              .catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
          };
          // Deleting is destructive → always a two-step picker: choose the conversation, then confirm.
          const confirmDelete = (id: string, title: string): void => {
            openPicker({
              tui, slot: editorSlot, editor, title: `Delete "${title || '(untitled)'}"?`,
              items: [
                { value: 'no', label: 'Cancel', description: 'keep the conversation' },
                { value: 'yes', label: 'Delete', description: 'cannot be undone' },
              ],
              onPick: (v) => { if (v === 'yes') doDelete(id); },
            });
          };
          if (!command.arg) {
            void client.sessions().then((list) => {
              listed = list.map((s) => ({ id: s.id, title: s.title }));
              if (list.length === 0) { notice = color.dim('no conversations'); render(); return; }
              openPicker({
                tui, slot: editorSlot, editor, title: 'Delete conversation', items: sessionItems(list),
                onPick: (id) => confirmDelete(id, list.find((s) => s.id === id)?.title ?? ''),
              });
            }).catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
            return;
          }
          const n = Number(command.arg);
          const target = Number.isInteger(n) && n >= 1 ? listed[n - 1]?.id : command.arg;
          if (!target) { notice = color.dim('use /delete and pick with the arrows'); render(); return; }
          confirmDelete(target, listed.find((s) => s.id === target)?.title ?? '');
          return;
        }
        case 'compact': {
          notice = color.dim('compacting…');
          render();
          void client.compact()
            .then(async (r) => { if (r.usage) usage = r.usage; await refreshMeta(); notice = color.dim(r.compacted ? 'conversation compacted' : (r.message ?? 'nothing to compact yet')); render(); })
            .catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
          return;
        }
        case 'stop': {
          if (!view.thinking) { notice = color.dim('nothing is running'); render(); return; }
          notice = color.dim('stopping…');
          render();
          void client.abort()
            .then(() => { notice = color.dim('agent stopped'); render(); })
            .catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
          return;
        }
        case 'status': {
          void client.status().then((s) => {
            const parts: string[] = [];
            if (s?.model) parts.push(`model: ${s.model}`);
            const u = s?.usage;
            if (u) {
              if (u.percent != null) parts.push(`context ${Math.round(u.percent)}% (${fmtK(u.tokens ?? 0)}/${fmtK(u.contextWindow)})`);
              parts.push(`Σ ${fmtK(u.totalTokens)} tok`);
              parts.push(`$${u.cost.toFixed(2)}`);
            }
            if (s?.thinkingLevel) parts.push(`reasoning: ${s.thinkingLevel}`);
            notice = color.dim(parts.length ? parts.join('  ·  ') : 'no active session');
            render();
          }).catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
          return;
        }
        case 'restart': {
          notice = color.dim('restarting daemon…');
          render();
          void client.command('restart')
            .then((r) => { notice = color.dim(r?.message ?? 'restarting…'); render(); })
            .catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
          return;
        }
      }
    }
    view = beginAssistant(pushUser(view, trimmed));
    render();
    void client.send(trimmed).catch((e: Error) => { view = reduce(view, { type: 'error', message: e.message }); render(); });
  };

  // Esc while a turn streams aborts it server-side (agent_end → idle winds the spinner down).
  editor.onEscape = (): void => {
    if (view.thinking) void client.abort().catch(() => { /* already idle */ });
  };

  const root = new Container();
  root.addChild(new TopRule());
  root.addChild(new MainColumn(panelReserve, [
    viewport,
    editorSlot,
    cardPanel,
    statusUnder,
    bottomBar,
  ]));
  tui.addChild(root);
  tui.setFocus(editor);
  showPanel(false);

  let done!: () => void;
  const finished = new Promise<void>((r) => { done = r; });
  const quit = (): void => {
    streamAc.abort();
    term.write(DISABLE_MOUSE);
    panelHandle?.hide();
    slashHandle?.hide();
    tui.stop();
    done();
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
        viewport.setScrollFromRow(ev.y);
        tui.requestRender();
        return { consume: true };
      }
      if (isPrimaryDrag && viewport.isScrollbarHit(ev.x, ev.y)) {
        draggingHistoryScroll = true;
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
          panelWidth = Math.max(30, Math.min(52, term.columns - ev.x + 1));
          showPanel(false);
          if (slashHandle) openSlash();
          tui.requestRender(true);
          return { consume: true };
        }
        if (ev.down && ev.code === 0 && Math.abs(ev.x - edge) <= 1) {
          resizingPanel = true;
          return { consume: true };
        }
      }
    }
    const click = mouseClick(data);
    if (click && viewport.isThoughtRow(click.y)) {
      viewport.toggleThought();
      tui.requestRender();
      return { consume: true };
    }
    const wheel = mouseWheel(data);
    if (wheel) {
      viewport.scroll(wheel);
      tui.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, 'ctrl+c')) { quit(); return { consume: true }; }
    if (matchesKey(data, 'ctrl+p')) {
      const hidden = !panelHandle?.isHidden();
      panelHandle?.setHidden(hidden);
      resizingPanel = false;
      tui.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, 'ctrl+r')) {
      openThinkingPicker();
      return { consume: true };
    }
    if (!slashHandle && editor.getText() === '' && data === '/') {
      openSlash();
      return { consume: true };
    }
    if (!slashHandle && (data === 'k' || data === '\x1b[5~')) {
      viewport.scroll(4);
      tui.requestRender();
      return { consume: true };
    }
    if (!slashHandle && (data === 'j' || data === '\x1b[6~')) {
      viewport.scroll(-4);
      tui.requestRender();
      return { consume: true };
    }
    return undefined;
  });

  tui.start();
  term.write(ENABLE_MOUSE);
  render();
  openStream();
  // Reconnect restore: if a question was already parked when this client attached (daemon restart, second
  // client), re-render its picker instead of leaving the turn silently hanging until the timeout.
  if (boot?.pendingAsk) launchAsk(boot.pendingAsk.id, boot.pendingAsk.questions);

  await finished;
}
