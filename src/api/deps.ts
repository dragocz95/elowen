import type { KeyedMutex } from '../shared/keyedMutex.js';
import type { TaskStore } from '../store/taskStore.js';
import type { Readiness } from '../store/readiness.js';
import type { MissionStore } from '../store/missionStore.js';
import type { AgentStore } from '../store/agentStore.js';
import type { MissionEngine } from '../overseer/missionEngine.js';
import type { MissionGit } from '../overseer/missionGit.js';
import type { SpawnService } from '../spawn/spawn.js';
import type { TmuxDriver } from '../tmux/types.js';
import type { EventBus } from './sse.js';
import type { AgentSpec } from '../spawn/commandBuilder.js';
import type { PlanJobStore, PlanJob } from '../overseer/planJob.js';
import type { DecisionQueue } from '../overseer/decisionQueue.js';
import type { InferenceClient, RelayConfig } from '../inference/types.js';
import type { Clock } from '../shared/clock.js';
import type { ConfigStore } from '../store/configStore.js';
import type { UserStore } from '../store/userStore.js';
import type { TicketStore } from '../terminal/ticketStore.js';
import type { EventStore } from '../store/eventStore.js';
import type { NoteStore } from '../store/noteStore.js';
import type { ProjectStore } from '../store/projectStore.js';
import type { UserProjectStore } from '../store/userProjectStore.js';
import type { PushSubscriptionStore } from '../store/pushSubscriptionStore.js';
import type { UserPromptStore } from '../store/userPromptStore.js';
import type { PromptService } from '../prompts/promptService.js';
import type { TaskUsageStore } from '../store/taskUsageStore.js';
import type { GitReader } from '../git/gitReader.js';

/** Everything the daemon injects into the REST server. Lives in its own module (rather than server.ts)
 *  so the route context and the route families can depend on the dependency shape without importing
 *  back from server.ts — keeping the module graph acyclic. */
export interface ServerDeps {
  tasks: TaskStore; readiness: Readiness; missions: MissionStore;
  engine: MissionEngine; spawn: SpawnService; tmux: TmuxDriver; bus: EventBus;
  /** PR-native git lifecycle. Absent (or PR mode off) → phases never commit, no worktree, no PR. */
  missionGit?: MissionGit;
  /** Shared per-checkout git serialization lock — the SAME instance the scheduler and mission engine
   *  use, so a phase's commit+snapshot at close can't interleave with the baseline read at another
   *  agent's spawn on the same checkout. Absent → a private lock (fine for isolated tests). */
  gitLock?: KeyedMutex;
  project: { id: number; path: string };
  fallback: AgentSpec;
  clock: Clock;
  config: ConfigStore;
  users?: UserStore;
  events?: EventStore;
  notes?: NoteStore;
  projects?: ProjectStore;
  userProjects?: UserProjectStore;
  /** Per-user web-push device subscriptions. Absent → push subscribe/unsubscribe routes degrade to no-ops. */
  pushSubscriptions?: PushSubscriptionStore;
  /** Per-user prompt overrides. Absent → the prompts API degrades and resolution uses file defaults only. */
  userPrompts?: UserPromptStore;
  /** User-aware prompt renderer (resolves a user's override else the file default). Absent → callers
   *  fall back to the plain file `render`, i.e. defaults for everyone. */
  prompts?: PromptService;
  taskUsage?: TaskUsageStore;
  /** Agent registry — records each spawned agent's project at spawn. Used to tag live sessions with
   *  their project (the daemon's single source of truth for session→repo). */
  agents?: AgentStore;
  git?: GitReader;
  /** Directory where uploaded user avatars are stored/served. Absent → avatar upload disabled. */
  avatarsDir?: string;
  /** HMAC secret for short-lived signed avatar URLs (so an <img> src never carries the long-lived
   *  session token). Per-daemon-process; absent → signed avatar links unavailable (bearer only). */
  avatarSecret?: string;
  /** Factory for the planning LLM client; defaults to RelayClient. Overridable in tests. */
  makeInference?: (cfg: RelayConfig) => InferenceClient;
  /** Async planning job registry (relay or agent backend resolves into it). Defaulted when absent. */
  planJobs?: PlanJobStore;
  /** Per-mission decision queue consumed by the parked overseer agent (long-poll). Defaulted when absent. */
  decisionQueue?: DecisionQueue;
  /** Spawn the Pilot agent for an agent-mode plan job (Task 9). Absent → relay-only planning. */
  pilot?: (job: PlanJob, projectPath: string) => Promise<void>;
  /** Per-user advisor lifecycle. Absent → advisor feature disabled (routes degrade gracefully). */
  advisor?: import('../advisor/service.js').AdvisorService;
  /** Single-use ticket store backing the terminal WebSocket stream. Shared with the daemon's
   *  `/ws/terminal` handler so a ticket minted here is redeemable there. Defaulted when absent. */
  tickets?: TicketStore;
  /** Latest published version lookup for the System panel. Injected in tests; defaults to a cached
   *  npm-registry fetch. */
  latestVersion?: () => Promise<string | null>;
  /** Start a manual in-place update (detached). Injected in tests; defaults to spawning `orca update`. */
  startUpdate?: () => void;
}
