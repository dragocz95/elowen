import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { Policy } from '../../plugins/policy.js';
import type { BrainEvent } from '../events.js';

/** One live brain conversation: the PI session plus its settings, event fanout and per-turn context.
 *  Shared by the chat brain, the channel service and the live registry. */
export interface LiveBrain {
  session: AgentSession;
  sessionId: string;
  model: string;
  /** The CONFIG provider entry id the model resolved from (selection.provider, else the default first
   *  entry) — lets delegation inherit "same provider + model" without re-deriving config defaults. */
  providerId?: string;
  thinkingLevel?: string;
  policy: Policy;
  autoCompact: boolean;
  autoCompactAt: number;
  listeners: Set<(e: BrainEvent) => void>;
  turnContext: () => string;
  /** Names of the plugin tools composed into this session — the subset a per-turn ToolPolicy allow-list
   *  may hide (the built-in orca_ and memory_ tools stay visible). Used by applyToolVisibility to slice
   *  the model's advertised tools to what the current sender may use. */
  pluginToolNames: Set<string>;
  /** True while the session runs on the user's vision-fallback model (an image turn hopped onto it). */
  visionFallback?: boolean;
  /** SESSION-scoped YOLO override (the CLI `/yolo` command): true/false wins over the user's persisted
   *  default for this live session only. Deliberately NOT carried across respawns (model switch,
   *  restart, vision hop) — a fresh session starts back at the persisted default. */
  yoloOverride?: boolean;
  /** Epoch ms of the user's last EXPLICIT interaction with this conversation (resume via the session
   *  picker / `/resume`, a model switch, a manual compact, a reasoning-effort change). Consulted by the
   *  idle-rollover check (send()) so a deliberately reopened old conversation continues instead of being
   *  cut over to a fresh session. Unset for auto-resumed sessions (client boot). */
  interactedAt?: number;
  /** Platform id (e.g. Discord author) of the sender whose turn is currently in flight — set at the
   *  start of a channel turn. Mid-run injection only STEERS a message into the running turn when it comes
   *  from this SAME sender, so one member can never inject instructions into another's (or the admin's)
   *  turn and inherit its policy/toolset. */
  turnSender?: string;
  /** Session ids of delegated sub-agents currently RUNNING under this conversation's turn — maintained
   *  by the `subagent` progress emitter (added on 'running', dropped on 'done'/'error'). abort() cancels
   *  these children along with the parent turn, so an interrupted delegation can't keep burning tokens. */
  activeChildren?: Set<string>;
  /** The session's resolved working directory (validated client cwd → policy root → primary project).
   *  Reused as the per-turn workDir fallback for sends that carry no client cwd (goal kickoff/continue)
   *  and re-passed on respawns (model switch, vision hop, restart) so the session cwd never silently
   *  reverts away from where the user launched their CLI. */
  workDir?: string;
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
  /** Reasoning effort for extended-thinking models (empty/undefined = the model default). */
  thinkingLevel?: string;
  /** Which personality platform this session is: 'web'|'cli' for per-user owner chat, 'discord' for
   *  shared owner-anchored channels. Selects which active profile the personality chunk resolves from
   *  (owner's per-platform pin). Default 'web'. */
  platform?: string;
  autoCompact: boolean;
  autoCompactAt: number;
  /** The client-reported working directory (the CLI sends where it was launched). Validated against
   *  the policy before use — see BrainService.turnWorkDir — and preferred as the session cwd, which pi
   *  advertises to the model ("Current working directory: …"). */
  clientCwd?: string;
}

/** Fallback auto-compact threshold (fraction of the context window) when the user set none. */
export const DEFAULT_AUTO_COMPACT_AT = 0.8;
