import type { TUI, ProcessTerminal, Container } from '@earendil-works/pi-tui';
import type { BrainClient, BrainRateLimits, BrainStatus, BrainWorkMode, McpServerView } from './brainClient.js';
import type { ChatEditor } from './picker.js';
import type { AttachmentChips, QueuedMessages } from './components.js';
import type { PromptStash } from './promptHistory.js';
import type { LocalShellBuffer } from './localShell.js';
import type { FileIndex, FrecencyMap, PendingImage } from './mentions.js';
import type { ChatView } from '../../brain/transcript.js';
import type { BrainCard } from '../../brain/events.js';
import type { ProcessInfo } from '../../brain/processRegistry.js';
import type { SlashCommandDef } from '../../brain/slashCommands.js';

/** The shared chat-session context: fixed wiring (client, TUI, editor…), the mutable per-session
 *  state every module reads and writes, and the few cross-module callbacks (render/refreshMeta/quit)
 *  that runChat wires up. Created once in runChat and passed to the module factories — deliberately
 *  just state + callbacks, no behavior of its own. */
export interface ChatRuntime {
  // ── fixed wiring (created once in runChat, never reassigned) ──
  readonly client: BrainClient;
  readonly tui: TUI;
  readonly term: ProcessTerminal;
  readonly editor: ChatEditor;
  /** Ask-user-question still borrows this slot for its multi-step flow. Other pickers use modals. */
  readonly editorSlot: Container;
  /** The chips ride in a fixed wrapper OUTSIDE editorSlot: the ask/approval flows clear that slot,
   *  and pending attachments must survive them. This wrapper is what the layout stacks render. */
  readonly inputStack: Container;
  readonly attachmentChips: AttachmentChips;
  /** The pending mid-turn message queue strip, rendered above the composer inside `inputStack`. Driven
   *  from `queued` in the render pass (mirrors how `attachmentChips` follows `pendingImages`). */
  readonly queuedMessages: QueuedMessages;
  /** ctrl+s draft stash — session-local LIFO (see PromptStash). */
  readonly promptStash: PromptStash;
  /** `!cmd` results waiting to ride along with the next prompt sent to the brain. */
  readonly shellContext: LocalShellBuffer;
  /** `@` mentions: the session file index (git ls-files/walk). */
  readonly mentionIndex: FileIndex;
  readonly commandDefs: SlashCommandDef[];
  readonly termSettings: Awaited<ReturnType<BrainClient['terminalSettings']>> | null;
  readonly cwdLabel: string;
  readonly branchLabel: string;

  // ── mutable session state ──
  view: ChatView;
  /** Drill-in to a delegated sub-agent's session (opened by clicking its row/panel entry or ctrl+o).
   *  Fully interactive: its own live tap stream feeds the view and the input steers the child. The
   *  server's ACTIVE conversation stays the parent — Esc returns without any server round-trip. */
  childView: { sessionId: string; view: ChatView; loading: boolean } | null;
  childAc: AbortController | null;
  streamAc: AbortController;
  /** Transient system lines (help, session list, errors) rendered under the conversation. */
  notice: string;
  modelName: string;
  conversationTitle: string;
  lineCfg: BrainStatus['statusline'];
  usage: BrainStatus['usage'];
  thinkingLevel: string;
  thinkingLevels: string[];
  thinkingLevelLabels: Record<string, string>;
  /** OpenAI OAuth fast mode is session-scoped and only offered when the live model supports it. */
  fastOn: boolean;
  fastAvailable: boolean;
  lspEnabled: boolean | null;
  /** Effective YOLO (session /yolo override, else the persisted Account default) — server-authoritative,
   *  refreshed with every status fetch; drives the warning chip in the prompt meta line. */
  yoloOn: boolean;
  /** MCP servers for the telemetry panel; null (fetch failed / non-admin) hides the section. */
  mcpList: McpServerView[] | null;
  /** OpenAI OAuth subscription windows. Null on other providers/accounts and while not yet available. */
  rateLimits: BrainRateLimits | null;
  workMode: BrainWorkMode;
  /** Live display cards (ctx.emitCard) — a persistent panel above the status bar, tracked outside the
   *  ChatView like `usage`. Seeded from status (survives reconnect) and updated on each `card` event. */
  cards: BrainCard[];
  /** Pending mid-turn messages (server-authoritative snapshot) — messages typed while a turn streams,
   *  parked until it ends. Seeded from status, replaced on each `queue` event; rendered as dim QUEUED
   *  lines above the input. Tracked outside the ChatView (like `cards`). */
  queued: { id: string; text: string }[];
  /** The owner's live background shell processes — a persistent panel above the input, tracked outside
   *  the ChatView (like `cards`). Boot-seeded from GET /brain/processes, then replaced on each `process`
   *  snapshot event (spawn/exit/kill). Only the running ones render, so it costs no rows at rest. */
  processes: ProcessInfo[];
  /** The last /sessions listing, so /resume <n> can address by number. */
  listed: { id: string; title: string }[];
  showThoughts: boolean;
  /** Images parked for the next send (`/paste`, `@clipboard`, `@image.png`) — shown as a chip row. */
  pendingImages: PendingImage[];
  /** The persisted per-project `@` mention frecency. */
  mentionFrecency: FrecencyMap;

  // ── callbacks wired in runChat ──
  render(): void;
  /** Slow, best-effort metadata refresh kept outside refreshMeta's blocking status/MCP path. */
  refreshRateLimits(): Promise<void>;
  refreshMeta(): Promise<void>;
  quit(): void;
}
