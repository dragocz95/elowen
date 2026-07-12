import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { Policy } from '../../plugins/policy.js';
import type { BrainEvent } from '../events.js';
import type { ProviderRequestProfile } from '../modelCapabilities.js';
import type { LiveEventReplay } from './liveEventReplay.js';
import type { DelegatedExecutionScope } from '../delegatedScope.js';

/** A queued mid-turn message's image attachments, in PI's ImageContent shape. */
export type QueuedImage = { type: 'image'; data: string; mimeType: string };
/** The durable/user-facing identity of a message that is still only in PI's transient queue. It becomes
 * a real transcript row at PI's `message_start`, never at HTTP admission time. */
export interface QueuedUserEcho {
  persistText: string;
  displayText: string;
  /** Owner CLI/web messages broadcast their user row. Platform messages were already rendered by the
   * platform sink, so they only journal the ordering marker for reconnect/drill-in snapshots. */
  publish: boolean;
}
/** One mirrored queue entry: the text we enqueued plus any image attachments PI's public queue drops.
 *  Defined here (next to the LiveBrain fields that hold them) so queueMirror.ts imports one-directionally
 *  from liveBrain and the two don't form an import cycle. */
export type QueuedMsg = {
  text: string;
  images?: QueuedImage[];
  /** PI may expand skills/templates before queueing. Captured from queue_update for exact delivery match. */
  queuedText?: string;
  echo?: QueuedUserEcho;
};

/** Volatile plugin context sampled once for a user turn and split around the user's own text. */
export interface TurnContextBlocks {
  beforeUser: string;
  afterUser: string;
}

/** One live brain conversation: the PI session plus its settings, event fanout and per-turn context.
 *  Shared by the chat brain, the channel service and the live registry. */
export interface LiveBrain {
  session: AgentSession;
  sessionId: string;
  model: string;
  /** The CONFIG provider entry id the model resolved from (selection.provider, else the default first
   *  entry) — lets delegation inherit "same provider + model" without re-deriving config defaults. */
  providerId?: string;
  thinkingLevel?: string;
  /** Resolved provider capabilities + live request switches used by `/fast` and status surfaces. */
  requestProfile: ProviderRequestProfile;
  fastAvailable: boolean;
  thinkingLabels: Record<string, string>;
  policy: Policy;
  listeners: Set<(e: BrainEvent) => void>;
  /** Bounded current-run event journal + the canonical fan-out seam. Used by opt-in sub-agent stream
   *  snapshots to reconstruct output emitted before the user opened the drill-in view. */
  replay: LiveEventReplay;
  turnContext: () => TurnContextBlocks;
  /** Names of the plugin tools composed into this session — the subset a per-turn ToolPolicy allow-list
   *  may hide (the built-in elowen_ and memory_ tools stay visible). Used by applyToolVisibility to slice
   *  the model's advertised tools to what the current sender may use. */
  pluginToolNames: Set<string>;
  /** True while the session runs on the user's vision-fallback model (an image turn hopped onto it). */
  visionFallback?: boolean;
  /** Exact session-scoped profile to restore after the temporary vision fallback. This cannot be
   *  re-derived from Account settings: the user may have selected a different provider/model, reasoning
   *  level or Fast state just for this conversation. */
  visionFallbackReturn?: {
    provider?: string;
    model: string;
    thinkingLevel?: string;
    fast: boolean;
  };
  /** SESSION-scoped YOLO override (the CLI `/yolo` command): true/false wins over the user's persisted
   *  default for this live session only. Deliberately NOT carried across respawns (model switch,
   *  restart, vision hop) — a fresh session starts back at the persisted default. */
  yoloOverride?: boolean;
  /** Epoch ms of the user's last EXPLICIT interaction with this conversation (resume via the session
   *  picker / `/resume`, a model switch, a manual compact, a reasoning-effort change). Consulted by the
   *  idle-rollover check (send()) so a deliberately reopened old conversation continues instead of being
   *  cut over to a fresh session. Unset for auto-resumed sessions (client boot). */
  interactedAt?: number;
  /** Platform id (e.g. Discord author) of the sender whose turn is currently in flight — set at the
   *  start of a channel turn. Mid-run injection only STEERS a message into the running turn when it comes
   *  from this SAME sender, so one member can never inject instructions into another's (or the admin's)
   *  turn and inherit its policy/toolset. */
  turnSender?: string;
  /** Image-carrying mirror of PI's native mid-turn queue (steering + follow-up), kept in sync via the
   *  `queue_update` event. PI's public queue is text-only and clearQueue() drops image attachments, so
   *  these hold what a positional queue-remove needs to re-queue the survivors WITH their images. Ordered
   *  to match queueItems([...steering, ...followUp]) so a client's positional id maps straight in. */
  queuedSteer?: QueuedMsg[];
  queuedFollowUp?: QueuedMsg[];
  /** Queue entries removed by PI immediately before their matching user `message_start`. Explicit queue
   * removal/abort clears this staging area, preventing a late callback from resurrecting a deleted row. */
  deliveringUserEchoes?: QueuedMsg[];
  /** The session's resolved working directory (validated client cwd → policy root → primary project).
   *  Reused as the per-turn workDir fallback for sends that carry no client cwd (goal kickoff/continue)
   *  and re-passed on respawns (model switch, vision hop, restart) so the session cwd never silently
   *  reverts away from where the user launched their CLI. */
  workDir?: string;
}

/** What it takes to spawn one live conversation — composed by BrainService.spawnLive and reused by
 *  the channel service (which delegates the actual spawn back to keep composition in one place). */
export interface SpawnOpts {
  sessionId: string;
  ownerUserId: number;
  selection: { provider?: string; model?: string };
  policy: Policy;
  /** Extra system-prompt chunks appended after the plugin fragments (e.g. a Discord role prompt). */
  extraAppend?: string[];
  /** Platform channel session (Discord, …): the sender is NOT the verified Elowen owner, so the owner's
   *  full-scope elowen_* API tools are withheld — only Policy-guarded plugin tools load. ALWAYS true for
   *  a shared channel; such a session is never owner-chat, whatever role the sender holds. */
  channel?: boolean;
  /** A shared channel whose sender holds the operator's admin role: resolves to `trusted-channel`
   *  (all-project Policy + full plugin toolset) instead of `foreign-channel`, but STILL without elowen_*
   *  tools or the owner API token. Only meaningful when `channel` is true. */
  trustedChannel?: boolean;
  /** Reasoning effort for extended-thinking models (empty/undefined = the model default). */
  thinkingLevel?: string;
  /** Initial Fast state for platform sessions; ignored when the resolved model cannot use it. */
  fast?: boolean;
  /** Durable parent conversation for delegated sessions (usage attribution + history navigation). */
  parentSessionId?: string;
  /** Immutable execution boundary minted by the delegating turn and checked on every child respawn. */
  delegatedAccess?: DelegatedExecutionScope;
  /** Which personality platform this session is: 'web'|'cli' for per-user owner chat, 'discord' for
   *  shared owner-anchored channels. Selects which active profile the personality chunk resolves from
   *  (owner's per-platform pin). Default 'web'. */
  platform?: string;
  /** PI's built-in auto-compaction toggle for this session (the owner's per-user setting; always on for
   *  long-lived channels). */
  autoCompact: boolean;
  /** Context-window fill percentage (30–95) at which PI auto-compacts — mapped to PI's reserveTokens in
   *  the factory. Channels pass the default; owner chat passes the user's %. */
  autoCompactAtPct: number;
  /** The client-reported working directory (the CLI sends where it was launched). Validated against
   *  the policy before use — see BrainService.turnWorkDir — and preferred as the session cwd, which pi
   *  advertises to the model ("Current working directory: …"). */
  clientCwd?: string;
}

/** Fallback auto-compact threshold (context-window fill %) when the user set none — also the fixed value
 *  for long-lived channels. Translated to PI's absolute reserveTokens in the session factory. */
export const DEFAULT_AUTO_COMPACT_PCT = 80;
