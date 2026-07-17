import type { Container, ProcessTerminal, TUI } from '@earendil-works/pi-tui';
import type { SlashCommandDef } from '../../brain/slashCommands.js';
import type { BrainClient } from './brainClient.js';
import type { AttachmentChips, QueuedMessages } from './components.js';
import type { LocalShellBuffer } from './localShell.js';
import type { FileIndex } from './mentions.js';
import type { ChatEditor } from './picker.js';
import type { PromptStash } from './promptHistory.js';

/** Read-only task port exposed by the application-owned lifetime. Async UI work publishes only while
 * this chat still owns the terminal, and operating-system work receives the same abort signal. */
export interface ChatTaskScope {
  readonly signal: AbortSignal;
  runApplication<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    onFulfilled: (value: T) => void,
    onRejected?: (error: Error) => void,
  ): void;
  runSession<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    onFulfilled: (value: T) => void,
    onRejected?: (error: Error) => void,
  ): void;
}

/** Fixed resources composed once by ChatApplication. Feature modules receive only the Pick they use. */
export interface ChatApplicationResources {
  readonly client: BrainClient;
  readonly tui: TUI;
  readonly term: ProcessTerminal;
  readonly editor: ChatEditor;
  readonly editorSlot: Container;
  readonly inputStack: Container;
  readonly attachmentChips: AttachmentChips;
  readonly queuedMessages: QueuedMessages;
  readonly promptStash: PromptStash;
  readonly shellContext: LocalShellBuffer;
  readonly mentionIndex: FileIndex;
  readonly commandDefs: SlashCommandDef[];
  readonly termSettings: Awaited<ReturnType<BrainClient['terminalSettings']>> | null;
  /** Project chips for the status row. Mutable, not readonly: `/cd` moves the process mid-session and
   *  these must follow it, or the CLI would keep reporting a directory it has left. Re-derived on `/cd`
   *  rather than per frame — `gitBranch` forks git, and the getter would run on every keystroke. */
  cwdLabel: string;
  branchLabel: string;
  readonly lifetime: ChatTaskScope;
}

/** Capabilities implemented by ChatApplication. Terminal transitions never live on mutable ChatState. */
export interface ChatApplicationActions {
  render(reason?: string): void;
  renderForced(reason?: string): void;
  refreshRateLimits(): Promise<void>;
  /** Signal that an agent turn has settled (the parent lane's idle). Refreshes the rail's rate-limit
   *  section, throttled to the daemon's usage-cache TTL so back-to-back turns fetch at most once, and
   *  stops the long-turn poll. */
  onTurnSettled(): void;
  /** Signal that a parent turn is running (a step arrived). Arms the 5-minute poll that keeps the rail
   *  fresh through a very long single turn; idempotent, so it is safe to call on every step. */
  onTurnActive(): void;
  refreshMeta(): Promise<void>;
  invalidateAsyncState(): void;
  quit(): void;
  suspendTerminal(): void;
  resumeTerminal(): void;
}
