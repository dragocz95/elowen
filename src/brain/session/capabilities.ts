import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { currentToolPolicy, toolPermitted, type ToolPolicy } from '../../plugins/policyContext.js';

/** What kind of session the tools are composed for — the explicit form of the security invariant that
 *  used to hide behind a `channel: !trusted` double negation. Every kind here is actually produced:
 *  `owner-chat` covers both the operator's own chat AND their trusted automation (cron turns resolve
 *  to it, since automation IS the operator). */
type SessionKind =
  /** The operator's own authenticated chat (web owner chat / owner DM), or their owner-authored
   *  automation (cron) — full orca_* control-plane tools + the owner API token. This is the ONLY kind
   *  that ever receives them; a SHARED platform channel never resolves here, whatever role its sender
   *  holds. */
  | 'owner-chat'
  /** A shared platform channel whose sender holds the operator's admin role — elevated to all-project
   *  Policy + the full plugin toolset, but STILL without orca_* tools and without the owner API token
   *  (an admin Discord role is not the verified owner). Tool-wise identical to `foreign-channel`; the
   *  distinct label keeps the trust level auditable and stops the channel-keyed session from ever being
   *  mislabelled owner-chat and leaking the owner toolset to a later non-admin sender. */
  | 'trusted-channel'
  /** A shared platform channel driven by OTHER, role-scoped people — the owner's full-scope orca_* API
   *  tools are withheld; only Policy-guarded plugin tools load. */
  | 'foreign-channel'
  /** An orca-exec task worker — its one control-plane tool (close-own-task) is baked in by the
   *  caller; plugin tools ride along, but never the owner's orca_* API tools. */
  | 'task-worker';

export interface CapabilitySpec {
  kind: SessionKind;
  /** Built lazily so the owner's API token is never even minted for sessions that must not have it. */
  orcaTools?: () => ToolDefinition[];
  /** PRIVATE per-user long-term memory tools — composed for every interactive session (owner-chat + all
   *  channel kinds), NOT task-workers. Each memory tool re-checks the acting identity at execute time and
   *  keys on a resolved orcaUserId, so a caller only ever reaches their OWN memory and an unlinked/
   *  anonymous sender (no orcaUserId) or a task-worker (no identity) gets a locked no-op. */
  memoryTools?: () => ToolDefinition[];
  pluginTools: ToolDefinition[];
}

/** Wrap a plugin tool so its access is decided at EXECUTE time from the current turn's ToolPolicy.
 *  This is the single, shared enforcement point: whether a tool is gated by a user's own `disabled_tools`
 *  (deny) or a platform role's tool allowlist (allow), the decision funnels through one predicate on the
 *  per-turn identity — mirroring how memory tools re-check identity at call time. A denied tool returns a
 *  clear locked no-op instead of running, so the model always gets something to reason over. Because a
 *  channel session is shared across senders, the tool SET is fixed at spawn; this per-turn gate is what
 *  makes access correct for whoever is actually speaking. */
function gateToolAccess(tool: ToolDefinition): ToolDefinition {
  if (typeof tool.execute !== 'function') return tool; // defensive (test stubs) — nothing to gate
  const run = tool.execute.bind(tool);
  const execute = ((...args: Parameters<ToolDefinition['execute']>) => {
    if (!toolPermitted(tool.name, currentToolPolicy())) {
      return Promise.resolve({ content: [{ type: 'text' as const, text: `The tool "${tool.name}" is not available to you in this conversation.` }], details: {} });
    }
    return run(...args);
  }) as ToolDefinition['execute'];
  return { ...tool, execute };
}

/** Compose the tool set for one session. THE security invariant lives here: `trusted-channel`,
 *  `foreign-channel` and `task-worker` sessions NEVER receive the owner's orca_* control-plane tools —
 *  ONLY `owner-chat` does. A shared channel sender (even one holding the admin role) reaching the
 *  owner's full-scope API token would be a privilege escalation. Plugin tools are always composed but
 *  wrapped with the per-turn access gate (see gateToolAccess) — the effective allow/deny is decided at
 *  execute time from the acting identity's ToolPolicy, one shared mechanism for every session kind. */
export function composeSessionTools(spec: CapabilitySpec): ToolDefinition[] {
  const ownerChat = spec.kind === 'owner-chat';
  const orcaTools = ownerChat ? (spec.orcaTools?.() ?? []) : [];
  // Memory tools ride every INTERACTIVE session (owner-chat + all channel kinds): memory is per-user, so
  // any linked sender reaches THEIR OWN memory from any surface (web/CLI chat or a Discord channel). The
  // tools re-check identity at execute time and key on the resolved orcaUserId, so an unlinked/anonymous
  // sender gets a locked no-op and no one can reach another user's memory. Task-workers (no identity)
  // never compose them.
  const memoryTools = spec.kind !== 'task-worker' ? (spec.memoryTools?.() ?? []) : [];
  const pluginTools = spec.pluginTools.map(gateToolAccess);
  return [...orcaTools, ...memoryTools, ...pluginTools];
}

/** The names a turn's ToolPolicy is allowed to HIDE from the model, given the full tool set and which of
 *  them are plugin tools. Mirrors the execute-time gate's scope with one deliberate asymmetry:
 *   - a role's `allow`-list narrows ONLY plugin tools — built-in `orca_*` / `memory_*` (composed per
 *     SessionKind) stay visible, so a channel never loses its core abilities to a narrow role grant;
 *   - a user's own `deny`-list (their `disabled_tools`) may hide ANY tool it names, plugin or not.
 *  No policy → the full set is visible. */
export function visibleToolNames(all: string[], pluginNames: Set<string>, tp: ToolPolicy | undefined): string[] {
  if (!tp) return all;
  return all.filter((name) => (pluginNames.has(name) ? toolPermitted(name, tp) : !tp.deny?.has(name)));
}

/** The minimal PI-session surface tool visibility needs — typed structurally so the logic stays unit-testable
 *  without a real AgentSession. */
export interface ToolVisibilityTarget {
  getAllTools(): { name: string }[];
  getActiveToolNames(): string[];
  setActiveToolsByName(names: string[]): void;
}

/** Narrow which tools the model SEES this turn to those the acting sender may use, so a shared channel
 *  advertises each sender only their own toolset — not just blocks a disallowed call after the fact. PI
 *  rebuilds the system prompt on a change, so we skip the call when the desired set already matches the
 *  active one: consecutive same-sender turns keep the prompt cache warm, and it only re-slices when the
 *  sender (hence their ToolPolicy) actually changes. The execute-time gate stays as defense-in-depth. */
export function applyToolVisibility(session: ToolVisibilityTarget, pluginNames: Set<string>, tp: ToolPolicy | undefined): void {
  const desired = visibleToolNames(session.getAllTools().map((t) => t.name), pluginNames, tp);
  const current = session.getActiveToolNames();
  if (desired.length === current.length && desired.every((n) => current.includes(n))) return;
  session.setActiveToolsByName(desired);
}
