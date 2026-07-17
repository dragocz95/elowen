import type { BrainCard } from '../../brain/events.js';
import type { ProcessInfo } from '../../brain/processRegistry.js';
import type { TranscriptModel } from '../../brain/transcriptModel.js';
import type { BrainRateLimits, BrainStatus, BrainWorkMode, GoalView, McpServerView } from './brainClient.js';
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
  goal?: GoalView | null;
  showThoughts?: boolean;
  mentionFrecency?: FrecencyMap;
}

/** One writable UI state for a chat application. Services mutate this instance; the transcript view is
 * always a live projection from TranscriptModel rather than a separately assigned snapshot. */
export class ChatState {
  readonly transcript: TranscriptModel;
  /** `usage` is the focused child's OWN context/cost, harvested from its own event lane — the parent's
   *  numbers describe a different conversation and must never be painted under a child's transcript.
   *  Null until that child reports its first step (or forever, for one restored without a live lane). */
  childView: { sessionId: string; transcript: TranscriptModel; processes: ProcessInfo[]; loading: boolean; usage: BrainStatus['usage'] } | null = null;
  childAc: AbortController | null = null;
  streamAc = new AbortController();
  notice: string;
  /** Set to true right after assigning `notice` to exempt THAT text from the frame loop's auto-expiry —
   *  for a status whose owner clears or replaces it (`… running locally…`), or a block meant to be read
   *  rather than glanced at (a goal draft). Describes the one assignment, not the slot: the frame loop
   *  consumes the flag when it first sees the new text, so the result that later replaces a pending
   *  status expires normally without its writer having to reset anything. */
  noticeSticky = false;
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
  private currentGoal: GoalView | null;
  private goalStateRevision = 0;
  private goalCommandRevision = 0;
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
    this.currentGoal = seed.goal ?? null;
    this.showThoughts = seed.showThoughts ?? true;
    this.mentionFrecency = seed.mentionFrecency ?? {};
  }

  /** Current durable/provisional goal projection. All writes go through `setGoal()` so asynchronous
   * readers can fence stale results with a monotonic revision (object identity has an ABA hole). */
  get goal(): GoalView | null { return this.currentGoal; }

  get goalRevision(): number { return this.goalStateRevision; }

  setGoal(goal: GoalView | null): number {
    this.currentGoal = goal;
    return ++this.goalStateRevision;
  }

  /** Goal HTTP commands can overlap. A separate command generation prevents an older mutation from
   * publishing merely because no SSE state write happened while a newer command was in flight. */
  beginGoalCommand(): number { return ++this.goalCommandRevision; }

  isCurrentGoalCommand(revision: number): boolean { return revision === this.goalCommandRevision; }
}
