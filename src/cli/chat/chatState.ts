import type { BrainCard } from '../../brain/events.js';
import type { ProcessInfo } from '../../brain/processRegistry.js';
import type { ChatView } from '../../brain/transcript.js';
import type { TranscriptModel } from '../../brain/transcriptModel.js';
import type { BrainRateLimits, BrainStatus, BrainWorkMode, McpServerView } from './brainClient.js';
import type { FrecencyMap, PendingImage } from './mentions.js';

export interface ChatStateSeed {
  transcript: TranscriptModel;
  notice?: string;
  modelName?: string;
  conversationTitle?: string;
  lineCfg?: BrainStatus['statusline'];
  usage?: BrainStatus['usage'];
  thinkingLevel?: string;
  thinkingLevels?: string[];
  thinkingLevelLabels?: Record<string, string>;
  fastOn?: boolean;
  fastAvailable?: boolean;
  lspEnabled?: boolean | null;
  yoloOn?: boolean;
  workMode?: BrainWorkMode;
  cards?: BrainCard[];
  queued?: { id: string; text: string }[];
  processes?: ProcessInfo[];
  showThoughts?: boolean;
  mentionFrecency?: FrecencyMap;
}

/** One writable UI state for a chat application. Services mutate this instance; the transcript view is
 * always a live projection from TranscriptModel rather than a separately assigned snapshot. */
export class ChatState {
  readonly transcript: TranscriptModel;
  childView: { sessionId: string; transcript: TranscriptModel; readonly view: ChatView; loading: boolean } | null = null;
  childAc: AbortController | null = null;
  streamAc = new AbortController();
  notice: string;
  modelName: string;
  conversationTitle: string;
  lineCfg: BrainStatus['statusline'];
  usage: BrainStatus['usage'];
  thinkingLevel: string;
  thinkingLevels: string[];
  thinkingLevelLabels: Record<string, string>;
  fastOn: boolean;
  fastAvailable: boolean;
  lspEnabled: boolean | null;
  yoloOn: boolean;
  mcpList: McpServerView[] | null = null;
  rateLimits: BrainRateLimits | null = null;
  workMode: BrainWorkMode;
  cards: BrainCard[];
  queued: { id: string; text: string }[];
  processes: ProcessInfo[];
  listed: { id: string; title: string }[] = [];
  showThoughts: boolean;
  pendingImages: PendingImage[] = [];
  mentionFrecency: FrecencyMap;

  constructor(seed: ChatStateSeed) {
    this.transcript = seed.transcript;
    this.notice = seed.notice ?? '';
    this.modelName = seed.modelName ?? '';
    this.conversationTitle = seed.conversationTitle ?? '';
    this.lineCfg = seed.lineCfg ?? null;
    this.usage = seed.usage ?? null;
    this.thinkingLevel = seed.thinkingLevel ?? '';
    this.thinkingLevels = seed.thinkingLevels ?? [];
    this.thinkingLevelLabels = seed.thinkingLevelLabels ?? {};
    this.fastOn = seed.fastOn ?? false;
    this.fastAvailable = seed.fastAvailable ?? false;
    this.lspEnabled = seed.lspEnabled ?? null;
    this.yoloOn = seed.yoloOn ?? false;
    this.workMode = seed.workMode ?? 'build';
    this.cards = seed.cards ?? [];
    this.queued = seed.queued ?? [];
    this.processes = seed.processes ?? [];
    this.showThoughts = seed.showThoughts ?? true;
    this.mentionFrecency = seed.mentionFrecency ?? {};
  }

  get view(): ChatView { return this.transcript.view; }
}
