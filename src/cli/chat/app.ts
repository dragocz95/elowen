import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { TUI, ProcessTerminal, Container, matchesKey, CombinedAutocompleteProvider } from '@earendil-works/pi-tui';
import { initTheme, getMarkdownTheme, getSelectListTheme } from '@earendil-works/pi-coding-agent';
import { chatThemeItems, color, glyph, isChatThemeName, setChatTheme, setCustomChatTheme } from './theme.js';
import { loadPrefs, savePrefs } from './prefs.js';
import { appendPromptHistory, loadPromptHistory, PromptStash } from './promptHistory.js';
import { LocalShellBuffer, localShellTurn, parseBangCommand, runLocalShell } from './localShell.js';
import { editTextExternally } from './externalEditor.js';
import { StatusBar, CardPanel, SubagentPanel, spinnerFrame, runApprovalFlow } from './components.js';
import type { SubagentPanelEntry } from './components.js';
import { ChatEditor, sessionItems, modelItems, parseModelValue, openPicker, openTextInput, openInfoModal } from './picker.js';
import { runAskFlow } from './askFlow.js';
import { BrainClient, type BrainProviderView, type BrainWorkMode, type McpServerView } from './brainClient.js';
import { API_KEY_PROVIDERS } from '../setup/constants.js';
import { fromHistory, pushUser, beginAssistant, reduce, upsertCard, type ChatView } from '../../brain/transcript.js';
import { commandsFor, expandPromptCommand } from '../../brain/slashCommands.js';
import type { AskQuestion, BrainCard } from '../../brain/events.js';
import { formatDuration, formatK } from '../ui/text.js';
import { ORCA_CLI_VERSION } from '../version.js';
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
  StartScreen,
  startScreenBox,
  startScreenInputTop,
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

/** Local slash-command routing: returns the recognized command (with its argument) or null for a
 *  regular chat message. Pure, so the command surface is unit-testable without a TTY. */
export function parseCommand(text: string): { cmd: 'quit' | 'new' | 'stop' | 'status' | 'restart' | 'sessions' | 'resume' | 'delete' | 'model' | 'reasoning' | 'theme' | 'editor' | 'lsp' | 'mcp' | 'skills' | 'tools' | 'goal' | 'subgoal' | 'compact' | 'plan' | 'build' | 'yolo' | 'help'; arg?: string } | null {
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
    case 'model': return { cmd: 'model', arg: m[2] };
    case 'reasoning': return { cmd: 'reasoning', arg: m[2] };
    case 'theme': return { cmd: 'theme', arg: m[2] };
    case 'editor': return { cmd: 'editor' };
    case 'lsp': return { cmd: 'lsp' };
    case 'mcp': return { cmd: 'mcp' };
    case 'skills': return { cmd: 'skills' };
    case 'tools': return { cmd: 'tools' };
    case 'goal': return { cmd: 'goal', arg: m[2] };
    case 'subgoal': return { cmd: 'subgoal', arg: m[2] };
    case 'compact': return { cmd: 'compact' };
    case 'plan': return { cmd: 'plan', arg: m[2] };
    case 'build': return { cmd: 'build', arg: m[2] };
    case 'yolo': return { cmd: 'yolo', arg: m[2] };
    case 'help': return { cmd: 'help' };
    default: return null;
  }
}

/** True while the input text can still be a slash-command name being typed ("/", "/mo", "/model").
 *  A space (arguments), a second '/' (a path like /var/www/x) or a wiped leading '/' means it's ordinary
 *  input text, so the suggestion overlay should close. Pure — unit-testable without a TTY. */
export function isSlashCommandDraft(text: string): boolean {
  return /^\/[^\s/]*$/.test(text);
}

/** The animated "model is generating" chip for the prompt meta line — a subtle spinner + elapsed
 *  seconds next to the reasoning level, replacing the old `thinking… Ns` transcript line (which kept
 *  pushing the conversation around). Time-based frame so every render advances it. */
function generatingChip(seconds: number): string {
  return `${color.accent(spinnerFrame())} ${color.faint(formatDuration(seconds))}`;
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

export function isModeToggleKey(data: string): boolean {
  return data === '\x1b[Z' // Shift+Tab in xterm-compatible terminals.
    || data === '\x1b[9;5u' // Ctrl+Tab when modifyOtherKeys/kitty-style reporting is enabled.
    || matchesKey(data, 'shift+tab')
    || matchesKey(data, 'ctrl+tab');
}

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
 *  Conversations are server-side: /new opens one, /sessions + /resume switch between them. */
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
  let modelName = boot?.model || opts.model || '';
  let conversationTitle = boot?.title ?? '';
  let lineCfg = boot?.statusline ?? null;
  let usage = boot?.usage ?? null;
  let thinkingLevel = boot?.thinkingLevel ?? '';
  let thinkingLevels = boot?.thinkingLevels ?? [];
  let lspEnabled: boolean | null = boot?.lspEnabled ?? null;
  /** Effective YOLO (session /yolo override, else the persisted Account default) — server-authoritative,
   *  refreshed with every status fetch; drives the warning chip in the prompt meta line. */
  let yoloOn = boot?.yolo ?? false;
  /** MCP servers for the telemetry panel; null (fetch failed / non-admin) hides the section. */
  let mcpList: McpServerView[] | null = null;
  let workMode: BrainWorkMode = 'build';
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
    const [st, mcp] = await Promise.all([
      client.status().catch(() => null),
      client.mcpServers().catch(() => null),
    ]);
    if (st) { modelName = st.model || modelName; conversationTitle = st.title ?? conversationTitle; lineCfg = st.statusline; usage = st.usage; thinkingLevel = st.thinkingLevel ?? ''; thinkingLevels = st.thinkingLevels ?? []; cards = st.cards ?? []; lspEnabled = st.lspEnabled ?? null; yoloOn = st.yolo ?? yoloOn; }
    mcpList = mcp;
  };
  await refreshMeta();
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
  /** ctrl+s draft stash — session-local LIFO (see PromptStash). */
  const promptStash = new PromptStash();
  /** `!cmd` results waiting to ride along with the next prompt sent to the brain. */
  const shellContext = new LocalShellBuffer();
  /** Ask-user-question still borrows this slot for its multi-step flow. Other pickers use modals. */
  const editorSlot = new Container();
  editorSlot.addChild(editor);
  /** Persistent card panel (ctx.emitCard — the todo checklist is the canonical one), pinned above the
   *  status line — lives in the fixed tree, NOT the rebuilt messages container, so it stays put across turns. */
  const cardPanel = new CardPanel();
  const subPanel = new SubagentPanel();
  const promptMeta = new StatusBar('', '');
  const bottomBar = new StatusBar(color.faint('  ⏎ send   ·   /help commands   ·   ctrl+r reasoning   ·   shift+tab mode'), color.faint('ctrl+c quit  '));

  const slashItems = commandDefs.map((cmd) => ({
    value: `/${cmd.name}`,
    label: `/${cmd.name}`,
    description: cmd.description,
  }));
  // Slash commands use Orca's custom overlay. Keep PI completion for files and @attachments only.
  editor.setAutocompleteProvider(new CombinedAutocompleteProvider([], process.cwd()));

  let panelHandle: ReturnType<TUI['showOverlay']> | null = null;
  let slashHandle: ReturnType<TUI['showOverlay']> | null = null;
  let slashOverlay: SlashOverlay | null = null;
  let panelWidth = 46;
  let resizingPanel = false;
  let draggingHistoryScroll = false;
  /** An empty conversation renders the centered start screen instead of the chat stack + panel. */
  const hasMessages = (): boolean => view.turns.length > 0;
  const panelVisible = (): boolean => term.columns >= 104 && hasMessages() && !panelHandle?.isHidden();
  const panelReserve = (): number => panelVisible() ? panelWidth + PANEL_GUTTER_COLUMNS : 0;
  const chatWidth = (): number => Math.max(24, term.columns - panelReserve());
  const panelLeftEdge = (): number => term.columns - panelWidth;
  const fixedRows = (): number => {
    const cardRows = cardPanel.render(Math.max(24, chatWidth())).length;
    const subRows = subPanel.render(Math.max(24, chatWidth())).length;
    const inputRows = editorSlot.render(Math.max(24, chatWidth())).length;
    return TOP_RULE_ROWS + cardRows + subRows + inputRows + 2;
  };

  const viewport = new ChatViewport(
    { view, notice, modelName, thinkingSeconds: 0 },
    mdTheme,
    () => Math.max(8, term.rows - fixedRows()),
    () => TOP_RULE_ROWS + 1,
    chatWidth,
  );
  let currentRunSeconds = 0;
  const telemetry = new TelemetryPanel(() => ({
    usage,
    cwd: cwdLabel,
    branch: branchLabel,
    mcp: mcpList,
    lspEnabled,
  }));
  const startScreen = new StartScreen(
    editorSlot,
    () => Math.max(12, term.rows - TOP_RULE_ROWS),
    () => ({
      modelLine: modelMetaLine(workMode, modelName, thinkingLevel, undefined, yoloOn),
      hints: color.faint('⏎ send · / commands · ! shell · ↑ history · ctrl+s stash · shift+tab mode'),
      tip: `${color.warning('●')} ${color.bold(color.text('Tip'))} ${color.dim('ask anything — try')} ${color.text('"What is the tech stack of this project?"')}`,
      notice,
      statusLeft: `${color.dim(cwdLabel)}${branchLabel ? color.faint(` · ${branchLabel}`) : ''}`,
      version: ORCA_CLI_VERSION,
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

  // Drill-in to a delegated sub-agent's session (opened by clicking its row/panel entry or ctrl+o).
  // Fully interactive: its own live tap stream feeds the view and the input steers the child. The
  // server's ACTIVE conversation stays the parent — Esc returns without any server round-trip.
  let childView: { sessionId: string; view: ChatView } | null = null;

  let thinkStart = 0;
  const render = (): void => {
    if (view.thinking) {
      if (!thinkStart) thinkStart = Date.now();
    } else {
      thinkStart = 0;
    }
    currentRunSeconds = thinkStart ? Math.max(0, Math.round((Date.now() - thinkStart) / 1000)) : 0;
    viewport.setState({
      view: childView?.view ?? view,
      notice: childView ? color.dim('· sub-agent session — your messages go to this agent') : notice,
      modelName,
      thinkingSeconds: currentRunSeconds,
      showThoughts,
    });
    // Contextual footer: while streaming, Esc interrupts; inside a sub-agent view, input steers the child.
    bottomBar.setLeft(childView
      ? color.faint('  ⏎ message the sub-agent   ·   esc back   ·   ctrl+o next session')
      : view.thinking
        ? color.faint(`  esc interrupt   ·   /help commands   ·   ctrl+r reasoning${subagentSessions().length ? '   ·   ctrl+o subagents' : ''}`)
        : color.faint('  ⏎ send   ·   / slash   ·   ! shell   ·   ctrl+s stash   ·   shift+tab mode   ·   ctrl+r reasoning   ·   ctrl+p telemetry')
          + (shellContext.pending ? `   ${color.warning('· ! output → next message')}` : ''));
    const projectLine = `${color.dim(cwdLabel)}${branchLabel ? color.faint(` · ${branchLabel}`) : ''}`;
    const line = statusline(lineCfg ? { ...lineCfg, showModel: false } : null, usage, modelName);
    promptMeta.setLeft(modelMetaLine(workMode, modelName, thinkingLevel, view.thinking ? generatingChip(currentRunSeconds) : undefined, yoloOn));
    promptMeta.setRight(panelVisible() || !line ? projectLine : `${color.faint(line)} ${color.faint('·')} ${projectLine}`);
    cardPanel.set(cards);
    subPanel.set(subagentStates());
    tui.requestRender();
  };

  // Drive the interactive picker flow for a parked ask_user_question, POST the answer (Esc aborts the
  // turn). Shared by the live `ask` event and the reconnect restore (boot.pendingAsk). An `approval`
  // kind (a blocked tool-permission ask) takes the dedicated warning-toned modal instead: 1/2/3 or
  // arrows+Enter pick, and Esc answers Deny — it never aborts the turn (the tool just reports the
  // denial to the model and the run continues).
  const launchAsk = (id: string, questions: AskQuestion[], kind?: 'approval'): void => {
    const q = questions[0];
    if (kind === 'approval' && q) {
      runApprovalFlow({
        tui, slot: editorSlot, editor, question: q,
        onDecision: (label) => { void client.answer(id, [{ header: q.header, selected: [label] }]).catch(() => { /* turn may have gone */ }); },
      });
      return;
    }
    runAskFlow({
      tui, slot: editorSlot, editor, questions,
      onComplete: (answers) => { void client.answer(id, answers).catch(() => { /* turn may have gone */ }); },
      onCancel: () => { void client.abort().catch(() => { /* already settled */ }); },
    });
  };

  const applyThinkingLevel = (level: string): void => {
    void client.setThinkingLevel(level).then((r) => {
      thinkingLevel = r.thinkingLevel;
      notice = color.dim(`reasoning effort: ${r.thinkingLevel}`);
      render();
    }).catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
  };

  const openThinkingPicker = (): void => {
    if (thinkingLevels.length === 0) { notice = color.dim('this model has no reasoning-effort levels'); render(); return; }
    openPicker({
      tui, editor, title: 'Reasoning effort',
      items: thinkingLevels.map((lv) => ({ value: lv, label: lv, description: lv === thinkingLevel ? 'current' : undefined })),
      onPick: (value) => applyThinkingLevel(value),
    });
  };

  // ctrl+r: cycle the reasoning effort in place — popping a modal for a one-key toggle just interrupts
  // the user's typing. The /think command still opens the explicit picker. The local level advances
  // OPTIMISTICALLY so rapid presses step through the levels instead of re-sending the same target
  // (the server reply is authoritative; an error rolls back).
  const cycleThinkingLevel = (): void => {
    if (thinkingLevels.length === 0) { notice = color.dim('this model has no reasoning-effort levels'); render(); return; }
    const previous = thinkingLevel;
    const next = thinkingLevels[(thinkingLevels.indexOf(thinkingLevel) + 1) % thinkingLevels.length]!;
    thinkingLevel = next;
    notice = color.dim(`reasoning effort: ${next}`);
    render();
    void client.setThinkingLevel(next)
      .then((r) => { thinkingLevel = r.thinkingLevel; notice = color.dim(`reasoning effort: ${r.thinkingLevel}`); render(); })
      .catch((e: Error) => { thinkingLevel = previous; notice = color.error(`error: ${e.message}`); render(); });
  };

  // /model → ctrl+p: manage brain providers right from the CLI. Presets come from the setup wizard's
  // curated endpoint catalog; a custom OpenAI-compatible URL, the API key and (for openai-type entries)
  // the wire API (Responses vs Chat Completions) are collected step by step through the same modals.
  const openProviderModal = (): void => {
    void client.brainProviders().then((providers) => {
      const apiLabel = (p: BrainProviderView): string => p.type !== 'openai' ? '' : ` · ${p.api ?? 'auto'} API`;
      const saveAll = (next: BrainProviderView[], done: string): void => {
        void client.saveBrainProviders(next)
          .then(() => { notice = color.dim(done); render(); })
          .catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
      };
      // Per-entry API mode picker (openai-type only): auto / responses / completions.
      const openApiPicker = (p: BrainProviderView, all: BrainProviderView[]): void => {
        const officialOpenAi = /api\.openai\.com/.test(p.baseUrl || 'https://api.openai.com/v1');
        openPicker({
          tui, editor, title: `${p.label} · wire API`,
          items: [
            { value: 'auto', label: 'Auto (recommended)', description: officialOpenAi ? 'OpenAI endpoint → Responses API' : 'OpenAI-compatible endpoint → Chat Completions' },
            { value: 'openai-responses', label: 'Responses API', description: 'prompt caching + reasoning summaries (needs endpoint support)' },
            { value: 'openai-completions', label: 'Chat Completions', description: 'the ubiquitous OpenAI-compatible API' },
          ],
          onPick: (v) => {
            const next = { ...p };
            if (v === 'auto') delete next.api; else next.api = v as 'openai-responses' | 'openai-completions';
            // In-place update — order is load-bearing (providers[0] is the default for users with no
            // saved model), so an edit must never move the entry to the end.
            const replaced = all.some((x) => x.id === p.id) ? all.map((x) => (x.id === p.id ? next : x)) : [...all, next];
            saveAll(replaced, `${p.label}: ${v === 'auto' ? 'auto' : v} · /model to pick a model`);
          },
        });
      };
      const addEntry = (label: string, type: 'openai' | 'anthropic', baseUrl: string): void => {
        openTextInput({
          tui, editor, title: `${label} · API key`,
          onSubmit: (key) => {
            const apiKey = key.trim();
            if (!apiKey) { notice = color.dim('cancelled — no API key entered'); render(); return; }
            const idBase = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'provider';
            let id = idBase;
            for (let i = 2; providers.some((x) => x.id === id); i++) id = `${idBase}-${i}`;
            const entry: BrainProviderView = { id, label, type, baseUrl, models: [], apiKey };
            if (type === 'openai') openApiPicker(entry, providers);
            else saveAll([...providers, entry], `${label} connected · /model to pick a model`);
          },
        });
      };
      openPicker({
        tui, editor, title: 'Brain providers',
        items: [
          { value: '__add', label: '+ Add provider', description: 'curated endpoints or a custom URL' },
          ...providers.map((p) => ({
            value: p.id,
            label: p.label,
            description: `${p.type.startsWith('oauth-') ? 'OAuth account' : (p.baseUrl || 'https://api.openai.com/v1')}${apiLabel(p)}`,
          })),
        ],
        footer: 'enter open · type to search · esc close',
        onPick: (v) => {
          if (v === '__add') {
            openPicker({
              tui, editor, title: 'Add provider',
              items: [
                ...API_KEY_PROVIDERS.map((p) => ({ value: p.key, label: p.label, description: p.base })),
                { value: '__custom', label: 'Custom OpenAI-compatible endpoint', description: 'any /v1 base URL' },
              ],
              footer: 'enter pick · type to search · esc close',
              onPick: (key) => {
                if (key === '__custom') {
                  openTextInput({
                    tui, editor, title: 'Custom endpoint · base URL (…/v1)',
                    onSubmit: (url) => {
                      const baseUrl = url.trim().replace(/\/$/, '');
                      if (!/^https?:\/\//.test(baseUrl)) { notice = color.error('a base URL must start with http(s)://'); render(); return; }
                      addEntry(new URL(baseUrl).hostname, 'openai', baseUrl);
                    },
                  });
                  return;
                }
                const preset = API_KEY_PROVIDERS.find((p) => p.key === key);
                if (preset && (preset.type === 'openai' || preset.type === 'anthropic')) addEntry(preset.label, preset.type, preset.base);
              },
            });
            return;
          }
          const p = providers.find((x) => x.id === v);
          if (!p) return;
          if (p.type !== 'openai') { notice = color.dim(`${p.label}: nothing to configure here (manage models via the web settings)`); render(); return; }
          openApiPicker(p, providers);
        },
      });
    }).catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
  };

  const openModelPicker = (): void => {
    void client.models().then((models) => {
      if (models.length === 0) { notice = color.dim('no models configured — ctrl+p in /model adds a provider'); render(); return; }
      const paid = models.filter((m) => !m.free);
      const free = models.filter((m) => m.free);
      const items = [
        ...modelItems(paid, modelName),
        // OpenRouter's zero-cost catalog folds in at the bottom under a FREE header row.
        ...(free.length ? [{ value: '__free', label: color.faint('─ FREE · OpenRouter ─'), description: `${free.length} zero-cost models` }] : []),
        ...free.map((m) => ({ value: `${m.provider} ${m.model}`, label: `☆ ${m.model.replace(/:free$/, '')}`, description: `${m.providerLabel} · free` })),
      ];
      openPicker({
        tui, editor, title: 'Switch model', items,
        footer: 'enter switch · type to search · ctrl+p providers · esc close',
        onInput: (data, _selected, close) => {
          if (matchesKey(data, 'ctrl+p')) { close(); openProviderModal(); return true; }
          return false;
        },
        onPick: (value) => {
          if (value === '__free') { openModelPicker(); return; }
          notice = color.dim('switching model…');
          render();
          void client.setModel(parseModelValue(value)).then(async (r) => {
            modelName = r.model;
            // The server rebuilt the session — the old event stream is dead, reopen it.
            streamAc.abort();
            const ac = new AbortController();
            streamAc = ac;
            openStream(ac);
            await refreshMeta();
            notice = '';
            render();
          }).catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
        },
      });
    }).catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
  };

  const applyTheme = (name: string): boolean => {
    // "custom" = the web Account → Terminal palette (offered only when one is configured): re-apply it
    // and persist the choice so startup keeps preferring it on this machine.
    if (name === 'custom' && termSettings?.theme === 'custom' && termSettings.palette) {
      setCustomChatTheme(termSettings.palette);
      savePrefs({ theme: 'custom' });
      editor.borderColor = color.faint;
      notice = color.dim('theme: Custom (web palette)');
      showPanel(panelHandle?.isHidden() ?? false);
      render();
      return true;
    }
    if (!isChatThemeName(name)) return false;
    const theme = setChatTheme(name);
    savePrefs({ theme: name });
    editor.borderColor = color.faint;
    notice = color.dim(`theme: ${theme.label}`);
    showPanel(panelHandle?.isHidden() ?? false);
    render();
    return true;
  };

  const openThemePicker = (): void => {
    const webCustom = termSettings?.theme === 'custom' && termSettings.palette
      ? [{ value: 'custom', label: 'Custom', description: 'your web Account → Terminal palette' }]
      : [];
    openPicker({
      tui, editor, title: 'Terminal theme',
      items: [...webCustom, ...chatThemeItems()],
      onPick: (value) => { applyTheme(value); },
    });
  };

  // /help as an interactive modal in the CLI pattern: an arrow-key list of every command; Enter runs the
  // highlighted one (routed back through the normal submit path), type to filter, esc closes.
  const openHelpModal = (): void => {
    openPicker({
      tui, editor, title: 'Commands',
      items: commandDefs.map((c) => ({ value: c.name, label: `/${c.name}`, description: c.description })),
      footer: 'enter run · type to filter · esc close',
      onPick: (name) => { editor.onSubmit?.(`/${name}`); },
    });
  };

  // /status as a read-only modal: model, reasoning, context/usage, project and any active goal at a glance.
  const openStatusModal = (): void => {
    void Promise.all([client.status().catch(() => null), client.goal().catch(() => null)]).then(([s, g]) => {
      const lines: string[] = [];
      const kv = (k: string, v: string): void => { lines.push(`${color.faint(k.padEnd(12))} ${color.text(v)}`); };
      if (s?.title) kv('conversation', s.title);
      kv('model', s?.model || '—');
      if (s?.thinkingLevel) kv('reasoning', s.thinkingLevel);
      kv('mode', workMode === 'plan' ? 'Plan' : 'Build');
      const u = s?.usage;
      if (u) {
        if (u.percent != null) kv('context', `${Math.round(u.percent)}%  (${formatK(u.tokens ?? 0)} / ${formatK(u.contextWindow)})`);
        kv('tokens', `${formatK(u.totalTokens)} total`);
        kv('cost', `$${u.cost.toFixed(2)}`);
      }
      kv('cwd', cwdLabel);
      if (branchLabel) kv('branch', branchLabel);
      if (g) {
        lines.push('');
        lines.push(color.accent('Goal'));
        kv('  status', g.status);
        kv('  turns', `${g.turns_used}/${g.turn_budget}`);
        if (g.paused_reason) kv('  paused', g.paused_reason);
      }
      openInfoModal({ tui, editor, title: 'Session status', lines });
    }).catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
  };

  const openSessionsModal = (): void => {
    void client.sessions().then((list) => {
      listed = list.map((s) => ({ id: s.id, title: s.title }));
      if (list.length === 0) { notice = color.dim('no conversations'); render(); return; }
      const refresh = () => openSessionsModal();
      const confirmDelete = (id: string, title: string, active: boolean): void => {
        openPicker({
          tui, editor, title: `Delete "${title || '(untitled)'}"?`,
          items: [
            { value: 'no', label: 'Cancel', description: 'keep the conversation' },
            { value: 'yes', label: 'Delete', description: 'also removes goal state for this session' },
          ],
          onPick: (v) => {
            if (v !== 'yes') { refresh(); return; }
            void client.deleteSession(id).then(async () => {
              notice = color.dim('conversation deleted');
              if (active) await switchTo({});
              refresh();
              render();
            })
              .catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
          },
        });
      };
      openPicker({
        tui, editor, title: 'Conversations', items: sessionItems(list),
        footer: 'enter resume · ctrl+r rename · ctrl+d delete · esc close',
        onPick: (id) => void switchTo({ session: id }).catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); }),
        onInput: (data, item, close) => {
          if (!item) return false;
          const row = list.find((s) => s.id === item.value);
          if (!row) return false;
          if (matchesKey(data, 'ctrl+d')) { close(); confirmDelete(row.id, row.title, row.active); return true; }
          if (matchesKey(data, 'ctrl+r')) {
            close();
            openTextInput({
              tui, editor, title: 'Rename conversation', initial: row.title,
              onSubmit: (title) => {
                void client.renameSession(row.id, title).then(() => { notice = color.dim('conversation renamed'); refresh(); render(); })
                  .catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
              },
            });
            return true;
          }
          return false;
        },
      });
    }).catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
  };

  const openMcpModal = (): void => {
    void client.mcpServers().then((servers) => {
      const items = servers.map((s) => ({
        value: s.name,
        label: `${s.status === 'connected' ? color.success('●') : s.status === 'connecting' ? color.warning('●') : color.faint('○')} ${s.name}`,
        description: `${s.transport} · ${s.toolCount} tools${s.lastError ? ` · ${s.lastError}` : ''}`,
      }));
      if (items.length === 0) { notice = color.dim('no MCP servers configured'); render(); return; }
      const refresh = () => openMcpModal();
      const reconnect = (name: string): void => {
        notice = color.dim(`reconnecting ${name}…`); render();
        void client.reconnectMcp(name).then(() => { notice = color.dim(`MCP ${name} connected`); refresh(); render(); })
          .catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
      };
      const detail = (name: string): void => {
        const server = servers.find((s) => s.name === name);
        if (!server) return;
        const rows = [
          { value: '__back', label: 'Back', description: 'return to servers' },
          { value: '__reconnect', label: 'Reconnect', description: server.status === 'connected' ? 'already connected' : 'try reconnect' },
          ...server.tools.map((tool) => ({
            value: tool.name,
            label: tool.name,
            description: `${tool.description ?? ''}${tool.schema ? ' · schema available' : ''}`.trim(),
          })),
        ];
        openPicker({ tui, editor, title: `MCP ${server.name}`, items: rows, onPick: (v) => {
          if (v === '__back') refresh();
          else if (v === '__reconnect') reconnect(server.name);
          else { notice = color.dim(`tool: ${v}`); render(); }
        } });
      };
      openPicker({
        tui, editor, title: 'MCP servers', items,
        footer: 'enter detail · r reconnect · R reconnect failed · esc close',
        onPick: detail,
        onInput: (data, item) => {
          if (data === 'R') {
            notice = color.dim('reconnecting disconnected/error MCP servers…'); render();
            void client.reconnectMcpAll().then(() => { notice = color.dim('MCP reconnect complete'); refresh(); render(); })
              .catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
            return true;
          }
          if (data === 'r' && item) { reconnect(item.value); return true; }
          return false;
        },
      });
    }).catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
  };

  const openSkillsModal = (): void => {
    void client.skills().then((skills) => {
      if (skills.length === 0) { notice = color.dim('no skills found'); render(); return; }
      const refresh = () => openSkillsModal();
      // Push a skill into the CURRENT conversation: instruct the agent to load its full instructions via
      // the `read_skill` tool (progressive disclosure — only name+description live in the system prompt).
      // Nothing to load if the skills plugin is off (the skill isn't registered at all then).
      const loadSkill = (name: string, active: boolean): void => {
        if (!active) { notice = color.dim('the skills plugin is disabled — enable it in Settings → Plugins first'); render(); return; }
        // onSubmit clears any notice and shows the sent turn itself, so a "loading…" notice here would be
        // wiped before it ever renders — just submit the read_skill instruction.
        editor.onSubmit?.(`Load the "${name}" skill with the read_skill tool and follow it for the rest of this conversation.`);
      };
      const confirmDelete = (name: string): void => {
        openPicker({
          tui, editor, title: `Delete skill "${name}"?`,
          items: [
            { value: 'no', label: 'Cancel', description: 'keep the skill' },
            { value: 'yes', label: 'Delete', description: 'user skill only' },
          ],
          onPick: (v) => {
            if (v !== 'yes') { refresh(); return; }
            void client.deleteSkill(name).then(() => { notice = color.dim('skill deleted'); refresh(); render(); })
              .catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
          },
        });
      };
      openPicker({
        tui, editor, title: 'Skills',
        items: skills.map((s) => ({ value: s.name, label: s.name, description: `${s.scope ?? s.source}${s.description ? ` · ${s.description}` : ''}` })),
        footer: 'type filter · enter detail · ctrl+l load · ctrl+d delete · esc close',
        onPick: (name) => {
          const s = skills.find((skill) => skill.name === name);
          if (!s) return;
          openPicker({
            tui, editor, title: `Skill ${s.name}`,
            items: [
              { value: '__back', label: 'Back', description: 'return to skills' },
              { value: '__load', label: 'Load into conversation', description: s.active ? 'agent reads it now and follows it' : 'enable the skills plugin first' },
              { value: '__delete', label: s.canDelete ? 'Delete' : 'Protected', description: s.canDelete ? 'delete this user-defined skill' : 'bundled/system skill cannot be deleted' },
              { value: '__location', label: 'Location', description: s.location ?? '' },
              { value: '__active', label: 'State', description: s.active ? 'active/loaded' : 'skills plugin disabled' },
            ],
            onPick: (v) => {
              if (v === '__back') refresh();
              else if (v === '__load') loadSkill(s.name, s.active === true);
              else if (v === '__delete' && s.canDelete) confirmDelete(s.name);
            },
          });
        },
        onInput: (data, item, close) => {
          if (!item) return false;
          const s = skills.find((skill) => skill.name === item.value);
          if (!s) return false;
          if (matchesKey(data, 'ctrl+l')) { close(); loadSkill(s.name, s.active === true); return true; }
          if (matchesKey(data, 'ctrl+d')) {
            if (!s.canDelete) { notice = color.dim('bundled/system skills are protected'); render(); return true; }
            close();
            confirmDelete(s.name);
            return true;
          }
          return false;
        },
      });
    }).catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
  };

  // /lsp as a status modal (mirrors /mcp): whether diagnostics are enabled and running, one row per
  // language server (● running · ○ installed · ✗ missing), and the on/off toggle as the first row —
  // replaces the old blind flip, so the operator SEES the state before (and after) changing it.
  const openLspModal = (): void => {
    void client.lspStatus().then((s) => {
      const refresh = () => openLspModal();
      const items = [
        {
          value: '__toggle',
          label: s.enabled ? 'Disable LSP diagnostics' : 'Enable LSP diagnostics',
          description: s.enabled ? 'stops every language server' : 'type-check edits live after each change',
        },
        ...s.servers.map((srv) => ({
          value: srv.command,
          label: `${srv.running ? color.success('●') : srv.installed ? color.faint('○') : color.error('✗')} ${srv.label}`,
          description: srv.running ? 'running · ctrl+u uninstalls' : srv.installed ? (srv.installable ? 'installed · ctrl+u uninstalls' : 'installed · starts on the first check')
            : srv.installable ? `not installed · ctrl+i installs (${srv.installHint})` : `not installed · ${srv.installHint}`,
        })),
      ];
      // ctrl+i installs / ctrl+u uninstalls the highlighted server daemon-side. In a terminal ctrl+i IS
      // Tab (\t) — same byte — so Tab doubles as the install key here.
      const runManage = (srv: { label: string; command: string }, install: boolean): void => {
        notice = color.dim(install ? `installing ${srv.label} (npm, this can take a minute)…` : `uninstalling ${srv.label}…`);
        render();
        // Deliberately NO modal reopen when npm finishes: the user may be typing (or inside another
        // picker) minutes later — a surprise overlay would steal focus and strand the one beneath it.
        // The outcome lands as a notice; /lsp shows the fresh state on demand.
        void (install ? client.lspInstall(srv.command) : client.lspUninstall(srv.command))
          .then(async (message) => { notice = color.dim(`${message} · /lsp shows the current state`); await refreshMeta(); render(); })
          .catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
      };
      const manageKey = (data: string, selected: { value: string } | null, close: () => void): boolean => {
        const install = data === '\t' || matchesKey(data, 'tab');
        const uninstall = !install && matchesKey(data, 'ctrl+u');
        if (!install && !uninstall) return false;
        const srv = s.servers.find((x) => x.command === selected?.value);
        if (!srv || (install && srv.installed) || (uninstall && !srv.installed)) return true; // nothing to do
        if (!srv.installable) {
          notice = color.dim(`${srv.label} ships with its toolchain — ${install ? 'install' : 'remove'} it with your package manager (${srv.installHint})`);
          render();
          return true;
        }
        close();
        if (install) { runManage(srv, true); return true; }
        // Uninstalling is destructive (and ctrl+u doubles as "clear line" muscle memory) → confirm first.
        openPicker({
          tui, editor, title: `Uninstall ${srv.label}?`,
          items: [
            { value: 'no', label: 'Cancel', description: 'keep the server' },
            { value: 'yes', label: 'Uninstall', description: "removes it from Orca's prefix and stops running servers" },
          ],
          onPick: (v) => { if (v === 'yes') runManage(srv, false); },
        });
        return true;
      };
      openPicker({
        tui, editor,
        title: `LSP · ${s.enabled ? (s.running ? 'on · running' : 'on · idle') : 'off'}`,
        items,
        footer: 'enter toggle · ctrl+i install · ctrl+u uninstall · esc close',
        onInput: manageKey,
        onPick: (v) => {
          if (v !== '__toggle') { refresh(); return; }
          void client.command('lsp')
            // refreshMeta keeps the right-panel LSP Active/Inactive line in step with the flip.
            .then(async (r) => { notice = color.dim(r?.message ?? 'toggled LSP'); await refreshMeta(); refresh(); render(); })
            .catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
        },
      });
    }).catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
  };

  const openToolsModal = (): void => {
    void client.tools().then((tools) => {
      if (tools.length === 0) { notice = color.dim('no active plugin tools'); render(); return; }
      const refresh = () => openToolsModal();
      openPicker({
        tui, editor, title: 'Tools',
        items: tools.map((t) => ({ value: t.name, label: t.name, description: `${t.plugin}${t.schema ? ` · ${t.schema}` : ''}` })),
        onPick: (name) => {
          const t = tools.find((tool) => tool.name === name);
          if (!t) { notice = color.dim(name); render(); return; }
          openPicker({
            tui, editor, title: `Tool ${t.name}`,
            items: [
              { value: '__back', label: 'Back', description: 'return to tools' },
              { value: '__plugin', label: 'Plugin', description: t.plugin },
              { value: '__schema', label: 'Schema', description: t.schema ?? 'no input schema' },
              { value: '__description', label: 'Description', description: t.description ?? 'no description' },
            ],
            onPick: (v) => { if (v === '__back') refresh(); },
          });
        },
      });
    }).catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
  };

  const goalSummary = (g: Awaited<ReturnType<BrainClient['goal']>>): string => {
    if (!g) return 'no active goal';
    const bits = [`goal ${g.status}`, `${g.turns_used}/${g.turn_budget} turns`, g.goal];
    try {
      const subs = JSON.parse(g.subgoals) as { text?: string; done?: boolean }[];
      if (Array.isArray(subs) && subs.length) bits.push(`subgoals: ${subs.filter((s) => s?.done).length}/${subs.length}`);
    } catch { /* malformed subgoals JSON → skip the count */ }
    if (g.paused_reason) bits.push(`paused: ${g.paused_reason}`);
    if (g.last_evidence) bits.push(`evidence: ${g.last_evidence}`);
    return bits.join(' · ');
  };

  const handleGoalCommand = (arg?: string): void => {
    const raw = (arg ?? '').trim();
    if (!raw || raw === 'status' || raw === 'show') {
      void client.goal().then((g) => { notice = color.dim(goalSummary(g)); render(); })
        .catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
      return;
    }
    if (raw === 'pause' || raw === 'resume' || raw === 'clear') {
      void client.goalAction(raw).then((g) => { notice = color.dim(raw === 'clear' ? 'goal cleared' : goalSummary(g)); render(); })
        .catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
      return;
    }
    const draft = raw.startsWith('draft ');
    const text = draft ? raw.slice('draft '.length).trim() : raw;
    notice = color.dim(draft ? 'drafting goal…' : 'starting persistent goal…');
    render();
    void client.setGoal(text, draft).then((g) => { notice = color.dim(draft ? `goal draft:\n${g.draft}` : goalSummary(g)); render(); })
      .catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
  };

  const handleSubgoalCommand = (arg?: string): void => {
    const raw = (arg ?? '').trim();
    if (!raw) { notice = color.dim('usage: /subgoal <text> · /subgoal remove <N> · /subgoal clear'); render(); return; }
    const remove = /^remove\s+(\d+)$/i.exec(raw);
    const action = raw === 'clear' ? ['clear', undefined] as const : remove ? ['remove', Number(remove[1])] as const : ['add', raw] as const;
    void client.subgoal(action[0], action[1]).then((g) => { notice = color.dim(goalSummary(g)); render(); })
      .catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
  };

  const closeSlash = (): void => {
    slashHandle?.hide();
    slashHandle = null;
    slashOverlay = null;
    tui.requestRender();
  };

  /** Open the slash suggestions as a NON-capturing overlay: the editor keeps focus (and the typed text,
   *  including the leading '/'), while the overlay just mirrors it as a filter via editor.onChange. */
  const openSlash = (): void => {
    closeSlash();
    const overlay = new SlashOverlay(slashItems);
    overlay.setFilter(editor.getText());
    slashOverlay = overlay;
    // Tallest render: top + hint + blank + 10 items + counter + bottom = 15 rows. One less would clip
    // the bottom border whenever the counter row shows (which, with 20+ commands, is always).
    if (!hasMessages()) {
      // Start screen: the input is vertically centered, so anchor the suggestions right UNDER it
      // (aligned to the box) — the normal bottom-of-screen slot would float rows below the input.
      const { boxWidth, leftPad } = startScreenBox(term.columns);
      const inputRows = editorSlot.render(boxWidth).length;
      const noticeRows = notice ? notice.split('\n').length : 0;
      const top = TOP_RULE_ROWS + startScreenInputTop(Math.max(12, term.rows - TOP_RULE_ROWS), inputRows, noticeRows) + inputRows;
      slashHandle = tui.showOverlay(overlay, {
        anchor: 'top-left',
        width: boxWidth,
        maxHeight: 15,
        margin: { top, left: leftPad, right: 0, bottom: 0 },
        nonCapturing: true,
      });
    } else {
      const reserve = panelReserve();
      slashHandle = tui.showOverlay(overlay, {
        anchor: 'bottom-left',
        width: Math.max(50, term.columns - reserve - 1),
        maxHeight: 15,
        margin: { top: TOP_RULE_ROWS, left: 0, right: reserve, bottom: fixedRows() },
        nonCapturing: true,
      });
    }
    tui.requestRender();
  };

  /** Latest known state of every delegated sub-agent in the parent transcript, in first-seen order —
   *  feeds the live Sub-agents panel and the ctrl+o cycle ring. */
  const subagentStates = (): SubagentPanelEntry[] => {
    const seen = new Map<string, SubagentPanelEntry>();
    for (const turn of view.turns) {
      if (turn.role !== 'orca') continue;
      for (const seg of turn.segments) {
        if (seg.kind !== 'tools') continue;
        for (const item of seg.items) {
          if (!item.sub) continue;
          const s = item.sub;
          seen.set(s.sessionId, { sessionId: s.sessionId, task: s.task, status: s.status, detail: s.detail, tools: s.tools, tokens: s.tokens, seconds: s.seconds });
        }
      }
    }
    return [...seen.values()];
  };
  const subagentSessions = (): { sessionId: string; running: boolean }[] =>
    subagentStates().map((s) => ({ sessionId: s.sessionId, running: s.status === 'running' }));

  /** Open a sub-agent's session: history first, then its LIVE tap stream — text/tool/reasoning events
   *  fold into the child view exactly like the main conversation, so steering feels first-class. */
  let childAc: AbortController | null = null;
  const openSubagent = async (sessionId: string): Promise<void> => {
    const msgs = await client.history(sessionId).catch(() => null);
    if (!msgs) { notice = color.error('could not load the sub-agent transcript'); render(); return; }
    childAc?.abort();
    const ac = new AbortController();
    childAc = ac;
    childView = { sessionId, view: fromHistory(msgs) };
    render();
    void client.stream((e) => {
      if (ac.signal.aborted || childView?.sessionId !== sessionId) return;
      // A child's parked ask_user_question is answerable from here — the registry is id-keyed globally.
      if (e.type === 'ask') { launchAsk(e.id, e.questions, e.kind); return; }
      childView.view = reduce(childView.view, e);
      render();
    }, ac.signal, 1000, undefined, sessionId).catch(() => { /* aborted/gone */ });
  };

  const closeSubagent = (): void => {
    childAc?.abort();
    childAc = null;
    childView = null;
    render();
  };

  /** ctrl+o: cycle main conversation → sub-agent 1 → sub-agent 2 → … → back to main. */
  const cycleSubagent = (): void => {
    const ring = subagentSessions();
    if (ring.length === 0) { notice = color.dim('no sub-agent in this conversation yet'); render(); return; }
    const at = childView ? ring.findIndex((r) => r.sessionId === childView!.sessionId) : -1;
    const next = ring[at + 1];
    if (next) void openSubagent(next.sessionId);
    else closeSubagent();
  };

  /** Plan-mode follow-up: the agent finished a turn containing a <proposed_plan> block — ask whether to
   *  implement it now. "Implement" flips to build mode and sends the go-ahead through the normal submit
   *  path; "Cancel" stays in plan mode for further refinement. */
  const openPlanDecision = (): void => {
    openPicker({
      tui, editor, title: 'Plan ready',
      items: [
        { value: 'implement', label: 'Implement plan', description: 'switch to build mode and start implementing' },
        { value: 'cancel', label: 'Cancel', description: 'stay in plan mode and keep refining' },
      ],
      footer: 'enter pick · esc close',
      onPick: (v) => {
        if (v !== 'implement') return;
        workMode = 'build';
        render();
        editor.onSubmit?.('Implement the plan you proposed above.');
      },
    });
  };

  let streamAc = new AbortController();
  // `ac` is captured by the CALLER at switch time: two rapid switches (`/new` + `/model` mid-roundtrip)
  // both pass their own controller, and the superseded one bails here instead of opening a second live
  // stream on the current signal — which would reduce every event twice (doubled text/cards).
  const openStream = (ac: AbortController): void => {
    if (ac !== streamAc || ac.signal.aborted) return; // a newer switch owns the stream now
    void client.stream((e) => {
      // ask_user_question parked the turn: drive the picker flow and skip the ChatView reducer (the
      // questions aren't a conversation segment).
      if (e.type === 'ask') { launchAsk(e.id, e.questions, e.kind); return; }
      if (e.type === 'idle') {
        if (e.usage) usage = e.usage;
        // A finished turn may have just auto-titled a fresh conversation — pull the new title (and usage)
        // so the header stops showing "new conversation". Best-effort; a dropped daemon just leaves it.
        if (!conversationTitle) void refreshMeta().then(render);
        // Plan mode: the agent just delivered a <proposed_plan> — offer to implement it right away
        // instead of leaving the user to flip modes and phrase the follow-up themselves.
        if (workMode === 'plan' && !childView) {
          const last = view.turns[view.turns.length - 1];
          const text = last?.role === 'orca' ? last.segments.filter((s) => s.kind === 'text').map((s) => (s as { text: string }).text).join('') : '';
          if (/<proposed_plan>/i.test(text)) openPlanDecision();
        }
      }
      if (e.type === 'step' && e.usage) usage = e.usage;
      if (e.type === 'card') cards = upsertCard(cards, e.card); // update the persistent panel (not part of the ChatView)
      // Sub-agent progress folds into the delegate tool row below; the open child view has its own
      // live tap stream, so nothing extra to do here.
      // Idle rollover: the server continued this message in a FRESH conversation. The SENDING client's
      // last turn is the just-typed message, so the shared fold trims correctly; a passively connected
      // client (second CLI/web on the same account) has no fresh local user turn — folding would carry
      // OLD history into the new conversation, so it refetches the transcript instead.
      if (e.type === 'session') {
        notice = color.dim('previous conversation was idle — continuing in a fresh one');
        void refreshMeta().then(render);
        if (view.turns[view.turns.length - 1]?.role !== 'you') {
          void client.history().then((h) => { view = fromHistory(h); render(); }).catch(() => { /* best-effort */ });
          return;
        }
      }
      view = reduce(view, e);
      render();
    }, ac.signal).catch(() => { /* aborted/gone */ });
  };

  /** Switch conversations: retarget the server session, then swap history + the event stream. */
  const switchTo = async (target: { session?: string; fresh?: boolean }): Promise<void> => {
    streamAc.abort();
    const ac = new AbortController();
    streamAc = ac;
    await client.start(target);
    const hist = await client.history().catch(() => []);
    view = fromHistory(hist);
    await refreshMeta(); // also refreshes the card panel from the new conversation's status
    openStream(ac);
    render();
  };

  editor.onSubmit = (text: string): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    editor.addToHistory(trimmed); // Up-arrow recall of sent inputs (seeded from disk at startup)
    appendPromptHistory(process.cwd(), trimmed); // per-project persistence for the next session
    editor.setText('');
    notice = '';
    // `!cmd` runs LOCALLY (node child_process in the CLI's cwd) — never sent to the brain. The output
    // renders as a console block and is buffered as context for the NEXT prompt (see LocalShellBuffer).
    const localCmd = parseBangCommand(trimmed);
    if (localCmd) {
      notice = color.dim(`$ ${localCmd} · running locally…`);
      render();
      void runLocalShell(localCmd, process.cwd()).then((result) => {
        shellContext.add(result);
        view = { ...view, turns: [...view.turns, localShellTurn(result)] };
        if (notice.includes('running locally')) notice = '';
        render();
      });
      return;
    }
    const command = parseCommand(trimmed);
    // Inside a sub-agent view, plain text goes to the CHILD (steered into its running turn, or a fresh
    // child turn when idle) — the reply streams into the open view. Slash commands always act on the
    // parent conversation, so they snap back first (running /new while "inside" a child would be chaos).
    if (childView && !command) {
      const target = childView.sessionId;
      childView.view = pushUser(childView.view, trimmed); // local echo; the store copy lands server-side
      render();
      void client.subagentSend(target, trimmed).catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
      return;
    }
    if (childView && command) closeSubagent();
    if (command) {
      switch (command.cmd) {
        case 'quit': quit(); return;
        case 'help': openHelpModal(); return;
        case 'new':
          void switchTo({ fresh: true }).catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
          return;
        case 'sessions':
        case 'resume': {
          if (!command.arg) {
            openSessionsModal();
            return;
          }
          const n = Number(command.arg);
          const target = Number.isInteger(n) && n >= 1 ? listed[n - 1]?.id : command.arg;
          if (!target) { notice = color.dim('use /resume and pick with the arrows'); render(); return; }
          void switchTo({ session: target }).catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
          return;
        }
        case 'model': {
          openModelPicker();
          return;
        }
        case 'reasoning': {
          // "/reasoning show" toggles the Thought rows — persisted per USER server-side (cross-device,
          // mirrors the Account → Terminal switch) with the local pref as offline fallback.
          if (command.arg?.trim() === 'show') {
            showThoughts = !showThoughts;
            savePrefs({ showThoughts });
            void client.saveTerminalSettings({ showThoughtsCli: showThoughts }).catch(() => { /* offline → local pref still applies */ });
            notice = color.dim(showThoughts ? 'Thought rows shown' : 'Thought rows hidden — /reasoning show brings them back');
            render();
            return;
          }
          if (thinkingLevels.length === 0) { notice = color.dim('this model has no reasoning-effort levels'); render(); return; }
          const apply = (level: string): void => {
            void client.setThinkingLevel(level).then((r) => {
              thinkingLevel = r.thinkingLevel;
              notice = '';
              render();
            }).catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
          };
          // A bare "/reasoning high" applies directly; "/reasoning" opens the picker over the model's levels.
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
        case 'editor': {
          // $VISUAL/$EDITOR (fallback vi) over the current draft: suspend the TUI so the editor owns
          // the terminal, then re-init and load the saved content into the input. Non-zero exit (:cq,
          // crash) keeps the original draft untouched.
          const initial = editor.getExpandedText();
          term.write(DISABLE_MOUSE);
          tui.stop();
          void editTextExternally({ text: initial }).then((edited) => {
            tui.start();
            term.write(ENABLE_MOUSE);
            editor.setText(edited ?? initial);
            if (edited == null) notice = color.dim('editor exited without saving — draft kept');
            tui.requestRender(true);
            render();
          });
          return;
        }
        case 'delete': {
          const doDelete = (target: string): void => {
            void client.deleteSession(target)
              .then(async () => {
                listed = listed.filter((s) => s.id !== target);
                notice = color.dim('conversation deleted');
                await switchTo({});
                render();
              })
              .catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
          };
          // Deleting is destructive → always a two-step picker: choose the conversation, then confirm.
          const confirmDelete = (id: string, title: string): void => {
            openPicker({
              tui, editor, title: `Delete "${title || '(untitled)'}"?`,
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
                tui, editor, title: 'Delete conversation', items: sessionItems(list),
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
        case 'lsp':
          openLspModal();
          return;
        case 'mcp':
          openMcpModal();
          return;
        case 'skills':
          openSkillsModal();
          return;
        case 'tools':
          openToolsModal();
          return;
        case 'goal':
          handleGoalCommand(command.arg);
          return;
        case 'subgoal':
          handleSubgoalCommand(command.arg);
          return;
        case 'compact': {
          notice = color.dim('compacting…');
          render();
          void client.compact()
            .then(async (r) => { if (r.usage) usage = r.usage; await refreshMeta(); notice = color.dim(r.compacted ? 'conversation compacted' : (r.message ?? 'nothing to compact yet')); render(); })
            .catch((e: Error) => { notice = color.error(`error: ${e.message}`); render(); });
          return;
        }
        case 'plan':
          workMode = 'plan';
          notice = '';
          render();
          return;
        case 'build':
          workMode = 'build';
          notice = '';
          render();
          return;
        case 'yolo': {
          // Session-scoped: "/yolo on|off" forces, bare "/yolo" toggles. The persisted default lives in
          // web Account → Orca AI; this override never outlives the live session.
          const arg = command.arg?.trim().toLowerCase();
          if (arg && arg !== 'on' && arg !== 'off') { notice = color.dim('usage: /yolo · /yolo on · /yolo off'); render(); return; }
          void client.setYolo(arg === 'on' ? true : arg === 'off' ? false : undefined)
            .then((r) => {
              yoloOn = r.yolo;
              notice = r.yolo
                ? color.warning('YOLO on — tool asks auto-approve for this session (deny rules still apply)')
                : color.dim('YOLO off — tool asks prompt for approval again');
              render();
            })
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
        case 'status':
          openStatusModal();
          return;
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
    // A plugin-contributed prompt command (`kind:'prompt'`) that isn't a built-in: expand its template
    // with the typed arguments and send THAT to the agent, while the transcript shows what the user typed.
    const pm = /^\/(\S+)(?:\s+([\s\S]+))?$/.exec(trimmed);
    const promptCmd = pm ? commandDefs.find((c) => c.name === pm[1] && c.kind === 'prompt' && c.prompt) : undefined;
    if (pm && promptCmd) {
      const expanded = expandPromptCommand(promptCmd.prompt ?? '', pm[2] ?? '');
      view = beginAssistant(pushUser(view, trimmed));
      render();
      void client.send(shellContext.take(expanded), workMode).catch((e: Error) => { view = reduce(view, { type: 'error', message: e.message }); render(); });
      return;
    }
    view = beginAssistant(pushUser(view, trimmed));
    render();
    // Any buffered `!` results ride along (prepended as a fenced context block), then the buffer clears.
    void client.send(shellContext.take(trimmed), workMode).catch((e: Error) => { view = reduce(view, { type: 'error', message: e.message }); render(); });
  };

  // The slash overlay is a live suggestion popup driven by the input text: it filters while the text can
  // still be a command name and closes the moment it can't be one anymore (a space for arguments, a
  // second '/' as in /var/www/x, or the leading '/' deleted) — the text itself always stays in the input.
  editor.onChange = (text: string): void => {
    if (!slashHandle || !slashOverlay) return;
    if (isSlashCommandDraft(text)) {
      slashOverlay.setFilter(text);
      tui.requestRender();
    } else {
      closeSlash();
    }
  };

  // Esc closes an open sub-agent view first; while a turn streams it aborts server-side (agent_end →
  // idle winds the spinner down). When idle it returns false so Esc falls through to the base editor.
  editor.onEscape = (): boolean => {
    if (childView) { closeSubagent(); return true; }
    if (!view.thinking) return false;
    void client.abort().catch(() => { /* already idle */ });
    return true;
  };

  const root = new Container();
  root.addChild(new TopRule(() => conversationTitle));
  const chatStack = [viewport, cardPanel, subPanel, editorSlot, promptMeta, bottomBar];
  root.addChild(new MainColumn(panelReserve, () => hasMessages() ? chatStack : [startScreen]));
  tui.addChild(root);
  tui.setFocus(editor);
  showPanel(false);

  let done!: () => void;
  const finished = new Promise<void>((r) => { done = r; });
  // 250ms: fast enough to animate the generating spinner in the prompt meta line, cheap enough to
  // leave idle sessions alone (renders fire only while a turn streams).
  const thinkingTimer = setInterval(() => {
    if (view.thinking) render();
  }, 250);
  const quit = (): void => {
    streamAc.abort();
    clearInterval(thinkingTimer);
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
      if (isPrimaryDrag && hasMessages() && viewport.isScrollbarHit(ev.x, ev.y)) {
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
          panelWidth = Math.max(36, Math.min(68, term.columns - ev.x + 1));
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
    // Background transcript/card interactions must not fire while a modal owns focus (a picker, the rename
    // input, the ask dock — which unfocus the editor — or the inline slash overlay): otherwise a click or
    // scroll inside the overlay would toggle the Todos checklist / scroll the transcript hidden underneath.
    // The start screen has no transcript, so those interactions also need a rendered chat stack.
    const noModal = editor.focused && !slashHandle && hasMessages();
    const click = mouseClick(data);
    // A sub-agent row opens the child transcript (its own registry — these rows don't expand in place).
    if (click && noModal && !childView) {
      const subId = viewport.subagentAt(click.x, click.y);
      if (subId) { void openSubagent(subId); return { consume: true }; }
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
      if (target) { void openSubagent(target); return { consume: true }; }
    }
    const wheel = mouseWheel(data);
    if (wheel && noModal) {
      viewport.scroll(wheel);
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
          notice = color.success(`✓ Copied ${n} line${n === 1 ? '' : 's'}`);
          render();
          setTimeout(() => { if (notice.includes('Copied')) { notice = ''; render(); } }, 1800);
        }
        return { consume: true };
      }
    }
    if (matchesKey(data, 'ctrl+c')) { quit(); return { consume: true }; }
    // Slash suggestions: the editor KEEPS focus while the overlay is open (typing keeps landing in the
    // input line), so only the overlay-navigation keys are stolen here — everything else falls through.
    if (editor.focused && slashHandle && slashOverlay) {
      if (matchesKey(data, 'escape')) { closeSlash(); return { consume: true }; }
      if (data === '\x1b[A' || matchesKey(data, 'up')) { slashOverlay.moveSelection(-1); tui.requestRender(); return { consume: true }; }
      if (data === '\x1b[B' || matchesKey(data, 'down')) { slashOverlay.moveSelection(1); tui.requestRender(); return { consume: true }; }
      // Tab COMPLETES the highlighted command into the input (ready for arguments); Enter runs it.
      if (data === '\t') {
        const value = slashOverlay.selectedValue();
        closeSlash();
        if (value) { editor.setText(`${value} `); tui.requestRender(); }
        return { consume: true };
      }
      if (data === '\r' || matchesKey(data, 'enter')) {
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
    const editing = editor.focused && !slashHandle;
    // No telemetry panel on the start screen — a toggle there would silently pre-hide it for later.
    if (editing && hasMessages() && matchesKey(data, 'ctrl+p')) {
      const hidden = !panelHandle?.isHidden();
      panelHandle?.setHidden(hidden);
      resizingPanel = false;
      render();
      return { consume: true };
    }
    if (editing && matchesKey(data, 'ctrl+r')) {
      cycleThinkingLevel();
      return { consume: true };
    }
    // ctrl+s: stash the current draft (LIFO, session-local); on an empty input, pop the latest one back.
    if (editing && matchesKey(data, 'ctrl+s')) {
      const draft = editor.getText();
      if (draft.trim()) {
        promptStash.push(draft);
        editor.setText('');
        notice = color.dim(`Draft stashed — ctrl+s to restore${promptStash.size > 1 ? ` (${promptStash.size} stashed)` : ''}`);
      } else {
        const restored = promptStash.pop();
        if (restored != null) { editor.setText(restored); notice = color.dim('Stashed draft restored'); }
        else notice = color.dim('no stashed draft — ctrl+s with text stashes it');
      }
      render();
      return { consume: true };
    }
    // ctrl+o cycles main conversation → each sub-agent session → back to main (opencode-style).
    if (editing && matchesKey(data, 'ctrl+o')) {
      cycleSubagent();
      return { consume: true };
    }
    if (editing && isModeToggleKey(data)) {
      workMode = workMode === 'plan' ? 'build' : 'plan';
      notice = color.dim(workMode === 'plan'
        ? 'plan mode: Orca will reason through approach, risks and tests before editing'
        : 'build mode: Orca can implement with tools');
      render();
      return { consume: true };
    }
    // '/' at an empty prompt opens the command suggestions but is NOT consumed — it falls through to the
    // editor, so the typed text (a command or a path like /var/www/x) always lives in the input line.
    if (editing && editor.getText() === '' && data === '/') {
      openSlash();
      return undefined;
    }
    if (noModal && data === '\x1b[5~') {
      viewport.scroll(4);
      tui.requestRender();
      return { consume: true };
    }
    if (noModal && data === '\x1b[6~') {
      viewport.scroll(-4);
      tui.requestRender();
      return { consume: true };
    }
    return undefined;
  });

  tui.start();
  term.write(ENABLE_MOUSE);
  // Mouse-reporting hygiene: quit() disables it on the normal path, but an uncaught throw or a
  // SIGTERM/SIGHUP would otherwise leave the user's shell spewing `[<35;…M` on every mouse move.
  const disableMouse = (): void => { try { process.stdout.write(DISABLE_MOUSE); } catch { /* tty gone */ } };
  process.once('exit', disableMouse);
  for (const sig of ['SIGTERM', 'SIGHUP'] as const) process.once(sig, () => { disableMouse(); process.exit(sig === 'SIGTERM' ? 143 : 129); });
  render();
  openStream(streamAc);
  // Reconnect restore: if a question was already parked when this client attached (daemon restart, second
  // client), re-render its picker instead of leaving the turn silently hanging until the timeout.
  if (boot?.pendingAsk) launchAsk(boot.pendingAsk.id, boot.pendingAsk.questions, boot.pendingAsk.kind);

  await finished;
}
