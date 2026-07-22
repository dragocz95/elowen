import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { currentToolPolicy, currentTurnPermissions, toolPermitted, type ToolPolicy } from '../../plugins/policyContext.js';
import { BASH_PERMISSION_TOOLS, bashAlwaysPattern, resolveToolPermission, type ApprovalDecision } from '../toolPermissions.js';
import type { ToolActivationTarget } from '../toolSearch/toolSearchTool.js';
import { withReason, stripReason } from '../toolReason.js';

/** What kind of session the tools are composed for — the explicit form of the security invariant that
 *  used to hide behind a `channel: !trusted` double negation. Every kind here is actually produced:
 *  `owner-chat` covers both the operator's own chat AND their trusted automation (cron turns resolve
 *  to it, since automation IS the operator). */
type SessionKind =
  /** The operator's own authenticated chat (web owner chat / owner DM), or their owner-authored
   *  automation (cron) — full Elowen* control-plane tools + the owner API token. This is the ONLY kind
   *  that ever receives them; a SHARED platform channel never resolves here, whatever role its sender
   *  holds. */
  | 'owner-chat'
  /** A shared platform channel whose sender holds the operator's admin role — elevated to all-project
   *  Policy + the full plugin toolset, but STILL without Elowen* tools and without the owner API token
   *  (an admin Discord role is not the verified owner). Tool-wise identical to `foreign-channel`; the
   *  distinct label keeps the trust level auditable and stops the channel-keyed session from ever being
   *  mislabelled owner-chat and leaking the owner toolset to a later non-admin sender. */
  | 'trusted-channel'
  /** A shared platform channel driven by OTHER, role-scoped people — the owner's full-scope Elowen* API
   *  tools are withheld; only Policy-guarded plugin tools load. */
  | 'foreign-channel'
  /** An elowen-exec task worker — its one control-plane tool (close-own-task) is baked in by the
   *  caller; plugin tools ride along, but never the owner's Elowen* API tools. */
  | 'task-worker';

/** What a plugin tool call produced — the payload the `tools.call.after` hook receives. `params` is the
 *  tool's input object (second `execute` argument) and `result` its resolved return value; both stay
 *  `unknown` so observers parse defensively (the v1 hook contract keeps payloads untyped). The observer
 *  is AWAITED before the result travels onward, so a hook may annotate it in place: appending short
 *  strings to `result.details.notes: string[]` (create the array if absent) is the supported channel —
 *  e.g. the formatters plugin pushes "formatted <file> with <name>" so the note reaches the transcript. */
export interface PluginToolResultEvent { tool: string; params: unknown; result: unknown }

export interface CapabilitySpec {
  kind: SessionKind;
  /** Built lazily so the owner's API token is never even minted for sessions that must not have it. */
  elowenTools?: () => ToolDefinition[];
  /** PRIVATE per-user long-term memory tools — composed for every interactive session (owner-chat + all
   *  channel kinds), NOT task-workers. Each memory tool re-checks the acting identity at execute time and
   *  keys on a resolved elowenUserId, so a caller only ever reaches their OWN memory and an unlinked/
   *  anonymous sender (no elowenUserId) or a task-worker (no identity) gets a locked no-op. */
  memoryTools?: () => ToolDefinition[];
  /** The `ToolSearch` built-in, composed for every INTERACTIVE session that actually defers tools (empty
   *  otherwise). Built lazily like `elowenTools` so it is only constructed when deferral is engaged. It is
   *  a built-in (permission-gated, not plugin-hook-gated), so it rides with the elowen/memory group. */
  toolSearch?: () => ToolDefinition[];
  pluginTools: ToolDefinition[];
  /** Observer fired after a PERMITTED plugin tool's execute resolves (never for a policy-denied call or
   *  a throwing execute). The caller typically forwards it to the plugin hook bus as `tools.call.after`.
   *  AWAITED before the tool result returns — so a hook that rewrites the just-written file (formatters)
   *  finishes before the model's next tool call can race it, and a `result.details.notes` annotation
   *  reaches the transcript. Still fail-soft: it runs inside the tool's ALS turn scope (so hooks can
   *  read currentWorkDir etc.) and a throwing/rejecting observer never fails the tool result; the hook
   *  bus bounds each hook by its event budget, so a hung hook delays the result at most that long. */
  onToolResult?: (e: PluginToolResultEvent) => void | Promise<void>;
}

/** Wrap a plugin tool so its access is decided at EXECUTE time from the current turn's ToolPolicy.
 *  This is the single, shared enforcement point: whether a tool is gated by a user's own `disabled_tools`
 *  (deny) or a platform role's tool allowlist (allow), the decision funnels through one predicate on the
 *  per-turn identity — mirroring how memory tools re-check identity at call time. A denied tool returns a
 *  clear locked no-op instead of running, so the model always gets something to reason over. Because a
 *  channel session is shared across senders, the tool SET is fixed at spawn; this per-turn gate is what
 *  makes access correct for whoever is actually speaking. */
function gateToolAccess(tool: ToolDefinition, onToolResult?: (e: PluginToolResultEvent) => void | Promise<void>): ToolDefinition {
  if (typeof tool.execute !== 'function') return tool; // defensive (test stubs) — nothing to gate
  const run = tool.execute.bind(tool);
  const execute = (async (...args: Parameters<ToolDefinition['execute']>) => {
    if (!toolPermitted(tool.name, currentToolPolicy())) {
      return { content: [{ type: 'text' as const, text: `The tool "${tool.name}" is not available to you in this conversation.` }], details: {} };
    }
    const result = await run(...args);
    // Observe AFTER a permitted execute resolved, still inside the turn's ALS scope, and AWAIT it
    // BEFORE returning: a hook that rewrites the written file (formatters) must finish before the
    // result — and the model's next tool call — moves on, and its `details.notes` annotation must be
    // in the result when it travels onward. Fail-soft: a throwing/rejecting observer never fails the
    // result (the hook bus additionally bounds each hook by its event budget).
    try { await onToolResult?.({ tool: tool.name, params: args[1], result }); } catch { /* observer only */ }
    return result;
  }) as ToolDefinition['execute'];
  return { ...tool, execute };
}

/** A model-readable refusal result (the tool "ran" but reports why it did not act). */
const refused = (text: string) => ({ content: [{ type: 'text' as const, text }], details: {} });

/** Wrap ANY session tool with the granular permission gate — THE single choke point every tool call
 *  passes (built-in Elowen* and Memory* tools and plugin tools alike; composeSessionTools applies it
 *  to the whole composed set). The turn's rules resolve to allow/ask/deny (resolveToolPermission — last matching
 *  rule wins): `deny` returns an error result naming the rule; `ask` blocks on the turn's approval
 *  channel where a human is attached (owner CLI/web chat) and, everywhere else (channel/cron/subagent
 *  turns — nobody can answer a blocking prompt there), follows the user's `unattendedAsks` setting:
 *  'allow' (default) runs, 'deny' (strict mode) refuses with a deny-shaped error. YOLO auto-approves
 *  asks that WOULD prompt (deny still denies under YOLO) — it deliberately does NOT override the
 *  unattended-strict denial, because strict is a hard safety opt-in that must not be silently undone
 *  by a convenience toggle. An "Always allow" pick persists a rule through the
 *  turn's `persistAllow` before running. Shell tools (BASH_PERMISSION_TOOLS) resolve in the `bash`
 *  pattern space against their command string; everything else in `tools` against the tool name. No
 *  TurnPermissions scope on the turn (task workers, tests) → the gate is inert. */
function gatePermissions(tool: ToolDefinition): ToolDefinition {
  if (typeof tool.execute !== 'function') return tool; // defensive (test stubs) — nothing to gate
  const run = tool.execute.bind(tool);
  const execute = (async (...args: Parameters<ToolDefinition['execute']>) => {
    const perms = currentTurnPermissions();
    if (!perms) return run(...args);
    const bash = BASH_PERMISSION_TOOLS.has(tool.name);
    const rawCommand = bash ? (args[1] as { command?: unknown } | null | undefined)?.command : undefined;
    const command = typeof rawCommand === 'string' ? rawCommand : undefined;
    const rule = resolveToolPermission(perms.ruleset, tool.name, bash ? (command ?? '') : undefined);
    if (rule.action === 'deny') {
      return refused(`Denied by permission rule "${rule.pattern}" — the user's settings forbid this call.`);
    }
    if (rule.action === 'ask') {
      if (!perms.requestApproval) {
        // UNATTENDED turn (channel/cron/subagent — no approval channel). Default ('allow', incl. absent)
        // keeps the historical behaviour: the ask resolves to allow. Strict mode ('deny') fails closed
        // with the same error shape as a deny rule. Checked BEFORE the YOLO shortcut on purpose: YOLO
        // only auto-approves asks that WOULD prompt, and strict is a hard safety opt-in it must not undo.
        if (perms.unattendedAsks === 'deny') {
          return refused(`Denied by permission rule "${rule.pattern}" — ask rule blocked in unattended run (strict mode).`);
        }
      } else if (!perms.yolo) {
        const alwaysPattern = bash ? bashAlwaysPattern(command ?? '') : tool.name;
        let decision: ApprovalDecision;
        try {
          decision = await perms.requestApproval({ tool: tool.name, scope: rule.scope, command, alwaysPattern });
        } catch {
          decision = 'deny'; // the prompt was cancelled (turn aborted / session switched) — fail closed
        }
        if (decision === 'deny') {
          return refused(`The user denied running "${tool.name}"${command ? ` (${command})` : ''}. Do not retry it without asking them first.`);
        }
        if (decision === 'always' && alwaysPattern) {
          try { perms.persistAllow?.(rule.scope, alwaysPattern); } catch { /* persistence is best-effort */ }
        }
      }
    }
    return run(...args);
  }) as ToolDefinition['execute'];
  return { ...tool, execute };
}

/** Compose the tool set for one session. THE security invariant lives here: `trusted-channel`,
 *  `foreign-channel` and `task-worker` sessions NEVER receive the owner's Elowen* control-plane tools —
 *  ONLY `owner-chat` does. A shared channel sender (even one holding the admin role) reaching the
 *  owner's full-scope API token would be a privilege escalation. Plugin tools are always composed but
 *  wrapped with the per-turn access gate (see gateToolAccess) — the effective allow/deny is decided at
 *  execute time from the acting identity's ToolPolicy, one shared mechanism for every session kind.
 *  The WHOLE composed set (built-ins included) then passes through the granular permission gate
 *  (gatePermissions) — the single choke point the per-user allow/ask/deny rules act on. */
export function composeSessionTools(spec: CapabilitySpec): ToolDefinition[] {
  const ownerChat = spec.kind === 'owner-chat';
  const elowenTools = ownerChat ? (spec.elowenTools?.() ?? []) : [];
  // Memory tools ride every INTERACTIVE session (owner-chat + all channel kinds): memory is per-user, so
  // any linked sender reaches THEIR OWN memory from any surface (web/CLI chat or a Discord channel). The
  // tools re-check identity at execute time and key on the resolved elowenUserId, so an unlinked/anonymous
  // sender gets a locked no-op and no one can reach another user's memory. Task-workers (no identity)
  // never compose them.
  const memoryTools = spec.kind !== 'task-worker' ? (spec.memoryTools?.() ?? []) : [];
  // ToolSearch is a built-in fetch mechanism, not a plugin tool — it takes the permission gate (so a
  // user's own deny can still hide it) but never the plugin hook wrapper. Only present when the session
  // actually defers tools; otherwise the list is empty and the composed set is byte-identical to before.
  const toolSearchTools = spec.kind !== 'task-worker' ? (spec.toolSearch?.() ?? []) : [];
  const pluginTools = spec.pluginTools.map((t) => gateToolAccess(t, spec.onToolResult));
  // Every composed tool gains an optional leading `_reason` (withReason augments the schema; excluded tools
  // — ToolSearch, mcp__* — pass through), then the whole set takes the permission gate, then stripReason
  // wraps OUTERMOST so `_reason` is removed from the arguments before any inner wrapper or handler sees it.
  return [...elowenTools, ...memoryTools, ...toolSearchTools, ...pluginTools]
    .map(withReason).map(gatePermissions).map(stripReason);
}

/** The names a turn's ToolPolicy is allowed to HIDE from the model, given the full tool set and which of
 *  them are plugin tools. Mirrors the execute-time gate's scope with one deliberate asymmetry:
 *   - a role's `allow`-list narrows ONLY plugin tools — built-in `Elowen*` / `Memory*` (composed per
 *     SessionKind) stay visible, so a channel never loses its core abilities to a narrow role grant;
 *   - a user's own `deny`-list (their `disabled_tools`) may hide ANY tool it names, plugin or not.
 *  No policy → the full set is visible. */
export function visibleToolNames(all: string[], pluginNames: Set<string>, tp: ToolPolicy | undefined): string[] {
  if (!tp) return all;
  return all.filter((name) => (pluginNames.has(name) ? toolPermitted(name, tp) : !tp.deny?.has(name)));
}

/** The minimal PI-session surface tool visibility needs — the SAME structural target ToolSearch uses to
 *  read the registry and change the active slice (one shared type, not two near-identical copies). Typed
 *  structurally so the logic stays unit-testable without a real AgentSession. */
export type ToolVisibilityTarget = ToolActivationTarget;

/** Deferred-tool state consulted by {@link applyToolVisibility}: `deferred` are registered tools withheld
 *  from the prompt until fetched; `activated` are the ones ToolSearch has already fetched. Structurally a
 *  subset of the tool-search handle, so the live's handle is passed straight through. */
export interface ToolDeferralState {
  deferred: Set<string>;
  activated: Set<string>;
}

/** Narrow which tools the model SEES this turn to those the acting sender may use, so a shared channel
 *  advertises each sender only their own toolset — not just blocks a disallowed call after the fact. PI
 *  rebuilds the system prompt on a change, so we skip the call when the desired set already matches the
 *  active one: consecutive same-sender turns keep the prompt cache warm, and it only re-slices when the
 *  sender (hence their ToolPolicy) actually changes. The execute-time gate stays as defense-in-depth.
 *
 *  Deferred tools (external MCP tools withheld to keep the prompt light) are excluded UNLESS ToolSearch
 *  has already fetched them (`deferral.activated`) — so a deferred tool the model has not asked for stays
 *  out of the prompt, and one it has fetched stays in across every subsequent turn. The sender-visibility
 *  filter still applies on top, so a deferred tool the acting sender may not use can never be advertised. */
export function applyToolVisibility(
  session: ToolVisibilityTarget,
  pluginNames: Set<string>,
  tp: ToolPolicy | undefined,
  deferral?: ToolDeferralState,
): void {
  let desired = visibleToolNames(session.getAllTools().map((t) => t.name), pluginNames, tp);
  if (deferral && deferral.deferred.size > 0) {
    desired = desired.filter((n) => !deferral.deferred.has(n) || deferral.activated.has(n));
  }
  const current = session.getActiveToolNames();
  if (desired.length === current.length && desired.every((n) => current.includes(n))) return;
  session.setActiveToolsByName(desired);
}
