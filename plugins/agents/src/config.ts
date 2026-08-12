import { z } from 'zod';
import type { PluginHostConfig } from '../../../src/plugins/api.js';

/** The plugin's OWN config keys (plugins.config.agents) — the autopilot keys consumed exclusively by
 *  this runtime, seeded there by the core's one-shot migrateAgentsPluginConfig() and edited by the
 *  plugin's settings deck since F3 (the transitional autopilot→slice mirror is gone). Matches the
 *  manifest `configSchema`. */
const agentsConfigSchema = z.object({
  overseerModel: z.string().optional(),
  prBaseBranch: z.string().optional(),
  prAutoOpen: z.boolean().optional(),
  prVerifyCommand: z.string().optional(),
}).passthrough();

export interface AgentsPluginConfig {
  /** Relay model for overseer decisions; empty → fall back to the planner model. */
  overseerModel: string;
  /** PR base branch override; empty → auto-detect per repo. */
  prBaseBranch: string;
  /** Open a mission's PR automatically when its epic completes. */
  prAutoOpen: boolean;
  /** Verify command that must exit 0 in the worktree before any PR opens; empty → no gate. */
  prVerifyCommand: string;
}

/** Resolve the plugin's effective config: its own validated plugins.config.agents slice first, the
 *  LIVE autopilot value as the fallback for a key the slice does not carry. DELIBERATELY KEPT after
 *  the mirror's removal: the one-shot migration runs on the first DAEMON boot of the new version, but
 *  a runner process opens the DB read-only and can load this plugin against a pre-migration row in
 *  the window before that boot — without the fallback, a configured prVerifyCommand would silently
 *  vanish there and a PR could open unverified. Post-migration the slice carries every key (the
 *  migration copies all four, empty values included), so the fallback is dead weight only then.
 *  A malformed slice degrades to the fallback whole. */
export function agentsPluginConfig(slice: Record<string, unknown>, host: PluginHostConfig): AgentsPluginConfig {
  const parsed = agentsConfigSchema.safeParse(slice);
  const own = parsed.success ? parsed.data : {};
  const autopilot = host.get().autopilot;
  return {
    overseerModel: own.overseerModel ?? autopilot.overseerModel,
    prBaseBranch: own.prBaseBranch ?? autopilot.prBaseBranch,
    prAutoOpen: own.prAutoOpen ?? autopilot.prAutoOpen,
    prVerifyCommand: own.prVerifyCommand ?? autopilot.prVerifyCommand,
  };
}
