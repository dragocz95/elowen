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
  /** Platform channel session (Discord, …): the sender is NOT the verified Orca owner, so the owner's
   *  full-scope orca_* API tools are withheld — only Policy-guarded plugin tools load. ALWAYS true for
   *  a shared channel; such a session is never owner-chat, whatever role the sender holds. */
  channel?: boolean;
  /** A shared channel whose sender holds the operator's admin role: resolves to `trusted-channel`
   *  (all-project Policy + full plugin toolset) instead of `foreign-channel`, but STILL without orca_*
   *  tools or the owner API token. Only meaningful when `channel` is true. */
  trustedChannel?: boolean;
  /** Per-role tool allowlist (tool names; '*' = everything). Undefined = no restriction. */
  toolFilter?: string[];
  /** Reasoning effort for extended-thinking models (empty/undefined = the model default). */
  thinkingLevel?: string;
  /** Which personality platform this session is: 'web'|'cli' for per-user owner chat, 'discord' for
   *  shared owner-anchored channels. Selects which active profile the personality chunk resolves from
   *  (owner's per-platform pin). Default 'web'. */
  platform?: string;
  autoCompact: boolean;
  autoCompactAt: number;
}

/** Fallback auto-compact threshold (fraction of the context window) when the user set none. */
export const DEFAULT_AUTO_COMPACT_AT = 0.8;
