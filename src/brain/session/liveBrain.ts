import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { Policy } from '../../plugins/policy.js';
import type { BrainEvent } from '../events.js';
import type { ProviderRequestProfile } from '../modelCapabilities.js';
import type { LiveEventReplay } from './liveEventReplay.js';
import type { DelegatedExecutionScope } from '../delegatedScope.js';
import type { TurnMode } from '../service/turnRequest.js';
import type { ToolSearchHandle } from '../toolSearch/toolSearchTool.js';
import type { AssessColdCompaction } from './coldStartCompaction.js';
import type { StoredChatImage } from '../chatImages.js';
import type { WorkspacePathView } from '../../plugins/pathView.js';

/** A queued mid-turn message's image attachments, in PI's ImageContent shape. */
export type QueuedImage = { type: 'image'; data: string; mimeType: string };
/** The durable/user-facing identity of a message that is still only in PI's transient queue. It becomes
 * a real transcript row at PI's `message_start`, never at HTTP admission time. */
export interface QueuedUserEcho {
  persistText: string;
  displayText: string;
  /** The clean model-facing text this message carried BEFORE any running-subagents reminder block or the
   * durable `[📎 …]` attachment marker was folded in. When Esc promotes a queued message to a fresh turn,
   * this is what the new turn re-composes from — so the block is re-derived once from live state and the
   * marker is re-appended once, instead of the stale copies being duplicated. */
  sourceText?: string;
  /** Attachments already written to disk when this message was queued. They ride here because the base64
   * only exists while the message sits in PI's transient queue: the durable row is written later, at
   * delivery, and would otherwise keep the `[📎 …]` marker with nothing left to render after a reload. */
  images?: StoredChatImage[];
  /** Work mode selected when this owner message entered PI's queue; needed if Esc promotes it to a turn. */
  mode?: 'build' | 'plan' | 'workflow';
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

/** Re-apply the live session's compaction threshold without respawning it. The live session owns this
 *  seam; the factory only supplies its implementation while assembling the session. */
export type ApplyCompaction = (proactive: boolean, atPercent: number) => void;

/** One live brain conversation: the PI session plus its settings, event fanout and per-turn context.
 *  Shared by the chat brain, the channel service and the live registry. */
export interface LiveBrain {
  session: AgentSession;
  sessionId: string;
  /** Spawn-time ownership/classification inputs that determine skills, instructions and tool composition. */
  ownerUserId: number;
  /** WHOSE personal settings this session was actually composed from (see SpawnOpts.settingsUserId) —
   *  the verified writer in a room, the owner everywhere else. Anything that re-applies a saved setting
   *  to an ALREADY LIVE session has to match on this rather than on who owns the row: a room's owner is
   *  only whoever opened it, so re-thresholding their rooms would put their personal preference back on
   *  a session composed for somebody else, one settings save later. */
  settingsUserId: number;
  direct: boolean;
  model: string;
  /** The CONFIG provider entry id the model resolved from (selection.provider, else the default first
   *  entry) — lets delegation inherit "same provider + model" without re-deriving config defaults. */
  providerId?: string;
  /** The pi provider the model belongs to (e.g. 'openai-codex', 'kimi-coding') — distinct from the config
   *  entry id above. Drives the subscription-usage rail: it selects which provider's usage service (if any)
   *  the rate-limits route polls for the active conversation. */
  provider: string;
  thinkingLevel?: string;
  /** Provider payload transforms such as configured temperature and Qwen thinking budgets. */
  requestProfile: ProviderRequestProfile;
  fastAvailable: boolean;
  thinkingLabels: Record<string, string>;
  policy: Policy;
  /** Re-apply this session's auto-compact threshold IN PLACE — PI reads its compaction settings at each
   *  check, so a saved Account change takes effect on the running conversation instead of waiting for the
   *  next respawn (model switch, rollover, daemon restart). See BrainService.applyAutoCompactSettings. */
  applyCompaction: ApplyCompaction;
  /** Live cold-start-compaction eligibility (proactive flag, breaker state, break-even estimate) —
   *  consulted by the turn runner before the first provider call of a turn that follows a provably
   *  expired prompt cache. Optional so tests and hand-built fakes without the factory seam simply never
   *  cold-compact. */
  assessColdCompaction?: AssessColdCompaction;
  /** cacheTtlMs(process.env) at the last prompt THIS process ran on this session — the TTL its provider
   *  requests were actually cached under. The cold-start gate keys on it instead of the current env, so
   *  a retention switch across a restart (long → short) cannot open the gate over a still-warm hour-long
   *  cache. Unset until this process runs a turn (rehydrated history): the gate then assumes the longest
   *  TTL, which can only delay the compaction. */
  lastRequestCacheTtlMs?: number;
  listeners: Set<(e: BrainEvent) => void>;
  /** Bounded current-run event journal + the canonical fan-out seam. Used by opt-in sub-agent stream
   *  snapshots to reconstruct output emitted before the user opened the drill-in view. */
  replay: LiveEventReplay;
  turnContext: () => TurnContextBlocks;
  /** Names of the plugin tools composed into this session — the subset a per-turn ToolPolicy allow-list
   *  may hide (the built-in elowen_ and memory_ tools stay visible). Used by applyToolVisibility to slice
   *  the model's advertised tools to what the current sender may use. */
  pluginToolNames: Set<string>;
  /** Deferred-tool state for this session, or undefined when nothing is deferred (the common case). Holds
   *  the withheld MCP tool names and the subset ToolSearch has fetched; consulted by applyToolVisibility so
   *  each turn advertises only the core plus already-fetched tools. */
  toolSearch?: ToolSearchHandle;
  /** Names of the tools composed into this session that only READ. Assembled at spawn from the same two
   *  declarations icons come from — the core's `BUILTIN_TOOL_PLAN_SAFE` and each plugin manifest's
   *  `planSafe` — so a tool's plan-safety is stated once, by whoever owns the tool. Plan mode still
   *  ADVERTISES every tool (the cached prefix must not change with the mode); anything absent from this
   *  set is treated as mutating and refused when the model tries to call it. */
  planSafeToolNames: Set<string>;
  /** True while the session runs on the user's vision-fallback model (an image turn hopped onto it). */
  visionFallback?: boolean;
  /** Exact session-scoped model profile to restore after the temporary vision fallback. */
  visionFallbackReturn?: {
    provider?: string;
    model: string;
    thinkingLevel?: string;
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
  /** Mode of the last real turn the user drove (the CLI toggle is per-request, so the daemon has no other
   *  record of it). A HOST-initiated turn carries no request of its own — a background sub-agent result is
   *  delivered through buildScope — and must not silently fall back to 'build': that would rebuild the turn
   *  without plan mode's shell clamp and re-advertise the tools plan mode withheld, letting a delivery that
   *  lands mid-planning mutate the repo.
   *
   *  Carried across every in-memory respawn (model switch, idle rollover, vision hop). It does NOT survive
   *  a daemon restart: the mode is a per-request CLI flag with no durable home, so a result drained into a
   *  freshly respawned session falls back to 'build' until the user's next real turn re-states it. */
  lastTurnMode?: TurnMode;
  /** Platform id (e.g. Discord author) of the sender whose turn is currently in flight — set at the
   *  start of a channel turn. Mid-run injection only STEERS a message into the running turn when it comes
   *  from this SAME sender, so one member can never inject instructions into another's (or the admin's)
   *  turn and inherit its policy/toolset. */
  turnSender?: string;
  /** The VERIFIED Elowen account writing the turn currently in flight, and null for an unlinked sender.
   *  Set per turn by the channel service; unset on an owner chat, which resolves its one identity from the
   *  session owner instead. The channel lock serializes turns, so it cannot change under a pass already
   *  running — and it is the only place a caller OUTSIDE the turn (a sub-agent being spawned by it) can
   *  read who is speaking.
   *
   *  Two things derive from it, and both must be derivations rather than copies: whose memories mid-turn
   *  recall may search ({@link liveRecallUserId}) and whose personal skills the turn may load
   *  ({@link contributionOwnerForSession}). Never the channel owner in either case — that would surface
   *  one person's private content into somebody else's turn in a room they share. */
  turnWriterUserId?: number | null;
  /** WHOSE personal contributions this session was actually COMPOSED from — the resolved answer of
   *  `contributionOwnerForSession` at spawn, so a turn never has to re-derive it and reach a different
   *  conclusion than the skills PI was handed and the block the system prompt already carries. Null for a
   *  session composed from the instance set alone, which includes every SHARED room: a room has no
   *  session-wide answer at all and resolves its writer per turn instead (see `announcesSkillsPerTurn`). */
  contributionUserId: number | null;
  /** name → the accounts a composed plugin tool belongs to. Present only on a SHARED room, which is the
   *  only session that composes several accounts' owner-scoped tools; every turn narrows the advertised
   *  set through it so a room member is never shown (nor told the name of) somebody else's personal MCP
   *  server. The execute gate was built from the same map at spawn. A name maps to more than one account
   *  when they share a dispatching definition for a tool they each own. */
  personalToolOwners?: ReadonlyMap<string, ReadonlySet<number>>;
  /** Image-carrying mirror of PI's native mid-turn queue (steering + follow-up), kept in sync via the
   *  `queue_update` event. PI's public queue is text-only and clearQueue() drops image attachments, so
   *  these hold what a positional queue-remove needs to re-queue the survivors WITH their images. Ordered
   *  to match queueItems([...steering, ...followUp]) so a client's positional id maps straight in. */
  queuedSteer?: QueuedMsg[];
  queuedFollowUp?: QueuedMsg[];
  /** Queue entries removed by PI immediately before their matching user `message_start`. Explicit queue
   * removal/abort clears this staging area, preventing a late callback from resurrecting a deleted row. */
  deliveringUserEchoes?: QueuedMsg[];
  /** Esc/Stop-before-first-output discard (see brainService.abort). The three fields together let a cancel
   *  that lands before the turn produced anything remove the just-sent user turn and hand its text back to
   *  the composer, while a cancel after streaming began only aborts the run:
   *  - `turnProducedOutput` — set true on the turn's first content event (spawnEventReducer); reset false
   *    when a new immediate user turn is admitted (TurnAdmission.publishAccepted). abort() reads it
   *    synchronously to decide whether there is anything to keep.
   *  - `lastAdmitted` — the durable id + display text of the immediate user turn currently awaiting output,
   *    so a discard need not scan history for the row to delete / the text to restore. Cleared when the
   *    turn settles (idle/agent_settled), so a later cancel with no new turn cannot discard a settled row.
   *  - `discardingUserTurn` — set synchronously in abort() before any await; while set, the reducer drops
   *    a content event still in flight from PI (the cancel won the first-token race). */
  turnProducedOutput?: boolean;
  lastAdmitted?: { durableId: string; text: string };
  discardingUserTurn?: string;
  /** Display-only chips for user messages typed while a MANUAL /compact runs. That compaction owns the
   *  session lock and ends idle, and PI's steer/follow-up queue only delivers inside a running turn — so the
   *  send below the compaction blocks on the lock with no PI queue entry and no chip. These surface the
   *  waiting message as a pending chip; each clears the instant its blocked turn starts. They are never in
   *  PI's native queue, so they stay distinct from the queuedSteer/queuedFollowUp mirrors above. */
  pendingCompactionEchoes?: { id: string; text: string }[];
  /** The session's resolved working directory (validated client cwd → policy root → primary project).
   *  Reused as the per-turn workDir fallback for sends that carry no client cwd (goal kickoff/continue)
   *  and re-passed on respawns (model switch, vision hop, restart) so the session cwd never silently
   *  reverts away from where the user launched their CLI. */
  workDir?: string;
  /** One-shot, model-facing notices of owner session-state changes (model/mode/rename/reasoning/cwd),
   *  drained into the NEXT turn's context as a <system-reminder> and cleared (see turnContextBuilder).
   *  Ephemeral like the mode reminder — never persisted. The durable, user-visible marker is the
   *  separate brain_session_events row emitted alongside each notice. */
  pendingSessionNotices?: string[];
  /** Id of the compaction divider this session has already been re-oriented for. A newer divider means
   *  the model just lost its plan and its bearings and gets the post-compaction <system-reminder> on
   *  its next turn (see continuity/postCompactionContext).
   *
   *  Deliberately an id compared against the store rather than a flag armed by the compaction event:
   *  the live session is not reliably resolvable at event time, so a flag could be written to nothing
   *  while clients still saw the compaction — the reminder would then silently never appear.
   *
   *  Carried across every in-memory respawn (model switch, idle rollover, vision hop) so a respawn
   *  right after a compaction does not re-send an orientation the model already had. */
  orientedForCompaction?: string;
  /** A reasoning-effort change riding out its debounce window before the visible marker lands (see
   *  scheduleReasoningMarker) — rapid ctrl+r cycling coalesces here into ONE marker showing the settled
   *  level. `baseline` is the level the transcript last reflected, `level` the latest target; the level
   *  itself is applied to the session immediately, only the marker waits. The turn runner flushes it at
   *  turn admission; LiveSessionRegistry.dispose clears it so no timer outlives its session. */
  pendingReasoningMarker?: { timer: ReturnType<typeof setTimeout>; baseline: string | undefined; level: string };
  /** The work mode of the last send on this session, so a change (build↔plan↔workflow) can be detected
   *  and recorded — mode is client-stamped per send, with no discrete daemon event of its own. */
  lastMode?: 'build' | 'plan' | 'workflow';
  /** Turns spent in the current work mode since its directive was last restated IN FULL. 0 means the
   *  turn that entered the mode; the full text returns every MODE_REMINDER_FULL_EVERY turns and the
   *  one-line restatement rides in between (see turnContextBuilder.modeTemplateFor). Carried across
   *  in-memory respawns beside lastTurnMode — a model switch is not a reason to resend the directive
   *  the model just read. A daemon restart resets it, which is correct: a fresh process has shown the
   *  model nothing. */
  modeReminderTurns?: number;
  /** Memory ids already printed into THIS context window, by either recall path. Both paths consult it,
   *  so neither re-prints what the other already delivered.
   *
   *  It lives on the session rather than the turn because that is how long the memories stay legible: a
   *  composed prompt freezes into history, so one recalled on turn 3 is still in front of the model on
   *  turn 30 and printing it again buys nothing. Measured on captured payloads before this existed —
   *  83.8% of the memory text sent was a repeat of a memory already in the same context.
   *
   *  Deliberately NOT carried across a respawn (it is absent from InPlaceRespawnState): the turn framing
   *  that carries these blocks is stripped before history is persisted, so a rehydrated conversation
   *  genuinely no longer contains them and an empty set is the truthful state. A compaction clears it for
   *  the same reason. */
  injectedMemoryIds?: Set<number>;
  /** Digests of the ambient blocks this session has already put in front of the model (see
   *  session/ambientBlock). Absent means "never sent on this session", which is why neither is carried
   *  across a respawn: like the memory dedup above, these blocks live only in turn framing that is
   *  stripped before history is persisted, so a rehydrated conversation genuinely no longer contains
   *  them and re-sending is the truthful behaviour.
   *
   *  `permissionsDigest` is an owner-chat concept and `skillsDigest` a shared-room one — a room has no
   *  interactive permission summary, and every other surface announces its skills once in its cached
   *  system prompt. */
  permissionsDigest?: string;
  skillsDigest?: string;
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
  /** Imported platform transcript rows persisted before the session manager rehydrates. */
  seedMessages?: { id: string; role: 'user' | 'assistant'; content: unknown }[];
  /** Platform channel session (Discord, …): the sender is NOT the verified Elowen owner, so the owner's
   *  full-scope Elowen* API tools are withheld — only Policy-guarded plugin tools load. ALWAYS true for
   *  a shared channel; such a session is never owner-chat, whatever role the sender holds. */
  channel?: boolean;
  /** The platform conversation is a DIRECT 1:1 chat with one verified account rather than a shared room
   *  (see `direct` in schema.sql). It stays a `channel` session in every other respect — no Elowen* tools,
   *  no owner token — but its sender's PERSONAL skills may load, because the turn-to-turn sender change
   *  that forces the instance-wide set in a room cannot happen here. */
  direct?: boolean;
  /** A shared channel whose sender holds the operator's admin role: resolves to `trusted-channel`
   *  (all-project Policy + full plugin toolset) instead of `foreign-channel`, but STILL without Elowen*
   *  tools or the owner API token. Only meaningful when `channel` is true. */
  trustedChannel?: boolean;
  /** A scheduled/unattended turn (a timer-driven plugin firing into its channel). Uses the focused
   *  `scheduled` system prompt (identity + channel-only delivery + outcome reporting) instead of the
   *  coding-agent `elowen` base + platform overlay — a timer-driven report is not an interactive session. */
  scheduled?: boolean;
  /** Reasoning effort for extended-thinking models (empty/undefined = the model default). */
  thinkingLevel?: string;
  /** Durable parent conversation for delegated sessions (usage attribution + history navigation). */
  parentSessionId?: string;
  /** Immutable execution boundary minted by the delegating turn and checked on every child respawn. */
  delegatedAccess?: DelegatedExecutionScope;
  /** WHOSE personal settings compose this session — chat model, compaction model, auto-compact
   *  thresholds and advisor style. A shared room serves several people, so its caller names the VERIFIED
   *  WRITER of the turn that is spawning: a room's owner is only whoever opened it, and their personal
   *  preferences must not answer for everybody else. Omitted on a single-sender surface (owner chat) and
   *  whenever there is no verified writer at all (an unlinked platform sender, a cron turn, instance
   *  automation), where `ownerUserId` stands. There is deliberately no per-setting override beside it:
   *  the spawner reads every one of them from this one id, so they cannot drift apart. */
  settingsUserId?: number;
  /** WHOSE personal skills (and any other owner-scoped plugin contribution) this session composes — set
   *  ONLY for a delegated child, whose caller read the writer of the delegating turn off the parent's live
   *  record. Every other session resolves its own answer from the id and its owner, and a SHARED room has
   *  no session-wide answer at all: its writer's skills are announced per turn instead. Deliberately
   *  separate from `settingsUserId`: preferences are how a room is configured to answer, while this
   *  decides whose private content a session may open. */
  contributionUserId?: number;
  /** PI's built-in auto-compaction toggle for this session (the owner's per-user setting; always on for
   *  long-lived channels). */
  autoCompact: boolean;
  /** The client-reported working directory (the CLI sends where it was launched). Validated against
   *  the policy before use — see BrainService.turnWorkDir — and preferred as the session cwd, which pi
   *  advertises to the model ("Current working directory: …"). */
  clientCwd?: string;
  /** Ephemeral exact workspace view resolved through Sandbox for this process. Never persisted or sent over IPC. */
  pathView?: WorkspacePathView;
}

/** Fallback auto-compact threshold (context-window fill %) when the user set none — also the fixed value
 *  for long-lived channels. Translated to PI's absolute reserveTokens in the session factory. */
export const DEFAULT_AUTO_COMPACT_PCT = 80;
