import { TUI, ProcessTerminal, Text, Markdown, Loader, Container, Spacer, matchesKey } from '@earendil-works/pi-tui';
import { Editor } from '@earendil-works/pi-tui';
import { initTheme, getMarkdownTheme, getSelectListTheme } from '@earendil-works/pi-coding-agent';
import { color, glyph } from './theme.js';
import { UserBlock, StatusBar, banner, toolChip } from './components.js';
import { BrainClient } from './brainClient.js';
import { fromHistory, pushUser, beginAssistant, reduce, type ChatView } from './render.js';

/** Plain-text rendering of the view — used for the non-TTY fallback and unit tests (no ANSI, so it's
 *  deterministic to assert on). The rich terminal path uses pi-tui components instead. */
export function viewToPlainText(view: ChatView): string[] {
  const lines: string[] = [];
  for (const turn of view.turns) {
    lines.push(turn.role === 'you' ? 'ty' : `${glyph.whale} orca`);
    for (const t of turn.tools) lines.push(`  ${glyph.tool} ${t}`);
    if (turn.text) lines.push(...turn.text.split('\n').map((l) => `  ${l}`));
    lines.push('');
  }
  return lines;
}

/** Local slash-command routing: returns the recognized command (with its argument) or null for a
 *  regular chat message. Pure, so the command surface is unit-testable without a TTY. */
export function parseCommand(text: string): { cmd: 'quit' | 'new' | 'sessions' | 'resume' | 'delete' | 'help'; arg?: string } | null {
  const m = /^\/(\w+)(?:\s+(.+))?$/.exec(text.trim());
  if (!m) return null;
  switch (m[1]) {
    case 'quit': case 'exit': return { cmd: 'quit' };
    case 'new': return { cmd: 'new' };
    case 'sessions': return { cmd: 'sessions' };
    case 'resume': return { cmd: 'resume', arg: m[2] };
    case 'delete': return { cmd: 'delete', arg: m[2] };
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
    parts.push(`kontext ${Math.round(usage.percent)}% (${fmtK(usage.tokens ?? 0)}/${fmtK(usage.contextWindow)})`);
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
  '/new — nová konverzace',
  '/sessions — seznam konverzací',
  '/resume <č.> — pokračovat v konverzaci',
  '/delete <č.> — smazat konverzaci',
  '/quit — konec',
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
  const messages = new Container();
  const spacer = new Spacer();
  const loader = new Loader(tui, color.accent, color.dim, 'přemýšlím…');
  const editor = new Editor(tui, { borderColor: color.accent, selectList: getSelectListTheme() }, {});
  const statusUnder = new Text('', 1, 0);
  const bottomBar = new StatusBar(color.faint('  ⏎ odeslat   ·   /help příkazy'), color.faint('ctrl+c konec  '));

  const render = (): void => {
    for (const c of [...messages.children]) messages.removeChild(c);
    if (view.turns.length === 0) {
      for (const line of banner(modelName)) messages.addChild(new Text(line, 1, 0));
    }
    for (const turn of view.turns) {
      if (turn.role === 'you') {
        messages.addChild(new UserBlock(turn.text));
        messages.addChild(new Text('', 0, 0));
      } else {
        // No speaker label — just the tool chips (if any) then the markdown reply.
        for (const t of turn.tools) messages.addChild(new Text(toolChip(t), 1, 0));
        if (turn.text) messages.addChild(new Markdown(turn.text, 2, 0, mdTheme));
        else if (turn.streaming) messages.addChild(new Text(color.faint('  …'), 1, 0));
        messages.addChild(new Text('', 0, 0));
      }
    }
    if (notice) for (const line of notice.split('\n')) messages.addChild(new Text(`  ${line}`, 1, 0));
    // Spinner lives INSIDE the rebuilt message list, so it vanishes the moment the turn goes idle.
    if (view.thinking) { messages.addChild(loader); loader.start(); } else { loader.stop(); }
    const title = sessionTitle ? `${color.faint('  ·  ')}${color.dim(sessionTitle.slice(0, 40))}` : '';
    statusUnder.setText(`  ${color.accent(`${glyph.whale} Orca AI`)}${color.faint('  ·  ')}${color.accentDim(modelName || '—')}${title}`);
    const line = statusline(lineCfg, usage, modelName);
    bottomBar.setLeft(line ? color.faint(`  ${line}`) : color.faint('  ⏎ odeslat   ·   /help příkazy'));
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
          void switchTo({ fresh: true }).catch((e: Error) => { notice = color.error(`chyba: ${e.message}`); render(); });
          return;
        case 'sessions':
          void client.sessions().then((list) => {
            listed = list.map((s) => ({ id: s.id, title: s.title }));
            notice = list.length === 0
              ? color.dim('žádné konverzace')
              : list.map((s, i) => `${s.active ? color.accent('▸') : ' '} ${i + 1}. ${s.title || color.dim('(bez názvu)')}  ${color.dim(s.model)}`).join('\n')
                + '\n' + color.dim('/resume <č.> pro přepnutí');
            render();
          }).catch((e: Error) => { notice = color.error(`chyba: ${e.message}`); render(); });
          return;
        case 'resume': {
          const n = Number(command.arg);
          const target = Number.isInteger(n) && n >= 1 ? listed[n - 1]?.id : command.arg;
          if (!target) { notice = color.dim('použij /sessions a pak /resume <č.>'); render(); return; }
          void switchTo({ session: target }).catch((e: Error) => { notice = color.error(`chyba: ${e.message}`); render(); });
          return;
        }
        case 'delete': {
          const n = Number(command.arg);
          const target = Number.isInteger(n) && n >= 1 ? listed[n - 1]?.id : command.arg;
          if (!target) { notice = color.dim('použij /sessions a pak /delete <č.>'); render(); return; }
          void client.deleteSession(target)
            .then(() => { listed = listed.filter((s) => s.id !== target); notice = color.dim('konverzace smazána'); render(); })
            .catch((e: Error) => { notice = color.error(`chyba: ${e.message}`); render(); });
          return;
        }
      }
    }
    view = beginAssistant(pushUser(view, trimmed));
    render();
    void client.send(trimmed).catch((e: Error) => { view = reduce(view, { type: 'error', message: e.message }); render(); });
  };

  tui.addChild(messages);
  tui.addChild(spacer); // push the input to the bottom of the screen (opencode-style anchoring)
  tui.addChild(editor);
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
