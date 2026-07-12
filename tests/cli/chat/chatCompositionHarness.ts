import { Container, isFocusable } from '@earendil-works/pi-tui';
import type { Component, OverlayOptions, OverlayHandle, TUI } from '@earendil-works/pi-tui';
import { getMarkdownTheme, getSelectListTheme } from '@earendil-works/pi-coding-agent';
import { TranscriptModel } from '../../../src/brain/transcriptModel.js';
import { AttachmentChips, QueuedMessages } from '../../../src/cli/chat/components.js';
import { ChatEditor } from '../../../src/cli/chat/picker.js';
import { ChatState } from '../../../src/cli/chat/chatState.js';
import { LocalShellBuffer } from '../../../src/cli/chat/localShell.js';
import { PromptStash } from '../../../src/cli/chat/promptHistory.js';
import type { BrainClient } from '../../../src/cli/chat/brainClient.js';
import type { ChatApplicationResources } from '../../../src/cli/chat/chatCapabilities.js';
import type { StreamCoordinatorPort } from '../../../src/cli/chat/streamCoordinator.js';
import type { TuiDiagnostics } from '../../../src/cli/chat/tuiDiagnostics.js';
import { ChatApplicationLifetime } from '../../../src/cli/chat/applicationLifetime.js';

type InputResult = { consume?: boolean; data?: string } | undefined;
type InputListener = (data: string) => InputResult;

interface NativeOverlayRecord {
  component: Component;
  options?: OverlayOptions;
  removed: boolean;
  hidden: boolean;
  focused: boolean;
}

class HarnessTerminal {
  writes: string[] = [];
  constructor(public columns = 80, public rows = 24) {}
  write(data: string): void { this.writes.push(data); }
}

/** Minimal behavioral PI boundary: controllers replace requestRender/showOverlay exactly as in production,
 * while tests can drive the real focused component and inspect the real root component. */
class HarnessTui {
  readonly children: Component[] = [];
  readonly listeners = new Set<InputListener>();
  readonly overlays: NativeOverlayRecord[] = [];
  readonly renderRequests: boolean[] = [];
  focused: Component | null = null;
  starts = 0;
  stops = 0;

  constructor(readonly terminal: HarnessTerminal) {}

  addChild(component: Component): void { this.children.push(component); }
  setFocus(component: Component | null): void {
    if (isFocusable(this.focused)) this.focused.focused = false;
    this.focused = component;
    if (isFocusable(component)) component.focused = true;
  }
  addInputListener(listener: InputListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  requestRender(force = false): void { this.renderRequests.push(force); }
  start(): void { this.starts++; }
  stop(): void { this.stops++; }

  showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
    const record: NativeOverlayRecord = {
      component, options, removed: false, hidden: false, focused: !options?.nonCapturing,
    };
    this.overlays.push(record);
    const handle: OverlayHandle = {
      hide: () => { record.removed = true; record.focused = false; },
      setHidden: (hidden) => { record.hidden = hidden; if (hidden) record.focused = false; },
      isHidden: () => record.hidden,
      focus: () => { if (!record.removed && !record.hidden) record.focused = true; },
      unfocus: () => { record.focused = false; },
      isFocused: () => record.focused,
    };
    return handle;
  }

  emit(data: string): InputResult {
    let routed = data;
    for (const listener of this.listeners) {
      const result = listener(routed);
      if (result?.consume) return result;
      if (result?.data != null) routed = result.data;
    }
    this.focused?.handleInput?.(routed);
    return undefined;
  }
}

interface CompositionHarness {
  term: HarnessTerminal;
  tui: HarnessTui;
  rt: ChatState;
  resources: ChatApplicationResources;
  stream: StreamCoordinatorPort;
  diagnostics: TuiDiagnostics;
  mdTheme: ReturnType<typeof getMarkdownTheme>;
}

export function compositionHarness(options: {
  columns?: number;
  rows?: number;
  turns?: number;
} = {}): CompositionHarness {
  const term = new HarnessTerminal(options.columns ?? 80, options.rows ?? 24);
  const tuiImpl = new HarnessTui(term);
  const tui = tuiImpl as unknown as TUI;
  const editor = new ChatEditor(tui, { borderColor: (value) => value, selectList: getSelectListTheme() }, {});
  const editorSlot = new Container();
  editorSlot.addChild(editor);
  const attachmentChips = new AttachmentChips();
  const queuedMessages = new QueuedMessages();
  const inputStack = new Container();
  inputStack.addChild(queuedMessages);
  inputStack.addChild(attachmentChips);
  inputStack.addChild(editorSlot);

  const history = Array.from({ length: options.turns ?? 24 }, (_, index) => [
    { role: 'user' as const, text: `question ${index}` },
    { role: 'assistant' as const, text: `answer ${index} with enough text to occupy one transcript row` },
  ]).flat();
  const state = new ChatState({
    transcript: new TranscriptModel(history),
    modelName: 'test/provider-model',
    conversationTitle: 'Harness conversation',
    thinkingLevel: 'medium',
    thinkingLevelLabels: { medium: 'medium' },
    showThoughts: true,
  });
  const client = {
    killProcess: async () => true,
    processes: async () => [],
    abort: async () => {},
    queueRemove: async () => true,
  };
  const resources = {
    client: client as unknown as BrainClient,
    tui,
    term: term as unknown as ChatApplicationResources['term'],
    editor,
    editorSlot,
    inputStack,
    attachmentChips,
    queuedMessages,
    promptStash: new PromptStash(),
    shellContext: new LocalShellBuffer(),
    mentionIndex: { files: () => [], refreshIfStale: () => {} },
    commandDefs: [{ name: 'help', description: 'Show help' }],
    termSettings: null,
    cwdLabel: '~/elowen',
    branchLabel: 'test',
    lifetime: new ChatApplicationLifetime<'metadata'>(),
  } satisfies ChatApplicationResources;
  const stream = {
    subagentStates: () => [],
    openSubagent: async () => {},
    closeSubagent: () => {},
    cycleSubagent: () => {},
    openStream: () => {},
    switchTo: async () => {},
    stop: () => {},
  } as StreamCoordinatorPort;
  const diagnostics: TuiDiagnostics = {
    enabled: false,
    path: null,
    record: () => {},
    close: async () => {},
  };
  return { term, tui: tuiImpl, rt: state, resources, stream, diagnostics, mdTheme: getMarkdownTheme() };
}
