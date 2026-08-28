import { randomUUID } from 'node:crypto';
import type { BrainStore } from '../store/brainStore.js';
import type { ProjectStore } from '../store/projectStore.js';
import type { KnownControls, PlatformHistory, PlatformHistoryMessage, SandboxExecutionLease } from '../plugins/api.js';
import type { Policy } from '../plugins/policy.js';
import type { TurnIdentity, ToolPolicy } from '../plugins/policyContext.js';
import type { PlatformSenderAttribution } from './identity.js';
import { runWithPolicy } from '../plugins/policyContext.js';
import { createWorkspacePathView, type WorkspacePathView } from '../plugins/pathView.js';
import {
  delegatedToolPolicy,
  normalizeDelegatedExecutionScope,
  type DelegatedExecutionScope,
} from './delegatedScope.js';
import type { AskQuestion, BrainEvent, BrainUsage, CompactResult, SubagentCompletion, SubagentUpdate, WorkflowCompletion, WorkflowUpdate } from './events.js';
import { recordSubagentFinishMarker, recordWorkflowFinishMarker, visibleSubagentUpdate, workDirReorientation } from './service/sessionEvents.js';
import { runCompaction, withDescendantUsage, sessionUsageSnapshot } from './events.js';
import type { ElicitationRegistry } from './elicitation.js';
import type { CardRegistry } from './cards.js';
import { projectUserTurn } from './persistence.js';
import { attachmentTurnNote, storeChannelAttachments, unstoredAttachmentTurnNote, type ChannelAttachment, type ChannelUploadDeps } from './channelAttachments.js';
import { newCostMeter, runWithMeter } from './openrouterMeter.js';
import { markDelegationInCurrentTool } from './stepDrain.js';
import { extractText, isThinkingOnlyReply, NO_REPLY_NUDGE, lastAssistant } from './messageView.js';
import { resolvesContributionsPerTurn, channelSessionId, archivedChannelSessionId, contributionOwnerForSession, isChannelSession, isSubagentSession, channelIdOf, mayDeliverToSession } from './sessionId.js';
import { isPromptCommand } from './slashCommands.js';
import { rolloverDue, SESSION_IDLE_ROLLOVER_MS } from './session/idleRollover.js';
import { drainPostCompactionContext } from './continuity/postCompactionContext.js';
import { composeTurnPrompt } from './session/turnPrompt.js';
import { turnSkillsBlock } from './session/turnSkills.js';
import { settleTurn, titleTurnConversation } from './session/turnSettled.js';
import { maybeColdStartCompaction } from './session/coldStartCompaction.js';
import { cacheTtlMs } from './session/cacheTiming.js';
import { recallMemoryBlock } from './session/memoryBlock.js';
import { pluginContextBlock } from './session/pluginContextBlock.js';
import { runningSubagentsBlock } from './session/runningSubagents.js';
import type { PluginRegistry } from '../plugins/registry.js';
import type { HookAuditBuffer } from '../shared/hookAudit.js';
import { applyToolVisibility } from './session/capabilities.js';
import { buildPermissionRuleset, noninteractiveTurnPermissions } from './toolPermissions.js';
import type { PermissionSettings, TurnPermissions } from './toolPermissions.js';
import type { MemoryService } from './memoryService.js';
import type { MemoryCategoryStore } from '../store/memoryCategoryStore.js';
import { globalMemoryRecallScope } from './memoryRecallScope.js';
import { effectiveTurnWorkDir, turnWorkDir } from './service/workDir.js';
import type { MemoryCurator } from './memoryCurator.js';
import type { ConversationTitler } from './conversationTitler.js';
import type { LiveSessionRegistry } from './session/liveRegistry.js';
import type { LiveBrain, QueuedUserEcho, SpawnOpts } from './session/liveBrain.js';
import { clearDeliveredUserEchoes, echoDeliveredId, enqueueMirrored } from './session/queueMirror.js';
import { abortSessionWork } from './session/abortSessionWork.js';
import { steerCustomMessage } from './session/steerCustomMessage.js';
import { execRefSpec } from '../shared/execs.js';

/** How a delegated steer ended: `delivered` = the message provably reached the child's context (its
 *  durable user row exists); `idle` = the child was not mid-turn here, or its turn ended before the queue
 *  drained the message — which was then removed, so the caller can (and must) deliver it another way. */
export type DelegatedSteerOutcome = 'delivered' | 'idle';

/** How often a pending delegated steer re-checks the child's transcript/queue for its verdict. */
const STEER_POLL_MS = 100;
const PLATFORM_HISTORY_MAX_ITEMS = 100;
const PLATFORM_HISTORY_MAX_CHARS = 6_000;
const PLATFORM_HISTORY_MAX_TEXT = 1_200;

type SeededSessionMessage = { id: string; role: 'user' | 'assistant'; content: { role: 'user' | 'assistant'; content: unknown } };

const boundedHistoryString = (value: unknown, max: number): string => String(value ?? '').trim().slice(0, max);

type PlatformEnvelope = {
  source: 'platform_history' | 'platform_message';
  untrusted: true;
  platform: string;
  channelId: string;
  messageId?: string;
  author?: { id?: string; name?: string };
  timestamp?: string;
  text: string;
  attachments?: { name?: string; mimeType?: string; kind: 'image' | 'file' | 'audio' | 'video' | 'unknown' }[];
};

/** One stable serializer for live platform turns and history backfill. Persist exactly what the model sees
 *  so a rehydrated session never rewrites old attribution or invalidates an already-cached prefix. */
export function serializePlatformEnvelope(envelope: PlatformEnvelope): string {
  return JSON.stringify(envelope);
}

/** Everything a later boot needs to reconstruct an ordinary platform channel turn faithfully — the
 *  durable foundation such turns need before they can ever be parked and resumed. Captured by send()
 *  when the turn starts, deleted when it settles, so a surviving row names an interrupted turn.
 *
 *  Two rules govern this shape:
 *  - AUTHORITY IS NEVER STORED. Only the verified ACCOUNT id is carried; the policy is re-derived from
 *    that account at resume time by {@link resolvePlatformTurnAuthority}, and an account that no longer
 *    resolves REFUSES the resume instead of falling back to anyone else's authority. The one permission
 *    field replayed is the deny union, because a deny can only narrow.
 *  - PROMPT INPUTS ARE VERBATIM. `promptAppend` (plugin platform prompts + the room fragment) and
 *    `turnText` (the exact serialized string the model and the durable user row received) are captured
 *    byte-for-byte, never recomputed on resume: a recompute against live state — a renamed room, a
 *    reloaded plugin — would change an already-cached prefix and re-bill the whole context. */
export interface PlatformTurnResumeEnvelope {
  v: 1;
  platform: string;
  /** The orchestrator's registry channel key (`<platform>-<thread-or-channel>`), from which the durable
   *  session id is re-derived (channelSessionId). */
  channelId: string;
  /** The session owner resolved for THIS turn (post-rollover): prompt composition (personal skills,
   *  account instructions, auto-compact threshold) keys on it. */
  ownerUserId: number;
  direct: boolean;
  /** The live turn ran as trusted-channel (admin ROOM role). Recorded because it shaped the live
   *  session's composition, but it is a room-role fact that storage cannot re-verify — the authority
   *  resolver deliberately ignores it and returns the account's own policy. */
  trusted: boolean;
  scheduled: boolean;
  /** The verified Elowen account behind the turn. null = unlinked sender or accountless instance
   *  automation, which is never resumable (the resolver refuses it). */
  accountUserId: number | null;
  sender?: { id: string; name: string };
  identity: {
    platform: string;
    userId: string;
    elowenUserId?: number;
    elowenUsername?: string;
    admin: boolean;
    owner: boolean;
    conversation: 'direct' | 'shared';
  };
  /** Spawn-time prompt append, VERBATIM bytes. */
  promptAppend?: string[];
  /** The deny union in effect on the live turn (account denies + turn-level `access.denyTools`).
   *  Replay-safe: the resolver unions it with the account's CURRENT denies, so it only ever narrows. */
  deniedTools?: string[];
  model?: { provider?: string; model?: string };
  thinkingLevel?: string;
  idleRolloverMs?: number;
  /** Opaque outbound destination — present only for verified direct chats, exactly as on the live turn. */
  deliveryTarget?: string;
  historyPlatform?: string;
  promptCommand: boolean;
  /** The EXACT string that went to the model and the durable user row (attachment marker and shared-room
   *  serialization included) — never re-serialized on resume. */
  turnText: string;
  /** The sender's clean words (title/curator input). */
  senderText: string;
  /** Image attachments ride only the live prompt (base64, never persisted here) — the count records that
   *  a resume cannot reproduce them. */
  imageCount?: number;
  capturedAt: string;
}

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isOptionalString = (value: unknown): value is string | undefined => value === undefined || typeof value === 'string';
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');
const isAccountId = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);

/** Validate a stored envelope read back from SQLite. The row is durable data parsed long after the code
 *  that wrote it, so everything is checked structurally; anything malformed or of an unknown version is
 *  null — callers fail closed rather than resuming a turn they cannot faithfully reconstruct. Unknown
 *  keys are dropped, known keys are copied field-by-field so the result is exactly the declared shape. */
export function normalizePlatformTurnEnvelope(raw: unknown): PlatformTurnResumeEnvelope | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (e.v !== 1) return null;
  if (!isNonEmptyString(e.platform) || !isNonEmptyString(e.channelId)) return null;
  if (!isAccountId(e.ownerUserId)) return null;
  if (typeof e.direct !== 'boolean' || typeof e.trusted !== 'boolean' || typeof e.scheduled !== 'boolean') return null;
  if (e.accountUserId !== null && !isAccountId(e.accountUserId)) return null;
  const sender = e.sender as Record<string, unknown> | undefined;
  if (sender !== undefined && (typeof sender !== 'object' || sender === null
    || !isNonEmptyString(sender.id) || typeof sender.name !== 'string')) return null;
  const identity = e.identity as Record<string, unknown> | null;
  if (typeof identity !== 'object' || identity === null
    || !isNonEmptyString(identity.platform) || !isNonEmptyString(identity.userId)
    || !isOptionalString(identity.elowenUsername)
    || (identity.elowenUserId !== undefined && !isAccountId(identity.elowenUserId))
    || typeof identity.admin !== 'boolean' || typeof identity.owner !== 'boolean'
    || (identity.conversation !== 'direct' && identity.conversation !== 'shared')) return null;
  if (e.promptAppend !== undefined && !isStringArray(e.promptAppend)) return null;
  if (e.deniedTools !== undefined && !isStringArray(e.deniedTools)) return null;
  const model = e.model as Record<string, unknown> | undefined;
  if (model !== undefined && (typeof model !== 'object' || model === null
    || !isOptionalString(model.provider) || !isOptionalString(model.model))) return null;
  if (!isOptionalString(e.thinkingLevel)) return null;
  if (e.idleRolloverMs !== undefined && !(typeof e.idleRolloverMs === 'number' && Number.isFinite(e.idleRolloverMs))) return null;
  if (!isOptionalString(e.deliveryTarget) || !isOptionalString(e.historyPlatform)) return null;
  if (typeof e.promptCommand !== 'boolean') return null;
  if (typeof e.turnText !== 'string' || typeof e.senderText !== 'string') return null;
  if (e.imageCount !== undefined && !(typeof e.imageCount === 'number' && Number.isInteger(e.imageCount) && e.imageCount >= 0)) return null;
  if (!isNonEmptyString(e.capturedAt)) return null;
  return {
    v: 1,
    platform: e.platform,
    channelId: e.channelId,
    ownerUserId: e.ownerUserId,
    direct: e.direct,
    trusted: e.trusted,
    scheduled: e.scheduled,
    accountUserId: e.accountUserId,
    ...(sender ? { sender: { id: sender.id as string, name: sender.name as string } } : {}),
    identity: {
      platform: identity.platform as string,
      userId: identity.userId as string,
      ...(identity.elowenUserId !== undefined ? { elowenUserId: identity.elowenUserId as number } : {}),
      ...(identity.elowenUsername !== undefined ? { elowenUsername: identity.elowenUsername } : {}),
      admin: identity.admin,
      owner: identity.owner,
      conversation: identity.conversation,
    },
    ...(e.promptAppend !== undefined ? { promptAppend: [...e.promptAppend] } : {}),
    ...(e.deniedTools !== undefined ? { deniedTools: [...e.deniedTools] } : {}),
    ...(model !== undefined ? { model: {
      ...(model.provider !== undefined ? { provider: model.provider as string } : {}),
      ...(model.model !== undefined ? { model: model.model as string } : {}),
    } } : {}),
    ...(e.thinkingLevel !== undefined ? { thinkingLevel: e.thinkingLevel } : {}),
    ...(e.idleRolloverMs !== undefined ? { idleRolloverMs: e.idleRolloverMs } : {}),
    ...(e.deliveryTarget !== undefined ? { deliveryTarget: e.deliveryTarget } : {}),
    ...(e.historyPlatform !== undefined ? { historyPlatform: e.historyPlatform } : {}),
    promptCommand: e.promptCommand,
    turnText: e.turnText,
    senderText: e.senderText,
    ...(e.imageCount !== undefined ? { imageCount: e.imageCount } : {}),
    capturedAt: e.capturedAt,
  };
}

/** How a resume derives WHO a captured turn runs as. `resolvePlatformUser` re-proves the platform
 *  sender → account binding (the daemon's own link resolver; null = no longer linked), and
 *  `policyForUser` must return undefined when the account no longer resolves — deleted, unlinked,
 *  whatever — which this seam turns into a refusal. Deliberately a different contract from the
 *  orchestrator's live `policyForUser` (which assumes an authenticated inbound sender): here both the
 *  binding and the account are stored claims that must be re-proven. */
export interface PlatformTurnAuthorityDeps {
  resolvePlatformUser: (platform: string, platformUserId: string) => { id: number } | null;
  policyForUser: (userId: number) => Policy | undefined;
  /** The account's CURRENT tool authority (toolAuthorityForUser): the fail-closed allow grant plus its
   *  denies. REQUIRED, not optional — an omitted seam here would resolve to "no allow list", which reads
   *  as unrestricted and would hand a resumed turn the whole catalogue the account was never granted.
   *  A caller that cannot resolve authority must refuse the resume, not widen it. */
  toolAuthorityFor: (userId: number) => ToolPolicy | undefined;
}

/** Re-prove ONE captured platform sender → account binding, or throw.
 *
 *  The captured account id is a stored CLAIM about who the platform sender was. The live path proves that
 *  binding on every inbound message (resolvePlatformUser); anything acting on a captured turn must prove
 *  it again, because the sender may have unlinked — or the platform id may have been claimed by a
 *  different account — while the daemon was down. An account row merely existing is not that proof.
 *
 *  Split out of {@link resolvePlatformTurnAuthority} because re-DELIVERING an already computed answer
 *  needs exactly this proof and nothing else: it runs no model and holds no tools, so it has no use for
 *  a policy — but it must not become a back door around the check. One proof, two callers. */
export function provePlatformSenderBinding(
  claim: { platform: string; platformUserId: string; accountUserId: number | null },
  resolvePlatformUser: (platform: string, platformUserId: string) => { id: number } | null,
): number {
  if (claim.accountUserId === null) {
    throw new Error('captured platform turn has no verified account — refusing to resume it');
  }
  const linked = resolvePlatformUser(claim.platform, claim.platformUserId);
  if (!linked || linked.id !== claim.accountUserId) {
    throw new Error(`captured platform identity ${claim.platform}/${claim.platformUserId} `
      + `no longer links to account ${claim.accountUserId} — refusing to resume it`);
  }
  return claim.accountUserId;
}

/** Re-derive a captured platform turn's authority from its ACCOUNT — never from the envelope. An
 *  envelope with no verified account, or whose account no longer resolves, throws: the correct answer
 *  to unresolvable authority is refusal, not a fallback to operator (or any other) authority. The
 *  stored `trusted` room-role elevation is deliberately NOT honored here — a room role cannot be
 *  re-verified from storage, so a resumed turn gets the account's own policy and nothing wider. */
export function resolvePlatformTurnAuthority(
  envelope: PlatformTurnResumeEnvelope,
  deps: PlatformTurnAuthorityDeps,
): { accountUserId: number; policy: Policy; toolPolicy?: ToolPolicy } {
  const accountUserId = provePlatformSenderBinding({
    platform: envelope.identity.platform,
    platformUserId: envelope.identity.userId,
    accountUserId: envelope.accountUserId,
  }, deps.resolvePlatformUser);
  const policy = deps.policyForUser(accountUserId);
  if (!policy) {
    throw new Error(`captured platform turn account ${accountUserId} no longer resolves — refusing to resume it`);
  }
  // The account's CURRENT authority, re-resolved like everything else here — the envelope is a claim
  // about the past, not a grant. `allow` is the fail-closed grant an admin gave the account and must
  // survive the replay: dropping it would let a resumed turn reach tools the live turn could not, which
  // is the one direction a resume must never move. `deny` unions the account's denies with the envelope's
  // replayed set, because a deny can only ever narrow.
  const authority = deps.toolAuthorityFor(accountUserId);
  const denied = new Set([
    ...(authority?.deny ?? []),
    ...(envelope.deniedTools ?? []),
  ]);
  const toolPolicy: ToolPolicy = {
    ...(authority?.allow ? { allow: authority.allow } : {}),
    ...(denied.size ? { deny: denied } : {}),
  };
  return {
    accountUserId,
    policy,
    ...(toolPolicy.allow || toolPolicy.deny ? { toolPolicy } : {}),
  };
}

/** Convert adapter history into real transcript messages. Every body is a JSON envelope so provenance is
 *  explicit and arbitrary platform text cannot masquerade as a fresh unframed request. */
function platformHistorySeed(history: PlatformHistory, platform: string, channelId: string): SeededSessionMessage[] {
  const source: PlatformHistoryMessage[] = typeof history === 'string'
    ? (history.trim() ? [{ role: 'user', text: history.trim(), author: { name: 'Platform history' } }] : [])
    : [...history];
  const selected: SeededSessionMessage[] = [];
  let chars = 0;
  for (const message of source.slice(-PLATFORM_HISTORY_MAX_ITEMS).reverse()) {
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;
    const text = boundedHistoryString(message.text, PLATFORM_HISTORY_MAX_TEXT);
    if (!text) continue;
    const attachments = (message.attachments ?? []).slice(0, 8).map((attachment) => ({
      ...(boundedHistoryString(attachment.name, 200) ? { name: boundedHistoryString(attachment.name, 200) } : {}),
      ...(boundedHistoryString(attachment.mimeType, 120) ? { mimeType: boundedHistoryString(attachment.mimeType, 120) } : {}),
      kind: attachment.kind ?? 'unknown',
    }));
    const envelope = serializePlatformEnvelope({
      source: 'platform_history',
      untrusted: true,
      platform,
      channelId,
      ...(boundedHistoryString(message.id, 256) ? { messageId: boundedHistoryString(message.id, 256) } : {}),
      ...(message.author ? { author: {
        ...(boundedHistoryString(message.author.id, 256) ? { id: boundedHistoryString(message.author.id, 256) } : {}),
        ...(boundedHistoryString(message.author.name, 160) ? { name: boundedHistoryString(message.author.name, 160) } : {}),
      } } : {}),
      ...(boundedHistoryString(message.timestamp, 80) ? { timestamp: boundedHistoryString(message.timestamp, 80) } : {}),
      text,
      ...(attachments.length ? { attachments } : {}),
    });
    if (chars + envelope.length > PLATFORM_HISTORY_MAX_CHARS) break;
    chars += envelope.length;
    selected.push({
      id: randomUUID(),
      role: message.role,
      content: message.role === 'assistant'
        ? { role: 'assistant', content: [{ type: 'text', text: envelope }] }
        : { role: 'user', content: envelope },
    });
  }
  return selected.reverse();
}

export interface ChannelSendOpts {
  channelId: string;
  ownerUserId: number;
  /** This platform conversation is a DIRECT 1:1 chat with one verified account, not a shared room (see
   *  `direct` in schema.sql). Stamped on the session row on every message, because the flag describes the
   *  conversation rather than the moment its row was created. */
  direct?: boolean;
  policy: Policy;
  promptAppend?: string[];
  /** Sender holds the operator's admin role: elevates the channel session to `trusted-channel`
   *  (all-project Policy + full plugin toolset) — but it is STILL a shared channel, never owner-chat,
   *  so it never receives Elowen* tools or the owner API token. */
  trusted?: boolean;
  /** This message is a scheduled/unattended turn (a timer-driven plugin firing into its channel — the
   *  bundled cronjob today): the session uses the focused `scheduled` system prompt instead of the
   *  coding-agent base. Set by the orchestrator from the source's generic `access.scheduled` flag. */
  scheduled?: boolean;
  model?: { provider?: string; model?: string };
  thinkingLevel?: string;
  /** Durable parent for delegated sessions; never accepted from ordinary external adapters. */
  parentSessionId?: string;
  /** Immutable policy/identity boundary minted by the delegating turn. Required for a child send. */
  delegatedAccess?: DelegatedExecutionScope;
  /** The delegating turn's working directory, inherited by a delegated child session so its tools resolve
   *  relative paths against — and it advertises — the SAME project the parent runs in, not the daemon's
   *  `/`. Validated against the child's policy in the spawner like any client-reported cwd. Only set for a
   *  subagent send; ordinary platform channels resolve their cwd from the policy root. */
  clientCwd?: string;
  /** The sender's effective tool access for THIS turn (see ToolPolicy). Sourced by the orchestrator
   *  from the linked Elowen account (deny-list) or the platform role (allow-list). Enforced at
   *  execute time by the plugin-tool gate. Undefined → no restriction. */
  toolPolicy?: ToolPolicy;
  images?: { data: string; mimeType: string }[];
  /** Non-image files attached to this message. They are written into the VERIFIED writer's project before
   *  the turn — the same target the web upload route claims — and the turn text gains their real paths, so
   *  a PDF dropped into a room is a file the agent can open rather than a note saying one arrived. A
   *  refusal throws: an attachment the sender can see in the channel and the agent never receives is the
   *  exact silence this exists to end. */
  attachments?: ChannelAttachment[];
  /** Idle cutoff for THIS surface: a channel that went quiet longer than this before the current
   *  message has a long-expired prompt cache, so its session is rolled over (the stale transcript is
   *  archived under a fresh id and a new empty session takes its place) rather than dragging the whole
   *  stale context back in at full price. Unset → SESSION_IDLE_ROLLOVER_MS (Discord's 30 min). Cron
   *  passes a shorter value so a frequent job past the cache window starts fresh — or `Infinity` to
   *  disable rollover entirely for a job that must keep continuity across runs. */
  idleRolloverMs?: number;
  /** Dispose this channel's live session before the turn so it is reassembled from current state, keeping
   *  the durable transcript (it rehydrates from SQLite). Set only where something the live session baked
   *  in at construction has changed underneath it — today a promoted delegated scope, whose new toolset
   *  the already-assembled session would otherwise ignore. NOT a rollover: nothing is archived and the
   *  session id is unchanged. */
  rebuildSession?: boolean;
  identity?: TurnIdentity;
  /** Host-verified platform author. Shared-room turns serialize it with the clean text; direct chats and
   *  automation omit the envelope entirely. */
  sender?: PlatformSenderAttribution;
  /** Explicit proof that the adapter recognized this as a plugin prompt-command. Never infer this from a
   *  leading slash: ordinary shared-room users may legitimately type slash-leading text. */
  promptCommand?: boolean;
  /** The Elowen account the sender is verified as (linked platform id). When set, that user's memory is
   *  recalled under their message and post-turn facts are saved to it — each gated by their own
   *  Account → Memory toggles. Unset (unlinked sender) → no memory at all (shared-space privacy). */
  writerUserId?: number;
  history?: () => Promise<PlatformHistory>;
  /** Adapter platform name stamped into imported history provenance. */
  historyPlatform?: string;
  /** Opaque outbound destination exposed to tools only for verified direct platform conversations. */
  deliveryTarget?: string;
  onEvent?: (e: BrainEvent) => void;
  /** Steer this message into the channel's RUNNING turn even though the sender differs from the turn's
   *  originator. Set ONLY by BrainService.sendToSubagent after verifying the caller OWNS the session row
   *  and it is a delegated sub-agent session: the child's turn executes with access inherited from the
   *  owner's own delegation, so the owner steering it can never escalate. Platform adapters (Discord)
   *  must NEVER set this — a shared channel keeps each sender's turn isolated (see the comment below). */
  ownerSteer?: boolean;
  /** Host-owned hidden custom turn (durable sub-agent result); never projected as a user row. */
  internalSystem?: { customType: string; resultId: string };
}

export interface ChannelServiceDeps {
  /** The SAME registry instance the chat brain uses — channel locks and LRU live in one place. */
  registry: LiveSessionRegistry<LiveBrain>;
  /** False once the daemon is draining for shutdown: a NEW platform/channel turn is refused so the drain
   *  can converge. Delegated sends take sendRemote/runDelegatedTurn, not this seam, so they still run.
   *  Absent ⇒ always admits. */
  admitsNewWork?(): boolean;
  store: BrainStore;
  /** Durable account Fast preference for status only; provider requests use the spawner's live getter. */
  fastMode?: (userId: number) => boolean;
  /** The same store-backed registry owner chat uses, so channel/sub-agent cards survive replay cleanup. */
  cards: CardRegistry;
  /** `granted_plugins` is needed as well as the display fields: the per-turn skills announcement runs the
   *  writer through the SAME grant gate `skillsFor` applies, and a shape without it would silently answer
   *  every grant-gated plugin with "holds nothing" and hide skills the writer really has. */
  users: { get(userId: number): { name?: string; username?: string; is_admin?: boolean; granted_plugins?: string[] } | null | undefined };
  /** Projects and assignments, used ONLY to decide where a room attachment is written (see
   *  channelAttachments.ts). Absent ⇒ no candidate project exists and an attachment is refused with the
   *  same message the web route gives, rather than silently discarded. */
  uploads?: ChannelUploadDeps;
  /** Registered Projects plus the live Sandbox control resolve the current writer's effective workspace. */
  projects?: ProjectStore;
  projectPath?: () => string | undefined;
  sandbox?(): KnownControls['sandbox'] | undefined;
  /** Session composition stays in BrainService.spawnLive — this service only orchestrates. */
  spawn: (opts: SpawnOpts) => Promise<LiveBrain>;
  /** Live channel sessions cap: past this the least-recently-used one is disposed (its history stays
   *  in SQLite and rehydrates on the next message), so a busy server can't leak sessions. */
  maxChannels?: number | (() => number);
  /** Memory for verified channel senders: recall the writer's durable memories under their message
   *  and (via the curator) persist post-turn facts. Both no-op without a writerUserId. Shared with
   *  BrainService so channel + owner-chat memory run through one implementation. */
  memoryService?: MemoryService;
  memoryCategoryStore?: MemoryCategoryStore;
  curator?: MemoryCurator;
  /** Names a brand-new channel conversation from its first message (shared with owner chat). */
  titler?: ConversationTitler;
  /** Per-user settings: the memory toggles (autoRecall/autoSave), read fresh per turn for the verified
   *  writer. The settings a SESSION is composed from (models, compaction thresholds, advisor style) are
   *  deliberately absent here — the channel names the writer via SpawnOpts.settingsUserId and the spawner
   *  reads them, so this surface cannot hold a second opinion about any of them. */
  userSettings?: (userId: number) => { autoRecall?: boolean; autoSave?: boolean };
  /** Parked AskUserQuestion registry (shared with BrainService) — lets a channel turn's `ctx.askUser`
   *  emit an `ask` event to the channel's clients and await the answer (settled by a Discord interaction). */
  elicitation?: ElicitationRegistry;
  /** Per-user granular tool-permission settings (shared with BrainService). Channel turns resolve them
   *  for the VERIFIED sender (writerUserId), falling back to the channel owner for unlinked senders —
   *  but never wire an approval channel, so only `deny` rules bite here (ask → allow, see send()). */
  permissions?: (userId: number) => PermissionSettings;
  /** Plugin registry, so `brain.turn.contextBuilt` fires on a room's turns exactly as it does in an owner
   *  chat. Without it a plugin's per-turn context reaches the CLI and web and silently skips every
   *  platform channel. Absent ⇒ no plugin context block. */
  plugins?: () => Promise<PluginRegistry | undefined>;
  hookAudit?: HookAuditBuffer;
  completeSubagent?: (parentSessionId: string, userId: number, completion: SubagentCompletion) => void;
  completeWorkflow?: (parentSessionId: string, userId: number, completion: WorkflowCompletion) => void;
  /** Stop the workflow engine for an aborted origin session (see BrainService.cancelWorkflowsFor) —
   *  a channel `/stop` must halt a DAG started from that channel exactly like the owner's Esc-Esc. */
  cancelWorkflows?: (sessionId: string) => Promise<void>;
  /** Observe every delegated parent→child edge this service registers. Set only in the sub-agent runner,
   *  which mirrors its NESTED tree into the daemon's authoritative registry. */
  onDelegatedEdge?: (parentSessionId: string, childSessionId: string, running: boolean) => void;
  /** Apply a plugin reload a tool requested during a room turn, once that turn's lock is released — see
   *  {@link settleTurn}. The owner surface has always had it; without the same callback here a skill
   *  created from Discord reached disk and never reached the runtime. */
  drainPluginReload?: () => void;
  /** Reach a delegated child whose PI session lives in the sub-agent runner process. The abort TREE stays
   *  here (its fencing is synchronous in-memory read-modify-write), but only the process actually holding
   *  the session can interrupt the model call — see SubagentDispatch. No-op without a runner. */
  abortRemote?: (channelId: string) => void;
}

const sameScopePolicy = (policy: Policy, scope: DelegatedExecutionScope): boolean => {
  const ids = policy.allowedProjectIds;
  if (scope.admin) return ids === 'all';
  if (ids === 'all') return false;
  if (ids.size !== scope.projectIds.length) return false;
  return scope.projectIds.every((id) => ids.has(id));
};

const samePromptAppend = (actual: string[] | undefined, expected: string[] | undefined): boolean =>
  (actual?.length ?? 0) === (expected?.length ?? 0)
  && (actual ?? []).every((chunk, index) => chunk === expected?.[index]);

/** Platform channel conversations (Discord threads, …): one session per channel — keyed by the
 *  channel, NOT the Elowen user — run with the caller-resolved Policy (role → projects) plus optional
 *  role prompt fragments. Persisted like any brain conversation (`brain-ch-<id>`), owned by
 *  `ownerUserId` (whose token drives the tools). */
export class ChannelSessionService {
  /** Resolved per eviction so an operator's config change to the live-session cap applies without a
   *  restart (a fixed number or a resolver both accepted). */
  private readonly maxChannels: () => number;
  /** Number of overlapping sends that currently hold each durable parent→child lifecycle edge. A
   *  steering request can overlap the child's original run; boolean Set bookkeeping alone would let
   *  the short steering call remove the edge while the original child was still running. */
  private readonly delegatedCalls = new Map<string, Map<string, number>>();

  constructor(private d: ChannelServiceDeps) {
    const m = d.maxChannels;
    this.maxChannels = typeof m === 'function' ? m : () => m ?? 32;
  }

  private beginDelegatedCall(parentSessionId: string, childSessionId: string): void {
    let children = this.delegatedCalls.get(parentSessionId);
    if (!children) { children = new Map(); this.delegatedCalls.set(parentSessionId, children); }
    children.set(childSessionId, (children.get(childSessionId) ?? 0) + 1);
    this.d.registry.setChildRunning(parentSessionId, childSessionId, true);
    // Tell the step-boundary shutdown drain that the tool call running this dispatch is a DELEGATION:
    // a parent blocked only on delegated children is safe to leave at a restart (boot recovery respawns
    // the child and the durable outbox re-answers the parent). Ambient no-op outside a tool execution.
    markDelegationInCurrentTool();
    this.d.onDelegatedEdge?.(parentSessionId, childSessionId, true);
  }

  private endDelegatedCall(parentSessionId: string, childSessionId: string): void {
    const children = this.delegatedCalls.get(parentSessionId);
    const count = children?.get(childSessionId) ?? 0;
    if (count > 1) { children!.set(childSessionId, count - 1); return; }
    children?.delete(childSessionId);
    if (children?.size === 0) this.delegatedCalls.delete(parentSessionId);
    this.d.registry.setChildRunning(parentSessionId, childSessionId, false);
    this.d.registry.consumePendingAbort(childSessionId);
    this.d.onDelegatedEdge?.(parentSessionId, childSessionId, false);
  }

  /** A child can only execute under the immutable scope minted by its original delegate call. This is
   * enforced here because this service owns first spawn, LRU revival, and idle drill-in continuations. */
  private delegatedExecution(opts: ChannelSendOpts, sessionId: string): {
    scope: DelegatedExecutionScope;
    toolPolicy: ToolPolicy | undefined;
    pathView?: WorkspacePathView;
  } {
    const scope = normalizeDelegatedExecutionScope(opts.delegatedAccess);
    if (!scope || !opts.identity || opts.writerUserId !== undefined
      || opts.identity.platform !== 'subagent' || opts.identity.userId !== 'subagent'
      || opts.identity.elowenUserId !== undefined || opts.identity.elowenUsername !== undefined
      || opts.identity.admin !== scope.admin || opts.identity.owner !== scope.owner
      || opts.trusted !== scope.admin
      || !sameScopePolicy(opts.policy, scope)
      || !samePromptAppend(opts.promptAppend, scope.promptAppend)) {
      throw new Error('invalid delegated access');
    }
    const existing = this.d.store.getSession(sessionId);
    // Never write a scope into a legacy child row. A matching persisted scope is the only authority for
    // respawns, so malformed/NULL data fails before it can run under the caller's ambient privileges.
    if (existing && (existing.parent_session_id !== opts.parentSessionId
      || !this.d.store.hasDelegatedAccess(sessionId, scope))) {
      throw new Error('delegated access unavailable');
    }
    // The captured allow-list is authoritative. A caller may only NARROW it — its current denies add, and
    // its current grant intersects — so it cannot swap the inherited allow/deny shape while the child is
    // idle. Dropping the caller's allow here is what made the account grant a per-path accident: the
    // careful intersection every caller computes was discarded and rebuilt from the frozen scope alone.
    let pathView: WorkspacePathView | undefined;
    if (scope.workspaceRef) {
      const sandbox = this.d.sandbox?.();
      if (!sandbox || scope.contributionUserId === undefined) throw new Error('delegated workspace unavailable');
      const binding = sandbox.resolveWorkspace({
        accountUserId: scope.contributionUserId,
        workspace: scope.workspaceRef,
        accessibleProjectIds: scope.admin ? 'all' : scope.projectIds,
      });
      const scopedProjectIds = scope.admin
        ? this.d.projects?.list().map((project) => project.id) ?? []
        : scope.projectIds;
      const hiddenPrefixes = [
        ...(this.d.projects?.list().filter((project) => scopedProjectIds.includes(project.id)).map((project) => project.path) ?? []),
        ...sandbox.workspacesFor({ userId: scope.contributionUserId, projectIds: scopedProjectIds }).map((workspace) => workspace.path),
      ];
      pathView = createWorkspacePathView(binding, hiddenPrefixes);
    }
    return {
      scope,
      toolPolicy: delegatedToolPolicy(scope, opts.toolPolicy?.deny ?? [], opts.toolPolicy?.allow),
      ...(pathView ? { pathView } : {}),
    };
  }

  /** WHOSE personal settings a DELEGATED child composes from: whatever composed its parent.
   *
   *  A child carries no writer of its own — `delegatedExecution` refuses one outright, because its sender
   *  is the sub-agent identity and not a person — so without this it fell back to the room's opener and
   *  ran on that account's default chat model, compaction model and thresholds while the parent turn that
   *  delegated it ran on the writer's. The parent's live record is the single place that already knows the
   *  answer (see SpawnOpts.settingsUserId), so the child reads it there rather than re-deriving it from a
   *  second copy of the writer.
   *
   *  Undefined when the parent is no longer live (evicted, restarted): the caller then falls back to the
   *  session owner, which is the id the child would have used anyway. */
  private parentSettingsUserId(parentSessionId: string | undefined): number | undefined {
    return this.parentLive(parentSessionId)?.settingsUserId;
  }

  /** WHOSE personal skills a DELEGATED child may load: the verified writer of the parent TURN that spawned
   *  it, read off the parent's live record — the one place that knows who is speaking right now.
   *
   *  The same hole `parentSettingsUserId` closes for preferences existed here, and it bites harder: a child
   *  carries no account identity of its own (`delegatedExecution` refuses one), so without this "load my
   *  checklist skill and follow it" found nothing the moment the work was handed to a sub-agent. Taking the
   *  ROW owner instead would be the leak: a room's row belongs to whoever opened it, so the child would open
   *  that person's private skills for whichever colleague delegated.
   *
   *  Undefined when the parent is no longer live (evicted, restarted) or when its writer is unlinked — the
   *  child then composes the instance set, which is the fail-closed answer and the one it had before. */
  private parentContributionUserId(parentSessionId: string | undefined): number | undefined {
    return this.parentLive(parentSessionId)?.turnWriterUserId ?? undefined;
  }

  private parentLive(parentSessionId: string | undefined): LiveBrain | undefined {
    if (!parentSessionId) return undefined;
    return this.d.registry.get(parentSessionId)
      ?? (isChannelSession(parentSessionId) ? this.d.registry.channelGet(channelIdOf(parentSessionId)) : undefined);
  }

  /** Resolve the durable owner of a prospective delegated parent. PlatformOrchestrator uses this before
   *  entering send(); send() repeats the parent/owner check at the write boundary to close TOCTOU races. */
  sessionOwnerUserId(sessionId: string): number | undefined {
    return this.d.store.getSession(sessionId)?.user_id;
  }

  /** Give a personal 1:1 chat back to the verified sender who actually talks in it, while it is still
   *  anchored on the operator fallback. See {@link BrainStore.adoptPersonalChat} for why this is the one
   *  case an inbound message may re-point a transcript. */
  adoptPersonalChat(sessionId: string, fromUserId: number, toUserId: number): boolean {
    return this.d.store.adoptPersonalChat(sessionId, fromUserId, toUserId);
  }

  /** Validate an opaque scheduled-delivery target against the durable direct session it claims to name. */
  mayDeliverDirectSession(userId: number, sessionId: string, channelId: string): boolean {
    return sessionId === channelSessionId(channelId)
      && mayDeliverToSession(this.d.store.getSession(sessionId), userId, sessionId)
      && !isSubagentSession(sessionId);
  }

  /** Send one channel message into that channel's own conversation; resolves with the final
   *  assistant text. Serialized per channel: two rapid messages must not prompt() one PI session
   *  concurrently (and must not both spawn it). */
  async send(opts: ChannelSendOpts, text: string): Promise<string> {
    const senderText = text;
    // Files land on disk BEFORE the text is serialized, so the model and the durable row both carry the
    // real path. Inside the envelope with the rest of the message body: the paths describe what this
    // untrusted sender attached, and hoisting them out would present them as host-stated fact.
    const files = opts.attachments?.length
      ? storeChannelAttachments(this.d.uploads ?? {}, opts.writerUserId, opts.attachments)
      : { stored: [], unstored: [] };
    const markers = [
      ...(opts.images?.length ? [`[📎 ${opts.images.length}× image]`] : []),
      ...(files.stored.length ? [attachmentTurnNote(files.stored)] : []),
      // A file the instance had nowhere to put still reaches the turn as a note, so the person who sent it
      // gets their answer instead of an error about somebody else's configuration. A refusal that is about
      // whether these bytes may be written at all threw above and never gets here.
      ...(files.unstored.length ? [unstoredAttachmentTurnNote(files.unstored)] : []),
    ];
    const textWithAttachmentMarker = markers.length ? `${text}\n${markers.join('\n')}` : text;
    // Prompt commands are adapter-recognized macros and stay raw for PI expansion. Every ordinary message
    // in a validated shared room is serialized once here; this exact string goes to the model and SQLite.
    const turnText = opts.identity?.conversation === 'shared' && opts.sender && !opts.promptCommand
      ? serializePlatformEnvelope({
          source: 'platform_message', untrusted: true, platform: opts.identity.platform,
          channelId: opts.channelId, author: opts.sender, text: textWithAttachmentMarker,
        })
      : textWithAttachmentMarker;
    const sessionId = channelSessionId(opts.channelId);
    const parentSessionId = opts.parentSessionId;
    // Draining for shutdown: refuse a NEW ordinary channel turn so the drain converges. A delegated send
    // (parentSessionId set) is existing work the drain is waiting on — it always runs through.
    if (this.d.admitsNewWork?.() === false && !parentSessionId) {
      throw new Error('the daemon is shutting down — try again once it is back up');
    }
    // The room spoke: this message IS the continuation of whatever a shutdown parked here, so the boot
    // resume sweep must stand down — cleared at admission, before any lock, so a message landing while
    // the sweep walks its worklist deterministically wins its claim-check (claimParkResumeAttempt bumps
    // only while the marker stands). The same rule owner turn admission applies in turnRunner. A hidden
    // internal turn is machine work — the resume sweep's own continuation rides it — and a delegated
    // send is not this room speaking; both leave the marker alone.
    if (!parentSessionId && !opts.internalSystem) this.d.store.clearSessionPark(sessionId);
    if (opts.ownerSteer && !parentSessionId) throw new Error('invalid delegated access');
    const delegated = parentSessionId ? this.delegatedExecution(opts, sessionId) : undefined;
    const effectiveToolPolicy = delegated?.toolPolicy ?? opts.toolPolicy;
    // `pendingAbort` is deliberately observed (not consumed) on the owner-steer fast path: the original
    // child turn must still consume it after prompt() and report a terminal abort instead of success.
    const delegationAborted = () => !!parentSessionId && (
      this.d.registry.isParentAborting(parentSessionId) || this.d.registry.hasPendingAbort(sessionId)
    );
    let delegatedCall = false;
    let delegationLease: SandboxExecutionLease | undefined;
    let delegationLeaseHeartbeat: ReturnType<typeof setInterval> | undefined;
    // Armed by a turn that actually produced an answer and consumed once by settleTurn below, mirroring
    // the owner surface: a turn that threw leaves it undefined, which is how a failed exchange stays out
    // of the writer's memory. The writer stamp and the drain are NOT gated on it — see the settle.
    let curate: NonNullable<Parameters<typeof settleTurn>[0]['curate']> | undefined;
    // Whether this message ran a turn of its OWN. False while it was steered into somebody else's running
    // turn (that turn is still live, so nothing may dispose it) and false if the steer attempt itself
    // threw, which is the same situation seen from the failing side.
    let ranOwnTurn = false;
    let admitted = false;
    try {
    if (parentSessionId) {
      if (this.d.registry.isParentAborting(parentSessionId)) throw new Error('delegation aborted');
      const parent = this.d.store.getSession(parentSessionId);
      if (!parent || parent.user_id !== opts.ownerUserId || parent.id === sessionId) throw new Error('invalid parent session');
      if (delegated?.scope.workspaceRef) {
        const sandbox = this.d.sandbox?.();
        const accountUserId = delegated.scope.contributionUserId;
        if (!sandbox || accountUserId === undefined) throw new Error('delegated workspace unavailable');
        delegationLease = sandbox.acquireDelegationLease({ accountUserId, workspace: delegated.scope.workspaceRef });
        delegationLeaseHeartbeat = setInterval(() => { void delegationLease?.heartbeat(); }, 5_000);
        delegationLeaseHeartbeat.unref?.();
      }
      // Register before the first async boundary. A background delegate may be stopped immediately after
      // its tool returns, before spawn has emitted the child's `session` progress event.
      this.beginDelegatedCall(parentSessionId, sessionId);
      delegatedCall = true;
    }
    admitted = true;
    const steered = await this.trySteerIntoRunningTurn(opts, turnText, senderText, delegationAborted);
    if (steered === null) ranOwnTurn = true;
    const reply = steered !== null ? steered : await this.d.registry.withLock(sessionId, async () => {
      if (parentSessionId && this.d.registry.isParentAborting(parentSessionId)) throw new Error('delegation aborted');
      if (this.d.registry.consumePendingAbort(sessionId)) throw new Error('delegation aborted');
      // Idle rollover (cache-cost fix): a channel that sat quiet past the idle cutoff has a long-expired
      // prompt cache, so continuing would re-send its whole stale transcript at full price for no benefit.
      // Roll it over like owner chat (lifecycle.maybeRollover): drop the live PI session and ARCHIVE the
      // old transcript+title under a fresh unique id — the deterministic channel id is freed, so the fall
      // through below spawns a fresh, empty session under it (the registry and slash commands key on
      // channelId, so the id stays stable). The old conversation stays browsable in the sessions view.
      // MUST run before the getMessages() backfill check so a reset channel re-triggers its history
      // backfill + titler. A streaming turn is never cut — the lock already serializes this channel's
      // turns, so this only guards against a live record left mid-flight. `interactedAt` is the live
      // session's own last deliberate touch (compact/model switch), mirroring the owner-chat call site:
      // a recent interaction vetoes the rollover even when the last stored message is stale.
      const live = this.d.registry.channelGet(opts.channelId);
      // The caller resolved this from the row that existed when the turn arrived. The rollover below can
      // rename that row out from under it, which is the one moment the value goes stale.
      let ownerUserId = opts.ownerUserId;
      if (!live?.session.isStreaming
          && !this.d.registry.hasActiveChildren(sessionId)
          && rolloverDue({ lastMessageAt: this.d.store.lastMessageAt(sessionId), interactedAt: live?.interactedAt, now: Date.now() }, opts.idleRolloverMs ?? SESSION_IDLE_ROLLOVER_MS)) {
        this.d.registry.channelDispose(opts.channelId);
        this.d.store.reassignSession(sessionId, archivedChannelSessionId(opts.channelId));
        // The previous conversation has just been archived under its own owner, and the canonical id is
        // free again. Whoever is writing now is therefore OPENING a room, not joining one, and owns what
        // they open — the same rule the orchestrator applies when no row exists at all. It cannot apply it
        // here itself: the rollover is decided inside this method, after the owner was already resolved.
        // An unlinked sender carries no account, so the channel owner stands.
        if (opts.writerUserId != null) ownerUserId = opts.writerUserId;
      }
      // The post-turn curator must distill ONLY this sender's own words. Imported platform history is
      // seeded separately, so it can never land in THIS sender's private memory or conversation title.
      const senderMessage = senderText;
      // A BRAND-NEW conversation may import what the platform said before the brain joined. Keep those
      // entries as individual transcript messages — never concatenate them into the live user's request.
      let seedMessages: SeededSessionMessage[] = [];
      if (opts.history && this.d.store.getMessages(sessionId).length === 0) {
        const past = await opts.history().catch((): PlatformHistory => []);
        seedMessages = platformHistorySeed(past, opts.historyPlatform ?? 'platform', opts.channelId);
      }
      if (this.d.registry.consumePendingAbort(sessionId)) throw new Error('delegation aborted');
      let ch = this.d.registry.channelGet(opts.channelId);
      // A provider, model or reasoning-effort switch mid-conversation rebuilds the session (history
      // rehydrates). Model ids are not globally unique: two configured providers may both expose e.g.
      // `gpt-5`, so comparing only the model would silently keep sending to the old credentials/base URL.
      const modelChanged = !!opts.model?.model && ch?.model !== opts.model.model;
      const providerChanged = !!opts.model?.provider && ch?.providerId !== opts.model.provider;
      const thinkingChanged = !!ch && (ch.thinkingLevel ?? '') !== (opts.thinkingLevel ?? '');
      // Ownership and direct/shared classification determine personal skills, account instructions and
      // other spawn-time composition. Re-stamping SQLite alone would leave the live session serving the
      // old account/classification until an unrelated respawn.
      const classificationChanged = !!ch
        && (ch.ownerUserId !== ownerUserId || ch.direct !== (opts.direct === true));
      // A channel respawn is invisible to the model, so the compaction it was already oriented for has
      // to survive it — otherwise every model switch re-sends the whole post-compaction block for a
      // compaction the model has already been told about.
      let carriedOrientation: string | undefined;
      if (ch && (providerChanged || modelChanged || thinkingChanged || classificationChanged || opts.rebuildSession)) {
        carriedOrientation = ch.orientedForCompaction;
        this.d.registry.channelDispose(opts.channelId);
        ch = undefined;
      }
      // A live-but-empty session (for example after a failed first prompt) was created before the history
      // provider ran. Respawn it so the factory can seed the imported transcript before PI is assembled.
      if (ch && seedMessages.length) {
        this.d.registry.channelDispose(opts.channelId);
        ch = undefined;
      }
      if (!ch) {
        this.d.registry.channelEvictOldestIfFull(this.maxChannels());
        ch = await this.d.spawn({
          sessionId,
          ownerUserId,
          direct: opts.direct === true,
          parentSessionId: opts.parentSessionId,
          delegatedAccess: delegated?.scope,
          selection: opts.model ?? {},
          policy: opts.policy,
          extraAppend: opts.promptAppend,
          ...(seedMessages.length ? { seedMessages } : {}),
          channel: true, // a shared platform channel is NEVER owner-chat — no Elowen* tools, no owner token
          trustedChannel: opts.trusted, // admin-role sender → trusted-channel (all projects + full plugin toolset), still no Elowen*
          scheduled: opts.scheduled, // timer-driven turn → focused `scheduled` system prompt instead of the coding base
          thinkingLevel: opts.thinkingLevel,
          autoCompact: true, // channels are long-lived and unattended — keep their context bounded
          // …at the WRITER'S personal settings, not the room opener's. A room is owned by whoever opened
          // it, which is bookkeeping only, so composing the session from that account meant one
          // colleague's default model, compaction model, thresholds and advisor style answered everyone
          // else in the room. An unlinked sender carries no account, so the owner still stands. Every
          // one of those settings is read from this single id inside the spawner; resolving even one of
          // them here would be the second opinion that let the threshold drift from the model.
          // A delegated child has no writer of its own and inherits its parent's — see parentSettingsUserId.
          settingsUserId: opts.writerUserId ?? this.parentSettingsUserId(parentSessionId) ?? ownerUserId,
          // Only a DELEGATED child names one. An ordinary room deliberately composes the instance set and
          // announces the writer's per turn: PI's skill set is fixed for the life of a session, so
          // composing it from whoever spoke first would leave that person's private skills expandable for
          // everyone who writes afterwards.
          ...(parentSessionId
            ? (() => {
                // The durable delegated scope is the cross-process source of truth. The parent live record
                // remains a legacy in-process fallback for rows minted before contribution ownership was
                // captured explicitly.
                const inherited = delegated?.scope.contributionUserId ?? this.parentContributionUserId(parentSessionId);
                return inherited != null ? { contributionUserId: inherited } : {};
              })()
            : {}),
          // A delegated child inherits its parent's working directory (set only for subagent sends); an
          // ordinary platform channel leaves this undefined and resolves its cwd from the policy root.
          clientCwd: delegated?.pathView?.root ?? opts.clientCwd,
          ...(delegated?.pathView ? { pathView: delegated.pathView } : {}),
        });
        if (carriedOrientation !== undefined) ch.orientedForCompaction = carriedOrientation;
        if (this.d.registry.consumePendingAbort(sessionId)) {
          ch.session.dispose();
          throw new Error('delegation aborted');
        }
      }
      // Stamp the 1:1-vs-shared flag on EVERY platform message, not only when this turn happened to spawn
      // the session: a conversation that was already live (or whose row predates the column) would
      // otherwise never learn what it is, and a private DM would keep behaving like a shared room forever.
      if (opts.direct !== undefined) this.d.store.setDirect(sessionId, opts.direct);
      this.d.registry.channelTouch(opts.channelId, ch); // (re-)insert → Map order doubles as LRU order
      // Provider calls before the prompt (cold-start compaction) already belong to THIS turn, so stamp
      // the verified writer before any of them. The inner finally clears both fields after settlement;
      // out-of-band compaction therefore fails closed instead of borrowing the previous room writer.
      ch.turnSender = opts.identity?.userId; // whose turn this is → mid-run injection only steers same-sender messages in
      ch.turnWriterUserId = opts.writerUserId ?? null;
      try {
      // First turn after this room's prompt cache expired: shrink the context BEFORE the provider
      // re-caches it. Owner chat has had this since the idle sweep was retired; a room did not, even
      // though a room — a cron channel that keeps one conversation for weeks — is where the expensive
      // cold context actually accumulates. Runs before the user's message is projected, so that message
      // is never part of what gets summarized. An ordinary Discord room is rolled over long before the
      // gate opens; this bites exactly on the long-lived channels that disable or lengthen the rollover.
      await maybeColdStartCompaction(
        { store: this.d.store, sessions: this.d.registry, elicitation: this.d.elicitation ?? { pendingForSession: () => null } },
        ch,
      );
      // Same rule for mid-turn recall as for the turn-start block below: the verified sender's memories,
      // nobody's when they are unlinked. Never the channel owner's — that would surface their memories
      // into a stranger's turn in a shared room.
      // WHOSE personal skills this turn may load — announced below and authorised by the same value on the
      // turn scope, so the model is never told about a skill a tool will then refuse to open for it.
      //
      // A SHARED room resolves it per turn, because the session it runs in was composed from nobody: PI's
      // skill set is fixed for the life of a session, so a room can only ever be built from the instance
      // set, and the writer's own skills have to arrive with the turn. Every other session HAS a
      // session-wide answer and the live records the exact one it was composed with — re-deriving it here
      // would be a second opinion, and it would go wrong precisely for a delegated child continued after
      // its parent turn ended, where the writer this turn could read is no longer there to read.
      const turnContributionUserId = resolvesContributionsPerTurn(sessionId, opts.direct === true)
        ? contributionOwnerForSession(sessionId, ownerUserId, {
            direct: opts.direct === true,
            ...(opts.writerUserId != null ? { writerUserId: opts.writerUserId } : {}),
          })
        : ch.contributionUserId;
      // One channel turn. `turnText` is the current sender's message; any platform-history backfill was
      // seeded as separate transcript entries before this live PI session was assembled.
      // `senderMsg` is the sender's CLEAN words for the title + curator; `turnOnEvent` is the live stream
      // sink (which Discord message the reply edits into). Returns the assistant reply. A same-sender
      // follow-up sent mid-turn is steered into THIS running turn (see send()'s top), not a fresh turn.
      const runOne = async (turnText: string, senderMsg: string, turnImages: { data: string; mimeType: string }[] | undefined, turnOnEvent?: (e: BrainEvent) => void): Promise<string> => {
        // The attachment marker was included before serialization, so the model and durable row receive the
        // same parseable text while image bytes still ride only the live prompt.
        const displayText = turnText;
        const projected = opts.internalSystem ? undefined : projectUserTurn(this.d.store, sessionId, displayText);
        // A child transcript is an owner-facing chat surface, so its daemon stream is the one echo
        // authority just like owner chat. Ordinary Discord/WhatsApp messages remain platform-rendered
        // and do not broadcast this marker back into their room.
        if (opts.ownerSteer && projected) {
          ch.replay.publish({ type: 'user', text: displayText, durableId: projected.id, createdAt: projected.createdAt });
        }
        // Name a brand-new channel conversation from the sender's own words (pre-backfill, so injected
        // channel history never leaks into the title). Same helper the owner chat titles through, called
        // at the same moment — once this turn's user row exists.
        if (!opts.internalSystem) {
          titleTurnConversation({
            store: this.d.store,
            ...(this.d.titler ? { titler: this.d.titler } : {}),
            sessionId,
            senderText: senderMsg,
          });
        }
        // Verified-sender memory recall (ephemeral, never persisted), keyed on their linked account + gated
        // by autoRecall; an unlinked sender has no writerUserId → no recall (shared-space privacy).
        const writerUserId = opts.writerUserId;
        const memoryBlock = await recallMemoryBlock({
          service: this.d.memoryService,
          userId: writerUserId,
          text: senderMsg,
          enabled: writerUserId != null && this.d.userSettings?.(writerUserId)?.autoRecall !== false,
          // Only the SCOPE is a channel concern: a room recalls globally for the verified sender, since
          // there is no project context to narrow it to. The rendering is shared, so a platform user is
          // told how old a memory is exactly like the owner is.
          scoped: (run) => runWithPolicy(opts.policy, run, {
            memoryRecallScope: this.d.memoryCategoryStore && writerUserId != null
              ? globalMemoryRecallScope(writerUserId, this.d.memoryCategoryStore)
              : { projectId: null, categoryIds: new Set<number>() },
          }),
        });
        const options = turnImages?.length
          ? { images: turnImages.map((i) => ({ type: 'image' as const, data: i.data, mimeType: i.mimeType })) }
          : undefined;
        // Optional live streaming (Discord edit-in-place): forward THIS turn's events to its own sink.
        const detach = turnOnEvent ? (ch.listeners.add(turnOnEvent), () => ch.listeners.delete(turnOnEvent)) : undefined;
        // Tell the sink which persisted session this runs as, BEFORE the turn (delegate plugin keys its
        // live progress row on it; Discord ignores the type).
        turnOnEvent?.({ type: 'session', sessionId });
        // Turn-bound elicitor + store-backed cards, shared with owner chat; fan updates live after persisting.
        const elicit = this.d.elicitation
          ? (qs: AskQuestion[]) => this.d.elicitation!.ask(sessionId, qs, (e) => ch.replay.publish(e))
          : undefined;
        const emitCard = (raw: unknown) => { const card = this.d.cards.set(sessionId, raw); if (card) ch.replay.publish({ type: 'card', card }); };
        // Mirror owner-chat delegation tracking: the progress event is both the live UI seam and the
        // abort tree. A channel can delegate recursively, so every channel node owns its direct children.
        const emitSubagent = (u: SubagentUpdate) => {
          const visible = visibleSubagentUpdate(
            u,
            this.d.registry.hasChildClaim(ch.sessionId, u.sessionId, 'call'),
          );
          // See turnContextBuilder.emitSubagent: read prior status before the upsert so the finish marker
          // fires once on the running→terminal transition, mirrored here for channel-driven delegations.
          const prevStatus = visible.status === 'done' || visible.status === 'error'
            ? this.d.store.getSubagentRuns(ch.sessionId).find((run) => run.sessionId === visible.sessionId)?.status
            : undefined;
          if (!this.d.store.upsertSubagentRun(ch.sessionId, visible, u.status)) return false;
          // 'progress' source, mirroring turnContextBuilder.emitSubagent: the continuation tool's terminal
          // row stays visibly running under the actual call claim, but releases its own progress claim.
          this.d.registry.setChildRunning(ch.sessionId, visible.sessionId, u.status === 'running', 'progress');
          ch.replay.publish({ type: 'subagent', ...visible });
          recordSubagentFinishMarker(this.d.store, ch.sessionId, (event) => ch.replay.publish(event), prevStatus, visible);
          return true;
        };
        const emitSubagentCompletion = parentSessionId && this.d.completeSubagent
          ? (completion: SubagentCompletion) => { this.d.completeSubagent!(ch.sessionId, ownerUserId, completion); }
          : undefined;
        // Persist-first, mirroring emitSubagent: the in-plugin engine owns the DAG only in memory, so the
        // durable row is the sole thing the transcript marker and its modal can be rebuilt from after a
        // reconnect or restart. A snapshot the store refuses must not reach a client. The finish marker
        // rides the running→terminal transition of the workflow's OWN status, read from the store before
        // the upsert, exactly as emitSubagent's does for a child.
        const emitWorkflow = (u: WorkflowUpdate) => {
          const prevStatus = u.status === 'done' || u.status === 'error' || u.status === 'cancelled'
            ? this.d.store.workflowStatus(ch.sessionId, u.id)
            : undefined;
          if (!this.d.store.upsertWorkflowRun(ch.sessionId, u)) return;
          ch.replay.publish({ type: 'workflow', ...u });
          recordWorkflowFinishMarker(this.d.store, ch.sessionId, (event) => ch.replay.publish(event), prevStatus, u);
        };
        const emitWorkflowCompletion = parentSessionId && this.d.completeWorkflow
          ? (completion: WorkflowCompletion) => { this.d.completeWorkflow!(ch.sessionId, ownerUserId, completion); }
          : undefined;
        const assistantBefore = [...(ch.session.messages as { role?: string }[])].reverse()
          .find((message) => message.role === 'assistant');
        // Resolve from THIS writer and THIS turn. `ch.workDir` is only the static spawn cwd (often the room
        // opener's Project); validating it through the current Policy first makes another writer fall back to
        // their own Project, then Sandbox may select that account's active workspace.
        const baseWorkDir = delegated?.pathView?.root
          ?? turnWorkDir(opts.policy, opts.clientCwd ?? ch.workDir, this.d.projectPath);
        const effectiveWorkDir = delegated?.pathView
          ? { baseWorkDir, workDir: delegated.pathView.root, workspace: null }
          : effectiveTurnWorkDir({
              policy: opts.policy,
              baseWorkDir,
              accountUserId: turnContributionUserId,
              sessionId,
              projects: this.d.projects,
              sandbox: this.d.sandbox?.(),
            });
        const workspaceReminder = workDirReorientation(ch.workDir, effectiveWorkDir.workDir);
        try {
          // …and, in a room, narrowed to the tools this writer OWNS as well as the ones they were granted.
          // The two are different questions and both have to be asked: the grant says what an admin gave
          // this account, while ownership says whose personal MCP server is on the other end of a name the
          // room composed for everybody. Absent on every session composed for a single account.
          applyToolVisibility(
            ch.session, ch.pluginToolNames, effectiveToolPolicy, ch.toolSearch,
            ch.personalToolOwners ? { owners: ch.personalToolOwners, contributionUserId: turnContributionUserId } : undefined,
          );
          // Granular permissions without an approval channel: ordinary platform turns read the verified
          // sender (else their channel owner) fresh, but a delegated child MUST use its immutable captured
          // boundary. Resolving `writerUserId ?? ownerUserId` here would let an idle child inherit the
          // durable row owner's newer/wider settings; it also must not gain owner-memory identity.
          const livePermissionSettings = delegated ? undefined : this.d.permissions?.(opts.writerUserId ?? ownerUserId);
          const permissions: TurnPermissions | undefined = delegated
            ? noninteractiveTurnPermissions(delegated.scope.permissionBoundary)
            : livePermissionSettings
              ? { ruleset: buildPermissionRuleset(livePermissionSettings), yolo: false, unattendedAsks: livePermissionSettings.unattendedAsks }
              : undefined;
          // Meter the channel turn too (Discord runs the OpenRouter-backed sarah-mimo etc.) so its real cost
          // is stamped onto the persisted assistant row by projectEvent, not lost as pi-ai's $0 estimate.
          const meter = newCostMeter();
          await runWithMeter(meter, () => runWithPolicy(opts.policy, async () => {
            // An adapter-recognized plugin prompt-command (`/name args`) rides RAW so PI expands its template
            // natively. A leading slash alone proves nothing: ordinary user text remains a normal framed turn.
            let prompted = turnText;
            // Assigned by the drain below and called only after the prompt has reached the provider.
            let commitOrientation = (): void => {};
            if (!(opts.promptCommand === true && isPromptCommand(turnText, ch.session))) {
              const turnContext = ch.turnContext();
              // The drain stays per-surface (it is stateful and commits only once the prompt reached the
              // provider), but the ORDER and framing of the blocks no longer live here: composeTurnPrompt
              // is the single source for that, so a block added for the owner chat cannot silently skip
              // every channel the way this composition used to allow.
              const { block: postCompaction, commit } = drainPostCompactionContext(this.d.store, ch);
              commitOrientation = commit;
              // Blocks a channel deliberately does not carry are simply absent: modes and the interactive
              // permission summary are owner-chat concepts, and a room has neither.
              prompted = composeTurnPrompt({
                // Absent on every surface whose skill announcement already sits in its cached system
                // prompt; a shared room is the one that cannot have it there — see resolvesContributionsPerTurn.
                skills: resolvesContributionsPerTurn(sessionId, opts.direct === true)
                  ? await turnSkillsBlock({
                      ...(this.d.plugins ? { plugins: this.d.plugins } : {}),
                      users: this.d.users,
                      contributionUserId: turnContributionUserId,
                    })
                  : '',
                memory: memoryBlock,
                hook: await pluginContextBlock({
                  ...(this.d.plugins ? { plugins: this.d.plugins } : {}),
                  ...(this.d.hookAudit ? { hookAudit: this.d.hookAudit } : {}),
                  text: senderMsg,
                }),
                beforeUser: turnContext.beforeUser,
                text: turnText,
                afterUser: turnContext.afterUser,
                workDirReorientation: workspaceReminder,
                postCompaction,
                // A room's turns are minutes apart with other people's messages in between, so an agent
                // that delegated here needs the reminder more than the owner chat does, not less.
                runningSubagents: runningSubagentsBlock(this.d.registry, this.d.store, ch.sessionId),
              });
            }
            if (this.d.registry.consumePendingAbort(sessionId)) throw new Error('delegation aborted');
            if (opts.internalSystem) {
              await ch.session.sendCustomMessage({
                customType: opts.internalSystem.customType, content: prompted, display: false,
                details: { source: 'elowen', resultId: opts.internalSystem.resultId },
              }, { triggerTurn: true, deliverAs: 'followUp' });
            } else await (options ? ch.session.prompt(prompted, options) : ch.session.prompt(prompted));
            // Requests provably went out under THIS process's cache retention — record the TTL they were
            // cached with, so the cold-start gate above uses a known value instead of falling back to the
            // longest TTL pi-ai ever uses forever (which is fail-closed, but never opens on a short one).
            ch.lastRequestCacheTtlMs = cacheTtlMs(process.env);
            // The re-orientation counts as delivered only now, once the prompt carrying it actually
            // reached the provider — an error or abort before this must leave it pending, not consumed.
            commitOrientation();
            // A parent stop that landed during prompt() must make the child terminally unsuccessful;
            // otherwise an empty aborted assistant is mistaken for a successful "returned nothing" job.
            if (this.d.registry.consumePendingAbort(sessionId)) throw new Error('delegation aborted');
            // Thinking-only guard (#115): a reasoning model that ends a 'stop' turn with ONLY a thinking
            // block would settle with an empty reply. ONE automatic nudge, never persisted, no loop.
            const settled = lastAssistant(ch.session.messages as { role?: string }[]);
            if (settled && isThinkingOnlyReply(settled)) {
              await ch.session.prompt(NO_REPLY_NUDGE);
              if (this.d.registry.consumePendingAbort(sessionId)) throw new Error('delegation aborted');
            }
          }, { identity: opts.identity, elicit, emitCard, emitSubagent, emitSubagentCompletion, emitWorkflow, emitWorkflowCompletion, toolPolicy: effectiveToolPolicy, permissions, sessionId, deliveryTarget: opts.deliveryTarget, workDir: effectiveWorkDir.workDir, ...(delegated?.pathView ? { pathView: delegated.pathView } : {}), contributionUserId: turnContributionUserId, model: { provider: ch.providerId, model: ch.model, thinkingLevel: ch.thinkingLevel } }));
          // Deterministic settled idle (model + context fill) AFTER the turn — proactive footers depend on it.
          turnOnEvent?.({
            type: 'idle',
            model: execRefSpec({ program: 'elowen', provider: ch.providerId || ch.provider, model: ch.model }),
            usage: sessionUsageSnapshot(ch.session, this.d.store, ch.sessionId),
          });
        } finally { detach?.(); }
        // Auto-compaction is PI-native (the factory configures the channel's reserveTokens from
        // DEFAULT_AUTO_COMPACT_PCT): PI compacts on its own after this turn's agent_end, and the factory's
        // subscription mirrors the shrunk context into the store — so no manual trigger/persist here.
        // The reply = the last assistant message of the settled turn. A failed turn must FAIL, not settle
        // silently: PI resolves prompt() even on a provider error (stopReason 'error', empty content).
        const msgs = ch.session.messages as { role?: string; stopReason?: string; errorMessage?: string }[];
        const last = lastAssistant(msgs);
        const assistantText = last ? extractText(last) : '';
        if (opts.internalSystem && (!last || last === assistantBefore || last.stopReason === 'error' || last.stopReason === 'aborted')) {
          throw new Error(last?.errorMessage?.trim() || 'sub-agent result was not processed by the delegated parent');
        }
        if (last?.stopReason === 'error' && !assistantText.trim()) {
          throw new Error(last.errorMessage?.trim() || 'the model returned no reply (provider error)');
        }
        // The post-turn curator, the writer stamp and the plugin-reload drain all settle in send() below,
        // outside this channel's lock — see settleTurn.
        return assistantText;
      };

      // Durable resume foundation: capture everything a later boot would need to reconstruct THIS turn
      // faithfully, synchronously before the turn's first model call, and drop it once the turn settles
      // — so a surviving row names exactly the turn a process death (or a future park) interrupted.
      // Ordinary platform turns only: a delegated child has the durable delegation store, an owner-steer
      // or hidden system turn is not a platform sender's turn, and a `delegated` conversation never
      // reaches here anyway (parentSessionId). Everything volatile is captured VERBATIM; authority is
      // captured as the ACCOUNT id alone and re-derived at resume (resolvePlatformTurnAuthority).
      const resumable = !parentSessionId && !opts.internalSystem && !opts.ownerSteer
        && opts.identity !== undefined
        && (opts.identity.conversation === 'direct' || opts.identity.conversation === 'shared');
      if (resumable) {
        const identity = opts.identity!;
        const denied = opts.toolPolicy?.deny ? [...opts.toolPolicy.deny].sort() : [];
        const envelope: PlatformTurnResumeEnvelope = {
          v: 1,
          platform: identity.platform,
          channelId: opts.channelId,
          ownerUserId,
          direct: opts.direct === true,
          trusted: opts.trusted === true,
          scheduled: opts.scheduled === true,
          accountUserId: opts.writerUserId ?? null,
          ...(opts.sender ? { sender: { id: opts.sender.id, name: opts.sender.name } } : {}),
          identity: {
            platform: identity.platform,
            userId: identity.userId,
            ...(identity.elowenUserId !== undefined ? { elowenUserId: identity.elowenUserId } : {}),
            ...(identity.elowenUsername !== undefined ? { elowenUsername: identity.elowenUsername } : {}),
            admin: identity.admin,
            owner: identity.owner,
            conversation: identity.conversation as 'direct' | 'shared',
          },
          ...(opts.promptAppend?.length ? { promptAppend: [...opts.promptAppend] } : {}),
          ...(denied.length ? { deniedTools: denied } : {}),
          ...(opts.model ? { model: {
            ...(opts.model.provider !== undefined ? { provider: opts.model.provider } : {}),
            ...(opts.model.model !== undefined ? { model: opts.model.model } : {}),
          } } : {}),
          ...(opts.thinkingLevel !== undefined ? { thinkingLevel: opts.thinkingLevel } : {}),
          // `Infinity` (cron's "never roll over") does not survive JSON — omitted, like unset.
          ...(opts.idleRolloverMs !== undefined && Number.isFinite(opts.idleRolloverMs)
            ? { idleRolloverMs: opts.idleRolloverMs } : {}),
          ...(opts.deliveryTarget !== undefined ? { deliveryTarget: opts.deliveryTarget } : {}),
          ...(opts.historyPlatform !== undefined ? { historyPlatform: opts.historyPlatform } : {}),
          promptCommand: opts.promptCommand === true,
          turnText,
          senderText,
          ...(opts.images?.length ? { imageCount: opts.images.length } : {}),
          capturedAt: new Date().toISOString(),
        };
        this.d.store.savePlatformTurnEnvelope(sessionId, JSON.stringify(envelope));
      }
      try {
        // A same-sender follow-up sent DURING this turn is steered into it (see send()'s top) — PI folds
        // it in between steps — so there is no post-turn flush: the running turn is the single place its
        // words land.
        return await runOne(turnText, senderMessage, opts.images, opts.onEvent);
      } finally {
        // The turn settled (reply or error already back with the adapter) — nothing left to resume.
        if (resumable) this.d.store.clearPlatformTurnEnvelope(sessionId);
      }
      } finally {
        ch.turnSender = undefined;
        ch.turnWriterUserId = null;
      }
    });
    // Armed only by a turn that produced an answer, exactly as the owner surface arms it.
    if (steered === null && !opts.internalSystem && opts.writerUserId != null && this.d.curator
        && this.d.userSettings?.(opts.writerUserId)?.autoSave !== false) {
      curate = { curator: this.d.curator, userId: opts.writerUserId, userText: senderText, assistantText: reply };
    }
    return reply;
    } finally {
      // The settlement side of a room turn — see settleTurn. In a `finally`, like the owner surface's, and
      // for the same reason: a turn that THROWS after the prompt (a provider error, a parent abort landing
      // mid-turn) is still a turn that happened. Settling it on the happy path meant a CreateSkill issued
      // from Discord in such a turn wrote its skill to disk and the reload was never drained — the exact
      // defect this settlement exists to close — and the register lost the writer for that message too.
      //
      // Deliberately OUTSIDE the channel lock: the plugin reload it drains disposes live sessions, so
      // draining it under the lock would tear down the very session that just answered. The writer stamp
      // lands only now for the reason it always did — the turn is what guarantees the session row exists.
      //
      // A message STEERED into somebody else's running turn omits the curator (that turn curates its own
      // exchange) and the drain (that turn is still running, so nothing may dispose it yet), while the
      // writer stamp still lands: the person did write here.
      try {
        if (admitted) settleTurn({
          sessionId,
          ...(curate ? { curate } : {}),
          ...(!opts.internalSystem && opts.writerUserId != null
            ? { lastWriter: { store: this.d.store, userId: opts.writerUserId } }
            : {}),
          // Its absence here is why a CreateSkill issued from Discord wrote a skill to disk and then silently
          // never applied it: the owner surface drained the request and no room ever did.
          ...(ranOwnTurn && this.d.drainPluginReload ? { drainPluginReload: this.d.drainPluginReload } : {}),
          // `notify` is owner-only and therefore absent: the room already received this answer.
        });
      } finally {
        if (delegationLeaseHeartbeat) clearInterval(delegationLeaseHeartbeat);
        try { await delegationLease?.release(); }
        finally { if (parentSessionId && delegatedCall) this.endDelegatedCall(parentSessionId, sessionId); }
      }
    }
  }

  /** Run ONE delegated turn whose EXECUTION happens in another process (the sub-agent runner), keeping in
   *  THIS one everything that cannot leave it. The parent/child edge, the parent-abort fence and the
   *  pending-abort marker all live in the in-memory LiveSessionRegistry and are used ACROSS sessions —
   *  `isParentAborting` asks about the parent, which is a daemon session — so their fencing depends on
   *  synchronous read-modify-write and cannot be distributed.
   *
   *  Deliberately the same guards, in the same order, as the delegated half of {@link send}: this is the
   *  same delegation, only its turn body is somewhere else. */
  async sendRemote(
    req: { channelId: string; ownerUserId: number; parentSessionId: string },
    run: () => Promise<string>,
  ): Promise<string> {
    const sessionId = channelSessionId(req.channelId);
    const parentSessionId = req.parentSessionId;
    if (this.d.registry.isParentAborting(parentSessionId)) throw new Error('delegation aborted');
    const parent = this.d.store.getSession(parentSessionId);
    if (!parent || parent.user_id !== req.ownerUserId || parent.id === sessionId) throw new Error('invalid parent session');
    // Register before the first async boundary. A background delegate may be stopped immediately after
    // its tool returns, before the runner has reported anything at all.
    this.beginDelegatedCall(parentSessionId, sessionId);
    try {
      if (this.d.registry.consumePendingAbort(sessionId)) throw new Error('delegation aborted');
      const reply = await run();
      // A parent stop that landed while the runner was working must make the child terminally
      // unsuccessful; otherwise an aborted child's partial answer is mistaken for a successful one.
      if (this.d.registry.consumePendingAbort(sessionId)) throw new Error('delegation aborted');
      return reply;
    } finally {
      this.endDelegatedCall(parentSessionId, sessionId);
    }
  }

  /** Steer a delegating turn's follow-up into ITS OWN child's RUNNING turn, and report success only once
   *  the message provably reached the child's context.
   *
   *  PI accepting a steer is a promise, not delivery: the queue drains before the next model call, so a
   *  turn that ends first leaves the message stranded in an in-memory queue that dies with the live record
   *  (LRU eviction, release to the runner) — silently. The transcript is the only honest confirmation
   *  (the same reasoning as BrainTurnRunner's resultInContext): a delivered queue item is persisted as a
   *  durable user row at message_start, and deliverQueuedUserEcho stamps THIS steer's echo object in the
   *  same beat — so the wait below is correlated per message, never by text. Matching the transcript by
   *  text would let one durable row confirm TWO concurrent steers that happen to carry the same words,
   *  leaving the second falsely confirmed and its copy stranded in the queue. A turn that ends with the
   *  item still queued gets it REMOVED — the caller's fallback turn re-sends the text, and the next
   *  prompt's queue drain would otherwise deliver the stale copy alongside it, putting the same message
   *  in front of the model twice. The wait is bounded by the child's own turn: it ends at delivery, at
   *  turn end, or with the delegation's abort fences (the stall watchdog aborts a wedged child, so this
   *  can never hang past it).
   *
   *  Authorization stays with the caller (DelegatedSessionService.continueSubagent's ownership + scope
   *  guards; the runner invokes this only for a steer verb the daemon already guarded). The parent-link
   *  check here is a backstop so an ordinary platform channel is never steerable through this seam. */
  async steerDelegatedTurn(channelId: string, text: string): Promise<DelegatedSteerOutcome> {
    const sessionId = channelSessionId(channelId);
    const parentSessionId = this.d.store.getSession(sessionId)?.parent_session_id;
    if (!parentSessionId) return 'idle';
    const aborted = (): boolean =>
      this.d.registry.isParentAborting(parentSessionId) || this.d.registry.hasPendingAbort(sessionId);
    const ch = this.d.registry.channelGet(channelId);
    if (!ch?.session.isStreaming) return 'idle';
    if (aborted()) throw new Error('delegation aborted');
    // This FRESH echo object is the steer's whole identity: deliverQueuedUserEcho stamps the durable row
    // id onto exactly this object at message_start, and every clear-and-requeue path re-enqueues the same
    // echo reference — so the checks below survive a concurrent cleanup rebuilding the queue's wrapper
    // objects, and can never be satisfied by another steer's row.
    const echo: QueuedUserEcho = { persistText: text, displayText: text, sourceText: text, publish: true };
    await enqueueMirrored(ch, 'steer', text, undefined, echo);
    const landed = (): boolean => echoDeliveredId(echo) !== undefined;
    while (true) {
      // Same fence as the ownerSteer fast path, re-checked every beat: a stop clears PI's queue, and the
      // copy enqueued after that clear must be cleared again before rejecting.
      if (aborted()) {
        const live = this.d.registry.channelGet(channelId);
        if (live) { live.session.clearQueue(); clearDeliveredUserEchoes(live); }
        throw new Error('delegation aborted');
      }
      if (landed()) return 'delivered';
      const live = this.d.registry.channelGet(channelId);
      // The live record died under us (eviction, release to the runner) — the queue died with it.
      if (!live) return 'idle';
      if (!live.session.isStreaming) {
        if ((live.queuedSteer ?? []).some((m) => m.echo === echo)) { this.removeQueuedSteer(live, echo); return 'idle'; }
        // Gone from the queue with no delivery stamp yet: one final read decides between "delivered in
        // the same beat the turn ended" and "erased by an abort/clear".
        return landed() ? 'delivered' : 'idle';
      }
      await new Promise((resolve) => setTimeout(resolve, STEER_POLL_MS));
    }
  }

  /** Drop the steer carrying `echo` from PI's queue while keeping every other queued message (with its
   *  images) — the same clear-and-requeue dance as SessionQueueService.queueRemove. Targeted by ECHO
   *  identity because the wrapper objects do NOT survive a concurrent clear-and-requeue (each requeue
   *  builds fresh QueuedMsg wrappers around the same echoes): matching wrappers would let another
   *  waiter's cleanup hide this steer from its own, leaving a stale copy queued for double delivery. */
  private removeQueuedSteer(live: LiveBrain, echo: QueuedUserEcho): void {
    const survivors = [
      ...(live.queuedSteer ?? []).filter((m) => m.echo !== echo).map((m) => ({ kind: 'steer' as const, m })),
      ...(live.queuedFollowUp ?? []).map((m) => ({ kind: 'followUp' as const, m })),
    ];
    live.session.clearQueue();
    clearDeliveredUserEchoes(live);
    for (const s of survivors) void enqueueMirrored(live, s.kind, s.m.text, s.m.images, s.m.echo);
  }

  /** Mid-run: a SAME-SENDER message that arrives while this channel's turn streams is STEERED into the
   *  running turn — PI delivers it between steps (after the current tool calls, before the next model
   *  call), so the agent folds it in without stalling the Discord handler on the channel lock or spawning
   *  a separate turn. Same-sender is REQUIRED: the running turn executes under the original sender's
   *  policy/identity, so steering a DIFFERENT member's words would run them with the first sender's powers
   *  — a shared channel keeps each sender isolated, so a different sender falls through to its own turn.
   *  Returns '' when it steered (nothing to run), or null when it fell through (no live turn / different
   *  sender) and send() must take the channel lock and run its own turn. */
  private async trySteerIntoRunningTurn(opts: ChannelSendOpts, turnText: string, senderText: string, delegationAborted: () => boolean): Promise<string | null> {
    const streaming = this.d.registry.channelGet(opts.channelId);
    if (streaming?.session.isStreaming) {
      // A durable sub-agent/workflow result for a DELEGATED parent (BrainTurnRunner.sendCustomSystem →
      // sendDelegatedCustom). Steer it in so the child folds the result into the work it is doing instead
      // of learning about it a turn late — the same reason the owner path steers. It rides PI's custom
      // seam rather than enqueueMirrored: a hidden message must not surface as a queue chip or a durable
      // user row. It carries only the result, because the running turn already holds the ambient turn
      // context this path would otherwise compose around it. It is ENQUEUED rather than sent so that a turn
      // ending between the isStreaming read and here leaves the message waiting for the next turn instead
      // of starting one outside the channel lock (see steerCustomMessage for what changed in PI 0.84.2).
      if (opts.internalSystem) {
        if (delegationAborted()) throw new Error('delegation aborted');
        steerCustomMessage(streaming.session, {
          customType: opts.internalSystem.customType, content: turnText, display: false,
          details: { source: 'elowen', resultId: opts.internalSystem.resultId },
        });
        if (delegationAborted()) {
          streaming.session.clearQueue();
          throw new Error('delegation aborted');
        }
        return '';
      }
      // Owner steering a delegated SUB-AGENT (BrainService.sendToSubagent sets ownerSteer): inject the
      // guidance mid-run — the owner owns the child, so redirecting it immediately is the point. Now the
      // SAME primitive as the Discord same-sender path below.
      if (opts.ownerSteer) {
        // This path intentionally does not take the channel lock (it must steer the current PI turn), so
        // fence it on both sides of the await. If stop clears PI's queue while steer() is pending, the
        // second check clears it again before rejecting; no late instruction survives the aborted tree.
        if (delegationAborted()) throw new Error('delegation aborted');
        await enqueueMirrored(streaming, 'steer', turnText, undefined, {
          persistText: turnText, displayText: senderText, sourceText: senderText, publish: true,
        });
        if (delegationAborted()) {
          streaming.session.clearQueue();
          clearDeliveredUserEchoes(streaming);
          throw new Error('delegation aborted');
        }
        return '';
      }
      // A platform (Discord) SAME-SENDER follow-up: the model and durable row receive the same envelope,
      // while the platform UI event keeps the sender's clean words. Image bytes ride the same queue item.
      if (streaming.turnSender != null && streaming.turnSender === opts.identity?.userId) {
        const displayText = opts.images?.length ? `${senderText}\n[📎 ${opts.images.length}× image]` : senderText;
        // Mirror the enqueue so the image bytes survive a positional queue-remove (PI's clearQueue drops them).
        await enqueueMirrored(
          streaming,
          'steer',
          turnText,
          opts.images?.map((i) => ({ type: 'image' as const, data: i.data, mimeType: i.mimeType })),
          { persistText: turnText, displayText, sourceText: senderText, publish: false },
        );
        return '';
      }
    }
    return null;
  }

  /** Live status of a channel session (model + whether a turn is in flight + context usage) for a platform
   *  `/status` (and `/stop`) slash. Null when the channel has no live session yet (never spawned, or
   *  LRU-evicted). Read-only — no lock needed. */
  status(channelId: string): { provider?: string; model: string; streaming: boolean; usage: BrainUsage; fast: boolean; fastAvailable: boolean } | null {
    const ch = this.d.registry.channelGet(channelId);
    return ch ? {
      provider: ch.providerId,
      model: ch.model,
      // A background delegate can outlive the parent's own prompt. Keep `/stop` available while any
      // tracked descendant is still running so the channel can cancel the whole tree.
      streaming: ch.session.isStreaming || this.d.registry.hasActiveChildren(ch.sessionId),
      usage: sessionUsageSnapshot(ch.session, this.d.store, ch.sessionId),
      fast: this.d.fastMode?.(ch.settingsUserId) === true,
      fastAvailable: ch.fastAvailable,
    } : null;
  }

  /** Abort the in-flight turn on a channel session (a platform `/stop` slash). Delegated descendants
   *  are stopped depth-first before their parent, so a nested child cannot keep working after the room's
   *  `/stop`. No-op when idle/absent. */
  async abort(channelId: string): Promise<void> {
    await this.abortTree(channelId, new Set());
  }

  private async abortTree(channelId: string, seen: Set<string>, reason = 'aborted'): Promise<void> {
    if (seen.has(channelId)) return;
    seen.add(channelId);
    const sessionId = channelSessionId(channelId);
    // Fence before inspecting descendants. A fresh idle-child continuation must not register itself
    // after this snapshot and then get erased by clearChildren() without being aborted.
    this.d.registry.beginParentAbort(sessionId);
    try {
      // Before tearing children down: a workflow ORIGINATING here (including a node's self-expansion)
      // must stop launching nodes, or it respawns fresh children the moment an aborted one settles.
      // INSIDE the try: this reaches into the plugin registry, and if that throws (a reload racing the
      // abort) an outer position would leave the fence held forever — permanently marking the session as
      // aborting, so every later delegation from it is refused until the daemon restarts.
      await this.d.cancelWorkflows?.(sessionId);
      const ch = this.d.registry.channelGet(channelId);
      if (!ch) {
        if (this.d.registry.isActiveChild(sessionId)) {
          this.d.registry.requestPendingAbort(sessionId);
          // No live record here, but the session may be running in the sub-agent runner: the marker above
          // makes the delegation terminal, and this is what actually interrupts the model call.
          this.d.abortRemote?.(channelId);
        }
        return;
      }
      // Record cancellation before awaiting PI. The running send consumes this marker immediately after
      // prompt settles and throws, so the delegate plugin records ERROR rather than DONE/empty output.
      if (this.d.registry.isActiveChild(ch.sessionId)) this.d.registry.requestPendingAbort(ch.sessionId);
      for (const child of this.d.registry.childrenOf(ch.sessionId)) {
        if (isChannelSession(child)) await this.abortTree(channelIdOf(child), seen, reason);
      }
      this.d.registry.clearChildren(ch.sessionId);
      // Match owner-chat stop semantics: queued steering belongs to the interrupted turn and a parked
      // AskUserQuestion must reject before PI aborts, otherwise `/stop` can leave prompt() hanging.
      ch.session.clearQueue();
      clearDeliveredUserEchoes(ch);
      this.d.elicitation?.cancelForSession(ch.sessionId, reason);
      await abortSessionWork(ch.session).catch(() => { /* nothing in flight / already settling */ });
    } finally {
      this.d.registry.endParentAbort(sessionId);
    }
  }

  /** Reset some/all channel sessions the SAFE way — unlike the old synchronous `channelDisposeAll()`
   *  (which held no per-channel lock, aborted no turn and waited for nothing), this fences out new
   *  delegated work, cancels any workflow DAG, releases a parked question and aborts an in-flight turn —
   *  the exact same tree teardown a platform `/stop` does — BEFORE disposing, and only under the
   *  channel's own lock so a concurrent send() cannot straddle the teardown.
   *
   *  `settingsFilter` narrows the reset to the channel sessions COMPOSED FROM one account (a change to
   *  that account's instructions or persona, which must not touch anyone else's room); omitted, every
   *  channel is reset (a plugin reload, which genuinely is global).
   *
   *  Matched on the id the session was composed from, never on who owns the row — the same rule
   *  BrainService.applyAutoCompactSettings follows, and for the same reason: a room belongs to whoever
   *  opened it, so keying this on ownership respawned the wrong rooms in both directions. The opener's
   *  save reset a room already composed for somebody else (pushing the opener's instructions back into
   *  it), while the writer whose instructions the room actually renders saw nothing happen at all. */
  async resetChannels(reason: string, settingsFilter?: (settingsUserId: number) => boolean): Promise<void> {
    const targets = this.d.registry.channelEntries()
      .filter(([, ch]) => !settingsFilter || settingsFilter(ch.settingsUserId))
      .map(([channelId]) => channelId);
    await Promise.all(targets.map(async (channelId) => {
      await this.abortTree(channelId, new Set(), reason);
      // The abort above interrupts any turn but does not itself remove the record — a concurrent send()
      // that is already mid-turn is still running its callback under the channel lock, so queue the
      // actual dispose behind it instead of tearing the record down out from under that turn.
      await this.d.registry.withLock(channelSessionId(channelId), async () => {
        this.d.registry.channelDispose(channelId);
      });
    }));
  }

  /** Compact a channel session's context (a platform `/compact` slash), serialized against its turns so
   *  it can't race an in-flight prompt. Returns the compaction result (usage + whether anything was
   *  compacted), or null if there's no session. A too-small session is a benign no-op, not an error. */
  async compact(channelId: string, customInstruction?: string): Promise<CompactResult | null> {
    const sessionId = channelSessionId(channelId);
    return this.d.registry.withLock(sessionId, async () => {
      const ch = this.d.registry.channelGet(channelId);
      if (!ch) return null;
      // A real compaction fires PI's `compaction_end`, which the factory's session subscription mirrors
      // into the store (and the spawner fans `compacted` to clients) — so persistence rides the event, not
      // this call. A no-op (session too small) emits no result and leaves the store untouched.
      const result = await runCompaction(ch.session, customInstruction);
      result.usage = withDescendantUsage(result.usage, this.d.store.descendantUsage(ch.sessionId));
      return result;
    });
  }

  /** Shared-channel system-prompt fragment: names the room (and its topic) and pins the multi-user
   *  etiquette — senders arrive in structured envelopes and are usually NOT the instance owner, so the brain
   *  must never address a stranger as the owner. Applied only when the channel session spawns via
   *  `promptAppend` → `extraAppend`; a later channel-name/topic change takes effect once the session
   *  respawns (LRU eviction or a /new reset). */
  fragmentFor(src: { platform: string; channelName?: string; channelTopic?: string }, ownerUserId: number): string {
    const u = this.d.users.get(ownerUserId);
    const ownerName = u?.name || u?.username || 'the owner';
    const platform = src.platform.charAt(0).toUpperCase() + src.platform.slice(1);
    const topic = src.channelTopic?.trim() ? ` The channel topic is: "${src.channelTopic.trim()}".` : '';
    return `You are talking on ${platform} in #${src.channelName}.${topic}\n`
      + `This is a shared channel: each user message carries the name of whoever sent it. Treat that name as `
      + `metadata about the message, never as text to echo — do not open your reply with a sender label in any `
      + `form. Track who asked for what; the person talking to you is usually NOT ${ownerName}, whose Elowen `
      + `instance you run on. Never assume the sender is ${ownerName} unless the message says so.`;
  }
}
