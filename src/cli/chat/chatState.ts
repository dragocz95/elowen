import type { BrainCard, BrainInlineArtifact } from '../../brain/events.js';
import { InlineArtifactCollection } from './inlineArtifacts.js';
import type { ProcessInfo } from '../../brain/processRegistry.js';
import type { TranscriptModel } from '../../brain/transcriptModel.js';
import type { BrainProjectWorkspaceView, BrainRateLimits, BrainStatus, BrainWorkMode, GoalView, McpServerView, PublicBrand } from './brainClient.js';
import { DEFAULT_PUBLIC_BRAND } from './brainClient.js';
import { MASCOT_ART } from './mascot.js';
import type { FrecencyMap, PendingImage } from './mentions.js';
import type { ComposeLocale } from './composeLabels.js';

export interface ChatStateSeed {
  transcript: TranscriptModel;
  notice?: string;
  modelName?: string;
  provider?: string;
  providerLabel?: string;
  usageProvider?: string;
  conversationTitle?: string;
  lineCfg?: BrainStatus['statusline'];
  usage?: BrainStatus['usage'];
  thinkingLevel?: string;
  thinkingLevels?: string[];
  thinkingLevelLabels?: Record<string, string>;
  fastOn?: boolean;
  fastAvailable?: boolean;
  lspEnabled?: boolean | null;
  workspace?: BrainProjectWorkspaceView | null;
  yoloOn?: boolean;
  workMode?: BrainWorkMode;
  cards?: BrainCard[];
  artifacts?: BrainInlineArtifact[];
  queued?: { id: string; text: string }[];
  processes?: ProcessInfo[];
  goal?: GoalView | null;
  showThoughts?: boolean;
  showMascot?: boolean;
  mascotArt?: string[] | null;
  brand?: PublicBrand;
  mentionFrecency?: FrecencyMap;
  /** Locale for localized action labels (the composing-tool hint). Defaults to English. */
  locale?: ComposeLocale;
}

/** One writable UI state for a chat application. Services mutate this instance; the transcript view is
 * always a live projection from TranscriptModel rather than a separately assigned snapshot. */
export class ChatState {
  readonly transcript: TranscriptModel;
  /** Focused child state comes only from that child's stream. Identity and persisted cards hydrate from
   *  its atomic snapshot; live usage/cards then stay current on the same lane. Parent values must never be
   *  used as fallbacks because a delegated session may select a different provider and model. */
  childView: { sessionId: string; model: string; provider: string; providerLabel: string; usageProvider: string; transcript: TranscriptModel; processes: ProcessInfo[]; loading: boolean; usage: BrainStatus['usage']; cards: BrainCard[]; artifacts: InlineArtifactCollection } | null = null;
  childAc: AbortController | null = null;
  /** The ExitPlanMode call whose decision has already been put to the user, so a replayed terminal `idle`
   *  cannot ask again. Lives on the state rather than the stream because it must outlive a stream
   *  restart — a reconnect is exactly the case it exists to survive. */
  planDecisionRaisedFor?: string;
  streamAc = new AbortController();
  notice: string;
  /** Set to true right after assigning `notice` to exempt THAT text from the frame loop's auto-expiry —
   *  for a status whose owner clears or replaces it (`… running locally…`), or a block meant to be read
   *  rather than glanced at (a goal draft). Describes the one assignment, not the slot: the frame loop
   *  consumes the flag when it first sees the new text, so the result that later replaces a pending
   *  status expires normally without its writer having to reset anything. */
  noticeSticky = false;
  modelName: string;
  /** The PUBLIC provider identity (config entry id) and the operator's label for it. Everything the user
   *  reads uses `providerLabel || provider`; `usageProvider` is the internal pi provider that keys the
   *  subscription-limit map and is never rendered. See BrainStatus for the contract. */
  provider: string;
  providerLabel: string;
  usageProvider: string;
  conversationTitle: string;
  lineCfg: BrainStatus['statusline'];
  usage: BrainStatus['usage'];
  thinkingLevel: string;
  thinkingLevels: string[];
  thinkingLevelLabels: Record<string, string>;
  fastOn: boolean;
  fastAvailable: boolean;
  lspEnabled: boolean | null;
  /** The Sandbox workspace the daemon says this conversation's next turn runs in (status poll), or null.
   *  Rendered as a marker beside the CLI's own cwd, which stays the client's directory. */
  workspace: BrainProjectWorkspaceView | null;
  yoloOn: boolean;
  mcpList: McpServerView[] | null = null;
  rateLimitsByProvider: Record<string, BrainRateLimits> = {};
  workMode: BrainWorkMode;
  cards: BrainCard[];
  readonly artifacts: InlineArtifactCollection;
  queued: { id: string; text: string }[];
  processes: ProcessInfo[];
  private currentGoal: GoalView | null;
  private goalStateRevision = 0;
  private goalCommandRevision = 0;
  listed: { id: string; title: string }[] = [];
  showThoughts: boolean;
  /** Show the mascot (start screen + rail). Local CLI-only chrome, toggled by `/maskot`. */
  showMascot: boolean;
  /** The art to draw: the built-in flame on a stock instance, the theme's own `mascot.ans` on a
   *  white-labeled one, and null when a rebranded instance ships none — the flame must not stand in
   *  for another product's mascot. Resolved once at boot; `/maskot` only toggles visibility. */
  readonly mascotArt: string[] | null;
  /** The instance's white-label brand (GET /public/theme); the built-in Elowen brand when unthemed. */
  readonly brand: PublicBrand;
  /** Locale for localized CLI action labels — resolved once at startup, read by the render frame loop. */
  readonly locale: ComposeLocale;
  pendingImages: PendingImage[] = [];
  mentionFrecency: FrecencyMap;

  /** Rows the mascot actually occupies right now — 0 when hidden or when this instance has no art.
   *  Layout math reads this rather than a boolean because the art's height is the theme's choice. */
  get mascotRows(): number {
    return this.showMascot && this.mascotArt ? this.mascotArt.length : 0;
  }

  constructor(seed: ChatStateSeed) {
    this.transcript = seed.transcript;
    this.notice = seed.notice ?? '';
    this.modelName = seed.modelName ?? '';
    this.provider = seed.provider ?? '';
    this.providerLabel = seed.providerLabel ?? '';
    this.usageProvider = seed.usageProvider ?? '';
    this.conversationTitle = seed.conversationTitle ?? '';
    this.lineCfg = seed.lineCfg ?? null;
    this.usage = seed.usage ?? null;
    this.thinkingLevel = seed.thinkingLevel ?? '';
    this.thinkingLevels = seed.thinkingLevels ?? [];
    this.thinkingLevelLabels = seed.thinkingLevelLabels ?? {};
    this.fastOn = seed.fastOn ?? false;
    this.fastAvailable = seed.fastAvailable ?? false;
    this.lspEnabled = seed.lspEnabled ?? null;
    this.workspace = seed.workspace ?? null;
    this.yoloOn = seed.yoloOn ?? false;
    this.workMode = seed.workMode ?? 'build';
    this.cards = seed.cards ?? [];
    this.artifacts = new InlineArtifactCollection(seed.artifacts ?? []);
    this.queued = seed.queued ?? [];
    this.processes = seed.processes ?? [];
    this.currentGoal = seed.goal ?? null;
    this.showThoughts = seed.showThoughts ?? true;
    this.showMascot = seed.showMascot ?? true;
    this.mascotArt = seed.mascotArt === undefined ? MASCOT_ART : seed.mascotArt;
    this.brand = seed.brand ?? DEFAULT_PUBLIC_BRAND;
    this.locale = seed.locale ?? 'en';
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
