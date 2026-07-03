import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { Policy } from '../../plugins/policy.js';
import type { BrainEvent } from '../events.js';

/** One live brain conversation: the PI session plus its settings, event fanout and per-turn context.
 *  Shared by the chat brain, the channel service and the live registry. */
export interface LiveBrain {
  session: AgentSession;
  sessionId: string;
  model: string;
  visionCapable: boolean;
  thinkingLevel?: string;
  policy: Policy;
  autoCompact: boolean;
  autoCompactAt: number;
  listeners: Set<(e: BrainEvent) => void>;
  turnContext: () => string;
  /** True while the session runs on the user's vision-fallback model (an image turn hopped onto it). */
  visionFallback?: boolean;
}

/** What it takes to spawn one live conversation — composed by BrainService.spawnLive and reused by
 *  the channel service (which delegates the actual spawn back to keep composition in one place). */
export interface SpawnOpts {
  sessionId: string;
  ownerUserId: number;
  selection: { provider?: string; model?: string };
  policy: Policy;
  /** Extra system-prompt chunks appended after the plugin fragments (e.g. a Discord role prompt). */
  extraAppend?: string[];
  /** Platform channel session (Discord, …): the sender is NOT an Orca user, so the owner's
   *  full-scope orca_* API tools are withheld — only Policy-guarded plugin tools load. */
  channel?: boolean;
  /** Per-role tool allowlist (tool names; '*' = everything). Undefined = no restriction. */
  toolFilter?: string[];
  /** Reasoning effort for extended-thinking models (empty/undefined = the model default). */
  thinkingLevel?: string;
  autoCompact: boolean;
  autoCompactAt: number;
}

/** Fallback auto-compact threshold (fraction of the context window) when the user set none. */
export const DEFAULT_AUTO_COMPACT_AT = 0.8;
