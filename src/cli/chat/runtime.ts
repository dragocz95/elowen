import type { TUI, ProcessTerminal, Container } from '@earendil-works/pi-tui';
import type { BrainClient } from './brainClient.js';
import type { ChatEditor } from './picker.js';
import type { AttachmentChips, QueuedMessages } from './components.js';
import type { PromptStash } from './promptHistory.js';
import type { LocalShellBuffer } from './localShell.js';
import type { FileIndex } from './mentions.js';
import type { SlashCommandDef } from '../../brain/slashCommands.js';
import type { TerminalLifecycle } from './terminalLifecycle.js';
import type { ChatState } from './chatState.js';

/** The shared chat-session context: fixed wiring (client, TUI, editor…), the mutable per-session
 *  state every module reads and writes, and the few cross-module callbacks (render/refreshMeta/quit)
 *  that runChat wires up. Created once in runChat and passed to the module factories — deliberately
 *  just state + callbacks, no behavior of its own. */
export interface ChatRuntime extends ChatState {
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

  // ── lifecycle handle (assigned after the shell exists) ──
  terminalLifecycle: TerminalLifecycle | null;

  // ── callbacks wired in runChat ──
  render(reason?: string): void;
  renderForced(reason?: string): void;
  /** Slow, best-effort metadata refresh kept outside refreshMeta's blocking status/MCP path. */
  refreshRateLimits(): Promise<void>;
  refreshMeta(): Promise<void>;
  /** Fence metadata/rate-limit promises that started before a session selection or teardown. */
  invalidateAsyncState(): void;
  quit(): void;
}
