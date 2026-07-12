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
  run<T>(
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
  readonly cwdLabel: string;
  readonly branchLabel: string;
  readonly lifetime: ChatTaskScope;
}

/** Capabilities implemented by ChatApplication. Terminal transitions never live on mutable ChatState. */
export interface ChatApplicationActions {
  render(reason?: string): void;
  renderForced(reason?: string): void;
  refreshRateLimits(): Promise<void>;
  refreshMeta(): Promise<void>;
  invalidateAsyncState(): void;
  quit(): void;
  suspendTerminal(): void;
  resumeTerminal(): void;
}
