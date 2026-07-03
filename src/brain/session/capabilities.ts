import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

/** What kind of session the tools are composed for — the explicit form of the security invariant that
 *  used to hide behind a `channel: !trusted` double negation. */
export type SessionKind =
  /** The operator's (or a user's) own authenticated chat — full orca_* control-plane tools. */
  | 'owner-chat'
  /** A platform channel whose turn is owner-authored automation (cron) — trusted like owner chat. */
  | 'trusted-channel'
  /** A platform channel driven by OTHER people — the owner's full-scope orca_* API tools are
   *  withheld; only Policy-guarded plugin tools load. */
  | 'foreign-channel'
  /** An orca-exec task worker — its one control-plane tool (close-own-task) is baked in by the
   *  caller; plugin tools ride along. */
  | 'task-worker';

export interface CapabilitySpec {
  kind: SessionKind;
  /** Built lazily so the owner's API token is never even minted for sessions that must not have it. */
  orcaTools?: () => ToolDefinition[];
  pluginTools: ToolDefinition[];
  /** Per-role tool allowlist (tool names; '*' = everything). Undefined = no restriction. */
  toolFilter?: string[];
}

/** Compose the tool set for one session. THE security invariant lives here: `foreign-channel` and
 *  `task-worker` sessions NEVER receive the owner's orca_* control-plane tools — a foreign sender
 *  reaching the owner's full-scope API token would be a privilege escalation. */
export function composeSessionTools(spec: CapabilitySpec): ToolDefinition[] {
  const trusted = spec.kind === 'owner-chat' || spec.kind === 'trusted-channel';
  const orcaTools = trusted ? (spec.orcaTools?.() ?? []) : [];
  let pluginTools = spec.pluginTools;
  if (spec.toolFilter && !spec.toolFilter.includes('*')) {
    const allow = new Set(spec.toolFilter);
    pluginTools = pluginTools.filter((t) => allow.has(t.name));
  }
  return [...orcaTools, ...pluginTools];
}
