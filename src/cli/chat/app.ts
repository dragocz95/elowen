import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { TUI, ProcessTerminal, Container, matchesKey, CombinedAutocompleteProvider } from '@earendil-works/pi-tui';
import { initTheme, getMarkdownTheme, getSelectListTheme } from '@earendil-works/pi-coding-agent';
import { chatThemeItems, color, glyph, isChatThemeName, setChatTheme } from './theme.js';
import { StatusBar, CardPanel } from './components.js';
import { ChatEditor, sessionItems, modelItems, parseModelValue, openPicker, openTextInput, openInfoModal } from './picker.js';
import { runAskFlow } from './askFlow.js';
import { BrainClient, type BrainWorkMode, type McpServerView } from './brainClient.js';
import { fromHistory, pushUser, beginAssistant, reduce, upsertCard, type ChatView } from '../../brain/transcript.js';
import { commandsFor, expandPromptCommand } from '../../brain/slashCommands.js';
import type { AskQuestion, BrainCard } from '../../brain/events.js';
import { formatK } from '../ui/text.js';
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
export function parseCommand(text: string): { cmd: 'quit' | 'new' | 'stop' | 'status' | 'restart' | 'sessions' | 'resume' | 'delete' | 'model' | 'think' | 'theme' | 'lsp' | 'mcp' | 'skills' | 'tools' | 'goal' | 'subgoal' | 'compact' | 'plan' | 'build' | 'help'; arg?: string } | null {
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
    case 'think': return { cmd: 'think', arg: m[2] };
    case 'theme': return { cmd: 'theme', arg: m[2] };
    case 'lsp': return { cmd: 'lsp' };
    case 'mcp': return { cmd: 'mcp' };
    case 'skills': return { cmd: 'skills' };
    case 'tools': return { cmd: 'tools' };
    case 'goal': return { cmd: 'goal', arg: m[2] };
    case 'subgoal': return { cmd: 'subgoal', arg: m[2] };
    case 'compact': return { cmd: 'compact' };
    case 'plan': return { cmd: 'plan', arg: m[2] };
    case 'build': return { cmd: 'build', arg: m[2] };
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

function modelMetaLine(mode: BrainWorkMode, modelName: string, thinkingLevel: string): string {
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
  const mdTheme = getMarkdownTheme();

  const client = opts.client ?? new BrainClient({ base: opts.base, token: opts.token });
  await client.start({ provider: opts.model, session: opts.session, fresh: opts.fresh });
  const boot = await client.status().catch(() => null);
  let modelName = boot?.model || opts.model || '';
  let conversationTitle = boot?.title ?? '';
  let lineCfg = boot?.statusline ?? null;
  let usage = boot?.usage ?? null;
  let thinkingLevel = boot?.thinkingLevel ?? '';
  let thinkingLevels = boot?.thinkingLevels ?? [];
  let lspEnabled: boolean | null = boot?.lspEnabled ?? null;
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
    if (st) { modelName = st.model || modelName; conversationTitle = st.title ?? conversationTitle; lineCfg = st.statusline; usage = st.usage; thinkingLevel = st.thinkingLevel ?? ''; thinkingLevels = st.thinkingLevels ?? []; cards = st.cards ?? []; lspEnabled = st.lspEnabled ?? null; }
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
  /** Ask-user-question still borrows this slot for its multi-step flow. Other pickers use modals. */
  const editorSlot = new Container();
  editorSlot.addChild(editor);
  /** Persistent card panel (ctx.emitCard — the todo checklist is the canonical one), pinned above the
   *  status line — lives in the fixed tree, NOT the rebuilt messages container, so it stays put across turns. */
  const cardPanel = new CardPanel();
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
  let currentRunSeconds = 0;
  const telemetry = new TelemetryPanel(() => ({
    usage,
    running: view.thinking,
    runSeconds: currentRunSeconds,
    workMode,
    cwd: cwdLabel,
    branch: branchLabel,
    mcp: mcpList,
    lspEnabled,
  }));
  const startScreen = new StartScreen(
    editorSlot,
    () => Math.max(12, term.rows - TOP_RULE_ROWS),
    () => ({
      modelLine: modelMetaLine(workMode, modelName, thinkingLevel),
      hints: color.faint('⏎ send · / commands · shift+tab mode'),
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

  let thinkStart = 0;
  const render = (): void => {
    if (view.thinking) {
      if (!thinkStart) thinkStart = Date.now();
    } else {
      thinkStart = 0;
    }
    currentRunSeconds = thinkStart ? Math.max(0, Math.round((Date.now() - thinkStart) / 1000)) : 0;
    viewport.setState({ view, notice, modelName, thinkingSeconds: currentRunSeconds });
    // Contextual footer: while streaming, Esc interrupts.
    bottomBar.setLeft(view.thinking
      ? color.faint('  esc interrupt   ·   /help commands   ·   ctrl+r reasoning')
      : color.faint('  ⏎ send   ·   / slash   ·   shift+tab mode   ·   ctrl+r reasoning   ·   ctrl+p telemetry'));
    const projectLine = `${color.dim(cwdLabel)}${branchLabel ? color.faint(` · ${branchLabel}`) : ''}`;
    const line = statusline(lineCfg ? { ...lineCfg, showModel: false } : null, usage, modelName);
    promptMeta.setLeft(modelMetaLine(workMode, modelName, thinkingLevel));
    promptMeta.setRight(panelVisible() || !line ? projectLine : `${color.faint(line)} ${color.faint('·')} ${projectLine}`);
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
      tui, editor, title: 'Reasoning effort',
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
      tui, editor, title: 'Terminal theme',
      items: chatThemeItems(),
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
          description: srv.running ? 'running' : srv.installed ? 'installed · starts on the first check'
            : srv.installable ? `not installed · ctrl+i installs (${srv.installHint})` : `not installed · ${srv.installHint}`,
        })),
      ];
      // ctrl+i installs the highlighted server daemon-side. In a terminal ctrl+i IS Tab (\t) — same byte.
      const installKey = (data: string, selected: { value: string } | null, close: () => void): boolean => {
        if (data !== '\t' && !matchesKey(data, 'tab')) return false;
        const srv = s.servers.find((x) => x.command === selected?.value);
        if (!srv || srv.installed) return true; // toggle row / already installed — consume, nothing to do
        if (!srv.installable) { notice = color.dim(`${srv.label} ships with its toolchain — install it with: ${srv.installHint}`); render(); return true; }
        close();
        notice = color.dim(`installing ${srv.label} (npm, this can take a minute)…`);
        render();
        void client.lspInstall(srv.command)
          .then((message) => { notice = color.dim(message); refresh(); render(); })
          .catch((e: Error) => { notice = color.error(`error: ${e.message}`); refresh(); render(); });
        return true;
      };
      openPicker({
        tui, editor,
        title: `LSP · ${s.enabled ? (s.running ? 'on · running' : 'on · idle') : 'off'}`,
        items,
        footer: 'enter toggle · ctrl+i install · esc close',
        onInput: installKey,
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
    const reserve = panelReserve();
    const width = Math.max(50, term.columns - reserve - 1);
    const overlay = new SlashOverlay(slashItems);
    overlay.setFilter(editor.getText());
    slashOverlay = overlay;
    slashHandle = tui.showOverlay(overlay, {
      anchor: 'bottom-left',
      width,
      // Tallest render: top + hint + blank + 10 items + counter + bottom = 15 rows. One less would clip
      // the bottom border whenever the counter row shows (which, with 20+ commands, is always).
      maxHeight: 15,
      margin: { top: TOP_RULE_ROWS, left: 0, right: reserve, bottom: fixedRows() },
      nonCapturing: true,
    });
    tui.requestRender();
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
      if (e.type === 'ask') { launchAsk(e.id, e.questions); return; }
      if (e.type === 'idle') {
        if (e.usage) usage = e.usage;
        // A finished turn may have just auto-titled a fresh conversation — pull the new title (and usage)
        // so the header stops showing "new conversation". Best-effort; a dropped daemon just leaves it.
        if (!conversationTitle) void refreshMeta().then(render);
      }
      if (e.type === 'step' && e.usage) usage = e.usage;
      if (e.type === 'card') cards = upsertCard(cards, e.card); // update the persistent panel (not part of the ChatView)
      // Idle rollover: the server continued this message in a FRESH conversation. The shared fold below
      // trims the transcript to the new turn; refresh the title bar / session metadata and say why.
      if (e.type === 'session') { notice = color.dim('previous conversation was idle — continuing in a fresh one'); void refreshMeta().then(render); }
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
    editor.addToHistory(trimmed); // Up-arrow recall of sent inputs (session-local, capped by the editor)
    editor.setText('');
    notice = '';
    const command = parseCommand(trimmed);
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
          void client.models().then((models) => {
            if (models.length === 0) { notice = color.dim('no models configured'); render(); return; }
            openPicker({
              tui, editor, title: 'Switch model', items: modelItems(models, modelName),
              onPick: (value) => {
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
          return;
        }
        case 'think': {
          if (thinkingLevels.length === 0) { notice = color.dim('this model has no reasoning-effort levels'); render(); return; }
          const apply = (level: string): void => {
            void client.setThinkingLevel(level).then((r) => {
              thinkingLevel = r.thinkingLevel;
              notice = '';
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
      void client.send(expanded, workMode).catch((e: Error) => { view = reduce(view, { type: 'error', message: e.message }); render(); });
      return;
    }
    view = beginAssistant(pushUser(view, trimmed));
    render();
    void client.send(trimmed, workMode).catch((e: Error) => { view = reduce(view, { type: 'error', message: e.message }); render(); });
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

  // Esc while a turn streams aborts it server-side (agent_end → idle winds the spinner down). When idle
  // it returns false so Esc falls through to the base editor instead of being swallowed.
  editor.onEscape = (): boolean => {
    if (!view.thinking) return false;
    void client.abort().catch(() => { /* already idle */ });
    return true;
  };

  const root = new Container();
  root.addChild(new TopRule(() => conversationTitle));
  const chatStack = [viewport, cardPanel, editorSlot, promptMeta, bottomBar];
  root.addChild(new MainColumn(panelReserve, () => hasMessages() ? chatStack : [startScreen]));
  tui.addChild(root);
  tui.setFocus(editor);
  showPanel(false);

  let done!: () => void;
  const finished = new Promise<void>((r) => { done = r; });
  const thinkingTimer = setInterval(() => {
    if (view.thinking) render();
  }, 1000);
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
    if (click && noModal && viewport.isThoughtRow(click.x, click.y)) {
      viewport.toggleThought(click.y);
      tui.requestRender();
      return { consume: true };
    }
    // Click the Todos header to collapse/expand the checklist. The card panel sits directly below the
    // viewport in the fixed stack, so its first row is TOP_RULE_ROWS + viewport-height + 1 (1-based).
    if (click && noModal) {
      const cardTop = TOP_RULE_ROWS + Math.max(8, term.rows - fixedRows()) + 1;
      const rel = click.y - cardTop;
      if (rel >= 0 && cardPanel.isHeaderRow(rel)) {
        cardPanel.toggleCollapsed();
        tui.requestRender();
        return { consume: true };
      }
    }
    const wheel = mouseWheel(data);
    if (wheel && noModal) {
      viewport.scroll(wheel);
      tui.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, 'ctrl+c')) { quit(); return { consume: true }; }
    // Slash suggestions: the editor KEEPS focus while the overlay is open (typing keeps landing in the
    // input line), so only the overlay-navigation keys are stolen here — everything else falls through.
    if (editor.focused && slashHandle && slashOverlay) {
      if (matchesKey(data, 'escape')) { closeSlash(); return { consume: true }; }
      if (data === '\x1b[A' || matchesKey(data, 'up')) { slashOverlay.moveSelection(-1); tui.requestRender(); return { consume: true }; }
      if (data === '\x1b[B' || matchesKey(data, 'down')) { slashOverlay.moveSelection(1); tui.requestRender(); return { consume: true }; }
      if (data === '\r' || matchesKey(data, 'enter') || data === '\t') {
        const value = slashOverlay.selectedValue();
        closeSlash();
        if (value) { editor.setText(''); editor.onSubmit?.(value); return { consume: true }; }
        // No matching command: swallow Tab, but let Enter fall through and send the text as-is.
        return data === '\t' ? { consume: true } : undefined;
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
      openThinkingPicker();
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
  if (boot?.pendingAsk) launchAsk(boot.pendingAsk.id, boot.pendingAsk.questions);

  await finished;
}
