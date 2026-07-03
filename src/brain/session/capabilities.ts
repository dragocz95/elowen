import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

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
  /** The owner's PRIVATE long-term memory tools — composed ONLY for 'owner-chat'. A shared platform
   *  channel (trusted OR foreign) never maps to owner-chat, so these tools are not composed for it at
   *  all. Defense-in-depth: each memory tool ALSO re-checks the acting identity at execute time
   *  (currentIdentity().owner===true && platform==='orca'), so even a mis-composition can't leak. */
  memoryTools?: () => ToolDefinition[];
  pluginTools: ToolDefinition[];
  /** Per-role tool allowlist (tool names; '*' = everything). Undefined = no restriction. */
  toolFilter?: string[];
}

/** Compose the tool set for one session. THE security invariant lives here: `trusted-channel`,
 *  `foreign-channel` and `task-worker` sessions NEVER receive the owner's orca_* control-plane tools —
 *  ONLY `owner-chat` does. A shared channel sender (even one holding the admin role) reaching the
 *  owner's full-scope API token would be a privilege escalation. */
export function composeSessionTools(spec: CapabilitySpec): ToolDefinition[] {
  const ownerChat = spec.kind === 'owner-chat';
  const orcaTools = ownerChat ? (spec.orcaTools?.() ?? []) : [];
  // Memory tools ride only owner-chat (like orca_*) — never a trusted/foreign channel or task-worker.
  // The role toolFilter never applies here — it scopes plugin tools.
  const memoryTools = ownerChat ? (spec.memoryTools?.() ?? []) : [];
  let pluginTools = spec.pluginTools;
  if (spec.toolFilter && !spec.toolFilter.includes('*')) {
    const allow = new Set(spec.toolFilter);
    pluginTools = pluginTools.filter((t) => allow.has(t.name));
  }
  return [...orcaTools, ...memoryTools, ...pluginTools];
}
