import type { PluginRegistry } from '../plugins/registry.js';
import { decodeNotificationDestination, encodeNotificationDestination } from '../plugins/destinations.js';
import type { ChannelRef, KnownControls, ServiceNotice } from '../plugins/api.js';
import type { Policy } from '../plugins/policy.js';
import { narrowToolAllowList, type ToolPolicy, type TurnIdentity } from '../plugins/policyContext.js';
import type { IdentityResolver } from './identity.js';
import type { ChannelSessionService } from './channels.js';
import { channelSessionId } from './sessionId.js';
import { platformOrigin } from '../api/clientIp.js';
import { openTurn, type TurnActivityFeed, type TurnOriginPin } from './session/turnSettled.js';
import type { SessionListItem, SessionPage, SessionPageOpts } from './service/statusService.js';
import {
  normalizeDelegatedExecutionScope,
  packDelegatedPromptAppend,
  withDelegatedDeniedTools,
} from './delegatedScope.js';
import type { BrainEvent } from './events.js';
import type { DelegatedTurnRequest } from './delegatedTurn.js';
import { resolveAgentTools, READ_ONLY_AGENT_TOOLS, type AgentDef } from './agents/agentRegistry.js';
import { renderAgentPrompt } from './agents/agentPrompt.js';
import { buildReadOnlyBoundary, resolveReadOnlyOrigin } from './agents/readOnlyBoundary.js';
import { bindingRef, resolveDelegatedWorkspace } from './workspaceScope.js';

export interface PlatformOrchestratorDeps {
  /** The daemon-wide plugin registry resolver (undefined when plugins aren't wired). */
  plugins: () => Promise<PluginRegistry | undefined>;
  /** Report a platform turn to the team activity feed. A CALLBACK rather than the event bus itself:
   *  the brain layer has no bus and should not grow a dependency on one for a single report. Absent in
   *  minimal wirings (tests), where the feed is simply not fed. */
  recordActivity?: TurnActivityFeed;
  /** The write-time origin rollup, so a room turn's spend is attributed to the person who wrote it and to
   *  the platform it came from. Absent in minimal wirings, which then attribute nothing. */
  usageOrigins?: TurnOriginPin;
  /** The Elowen user that anchors platform channel sessions (the admin). */
  platformOwner?: () => number | undefined;
  /** The typed sub-agent registry, resolved when a delegate call names a `subagent_type` — turns the type
   *  into the child's role prompt, tool allow-list and (for a read-only type) a minted read-only boundary. */
  agents?: () => Map<string, AgentDef>;
  /** A linked sender uses their Elowen account permissions wherever they write: this resolves that
   *  account's own project Policy. An unlinked sender receives no project or tool access. */
  policyForUser?: (userId: number) => Policy;
  /** A linked user's own tool authority — the grant an admin gave that account, minus their deny-list and
   *  the tools of any grant-gated plugin they do not hold — applied for their platform turns. */
  toolAuthorityFor?: (userId: number) => ToolPolicy | undefined;
  identity: IdentityResolver;
  channels: ChannelSessionService;
  /** Where a DELEGATED turn actually executes — see SubagentDispatch. Every delegation reaches the host
   *  through this orchestrator's `run` handle (the Delegate tool and a workflow node alike), so this is
   *  the one place that decides between running it on this event loop and handing it to the runner. */
  dispatch: { send(request: DelegatedTurnRequest, text: string, onEvent?: (e: BrainEvent) => void): Promise<string> };
  sandbox?: () => KnownControls['sandbox'] | undefined;
  /** Admin daemon restart for a platform `/restart` slash. Lazily resolved: the handler is built after
   *  the brain (it needs systemd + the marker path), so this returns undefined until it's wired. */
  restart?: () => ((byUserId: number) => Promise<void>) | undefined;
  /** BOUND send into a user's OWN stored owner-chat conversation. Direct platform origins are handled
   *  here in the orchestrator through ChannelSessionService and the platform outbound adapter instead. */
  originSend?: (userId: number, sessionId: string | undefined, text: string, onEvent?: (e: { type: string; sessionId?: string }) => void) => Promise<string | null>;
  /** The caller's OWN conversations eligible to bind into a channel (the /context picker), resolved from
   *  the platform sender id to their linked Elowen account. Null when that sender is not linked to any
   *  account (they have no bindable sessions). Paginated for the surface pickers. */
  listContextSessions?: (platform: string, platformUserId: string, opts: SessionPageOpts) => SessionPage<SessionListItem> | null;
  /** Bind (MOVE) one of the caller's own conversations into the channel slot — see
   *  BrainService.bindChannelContext. Rejects when the sender is unlinked or a guard fails. */
  bindContext?: (platform: string, platformUserId: string, channelKey: string, sessionId: string) => Promise<{ title: string }>;
}

/** THE single expression mapping an inbound conversation to its registry channel key — used by both the
 *  message pipeline and the control surface so a slash command targets the exact session a message would. */
const keyOf = (ref: ChannelRef): string => `${ref.platform}-${ref.threadId ?? ref.channelId}`;

/** Lifecycle + turn pipeline of the plugin-contributed platform adapters (Discord bot, …): connect
 *  them, translate each inbound message into a channel-session turn (policy → identity → send), and
 *  fan proactive notifications out to them. Fail-open per adapter — one broken platform must not
 *  block the rest. */
export class PlatformOrchestrator {
  private started: { name: string; disconnect?(): void; notify?(t: string, channelId?: string, notice?: ServiceNotice): Promise<void> }[] = [];
  private knownPlatforms = new Set<string>();
  /** Sources entering through the host-only relay control, not through an adapter's human message listener. */
  private hostAutomationSources = new WeakSet<object>();

  constructor(private d: PlatformOrchestratorDeps) {}

  /** Start every platform adapter: wire its messages into channel sessions and let it deliver the
   *  replies. Called once at daemon startup and re-run by reloadPlugins. */
  async startAll(log?: { info(m: string): void; error(m: string): void }, only?: readonly string[]): Promise<void> {
    const plugins = await this.d.plugins();
    const adapters = plugins?.platforms ?? [];
    this.knownPlatforms = new Set(adapters.map((adapter) => adapter.name));
    for (const adapter of adapters) {
      if (only && !only.includes(adapter.name)) continue;
      try {
        const onMessage: Parameters<typeof adapter.listen>[0] = async (src, text, onEvent) => {
          const owner = this.d.platformOwner?.();
          if (owner === undefined || !src.access) return undefined; // unmapped sender → stay silent
          // Direct-chat scheduled work must remain a CHANNEL turn: owner-chat send() would mint a second
          // live session with owner tooling over the same transcript. The plugin persists this opaque target;
          // core validates it against the durable direct row, runs through ChannelSessionService, then pushes
          // the settled text through the original platform adapter before confirming delivery.
          if (src.origin?.sessionId && src.origin.deliveryTarget) {
            const destination = decodeNotificationDestination(src.origin.deliveryTarget, this.knownPlatforms);
            if (!destination) throw new Error('invalid direct delivery target');
            const channelId = `${destination.platform}-${destination.id}`;
            if (!this.d.channels.mayDeliverDirectSession(src.origin.userId, src.origin.sessionId, channelId)) {
              throw new Error('direct origin session is unavailable');
            }
            const policy = this.d.policyForUser?.(src.origin.userId);
            if (!policy) throw new Error('direct origin account is unavailable');
            const originAuthority = this.d.toolAuthorityFor?.(src.origin.userId);
            const reply = await this.d.channels.send({
              channelId,
              ownerUserId: src.origin.userId,
              direct: true,
              policy,
              // A direct wake-up resumes the interactive DM's normal composition and context. The cron
              // source already frames the turn as scheduled; using the scheduled persona here would leave
              // a cold/evicted DM live under that persona for the next human message.
              promptAppend: plugins?.platformPromptsFor?.(destination.platform) ?? undefined,
              toolPolicy: originAuthority,
              identity: this.d.identity.forDirectChat(src.origin.userId, destination.platform, policy),
              writerUserId: src.origin.userId,
              historyPlatform: destination.platform,
              deliveryTarget: src.origin.deliveryTarget,
              onEvent,
            }, text);
            await this.notify(reply, src.origin.deliveryTarget);
            onEvent?.({ type: 'delivery', sessionId: src.origin.sessionId });
            return reply;
          }
          // Owner-chat origins use the bound owner path. A named session may fall through only when it is
          // gone/foreign; an account-bound job without a session never falls into an operator-owned channel.
          if (src.origin && this.d.originSend) {
            const reply = await this.d.originSend(src.origin.userId, src.origin.sessionId, text, onEvent);
            if (reply !== null) return reply;
            if (src.origin.sessionId === undefined) return undefined;
          }
          // Delegated children belong to the account that owns their durable parent, not necessarily the
          // instance-wide platform owner. Resolve that owner from the parent row, then let channels.send
          // repeat the equality check at spawn time. A subagent message without a valid parent is never
          // allowed to fall back to an owner-anchored standalone channel.
          const parentSessionId = src.platform === 'subagent' ? src.access.parentSessionId : undefined;
          let sessionOwner = owner;
          if (src.platform === 'subagent') {
            if (!parentSessionId) throw new Error('invalid parent session');
            const parentOwner = this.d.channels.sessionOwnerUserId(parentSessionId);
            if (parentOwner === undefined) throw new Error('invalid parent session');
            sessionOwner = parentOwner;
          }
          // A typed sub-agent (subagent_type on the delegate call): the plugin forwards only the type name
          // in `access.agentType`; the host resolves it into the child's role prompt (here) plus its tool
          // allow-list and permission boundary (in the subagent branch below). Unknown/absent type → the
          // generic path (src.access.prompt), so back-compat holds.
          const agentDef = src.platform === 'subagent' && src.access.agentType
            ? this.d.agents?.().get(src.access.agentType)
            : undefined;
          const rolePrompt = agentDef ? renderAgentPrompt(agentDef.body) : src.access.prompt;
          const platformPrompts = src.platform === 'subagent' ? [] : (plugins?.platformPromptsFor?.(src.platform) ?? []);
          const promptAppend = [
            // Platform-owned surface instructions apply even in a personal chat with no channel metadata.
            // They lead the append so role/context blocks can specialize the task without erasing where the
            // reply is being delivered or which native communication tools own that surface.
            ...platformPrompts,
            // Trimmed like every other section: a blank role is no role, and an append that survives only
            // as whitespace is what the scope normalizer rejects the whole delegation over.
            ...(rolePrompt?.trim() ? [rolePrompt] : []),
            // Parent-supplied background for a delegated child — stable prefix blocks (cache-friendly),
            // each bounded by the delegated-scope normalizer like every other prompt append. One entry per
            // block, so a workflow node's dependency results are not squeezed into a single chunk's budget.
            ...(typeof src.access.context === 'string' ? [src.access.context] : src.access.context ?? [])
              .filter((chunk) => typeof chunk === 'string' && chunk.trim().length > 0),
            ...(src.channelName ? [this.d.channels.fragmentFor(src, owner)] : []),
          ];
          // ONE unified access decision, in two shapes: a DELEGATED turn runs under the immutable boundary
          // minted here and dispatched below, while an ordinary platform turn resolves its sender.
          if (src.platform === 'subagent') {
            // Capture one immutable boundary on the very first child spawn. The synthetic platform source
            // is internal but still validated like persisted JSON: a malformed scope must not fall back to
            // the owner's ambient policy. `owner` is independently authenticated, never inferred from an
            // admin role (a foreign Discord admin is not the instance operator).
            // Read-only MODE — from a read-only agent TYPE or a bare `read_only` delegation — resolves to ONE
            // host-side definition: the READ_ONLY_AGENT_TOOLS preset plus a minted permission boundary (Bash
            // clamped to non-destructive commands even though the child runs unattended — see
            // readOnlyBoundary.ts). This is the single source of "read-only"; the subagent plugin no longer
            // carries its own toolset.
            const readOnlyMode = agentDef?.toolsSpec === 'read-only' || src.access.readOnly === true;
            // WHERE the clamp came from, recorded on the durable scope because a later DelegateContinue may
            // lift one the delegating turn chose and may never lift one it was subject to. `planMode` is
            // stamped next to `readOnly` by pathGuard precisely so the two stay distinguishable here.
            const readOnlyOrigin = resolveReadOnlyOrigin({
              agentReadOnly: agentDef?.toolsSpec === 'read-only',
              requested: src.access.readOnly === true,
              planMode: src.access.planMode === true,
            });
            // What the type / read-only mode contributes to the toolset (undefined = no constraint of its own).
            const preset = readOnlyMode ? READ_ONLY_AGENT_TOOLS : agentDef ? resolveAgentTools(agentDef) : undefined;
            // INTERSECT the preset with any call-level allow-list (an explicit `tools`, or a restricted
            // parent) — both only ever narrow, so a read-only child never even SEES a tool the caller lacks.
            // A parent deny-list (disabled tools) rides on top untouched.
            //
            // Through the shared narrowing, because BOTH sides carry patterns. An exact intersection broke
            // this path twice over: a pre-migration grant is literally `['*']`, which shares no member with
            // any preset and left every read-only or typed child of a non-admin with an empty scope; and
            // `mcp__*` in the read-only preset can never equal a concrete granted MCP tool name, so those
            // children lost MCP permanently.
            const callAllow = src.access.toolPolicy?.allow;
            const narrowed = preset && callAllow ? narrowToolAllowList(preset, callAllow) : preset ?? callAllow;
            // A disjoint intersection (the caller's allow-list shares no tool with the preset) leaves the
            // child with nothing to do. Fail with an actionable error — as the pre-unification plugin did —
            // instead of silently spawning a mute child whose empty allow-list can never run a tool.
            if (preset && callAllow && narrowed && narrowed.length === 0) {
              throw new Error('delegated tool scope is empty: the requested tools are all outside the caller’s own allow-list');
            }
            const effectiveToolPolicy = narrowed
              ? { ...(src.access.toolPolicy?.deny ? { deny: src.access.toolPolicy.deny } : {}), allow: [...narrowed] }
              : src.access.toolPolicy;
            const boundary = readOnlyMode
              ? buildReadOnlyBoundary(src.access.permissionBoundary ?? null)
              : src.access.permissionBoundary;
            // The role prompt is user-authored (a `.md` agent) and the context is caller-supplied, so
            // nothing upstream bounds their combined size. Fit them to the scope ceilings HERE: over any
            // of the three the normalizer below rejects the whole scope and the child never runs at all —
            // the least diagnosable failure this path can produce. Log whatever had to be cut, since the
            // child only learns it from a marker inside its own prompt.
            const packed = packDelegatedPromptAppend(promptAppend);
            const workspaceBinding = resolveDelegatedWorkspace(
              this.d.sandbox?.(),
              {
                admin: src.access.admin === true,
                projectIds: src.access.projectIds ?? [],
                contributionUserId: src.access.contributionUserId,
                workspaceRef: src.access.workspaceRef,
              },
              src.access.workspaceId,
            );
            if (packed.truncated || packed.dropped) {
              log?.info(`delegated prompt did not fit the scope budget: ${packed.truncated} section(s) shortened, `
                + `${packed.dropped} dropped (channel ${keyOf(src)})`);
            }
            const rawScope = normalizeDelegatedExecutionScope({
              admin: src.access.admin === true,
              projectIds: src.access.projectIds,
              owner: src.access.owner === true && sessionOwner === owner,
              // The subagent plugin copies this from ctx.currentAccess(). It is deliberately required by
              // the scope normalizer: accepting a missing field would make an old/corrupt child inherit
              // the durable row owner's current (and potentially wider) permission settings.
              permissionBoundary: boundary,
              ...(effectiveToolPolicy !== undefined ? { toolPolicy: effectiveToolPolicy } : {}),
              ...(packed.promptAppend.length ? { promptAppend: packed.promptAppend } : {}),
              ...(readOnlyOrigin ? { readOnlyOrigin } : {}),
              // Host-stamped on the delegating turn (pathGuard.currentAccess), so the child records the
              // identity that actually spawned it. Absent leaves the child unpromotable, never wider.
              ...(typeof src.access.principal === 'string' ? { spawnedBy: src.access.principal } : {}),
              ...(Number.isSafeInteger(src.access.contributionUserId) && src.access.contributionUserId! > 0
                ? { contributionUserId: src.access.contributionUserId } : {}),
              ...(workspaceBinding ? { workspaceRef: bindingRef(workspaceBinding) } : {}),
            });
            if (!rawScope) throw new Error('invalid delegated access');
            // The account running the child can only make the captured scope narrower. Persist this union
            // too, so a later settings change that re-enables a tool never widens an already-delegated run.
            const spawnerAuthority = this.d.toolAuthorityFor?.(sessionOwner);
            const delegatedAccess = withDelegatedDeniedTools(rawScope, spawnerAuthority?.deny ?? []);
            // Validated above for the owner lookup; re-checked here so the request below carries the
            // non-optional parent it actually has.
            if (!parentSessionId) throw new Error('invalid parent session');
            // THE DISPATCH SEAM. `policy`, `toolPolicy` and `identity` are deliberately NOT built here any
            // more: none of the three can cross a process boundary (a closure over the project store, two
            // Sets, and an identity minted against the live owner check), so they are derived from the
            // captured scope by delegatedChannelSendOpts — the single builder the daemon and the runner
            // both use, which is what keeps the child's system prompt byte-identical between them.
            // `images` and `history` are not carried: a delegated source has neither by construction (the
            // subagent plugin mints it with only platform/userId/roleIds/channelId/access).
            return this.d.dispatch.send({
              channelId: keyOf(src),
              ownerUserId: sessionOwner,
              parentSessionId,
              delegatedAccess,
              // The account's grant travels ALONGSIDE the scope rather than inside it: the scope is frozen
              // at spawn, while this is re-read on every turn so a revoked tool stops reaching the child.
              ...(spawnerAuthority?.allow ? { accountAllow: [...spawnerAuthority.allow] } : {}),
              // A scheduled/unattended turn (a plugin sets access.scheduled) uses the focused `scheduled`
              // system prompt, not the coding-agent base. Core stays agnostic to which plugin fired it.
              scheduled: src.access.scheduled === true,
              ...(src.access.model ? { model: src.access.model } : {}),
              ...(src.access.thinkingLevel !== undefined ? { thinkingLevel: src.access.thinkingLevel } : {}),
              ...(src.access.fast !== undefined ? { fast: src.access.fast } : {}),
              // A delegated child inherits the delegating turn's working directory so its tools run in —
              // and it advertises — the SAME project as the parent, not the daemon's `/`.
              ...(!workspaceBinding && src.access.cwd !== undefined ? { clientCwd: src.access.cwd } : {}),
              // Surface-tuned idle cutoff (the delegate plugin pins it so a child's transcript is never
              // rolled over mid-delegation).
              ...(src.access.sessionIdleMs !== undefined ? { idleRolloverMs: src.access.sessionIdleMs } : {}),
            }, text, onEvent);
          }
          // A platform sender has only the permissions of their linked Elowen account. Room roles still
          // decide admission and trusted-room context, but never supply projects or tools.
          const resolved = this.d.identity.forPlatformTurn(src, owner);
          const accountUserId = resolved.accountUserId;
          const linkedUserId = resolved.linkedUserId;
          // A DIRECT 1:1 chat is its sender's own conversation, not a room the operator hosts. It counts
          // only when the adapter says so AND the sender has a VERIFIED platform link — `actAsUserId` is a
          // host automation account scope, not proof of who sent an arbitrary plugin source.
          const claimsDirect = src.platform !== 'subagent' && src.direct === true && linkedUserId != null;
          // An existing row keeps its owner on purpose: re-pointing a transcript (with its usage, spills
          // and running processes) at another account is a migration, not something an incoming message
          // may do behind the user's back. Only a BRAND-NEW direct conversation is anchored on its sender.
          const canonicalSessionId = channelSessionId(keyOf(src));
          // Read for EVERY platform turn, not just the direct path: the room anchoring below has to send
          // the row's real owner back, and it is one lookup by primary key.
          const existingOwner = this.d.channels.sessionOwnerUserId(canonicalSessionId);
          // …which is exactly why the flag also requires the row to be THIS sender's. Personal skills and
          // bound delivery are resolved from the session's owner, so marking a conversation owned by
          // somebody else as direct would serve that owner's private context to whoever writes here.
          //
          // The one case that is NOT somebody else's conversation is a row still sitting on the operator
          // fallback. A private chat lands there when its sender had not linked their account yet at the
          // moment the row was minted, or when the bot opened the chat proactively and there was no sender
          // to anchor on at all. Both used to be permanent: linking afterwards changed nothing, so a
          // colleague's private DM kept showing up as the operator's own conversation. Hand it over instead
          // — a 1:1 chat has exactly one human in it, so the operator is a placeholder here, never a
          // participant. Bounded to a SINGLE transfer by the compare-and-swap in the store: once the row
          // belongs to a real person, the clause below is what applies and it is never re-pointed again.
          const adopted = claimsDirect
            && existingOwner === owner
            && linkedUserId !== owner
            && this.d.channels.adoptPersonalChat(canonicalSessionId, owner, linkedUserId!);
          const directChat = claimsDirect && (existingOwner === undefined || existingOwner === linkedUserId || adopted);
          // Safe unconditionally BECAUSE of that check: the row either does not exist yet or is already
          // this account's, so nothing is re-pointed. Ownership intentionally carries usage attribution,
          // account-deletion cleanup and the account-scoped managed-session view with it; personal search
          // and the ordinary web conversation list continue to exclude every channel session.
          // After a successful adoption the row belongs to the sender, so the pre-adoption read is stale.
          const rowOwner = adopted ? linkedUserId : existingOwner;
          if (directChat) sessionOwner = linkedUserId;
          // A ROOM belongs to whoever opened it, not to whoever happens to run the instance. It used to be
          // anchored on the operator unconditionally, so a room a colleague started in Teams was filed
          // under the operator's name and the register had to explain that away in a tooltip.
          //
          // Two halves, and the first is useless without the second. A brand-new row is created with its
          // sender as owner. An EXISTING row keeps the owner it was created with — and that owner is what
          // must be sent back, because `ownerUserId` is not merely the value a fresh row is stamped with:
          // channels.send compares it against the live channel and disposes/respawns on a mismatch, and
          // the auto-compaction threshold and the permission fallback are both resolved from it. Sending
          // the operator for a row owned by somebody else would respawn the channel on every single turn.
          //
          // The anchor never moves within a session, so this is not a transcript being re-pointed behind
          // anyone's back. It does not need to move either: an idle channel is rolled over by renaming its
          // row to the archived id (channels.ts), which frees the canonical id, so the next person to write
          // opens a genuinely new session and owns that one.
          //
          // An unlinked sender has no account to name, and the accountless instance cron has none either,
          // so both keep the operator.
          else sessionOwner = rowOwner ?? linkedUserId ?? owner;
          const identity: TurnIdentity = {
            ...resolved.identity,
            conversation: directChat ? 'direct' : 'shared',
          };
          // A human platform sender needs a linked account. Host automation has no human sender attribution:
          // it runs under the scope the host stamped into `access` instead of inventing an account principal.
          const humanPlatformSender = resolved.sender !== undefined && !this.hostAutomationSources.has(src);
          if (humanPlatformSender && linkedUserId == null) return undefined;
          const turnDenied = src.access.denyTools ?? [];
          let policy: Policy;
          let toolPolicy: ToolPolicy | undefined;
          if (accountUserId != null) {
            if (!this.d.policyForUser) return undefined;
            policy = this.d.policyForUser(accountUserId);
            // `allow` comes from the ACCOUNT alone. A platform role no longer contributes a tool list:
            // a room role is not an identity, so there is nobody to hold its grant against.
            const account = this.d.toolAuthorityFor?.(accountUserId);
            const deny = new Set([...(account?.deny ?? []), ...turnDenied]);
            toolPolicy = account?.allow || deny.size
              ? { ...(account?.allow ? { allow: account.allow } : {}), ...(deny.size ? { deny } : {}) }
              : undefined;
          } else {
            // Only the exact instance-cron shape is accountless: no owner claim and no originating account
            // conversation. A stale owned/origin job must fail closed instead of widening to instance authority.
            if (src.platform !== 'cron' || src.access.actAsUserId !== undefined || src.origin !== undefined || !identity.admin) {
              return undefined;
            }
            policy = { allowedProjectIds: 'all' as const, allowedPaths: () => [] };
            toolPolicy = turnDenied.length ? { deny: new Set(turnDenied) } : undefined;
          }
          // Everything this turn does besides answering, opened here and settled inside channels.send —
          // see openTurn. Immediately before the send, because both effects describe a turn that is
          // ABOUT to run and the pin has to exist before the first provider request settles it.
          //
          // The origin pin is keyed on the WRITER, never on the room's owner. A room belongs to whoever
          // opened it, so attributing its spend to that account billed one person for everybody else's
          // turns — and because no pin existed at all, every room turn also settled as `internal`. An
          // unlinked sender has no account to bill, so the pin is omitted and the turn settles against
          // the room's owner exactly as before, which is the honest answer when nobody is identified.
          //
          // The feed's surface is the platform name, which IS derivable here — unlike web vs CLI, which
          // post an identical body and must state themselves. An unlinked sender carries no actor, so the
          // feed shows the platform alone rather than inventing an attribution.
          //
          // The handle is closed in the `finally` below, and that is a money fix rather than tidiness: a
          // room is written by SEVERAL people, and every pre-prompt refusal inside `send` (the shutdown
          // drain, a delegation abort, an unavailable fast mode) returns without any turn settling the
          // pin. The pin then survived, the next colleague was refused a pin of their own, and their whole
          // turn was billed to the previous writer under that person's platform origin.
          const opened = openTurn({
            sessionId: canonicalSessionId,
            ...(accountUserId != null && this.d.usageOrigins
              ? { origin: {
                  pin: this.d.usageOrigins,
                  userId: accountUserId,
                  origin: platformOrigin(src.platform),
                  atMs: Date.now(),
                } }
              : {}),
            ...(this.d.recordActivity
              ? { activity: {
                  record: this.d.recordActivity,
                  actorUserId: accountUserId ?? null,
                  surface: src.platform,
                  target: keyOf(src),
                } }
              : {}),
          });
          try {
          // Ordinary platform channels only — every delegated send returned through the dispatch above.
          const channelReply = await this.d.channels.send({
            channelId: keyOf(src),
            ownerUserId: sessionOwner,
            // Stamped on the session row so the skill resolver and the scheduled-delivery guard can tell a
            // private DM from a shared room — the `brain-ch-*` id alone cannot.
            direct: directChat,
            policy,
            promptAppend: promptAppend.length ? promptAppend : undefined,
            trusted: src.access.admin, // admin role → trusted-channel, never owner-chat
            // A scheduled/unattended turn (a plugin sets access.scheduled — the bundled cronjob does) uses
            // the focused `scheduled` system prompt, not the coding-agent base. Core stays agnostic to which
            // plugin fired it. (An origin-bound wake-up replays into its owner conversation via the bound
            // send path instead, so it keeps that conversation's own prompt.)
            scheduled: src.access.scheduled === true,
            model: src.access.model,
            thinkingLevel: src.access.thinkingLevel,
            fast: src.access.fast,
            // Surface-tuned idle cutoff (cron passes a shorter one; Discord omits it → host default).
            idleRolloverMs: src.access.sessionIdleMs,
            toolPolicy,
            images: src.images,
            attachments: src.attachments,
            identity,
            // The effective account view: a verified human link or host-authenticated automation relay.
            // Arbitrary actAsUserId still cannot validate `direct`; it only scopes the admitted automation.
            writerUserId: accountUserId,
            history: src.history,
            historyPlatform: src.platform,
            // Only a validated direct chat exposes an outbound target to tools creating scheduled work.
            deliveryTarget: directChat
              ? encodeNotificationDestination(src.platform, src.threadId ?? src.channelId)
              : undefined,
            onEvent,
            sender: resolved.sender,
            promptCommand: src.promptCommand === true,
          }, text);
          // The writer stamp used to be recorded here, after the send guaranteed the session row exists.
          // It still is — one layer down, inside settleTurn, where the owner surface finally records one
          // too instead of leaving the register's writer column empty for every CLI and web row.
          return channelReply;
          } finally {
            // Only ever releases the pin this turn SET: a settled turn already consumed it, and a message
            // steered into a running turn never held one, so neither is disturbed.
            opened.close();
          }
        };
        adapter.listen(onMessage);
        // Out-of-band channel control for slash commands (stop/status/compact/restart) and synthetic
        // platform relays. Optional: an adapter without `control` keeps its message-only behaviour.
        adapter.control?.({
          status: (ref) => this.d.channels.status(keyOf(ref)),
          abort: (ref) => this.d.channels.abort(keyOf(ref)),
          compact: (ref) => this.d.channels.compact(keyOf(ref)),
          setFast: (ref, on) => this.d.channels.setFast(keyOf(ref), on),
          restart: async () => {
            const fn = this.d.restart?.();
            if (!fn) throw new Error('restart is not available on this deployment');
            await fn(this.d.platformOwner?.() ?? 0); // attributed to the instance operator
          },
          // /context picker: list the invoking sender's OWN conversations (identity-scoped, bare default
          // excluded server-side) and bind (MOVE) the chosen one into THIS channel slot. The channel key
          // is the exact one the message pipeline uses (keyOf), so the bound history continues on the next
          // turn. The sender platform id resolves to their linked Elowen account inside the deps.
          listContext: (ref, senderPlatformId, opts) => this.d.listContextSessions?.(ref.platform, senderPlatformId, opts) ?? null,
          bindContext: (ref, senderPlatformId, sessionId) => {
            const bind = this.d.bindContext;
            if (!bind) return Promise.reject(new Error('context binding is not available on this deployment'));
            return bind(ref.platform, senderPlatformId, keyOf(ref), sessionId);
          },
          relay: (src, text) => {
            if (src.platform !== adapter.name) return Promise.reject(new Error('relay platform mismatch'));
            this.hostAutomationSources.add(src);
            return onMessage(src, text).finally(() => this.hostAutomationSources.delete(src));
          },
        });
        await adapter.connect();
        this.started.push(adapter);
        log?.info(`platform connected: ${adapter.name}`);
      } catch (e) {
        log?.error(`platform failed: ${adapter.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** Disconnect every started adapter (reloadPlugins rebuilds them from the fresh registry). */
  stopAll(): void {
    for (const p of this.started) { try { p.disconnect?.(); } catch { /* already down */ } }
    this.started = [];
  }

  /** Push a proactive message to every started platform that has a notification channel (Discord, …).
   *  Fail-open per adapter — one broken sink must not stop the others, so a push that reached at least one
   *  of them counts as delivered. But when EVERY sink threw, nothing was delivered, and reporting success
   *  there is what let the cron scheduler drop a result it had promised to retry (it deletes the stored
   *  pending delivery on a resolved push). So that case rejects, carrying each sink's failure.
   *  An instance with no notification sink at all is a configuration state, not a delivery failure — it
   *  resolves, exactly as before, so nothing queues results for a channel that does not exist. */
  async notify(text: string, channelId?: string, notice?: ServiceNotice): Promise<void> {
    const destination = decodeNotificationDestination(channelId, this.knownPlatforms);
    const targets = destination ? this.started.filter((p) => p.name === destination.platform) : this.started;
    if (destination && targets.length === 0) {
      throw new Error(`notification platform "${destination.platform}" is unavailable`);
    }
    let delivered = false;
    const failures: string[] = [];
    for (const p of targets) {
      if (typeof p.notify === 'function') {
        try {
          await p.notify(text, destination?.id ?? channelId, notice);
          delivered = true;
        } catch (e) {
          failures.push(`${p.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    if (!delivered && failures.length > 0) {
      throw new Error(`notification delivery failed on every platform — ${failures.join('; ')}`);
    }
    if (destination && !delivered) {
      throw new Error(`notification platform "${destination.platform}" has no notification sink`);
    }
  }

  /** Whether {@link notify} could reach `channelId` RIGHT NOW: the value is a routed `destination:`
   *  target that decodes, its platform adapter is started, and that adapter exposes a notification sink.
   *  Never throws — an uninstalled plugin, a bot that failed to connect and a malformed target are all
   *  exactly the "no" this question exists to give. The boot resume sweep asks it BEFORE spending a model
   *  turn on a parked platform conversation whose answer could never be delivered. */
  canDeliver(channelId: string): boolean {
    try {
      const destination = decodeNotificationDestination(channelId, this.knownPlatforms);
      if (!destination) return false;
      return this.started.some((p) => p.name === destination.platform && typeof p.notify === 'function');
    } catch {
      return false;
    }
  }
}
