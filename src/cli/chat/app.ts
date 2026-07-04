import { TUI, ProcessTerminal, Text, Markdown, Loader, Container, Spacer, matchesKey, CombinedAutocompleteProvider } from '@earendil-works/pi-tui';
import type { SlashCommand } from '@earendil-works/pi-tui';
import { initTheme, getMarkdownTheme, getSelectListTheme } from '@earendil-works/pi-coding-agent';
import { color, glyph } from './theme.js';
import { UserBlock, StatusBar, TitleBar, CardPanel, banner, toolChip, diffBlock, metaLine, titleBarContent } from './components.js';
import { ChatEditor, sessionItems, modelItems, parseModelValue, openPicker } from './picker.js';
import { runAskFlow } from './askFlow.js';
import { BrainClient } from './brainClient.js';
import { fromHistory, pushUser, beginAssistant, reduce, upsertCard, type ChatView } from '../../brain/transcript.js';
import { commandsFor } from '../../brain/slashCommands.js';
import type { AskQuestion, BrainCard } from '../../brain/events.js';

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
export function parseCommand(text: string): { cmd: 'quit' | 'new' | 'stop' | 'status' | 'restart' | 'sessions' | 'resume' | 'delete' | 'model' | 'think' | 'compact' | 'help'; arg?: string } | null {
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
  const titleBar = new TitleBar();
  const messages = new Container();
  const spacer = new Spacer();
  const loader = new Loader(tui, color.accent, color.dim, 'thinking…');
  const editor = new ChatEditor(tui, { borderColor: color.faint, selectList: getSelectListTheme() }, {});
  /** The picker temporarily replaces the editor in this slot (the pi modal pattern). */
  const editorSlot = new Container();
  editorSlot.addChild(editor);
  /** Persistent card panel (ctx.emitCard — the todo checklist is the canonical one), pinned above the
   *  status line — lives in the fixed tree, NOT the rebuilt messages container, so it stays put across turns. */
  const cardPanel = new CardPanel();
  const statusUnder = new Text('', 1, 0);
  const bottomBar = new StatusBar(color.faint('  ⏎ send   ·   /help commands'), color.faint('ctrl+c quit  '));

  // Slash-command autocomplete: typing `/` pops the command menu; /resume and /delete complete their
  // conversation number from the live session list.
  const numberCompletions = async (): Promise<{ value: string; label: string; description?: string }[]> => {
    const list = await client.sessions().catch(() => []);
    listed = list.map((s) => ({ id: s.id, title: s.title }));
    return list.map((s, i) => ({ value: String(i + 1), label: `${i + 1}`, description: s.title || '(untitled)' }));
  };
  // The command palette is derived from the SHARED registry (src/brain/slashCommands.ts) — the same
  // source Discord and the web dock publish from — so a new command shows up everywhere at once. The CLI
  // runs as the operator, so admin-only commands (restart) are included. Only the conversation-number
  // pickers get their live argument completions grafted on.
  const SLASH_COMMANDS: SlashCommand[] = commandsFor('cli', true).map((cmd) =>
    cmd.name === 'resume' || cmd.name === 'delete'
      ? { name: cmd.name, description: cmd.description, argumentHint: '[n]', getArgumentCompletions: numberCompletions }
      : { name: cmd.name, description: cmd.description },
  );
  editor.setAutocompleteProvider(new CombinedAutocompleteProvider(SLASH_COMMANDS, process.cwd()));

  let thinkStart = 0;
  const render = (): void => {
    for (const c of [...messages.children]) messages.removeChild(c);
    if (view.turns.length === 0) {
      for (const line of banner(modelName)) messages.addChild(new Text(line, 1, 0));
    }
    for (const [i, turn] of view.turns.entries()) {
      if (turn.role === 'you') {
        messages.addChild(new UserBlock(turn.text));
        messages.addChild(new Text('', 0, 0));
      } else {
        // No speaker label — render segments in order: grouped tool lines (with edit diffs), markdown text.
        let hasText = false;
        for (const seg of turn.segments) {
          if (seg.kind === 'tools') {
            for (const item of seg.items) {
              messages.addChild(new Text(toolChip(item.name, item.detail, item.icon), 1, 0));
              if (item.diff) for (const line of diffBlock(item.diff)) messages.addChild(new Text(line, 1, 0));
            }
          } else if (seg.kind === 'reasoning') {
            // Reasoning stream: dim, prefixed, visually distinct from the answer. Only shown while it
            // is the freshest content of a still-streaming turn (a settled turn keeps the answer clean).
            const showReasoning = turn.streaming && seg === turn.segments[turn.segments.length - 1];
            if (showReasoning) for (const l of seg.text.split('\n')) messages.addChild(new Text(color.faint(`  ${glyph.think} ${l}`), 1, 0));
          } else { hasText = true; messages.addChild(new Markdown(seg.text, 2, 0, mdTheme)); }
        }
        if (!hasText && turn.streaming) messages.addChild(new Text(color.faint('  …'), 1, 0));
        // One footer per reply: a stored turn can span several assistant rows — only the last gets it.
        const nextIsOrca = view.turns[i + 1]?.role === 'orca';
        if (hasText && !turn.streaming && !nextIsOrca) messages.addChild(new Text(metaLine(modelName), 1, 0));
        messages.addChild(new Text('', 0, 0));
      }
    }
    if (notice) for (const line of notice.split('\n')) messages.addChild(new Text(`  ${line}`, 1, 0));
    // Transient runtime line (rate-limit retry, context compaction) so a stalled turn explains itself.
    if (view.notice) messages.addChild(new Text(color.faint(`  ${glyph.dot} ${view.notice}`), 1, 0));
    // Spinner lives INSIDE the rebuilt message list, so it vanishes the moment the turn goes idle.
    if (view.thinking) {
      if (!thinkStart) thinkStart = Date.now();
      loader.setMessage(`thinking… ${Math.max(0, Math.round((Date.now() - thinkStart) / 1000))}s`);
      messages.addChild(loader);
      loader.start();
    } else {
      thinkStart = 0;
      loader.stop();
    }
    // Contextual footer: while streaming, Esc interrupts.
    bottomBar.setLeft(view.thinking
      ? color.faint('  esc interrupt   ·   /help commands')
      : color.faint('  ⏎ send   ·   /help commands'));
    // Top bar: conversation title on the left, usage stats (tokens · ctx% · cost) on the right.
    const bar = titleBarContent(sessionTitle, usage);
    titleBar.set(bar.left, bar.right);
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
          openPicker({
            tui, slot: editorSlot, editor, title: 'Reasoning effort',
            items: thinkingLevels.map((lv) => ({ value: lv, label: lv, description: lv === thinkingLevel ? 'current' : undefined })),
            onPick: (value) => apply(value),
          });
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
            .then(async (u) => { if (u) usage = u; await refreshMeta(); notice = color.dim('conversation compacted'); render(); })
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

  tui.addChild(titleBar);   // top: conversation title + usage stats
  tui.addChild(messages);
  tui.addChild(spacer); // push the input to the bottom of the screen (opencode-style anchoring)
  tui.addChild(editorSlot);
  tui.addChild(cardPanel);  // persistent card panel (todo checklist etc.), pinned above the status line
  tui.addChild(statusUnder);
  tui.addChild(bottomBar);
  tui.setFocus(editor);

  let done: () => void;
  const finished = new Promise<void>((r) => { done = r; });
  const quit = (): void => { streamAc.abort(); tui.stop(); done(); };

  tui.addInputListener((data) => (matchesKey(data, 'ctrl+c') ? (quit(), { consume: true }) : undefined));

  tui.start();
  render();
  openStream();
  // Reconnect restore: if a question was already parked when this client attached (daemon restart, second
  // client), re-render its picker instead of leaving the turn silently hanging until the timeout.
  if (boot?.pendingAsk) launchAsk(boot.pendingAsk.id, boot.pendingAsk.questions);

  await finished;
}
