import { TUI, ProcessTerminal, Text, Markdown, Loader, Container, Spacer, matchesKey } from '@earendil-works/pi-tui';
import { Editor } from '@earendil-works/pi-tui';
import { initTheme, getMarkdownTheme, getSelectListTheme } from '@earendil-works/pi-coding-agent';
import { color, glyph } from './theme.js';
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

export interface RunChatOpts {
  base: string;
  token: string;
  model?: string;
  /** Injected for tests; defaults to a real BrainClient. */
  client?: BrainClient;
}

/** Launch the interactive Orca chat TUI. Thin client: renders the brain's stream, posts user input.
 *  Styled to match the pi/opencode family (pi's own markdown renderer + a teal Orca accent). */
export async function runChat(opts: RunChatOpts): Promise<void> {
  if (!process.stdout.isTTY) {
    process.stderr.write('orca chat needs an interactive terminal (a TTY).\n');
    return;
  }
  // pi's theme powers the markdown renderer (syntax highlighting, headings, code blocks) and the
  // editor's autocomplete list — the look the pi/opencode CLIs ship with.
  initTheme();
  const mdTheme = getMarkdownTheme();

  const client = opts.client ?? new BrainClient({ base: opts.base, token: opts.token });
  await client.start(opts.model === 'anthropic' || opts.model === 'openai' ? opts.model : undefined);
  let view = fromHistory(await client.history().catch(() => []));

  const term = new ProcessTerminal();
  const tui = new TUI(term);
  const modelLabel = opts.model ? `  ${color.dim('·')}  ${color.dim(opts.model)}` : '';
  const header = new Text(` ${color.accent(`${glyph.whale} orca`)}${modelLabel}`, 1, 1);
  const messages = new Container();
  const spacer = new Spacer();
  const loader = new Loader(tui, color.accent, color.dim, 'přemýšlím…');
  const editor = new Editor(tui, { borderColor: color.accent, selectList: getSelectListTheme() }, {});
  const footer = new Text(color.dim(`  enter ⏎ odeslat   ·   /quit konec`), 1, 0);

  const render = (): void => {
    for (const c of [...messages.children]) messages.removeChild(c);
    for (const turn of view.turns) {
      if (turn.role === 'you') {
        messages.addChild(new Text(`${color.accent('▌')} ${color.bold('ty')}`, 1, 0));
        if (turn.text) messages.addChild(new Text(color.dim(turn.text), 3, 0));
      } else {
        messages.addChild(new Text(`${color.accent(glyph.whale)} ${color.accent('orca')}`, 1, 0));
        for (const t of turn.tools) messages.addChild(new Text(color.dim(`  ${glyph.tool} ${t}`), 2, 0));
        if (turn.text) messages.addChild(new Markdown(turn.text, 2, 0, mdTheme));
        else if (turn.streaming) messages.addChild(new Text(color.dim('  …'), 2, 0));
      }
      messages.addChild(new Text('', 0, 0));
    }
    // Spinner lives INSIDE the rebuilt message list, so it vanishes the moment the turn goes idle.
    if (view.thinking) { messages.addChild(loader); loader.start(); } else { loader.stop(); }
    tui.requestRender();
  };

  editor.onSubmit = (text: string): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    editor.setText('');
    if (trimmed === '/quit' || trimmed === '/exit') { quit(); return; }
    view = beginAssistant(pushUser(view, trimmed));
    render();
    void client.send(trimmed).catch((e: Error) => { view = reduce(view, { type: 'error', message: e.message }); render(); });
  };

  tui.addChild(header);
  tui.addChild(messages);
  tui.addChild(spacer); // pushes the input to the bottom of the screen (opencode-style anchoring)
  tui.addChild(editor);
  tui.addChild(footer);
  tui.setFocus(editor);

  const ac = new AbortController();
  let done: () => void;
  const finished = new Promise<void>((r) => { done = r; });
  const quit = (): void => { ac.abort(); tui.stop(); done(); };

  // Global ctrl+c → quit (in raw mode SIGINT arrives as a key, not a signal).
  tui.addInputListener((data) => (matchesKey(data, 'ctrl+c') ? (quit(), { consume: true }) : undefined));

  tui.start();
  render();

  void client.stream((e) => { view = reduce(view, e); render(); }, ac.signal).catch(() => { /* aborted/gone */ });

  await finished;
}
