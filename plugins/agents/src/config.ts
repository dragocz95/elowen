import { z } from 'zod';
import type { PluginHostConfig } from '../../../src/plugins/api.js';

/** The plugin's OWN config keys (plugins.config.agents) — the autopilot keys consumed exclusively by
 *  this runtime, seeded there by the core's one-shot migrations (wave 1: migrateAgentsPluginConfig,
 *  wave 2: migrateAgentsPluginConfigWave2) and edited by the plugin's settings deck. Matches the
 *  manifest `configSchema`. */
const agentsConfigSchema = z.object({
  overseerModel: z.string().optional(),
  prBaseBranch: z.string().optional(),
  prAutoOpen: z.boolean().optional(),
  prVerifyCommand: z.string().optional(),
  pilotExec: z.string().optional(),
  overseerExec: z.string().optional(),
  reviewOnDone: z.boolean().optional(),
  tddMode: z.boolean().optional(),
  prEnabled: z.boolean().optional(),
  ghToken: z.string().optional(),
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
  /** Agent CLI exec the planning Pilot runs on; empty → relay planning. */
  pilotExec: string;
  /** Agent CLI exec the parked per-mission overseer runs on; empty → relay decisions. */
  overseerExec: string;
  /** Post-done review gate: the overseer judges each closed phase before dependents run. */
  reviewOnDone: boolean;
  /** TDD mission mode: workers must write a failing test first, then implement, then verify. */
  tddMode: boolean;
  /** Global default for the PR-native (isolated worktree) workflow; projects/epics can override. */
  prEnabled: boolean;
  /** GitHub token for PR create/merge/review polling; empty → gh CLI's own auth. */
  ghToken: string;
}

/** Resolve the plugin's effective config: its own validated plugins.config.agents slice first, the
 *  LIVE autopilot value (and the top-level ghToken) as the fallback for a key the slice does not
 *  carry. DELIBERATELY KEPT after the mirror's removal: the one-shot migrations run on the first
 *  DAEMON boot of the new version, but a runner process opens the DB read-only and can load this
 *  plugin against a pre-migration row in the window before that boot — without the fallback, a
 *  configured prVerifyCommand would silently vanish there and a PR could open unverified.
 *  Post-migration the slice carries every key (the migrations copy all of them, empty values
 *  included), so the fallback is dead weight only then. A malformed slice degrades to the fallback
 *  whole. */
export function agentsPluginConfig(slice: Record<string, unknown>, host: PluginHostConfig): AgentsPluginConfig {
  const parsed = agentsConfigSchema.safeParse(slice);
  const own = parsed.success ? parsed.data : {};
  const autopilot = host.get().autopilot;
  return {
    overseerModel: own.overseerModel ?? autopilot.overseerModel,
    prBaseBranch: own.prBaseBranch ?? autopilot.prBaseBranch,
    prAutoOpen: own.prAutoOpen ?? autopilot.prAutoOpen,
    prVerifyCommand: own.prVerifyCommand ?? autopilot.prVerifyCommand,
    pilotExec: own.pilotExec ?? autopilot.pilotExec,
    overseerExec: own.overseerExec ?? autopilot.overseerExec,
    reviewOnDone: own.reviewOnDone ?? autopilot.reviewOnDone,
    tddMode: own.tddMode ?? autopilot.tddMode,
    prEnabled: own.prEnabled ?? autopilot.prEnabled,
    // Slice first, the core's legacy top-level secret only as the fallback — the plugin owns this
    // choice, core no longer makes it. Optional call: many test stubs satisfy only get(), and a
    // missing accessor means no legacy token.
    ghToken: own.ghToken || (host.legacyGhToken?.() ?? ''),
  };
}
