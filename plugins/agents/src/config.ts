import { z } from 'zod';
import type { PluginHostConfig } from '../../../src/plugins/api.js';

/** The plugin's OWN config keys (plugins.config.agents) — the autopilot keys consumed exclusively by
 *  this runtime, copied there by the core's one-shot migrateAgentsPluginConfig() and mirrored on every
 *  autopilot patch until F3 moves the Settings web over. Matches the manifest `configSchema`. */
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
 *  LIVE autopilot value as the fallback for a key the slice does not carry (pre-migration DB read by
 *  a runner, or a value cleared from the slice). A malformed slice degrades to the fallback whole. */
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
