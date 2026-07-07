import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { TUI, ProcessTerminal, Container } from '@earendil-works/pi-tui';
import { initTheme, getMarkdownTheme, getSelectListTheme } from '@earendil-works/pi-coding-agent';
import { color, glyph, isChatThemeName, setChatTheme, setCustomChatTheme } from './theme.js';
import { loadPrefs } from './prefs.js';
import { loadPromptHistory, PromptStash } from './promptHistory.js';
import { LocalShellBuffer } from './localShell.js';
import { AttachmentChips } from './components.js';
import { FileIndex, loadMentionFrecency } from './mentions.js';
import { ChatEditor } from './picker.js';
import { BrainClient } from './brainClient.js';
import { createFlows } from './flows.js';
import { createStreamController } from './streamController.js';
import { createShell } from './shell.js';
import { createPickers } from './pickers.js';
import { wireSubmit } from './commands.js';
import type { ChatRuntime } from './runtime.js';
import { fromHistory, type ChatView } from '../../brain/transcript.js';
import { commandsFor } from '../../brain/slashCommands.js';
import { DISABLE_MOUSE, ENABLE_MOUSE } from './layout.js';

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

/** Launch the interactive Orca chat TUI — an opencode-style layout (user blocks with a teal rail,
 *  markdown replies with a metadata line, a bottom status bar) rendered on pi-tui + pi's markdown theme.
 *  Conversations are server-side: /new opens one, /sessions + /resume switch between them.
 *
 *  This is the entry that owns the shared ChatRuntime and wires the focused modules together:
 *  flows (ask/approval/plan modals), streamController (event stream + sub-agent taps), shell
 *  (layout/render/input), pickers (modal surface) and commands (the submit dispatcher). */
export async function runChat(opts: RunChatOpts): Promise<void> {
  if (!process.stdout.isTTY) {
    process.stderr.write('orca chat needs an interactive terminal (a TTY).\n');
    return;
  }
  initTheme();
  // Restore the last-used chat theme before any component reads chatTheme() — otherwise every launch
  // silently reverted to the default.
  const prefs0 = loadPrefs();
  if (prefs0.theme && isChatThemeName(prefs0.theme)) setChatTheme(prefs0.theme);
  // Thought-row visibility — the per-USER server setting wins (Account → Terminal / `/reasoning show`
  // on any device); the local pref is the offline fallback until termSettings load below.
  let showThoughts = prefs0.showThoughts !== false;
  const mdTheme = getMarkdownTheme();

  const client = opts.client ?? new BrainClient({ base: opts.base, token: opts.token });
  await client.start({ provider: opts.model, session: opts.session, fresh: opts.fresh });
  const boot = await client.status().catch(() => null);
  // Cross-device colors: a CUSTOM web Account → Terminal palette drives the CLI chat theme — but only
  // when THIS machine has no explicit /theme pick saved. A local pick must win, otherwise the web
  // setting silently clobbered it on every launch ("/theme doesn't stick"). Picking "Custom (web)"
  // in /theme stores theme:'custom', which is not a preset name, so the palette applies again here.
  const termSettings = await client.terminalSettings().catch(() => null);
  const localPick = !!(prefs0.theme && isChatThemeName(prefs0.theme));
  if (!localPick && termSettings?.theme === 'custom' && termSettings.palette) setCustomChatTheme(termSettings.palette);
  if (typeof termSettings?.showThoughtsCli === 'boolean') showThoughts = termSettings.showThoughtsCli;
  const history0 = await client.history().catch(() => []);
  let commandDefs = await client.commands().catch(() => commandsFor('cli', true));
  if (commandDefs.length === 0) commandDefs = commandsFor('cli', true);

  const term = new ProcessTerminal();
  const tui = new TUI(term);
  const cwdLabel = prettyCwd();
  const branchLabel = gitBranch();
  const editor = new ChatEditor(tui, { borderColor: color.faint, selectList: getSelectListTheme() }, {});
  // ↑-recall persists per project: seed the editor's history navigation (oldest → newest) from disk;
  // onSubmit appends both in-session and to the file. The walk itself (back/forward, draft restore,
  // edit-exits-recall) is the editor's built-in history mode — recall only triggers on an empty input
  // or at the very start of the draft, so ↑/↓ inside a multiline draft keep moving the cursor.
  for (const entry of loadPromptHistory(process.cwd())) editor.addToHistory(entry);
  const attachmentChips = new AttachmentChips();
  const editorSlot = new Container();
  editorSlot.addChild(editor);
  const inputStack = new Container();
  inputStack.addChild(attachmentChips);
  inputStack.addChild(editorSlot);

  /** The shared runtime: all mutable chat state + the render/refreshMeta/quit callbacks, threaded
   *  through every module factory below (see ChatRuntime). */
  const rt: ChatRuntime = {
    client, tui, term, editor, editorSlot, inputStack, attachmentChips,
    promptStash: new PromptStash(),
    shellContext: new LocalShellBuffer(),
    mentionIndex: new FileIndex(process.cwd()),
    commandDefs, termSettings, cwdLabel, branchLabel,
    view: fromHistory(history0),
    childView: null,
    childAc: null,
    streamAc: new AbortController(),
    notice: '',
    modelName: boot?.model || opts.model || '',
    conversationTitle: boot?.title ?? '',
    lineCfg: boot?.statusline ?? null,
    usage: boot?.usage ?? null,
    thinkingLevel: boot?.thinkingLevel ?? '',
    thinkingLevels: boot?.thinkingLevels ?? [],
    lspEnabled: boot?.lspEnabled ?? null,
    yoloOn: boot?.yolo ?? false,
    mcpList: null,
    workMode: 'build',
    cards: boot?.cards ?? [],
    listed: [],
    showThoughts,
    pendingImages: [],
    mentionFrecency: loadMentionFrecency(process.cwd()),
    render: () => { /* wired to the shell below */ },
    quit: () => { /* wired below, after the shell exists */ },
    refreshMeta: async (): Promise<void> => {
      const [st, mcp] = await Promise.all([
        client.status().catch(() => null),
        client.mcpServers().catch(() => null),
      ]);
      if (st) { rt.modelName = st.model || rt.modelName; rt.conversationTitle = st.title ?? rt.conversationTitle; rt.lineCfg = st.statusline; rt.usage = st.usage; rt.thinkingLevel = st.thinkingLevel ?? ''; rt.thinkingLevels = st.thinkingLevels ?? []; rt.cards = st.cards ?? []; rt.lspEnabled = st.lspEnabled ?? null; rt.yoloOn = st.yolo ?? rt.yoloOn; }
      rt.mcpList = mcp;
    },
  };
  await rt.refreshMeta();

  const flows = createFlows(rt);
  const stream = createStreamController(rt, flows);
  const shell = createShell(rt, stream, mdTheme);
  rt.render = shell.render;
  const pickers = createPickers(rt, stream, { reshowPanel: shell.reshowPanel });
  wireSubmit(rt, { stream, pickers });

  let done!: () => void;
  const finished = new Promise<void>((r) => { done = r; });
  // 250ms: fast enough to animate the generating spinner in the prompt meta line, cheap enough to
  // leave idle sessions alone (renders fire only while a turn streams).
  const thinkingTimer = setInterval(() => {
    if (rt.view.thinking) rt.render();
  }, 250);
  rt.quit = (): void => {
    rt.streamAc.abort();
    clearInterval(thinkingTimer);
    term.write(DISABLE_MOUSE);
    shell.hideOverlays();
    tui.stop();
    done();
  };
  shell.attachInput({ cycleThinkingLevel: pickers.cycleThinkingLevel });

  tui.start();
  term.write(ENABLE_MOUSE);
  // Mouse-reporting hygiene: quit() disables it on the normal path, but an uncaught throw or a
  // SIGTERM/SIGHUP would otherwise leave the user's shell spewing `[<35;…M` on every mouse move.
  const disableMouse = (): void => { try { process.stdout.write(DISABLE_MOUSE); } catch { /* tty gone */ } };
  process.once('exit', disableMouse);
  for (const sig of ['SIGTERM', 'SIGHUP'] as const) process.once(sig, () => { disableMouse(); process.exit(sig === 'SIGTERM' ? 143 : 129); });
  rt.render();
  stream.openStream(rt.streamAc);
  // Reconnect restore: if a question was already parked when this client attached (daemon restart, second
  // client), re-render its picker instead of leaving the turn silently hanging until the timeout.
  if (boot?.pendingAsk) flows.launchAsk(boot.pendingAsk.id, boot.pendingAsk.questions, boot.pendingAsk.kind);

  await finished;
}
