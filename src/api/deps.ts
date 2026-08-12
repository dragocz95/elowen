import type { TaskStore } from '../store/taskStore.js';
import type { Readiness } from '../store/readiness.js';
import type { AgentsCliDetection, AgentsCliDetectionContext, AgentsExecSpec, AgentsGitLock, AgentsMissionEngine, AgentsMissionGit, AgentsMissions, AgentsPlanJobs } from '../plugins/api.js';
import type { Task } from '../store/types.js';
import type { PlanJob } from '../shared/agentEvents.js';
import type { TmuxDriver } from '../tmux/types.js';
import type { ElowenEvent, EventBus } from './sse.js';
import type { TokenUsage } from '../integrations/usage/types.js';
import type { InferenceClient, RelayConfig } from '../inference/types.js';
import type { Clock } from '../shared/clock.js';
import type { ConfigStore } from '../store/configStore.js';
import type { UserStore } from '../store/userStore.js';
import type { EventStore } from '../store/eventStore.js';
import type { ProjectStore } from '../store/projectStore.js';
import type { UserProjectStore } from '../store/userProjectStore.js';
import type { PushSubscriptionStore } from '../store/pushSubscriptionStore.js';
import type { UserPromptStore } from '../store/userPromptStore.js';
import type { UserSettingStore } from '../store/userSettingStore.js';
import type { PromptService } from '../prompts/promptService.js';
import type { TaskUsageStore } from '../store/taskUsageStore.js';
import type { GitReader } from '../git/gitReader.js';
import type { BrainOAuthManager } from '../brain/oauth.js';
import type { BrainCredentialAccess } from '../brain/providerUsage.js';
import type { EmbeddingService } from '../embeddings/embeddingService.js';
import type { SubagentPoolStats } from '../subagent/poolStats.js';
import type { ThemeStore } from '../store/themeStore.js';

/** Everything the daemon injects into the REST server. Lives in its own module (rather than server.ts)
 *  so the route context and the route families can depend on the dependency shape without importing
 *  back from server.ts — keeping the module graph acyclic. */
export interface ServerDeps {
  /** The sub-agent pool's live state, for `/health`. Absent in a process with no pool (the in-memory test
   *  database, and the runner itself), which is reported as an absent block rather than a fake empty one. */
  subagentPool?: () => SubagentPoolStats;
  /** Read view of the agents plugin's missions table (a live facade over the control in the daemon;
   *  the plugin's own store instance in tests). Reads degrade to empty while the plugin is disabled —
   *  every mission WRITE goes through `engine` and answers 503 without it. */
  tasks: TaskStore; readiness: Readiness; missions: AgentsMissions;
  /** The agents plugin's mission engine (structural — see AgentsControl). Absent while the plugin is
   *  disabled/not yet loaded: engage/pause/resume/disengage and plan-engage answer 503. */
  engine?: AgentsMissionEngine;
  tmux: TmuxDriver; bus: EventBus;
  /** PR-native git lifecycle. Absent (or PR mode off) → phases never commit, no worktree, no PR. */
  missionGit?: AgentsMissionGit;
  /** Shared per-checkout git serialization lock — the SAME instance the scheduler and mission engine
   *  use, so a phase's commit+snapshot at close can't interleave with the baseline read at another
   *  agent's spawn on the same checkout. Absent → a private lock (fine for isolated tests). */
  gitLock?: AgentsGitLock;
  /** LIVE token-usage reader (agents plugin control). Absent → /tasks/:id/usage serves the recorded
   *  task_usage snapshot only, exactly what an embedded (elowen:) run already does. */
  liveTaskUsage?: (taskId: string) => TokenUsage | null;
  /** Agent-CLI availability probe (agents plugin control). Absent → /integrations/cli-status 503s. */
  detectClis?: (context?: AgentsCliDetectionContext) => Promise<AgentsCliDetection>;
  project: { id: number; path: string };
  fallback: AgentsExecSpec;
  /** How spawned agents invoke the elowen CLI (`elowen` globally, or `node <path>` in a checkout). Same
   *  value threaded to spawn/pilot/overseer; used by the guide service to render `elowen help`. Absent → `elowen`. */
  cli?: string;
  clock: Clock;
  config: ConfigStore;
  users?: UserStore;
  events?: EventStore;
  projects?: ProjectStore;
  userProjects?: UserProjectStore;
  /** Per-user web-push device subscriptions. Absent → push subscribe/unsubscribe routes degrade to no-ops. */
  pushSubscriptions?: PushSubscriptionStore;
  /** Per-user prompt overrides. Absent → the prompts API degrades and resolution uses file defaults only. */
  userPrompts?: UserPromptStore;
  /** Per-user CLI/brain settings (model override, auto-compact). Absent → the settings API degrades. */
  userSettings?: UserSettingStore;
  /** Plugin scan roots (bundled first, then user) for the admin /plugins listing. Absent → empty list. */
  pluginDirs?: string[];
  /** Plugin-contributed event→project resolvers (live registry read, so a reload swaps them). The SSE
   *  per-subscriber gate and the activity recorder consult them for events whose tenancy lookup lives
   *  in a plugin (agents: signal/plan). Absent → those events resolve null = admin-only (fail closed). */
  eventProjectResolvers?: () => readonly ((e: ElowenEvent) => number | null)[];
  /** Root of per-plugin writable data dirs (serves generated images from plugins-data/image-gen). */
  pluginDataRoot?: string;
  /** Where a chat turn's own attachments are kept, so a bubble still shows them after a reload. Absent
   *  (in-memory database) → the read route 404s and messages keep only their attachment marker. */
  chatImagesDir?: string;
  /** Brain provider OAuth flows (connect Anthropic/Copilot/OpenAI accounts). Absent → routes degrade. */
  brainOauth?: BrainOAuthManager;
  /** The brain's credential access — lets /brain/models surface connected OAuth accounts' catalogs and
   *  the usage pollers read their tokens. */
  brainAuth?: BrainCredentialAccess;
  /** User-aware prompt renderer (resolves a user's override else the file default). Absent → callers
   *  fall back to the plain file `render`, i.e. defaults for everyone. */
  prompts?: PromptService;
  taskUsage?: TaskUsageStore;
  git?: GitReader;
  /** Directory where uploaded user avatars are stored/served. Absent → avatar upload disabled. */
  avatarsDir?: string;
  /** HMAC secret for short-lived signed avatar URLs (so an <img> src never carries the long-lived
   *  session token). Per-daemon-process; absent → signed avatar links unavailable (bearer only). */
  avatarSecret?: string;
  /** Factory for the planning LLM client; defaults to RelayClient. Overridable in tests. */
  makeInference?: (cfg: RelayConfig) => InferenceClient;
  /** Async planning job registry (relay or agent backend resolves into it). Defaulted when absent. */
  planJobs?: AgentsPlanJobs;
  /** The agents plugin's post-done review gate (AgentsControl.onTaskClosed): drives the mission-phase
   *  review workflow after a close. Absent (plugin disabled) → no gate, the close is final. */
  onTaskClosed?: (id: string, existing: Task, opts: { outcome?: string; summary?: string }) => Promise<void>;
  /** Spawn the Pilot agent for an agent-mode plan job (Task 9). Absent → relay-only planning. */
  pilot?: (job: PlanJob, projectPath: string) => Promise<void>;
  /** The agents plugin's advisor lifecycle hooks (login autostart, user-deletion teardown). The
   *  /advisor routes are plugin root mounts; absent (plugin disabled) → both hooks are skipped. */
  advisor?: import('../plugins/api.js').AgentsAdvisorHooks;
  /** Per-user embedded brain (PI agent) — the new advisor engine. Absent → brain routes degrade to 503. */
  brain?: import('../brain/brainService.js').BrainService;
  /** Admin-only interactive `elowen chat` terminals bound to existing brain conversations. Absent →
   *  POST /brain/terminal degrades to 503 and the DELETE /sessions chat branch is inert. */
  brainTerminal?: import('../brain/terminalService.js').BrainTerminalService;
  /** Restart the Elowen daemon (the admin-only `/restart` slash command): announce it on the platforms,
   *  drop a marker so the next boot announces "back online", then hand off to systemd. Absent → 501. */
  restartDaemon?: (byUserId: number) => Promise<void>;
  /** Elowen exec engine (embedded-brain workers): kill controls + task transcripts. */
  brainWorkers?: { isLive(session: string): boolean; abort(session: string): Promise<void> };
  /** Brain message store — feeds GET /tasks/:id/conversation for elowen workers. */
  brainStore?: import('../store/brainStore.js').BrainStore;
  /** Elowen RAW memory persistence (user-scoped): facts, packed-Float32 embeddings, audit events. */
  memoryStore?: import('../store/memoryStore.js').MemoryStore;
  /** Per-user memory categories (labels + LLM-facing descriptions). Absent → the category routes 400. */
  memoryCategoryStore?: import('../store/memoryCategoryStore.js').MemoryCategoryStore;
  /** Assigns memories to one of the owner's categories via a cheap model (owner-scoped). Absent → the
   *  manual reclassify route 400s and the curator never auto-categorizes new memories. */
  memoryCategorizer?: import('../brain/memoryCategorizer.js').MemoryCategorizer;
  /** Text→vector embeddings via an OpenAI-compatible /v1/embeddings endpoint, reusing brain provider creds. Absent → memory retrieval (Phase 4) has no embedder. */
  embeddings?: EmbeddingService;
  /** The ONE shared plugin registry provider (merged contributions of every enabled plugin). Feeds the
   *  runtime plugin-contribution introspection endpoint. Absent → that endpoint reports an empty shape. */
  plugins?: import('../plugins/pluginsProvider.js').PluginRegistryProvider;
  /** Installs/updates/removes plugins from the curated GitHub registry (shallow-clone cache → user plugin
   *  dir). Feeds the marketplace endpoints. Absent → those endpoints return 503. */
  marketplace?: import('../plugins/marketplace.js').MarketplaceService;
  /** Bounded in-memory ring of recent log lines, tapped at the logger's emit() choke point. Feeds the
   *  admin per-plugin logs + health views. Absent → those views report empty/`ok`. */
  pluginLogs?: import('../shared/logBuffer.js').PluginLogBuffer;
  /** Bounded in-memory ring of recent mutating-hook execution records (writer: the brain's hook
   *  runner; reader: the admin plugins API). Feeds the per-plugin hook-audit view. Absent → that
   *  view reports empty. Constructed in bootstrap's brain stage, shared with the hook bus as its
   *  audit sink. */
  hookAudit?: import('../shared/hookAudit.js').HookAuditBuffer;
  /** Latest published version lookup for the System panel. Injected in tests; defaults to a cached
   *  npm-registry fetch. */
  latestVersion?: () => Promise<string | null>;
  /** Start a manual in-place update (detached). Injected in tests; defaults to spawning `elowen update`. */
  startUpdate?: () => void;
  /** Restart one systemd unit (detached, `--no-block`). Injected in tests; defaults to sudo systemctl. */
  startRestart?: (target: 'daemon' | 'web') => void;
  /** White-label theme packages under `<dataDir>/themes/`. Absent → the public theme endpoint serves
   *  the built-in brand and the admin theme list is empty. */
  themes?: ThemeStore;
}
