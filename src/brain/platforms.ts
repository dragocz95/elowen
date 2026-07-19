import type { PluginRegistry } from '../plugins/registry.js';
import type { ChannelRef } from '../plugins/api.js';
import type { Policy } from '../plugins/policy.js';
import type { ToolPolicy, TurnIdentity } from '../plugins/policyContext.js';
import type { IdentityResolver } from './identity.js';
import type { ChannelSessionService } from './channels.js';
import type { SessionListItem, SessionPage, SessionPageOpts } from './service/statusService.js';
import {
  delegatedToolPolicy,
  normalizeDelegatedExecutionScope,
  withDelegatedDeniedTools,
  type DelegatedExecutionScope,
} from './delegatedScope.js';
import { resolveAgentTools, READ_ONLY_AGENT_TOOLS, type AgentDef } from './agents/agentRegistry.js';
import { renderAgentPrompt } from './agents/agentPrompt.js';
import { buildReadOnlyBoundary } from './agents/readOnlyBoundary.js';

export interface PlatformOrchestratorDeps {
  /** The daemon-wide plugin registry resolver (undefined when plugins aren't wired). */
  plugins: () => Promise<PluginRegistry | undefined>;
  /** The Elowen user that anchors platform channel sessions (the admin). */
  platformOwner?: () => number | undefined;
  /** The typed sub-agent registry, resolved when a delegate call names a `subagent_type` — turns the type
   *  into the child's role prompt, tool allow-list and (for a read-only type) a minted read-only boundary. */
  agents?: () => Map<string, AgentDef>;
  /** Build a Policy from an explicit project-id set (platform role mappings resolve through this). */
  policyForProjects?: (projectIds: number[]) => Policy;
  /** A LINKED platform sender runs fully through their Elowen account: this resolves that account's own
   *  project Policy (same as their web chat). Absent → falls back to the role policy. */
  policyForUser?: (userId: number) => Policy;
  /** A linked user's own tool deny-list (their Account → disabled tools), applied for their platform turns. */
  disabledToolsFor?: (userId: number) => string[];
  identity: IdentityResolver;
  channels: ChannelSessionService;
  /** Admin daemon restart for a platform `/restart` slash. Lazily resolved: the handler is built after
   *  the brain (it needs systemd + the marker path), so this returns undefined until it's wired. */
  restart?: () => ((byUserId: number) => Promise<void>) | undefined;
  /** BOUND send into a user's OWN stored conversation — origin-carrying messages (a cron wake-up
   *  scheduled from a user conversation) route here so the reply lands where the schedule was created.
   *  Resolves with the reply text, or null when the session no longer exists / isn't owned by that
   *  user — the orchestrator then falls back to the normal channel path. Emits a `session` event
   *  carrying the origin session id on success, so the caller can tell origin delivery happened. */
  originSend?: (userId: number, sessionId: string, text: string, onEvent?: (e: { type: string; sessionId?: string }) => void) => Promise<string | null>;
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
  private started: { name: string; disconnect?(): void; notify?(t: string, channelId?: string): Promise<void> }[] = [];

  constructor(private d: PlatformOrchestratorDeps) {}

  /** Start every platform adapter: wire its messages into channel sessions and let it deliver the
   *  replies. Called once at daemon startup and re-run by reloadPlugins. */
  async startAll(log?: { info(m: string): void; error(m: string): void }): Promise<void> {
    const plugins = await this.d.plugins();
    for (const adapter of plugins?.platforms ?? []) {
      try {
        adapter.listen(async (src, text, onEvent) => {
          const owner = this.d.platformOwner?.();
          if (owner === undefined || !src.access) return undefined; // unmapped sender → stay silent
          // Origin-bound work (#116): a message replaying a job scheduled FROM a user conversation runs
          // as a bound send into that conversation — the reply lands + streams + persists where the
          // schedule was created, not in the job's own channel session. Falls through to the normal
          // channel path when the origin session vanished or changed hands (originSend returns null).
          if (src.origin && this.d.originSend) {
            const reply = await this.d.originSend(src.origin.userId, src.origin.sessionId, text, onEvent);
            if (reply !== null) return reply;
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
          const promptAppend = [
            ...(rolePrompt ? [rolePrompt] : []),
            // Parent-supplied background for a delegated child — a stable prefix block (cache-friendly),
            // bounded by the delegated-scope normalizer like every other prompt append.
            ...(src.access.context ? [src.access.context] : []),
            ...(src.channelName ? [this.d.channels.fragmentFor(src, owner)] : []),
          ];
          // ONE unified access decision. A LINKED sender runs fully through their Elowen account — their
          // own project Policy AND their own tool deny-list — exactly as in their web chat (the role
          // policy is bypassed for them). An UNLINKED sender falls back to the Role-ID policy: all-project
          // for an admin role, else the role's projects, plus the role's tool allowlist. Neither ever gets
          // the owner's Elowen* API tools/token — a shared channel is never the verified owner's own chat.
          let policy: Policy;
          let toolPolicy: ToolPolicy | undefined;
          let identity: TurnIdentity;
          let verifiedPrefix = '';
          let linkedUserId: number | undefined;
          let delegatedAccess: DelegatedExecutionScope | undefined;
          if (src.platform === 'subagent') {
            // Capture one immutable boundary on the very first child spawn. The synthetic platform source
            // is internal but still validated like persisted JSON: a malformed scope must not fall back to
            // the owner's ambient policy. `owner` is independently authenticated, never inferred from an
            // admin role (a foreign Discord admin is not the instance operator).
            // Read-only MODE — from a read-only agent TYPE or a bare `read_only` delegation — resolves to ONE
            // host-side definition: the READ_ONLY_AGENT_TOOLS preset plus a minted read-only permission
            // boundary (Bash gated to look-only commands even though the child runs unattended — see
            // readOnlyBoundary.ts). This is the single source of "read-only"; the subagent plugin no longer
            // carries its own toolset.
            const readOnlyMode = agentDef?.toolsSpec === 'read-only' || src.access.readOnly === true;
            // What the type / read-only mode contributes to the toolset (undefined = no constraint of its own).
            const preset = readOnlyMode ? READ_ONLY_AGENT_TOOLS : agentDef ? resolveAgentTools(agentDef) : undefined;
            // INTERSECT the preset with any call-level allow-list (an explicit `tools`, or a restricted
            // parent) — both only ever narrow, so a read-only child never even SEES a tool the caller lacks.
            // A parent deny-list (disabled tools) rides on top untouched.
            const callAllow = src.access.toolPolicy?.allow;
            const narrowed = preset && callAllow ? preset.filter((t) => callAllow.includes(t)) : preset ?? callAllow;
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
            const rawScope = normalizeDelegatedExecutionScope({
              admin: src.access.admin === true,
              projectIds: src.access.projectIds,
              owner: src.access.owner === true && sessionOwner === owner,
              // The subagent plugin copies this from ctx.currentAccess(). It is deliberately required by
              // the scope normalizer: accepting a missing field would make an old/corrupt child inherit
              // the durable row owner's current (and potentially wider) permission settings.
              permissionBoundary: boundary,
              ...(effectiveToolPolicy !== undefined ? { toolPolicy: effectiveToolPolicy } : {}),
              ...(promptAppend.length ? { promptAppend } : {}),
            });
            if (!rawScope) throw new Error('invalid delegated access');
            // The account running the child can only make the captured scope narrower. Persist this union
            // too, so a later settings change that re-enables a tool never widens an already-delegated run.
            delegatedAccess = withDelegatedDeniedTools(rawScope, this.d.disabledToolsFor?.(sessionOwner) ?? []);
            toolPolicy = delegatedToolPolicy(delegatedAccess);
            policy = delegatedAccess.admin
              ? { allowedProjectIds: 'all' as const, allowedPaths: () => [] }
              : this.d.policyForProjects?.(delegatedAccess.projectIds)
                ?? { allowedProjectIds: new Set(delegatedAccess.projectIds), allowedPaths: () => [] };
            identity = this.d.identity.forDelegatedTurn(delegatedAccess, sessionOwner);
          } else {
            const resolved = this.d.identity.forPlatformTurn(src, owner);
            identity = resolved.identity;
            verifiedPrefix = resolved.verifiedPrefix;
            linkedUserId = resolved.linkedUserId;
            if (linkedUserId != null && this.d.policyForUser) {
              policy = this.d.policyForUser(linkedUserId);
              const denied = this.d.disabledToolsFor?.(linkedUserId) ?? [];
              toolPolicy = denied.length ? { deny: new Set(denied) } : undefined;
            } else {
              policy = src.access.admin
                ? { allowedProjectIds: 'all' as const, allowedPaths: () => [] }
                : this.d.policyForProjects?.(src.access.projectIds)
                  ?? { allowedProjectIds: new Set(src.access.projectIds), allowedPaths: () => [] };
              // Admin role → full plugin toolset (no allowlist). Otherwise the role's tool allowlist — but
              // the Discord convention (plugins/discord/index.mjs) is that an empty list OR ['*'] means
              // "everything", so it must map to NO restriction, not an allow-list of the literal "*" (which
              // would match no real tool name and deny the whole toolset).
              const roleTools = src.access.tools;
              const unrestricted = !roleTools?.length || roleTools.includes('*');
              toolPolicy = !src.access.admin && !unrestricted ? { allow: new Set(roleTools) } : undefined;
            }
          }
          return this.d.channels.send({
            channelId: keyOf(src),
            ownerUserId: sessionOwner,
            policy,
            promptAppend: delegatedAccess?.promptAppend ?? (promptAppend.length ? promptAppend : undefined),
            trusted: delegatedAccess?.admin ?? src.access.admin, // admin role → trusted-channel, never owner-chat
            // A scheduled/unattended turn (a plugin sets access.scheduled — the bundled cronjob does) uses
            // the focused `scheduled` system prompt, not the coding-agent base. Core stays agnostic to which
            // plugin fired it. (An origin-bound wake-up replays into its owner conversation via the bound
            // send path instead, so it keeps that conversation's own prompt.)
            scheduled: src.access.scheduled === true,
            model: src.access.model,
            thinkingLevel: src.access.thinkingLevel,
            fast: src.access.fast,
            parentSessionId,
            delegatedAccess,
            // Surface-tuned idle cutoff (cron passes a shorter one; Discord omits it → host default).
            idleRolloverMs: src.access.sessionIdleMs,
            toolPolicy,
            images: src.images,
            identity,
            // The Elowen account this sender is verified as — memory recall/save keys on it. Unlinked
            // senders have no linkedUserId, so the channel turn gets no memory (shared-space privacy).
            writerUserId: linkedUserId,
            history: src.history,
            onEvent,
          }, verifiedPrefix + text);
        });
        // Out-of-band channel control for slash commands (stop/status/compact/restart). Optional: an
        // adapter that doesn't implement `control` simply keeps its message-only behaviour.
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
   *  Fail-open per adapter — a broken sink must not break the cron tick that triggered it. */
  async notify(text: string, channelId?: string): Promise<void> {
    for (const p of this.started) {
      if (typeof p.notify === 'function') {
        try { await p.notify(text, channelId); } catch { /* one sink down must not block the rest */ }
      }
    }
  }
}
