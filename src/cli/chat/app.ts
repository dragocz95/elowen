import { TUI, ProcessTerminal, Text, Markdown, Loader, Container, Spacer, matchesKey, CombinedAutocompleteProvider } from '@earendil-works/pi-tui';
import type { SlashCommand } from '@earendil-works/pi-tui';
import { initTheme, getMarkdownTheme, getSelectListTheme } from '@earendil-works/pi-coding-agent';
import { color, glyph } from './theme.js';
import { UserBlock, StatusBar, TitleBar, banner, toolChip, diffBlock, metaLine, titleBarContent } from './components.js';
import { ChatEditor, sessionItems, modelItems, parseModelValue, openPicker } from './picker.js';
import { BrainClient } from './brainClient.js';
import { fromHistory, pushUser, beginAssistant, reduce, type ChatView } from './render.js';

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
export function parseCommand(text: string): { cmd: 'quit' | 'new' | 'sessions' | 'resume' | 'delete' | 'model' | 'compact' | 'help'; arg?: string } | null {
  const m = /^\/(\w+)(?:\s+(.+))?$/.exec(text.trim());
  if (!m) return null;
  switch (m[1]) {
    case 'quit': case 'exit': return { cmd: 'quit' };
    case 'new': return { cmd: 'new' };
    case 'sessions': return { cmd: 'sessions' };
    case 'resume': return { cmd: 'resume', arg: m[2] };
    case 'delete': return { cmd: 'delete', arg: m[2] };
    case 'model': return { cmd: 'model' };
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

const HELP = [
  '/new — new conversation',
  '/sessions — list conversations',
  '/resume [n] — resume a conversation (no argument opens the picker)',
  '/delete <n> — delete a conversation',
  '/model — switch the model (picker)',
  '/compact — summarize the conversation to free context',
  '/quit — exit',
].join('\n');

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
  let sessionTitle = '';
  let view = fromHistory(await client.history().catch(() => []));
  /** The last /sessions listing, so /resume <n> can address by number. */
  let listed: { id: string; title: string }[] = [];
  /** Transient system lines (help, session list, errors) rendered under the conversation. */
  let notice = '';

  const refreshMeta = async (): Promise<void> => {
    const [st, sessions] = await Promise.all([
      client.status().catch(() => null),
      client.sessions().catch(() => []),
    ]);
    if (st) { modelName = st.model || modelName; lineCfg = st.statusline; usage = st.usage; }
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
  const statusUnder = new Text('', 1, 0);
  const bottomBar = new StatusBar(color.faint('  ⏎ send   ·   /help commands'), color.faint('ctrl+c quit  '));

  // Slash-command autocomplete: typing `/` pops the command menu; /resume and /delete complete their
  // conversation number from the live session list.
  const numberCompletions = async (): Promise<{ value: string; label: string; description?: string }[]> => {
    const list = await client.sessions().catch(() => []);
    listed = list.map((s) => ({ id: s.id, title: s.title }));
    return list.map((s, i) => ({ value: String(i + 1), label: `${i + 1}`, description: s.title || '(untitled)' }));
  };
  const SLASH_COMMANDS: SlashCommand[] = [
    { name: 'new', description: 'new conversation' },
    { name: 'sessions', description: 'list conversations' },
    { name: 'resume', description: 'resume a conversation', argumentHint: '[n]', getArgumentCompletions: numberCompletions },
    { name: 'delete', description: 'delete a conversation', argumentHint: '<n>', getArgumentCompletions: numberCompletions },
    { name: 'model', description: 'switch the model' },
    { name: 'compact', description: 'summarize the conversation to free context' },
    { name: 'help', description: 'show commands' },
    { name: 'quit', description: 'exit' },
  ];
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
              messages.addChild(new Text(toolChip(item.name, item.detail), 1, 0));
              if (item.diff) for (const line of diffBlock(item.diff)) messages.addChild(new Text(line, 1, 0));
            }
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
    // The line above the input shows the model; the statusline plugin adds context/tokens when enabled.
    const line = statusline(lineCfg, usage, modelName);
    statusUnder.setText(line ? color.faint(`  ${line}`) : `  ${color.accentDim(modelName || '—')}`);
    tui.requestRender();
  };

  let streamAc = new AbortController();
  const openStream = (): void => {
    void client.stream((e) => {
      if (e.type === 'idle' && e.usage) usage = e.usage;
      view = reduce(view, e);
      render();
    }, streamAc.signal).catch(() => { /* aborted/gone */ });
  };

  /** Switch conversations: retarget the server session, then swap history + the event stream. */
  const switchTo = async (target: { session?: string; fresh?: boolean }): Promise<void> => {
    streamAc.abort();
    streamAc = new AbortController();
    await client.start(target);
    view = fromHistory(await client.history().catch(() => []));
    await refreshMeta();
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
          void client.sessions().then((list) => {
            listed = list.map((s) => ({ id: s.id, title: s.title }));
            notice = list.length === 0
              ? color.dim('no conversations')
              : list.map((s, i) => `${s.active ? color.accent('▸') : ' '} ${i + 1}. ${s.title || color.dim('(untitled)')}  ${color.dim(s.model)}`).join('\n')
                + '\n' + color.dim('/resume <n> to switch');
            render();
          }).catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
          return;
        case 'resume': {
          if (!command.arg) {
            // No argument → arrow-key picker over the stored conversations.
            void client.sessions().then((list) => {
              listed = list.map((s) => ({ id: s.id, title: s.title }));
              openPicker({
                tui, slot: editorSlot, editor, title: 'Resume conversation', items: sessionItems(list),
                onPick: (id) => void switchTo({ session: id }).catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); }),
              });
            }).catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
            return;
          }
          const n = Number(command.arg);
          const target = Number.isInteger(n) && n >= 1 ? listed[n - 1]?.id : command.arg;
          if (!target) { notice = color.dim('use /sessions then /resume <n>'); render(); return; }
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
        case 'delete': {
          const n = Number(command.arg);
          const target = Number.isInteger(n) && n >= 1 ? listed[n - 1]?.id : command.arg;
          if (!target) { notice = color.dim('use /sessions then /delete <n>'); render(); return; }
          void client.deleteSession(target)
            .then(() => { listed = listed.filter((s) => s.id !== target); notice = color.dim('conversation deleted'); render(); })
            .catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
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

  await finished;
}
