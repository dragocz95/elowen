import { ungrantedPluginTools } from '../plugins/toolGrants.js';
import type { createAgentSession, ModelRuntime, ResourceLoader } from '@earendil-works/pi-coding-agent';
import type { PluginRegistryProvider } from '../plugins/pluginsProvider.js';
import type { HookAuditBuffer } from '../shared/hookAudit.js';
import type { Policy } from '../plugins/policy.js';
import type { BrainStore } from '../store/brainStore.js';
import type { BrainRuntimeConfig } from './providers.js';
import type { AgentDef } from './agents/agentRegistry.js';
import type { MemoryCategorizer } from './memoryCategorizer.js';
import type { MemoryCategoryStore } from '../store/memoryCategoryStore.js';
import type { UserPluginConfigStore } from '../store/userPluginConfigStore.js';
import type { MemoryStore } from '../store/memoryStore.js';
import type { MemoryService } from './memoryService.js';
import type { InferenceClient } from '../inference/types.js';
import type { PermissionScope, PermissionSettings } from './toolPermissions.js';
import type { BrainLimits, RuntimeConfig } from '../store/configStore.js';
import type { BrainResourceLoaderOptions } from './session/factory.js';
import type { ProjectModelPreference } from '../store/userSettingStore.js';
import type { ProjectStore } from '../store/projectStore.js';
import type { DelegatedTurnRunner } from './delegatedTurn.js';
import type { ResolvedBrand } from '../shared/brand.js';

// The daemon-wiring seam of the brain, in its own module so the service/* units can depend on it
// without importing the BrainService facade back (keeps the dependency graph acyclic — depcruise
// no-circular is a hard gate).
export interface BrainDeps {
  store: BrainStore;
  users: {
    ensureAdvisorToken(userId: number): string;
    get(userId: number): { name?: string; username?: string; is_admin?: boolean; disabled_tools?: string[]; granted_plugins?: string[] } | null | undefined;
  };
  /** The provider set, or a live resolver so provider/OAuth changes apply without a daemon restart.
   *  A resolver returning null means "nothing configured yet" — `start` fails with a clear error. */
  config: BrainRuntimeConfig | (() => BrainRuntimeConfig | null);
  /** The brain's model runtime: credential store (OAuth tokens) + built-in catalog. buildBrainRegistry
   *  wraps it per session; its stored credentials resolve OAuth auth. */
  runtime: ModelRuntime;
  /** Renders the brain's system prompt from the editable `elowen` template (per-user override aware). */
  prompts: { render(name: string, vars: Record<string, string>, userId?: number): string };
  /** Daemon REST base the brain's tools call (ELOWEN_URL). */
  url: string;
  /** Working dir for the in-memory session (not a repo checkout). Default: process.cwd(). */
  cwd?: string;
  /** The daemon's primary project checkout — the final turn-workDir fallback for an all-access chat
   *  with no client-reported cwd (the daemon process itself runs at `/` under systemd). */
  projectPath?: () => string | undefined;
  /** Registered projects resolve a canonical client cwd to the category scope used for recall. */
  projects?: ProjectStore;
  /** Where a turn's image attachments are written so a bubble still shows them after a reload. Raw base64
   *  never enters `brain_messages`; the row keeps a reference to a file here. Absent (in-memory database)
   *  → attachments live only for their turn, exactly as before. */
  chatImagesDir?: string;
  /** Bill a settled turn's tokens to the request origin that ordered it. Wired in brainCore to
   *  UsageOriginStore; absent (tests, the forked sub-agent runner) → nothing is attributed and the admin
   *  origin view simply has no rows for those turns, which is truthful rather than approximate. */
  onTurnSettled?: (sessionId: string, usage: import('./persistence.js').SettledTurnUsage) => void;
  /** The daemon-wide shared plugin registry (lazy-loaded, memoized, invalidated on plugin toggles).
   *  Shared with the brain workers and platform adapters so ALL consumers reload together. Absent →
   *  brain runs exactly as before plugins existed. */
  plugins?: PluginRegistryProvider;
  /** Called once a plugin reload has actually SWAPPED the registry. A toggle is persisted the moment its
   *  route answers, but the swap can land later — when running work settles — so surfaces that render the
   *  offered set (nav worlds, pages, slash commands) need telling then, not at the write. */
  onPluginsReloaded?: () => void;
  /** Bounded ring the mutating-hook runner writes one record per hook to (owner chat, per turn). Absent
   *  → hook executions aren't audited. Shared with the admin per-plugin hook-audit route. */
  hookAudit?: HookAuditBuffer;
  /** Resolves the repo-access Policy for a user; carried into plugin tool execution via AsyncLocalStorage. */
  policy?: (userId: number) => Policy;
  /** Per-user CLI/brain settings: an optional model override (empty → configured default) + auto-compact
   *  toggle and its user-tunable threshold percentage. */
  userSettings?: (userId: number) => { model?: string; modelProvider?: string; visionModel?: string; visionModelProvider?: string; compactModel?: string; compactModelProvider?: string; thinkingLevel?: string; autoCompact?: boolean; autoCompactAt?: number; autoCompactAtByModel?: Record<string, number>; advisorStyle?: string; autoRecall?: boolean; autoLiveRecall?: boolean; autoSave?: boolean };
  /** The CLI's per-user model choice for a canonical, policy-authorized Git project root. */
  projectModelPreference?: (userId: number, projectRoot: string) => ProjectModelPreference | undefined;
  setProjectModelPreference?: (userId: number, projectRoot: string, selection: ProjectModelPreference) => void;
  /** The account owner's global instructions as raw text, or undefined when empty. The spawner escapes and
   *  wraps them before appending them AFTER the persona at the cache-safe appendSystemPrompt seam. Identical
   *  on every platform (web/CLI/Discord/cron); for a channel `userId` is the channel owner. */
  activeUserInstructions?: (userId: number) => string | undefined;
  /** The instance's resolved brand — persona name (Settings → Elowen AI / active theme) and product
   *  name (active theme). Read fresh at spawn so a brand change lands on the next respawn. Absent →
   *  the built-in Elowen brand. */
  brand?: () => ResolvedBrand;
  /** Max agent steps (model round-trips) per run before the turn is aborted (Settings → Elowen AI). Read
   *  fresh each turn so a config change applies without a session restart. Absent or ≤0 → unlimited. */
  maxSteps?: () => number;
  /** Operator-tunable brain limits (Settings → Elowen AI → Limits): tool-output caps, elicitation timeout,
   *  memory recall size, goal turn budget + safety ceiling, live-channel cap. Read fresh so a config
   *  change applies without a restart. Absent (minimal/test wiring) → the built-in defaults. */
  brainLimits?: () => BrainLimits;
  /** Operator-tunable runtime config (Settings → Elowen AI → Runtime). The brain consumes its
   *  deferred-tool policy half — the threshold and the kill switch — when composing a session's tool set.
   *  Read fresh so a config change applies to the next spawn without a restart. Absent (minimal/test
   *  wiring) → the deferral policy's built-in defaults. */
  runtimeConfig?: () => RuntimeConfig;
  /** Resolve a platform sender to the Elowen user who claimed it. `verifiedEmail` is optional platform-
   *  authenticated identity evidence (Teams UPN), never user-authored message content. */
  resolvePlatformUser?: (platform: string, platformUserId: string, verifiedEmail?: string) => { id: number; name: string; username?: string; admin: boolean } | null;
  /** Per-user granular tool permissions (allow/ask/deny rules + the persisted YOLO default), read
   *  fresh each turn so an "Always allow" or a settings edit applies immediately. Absent → the
   *  execute-time permission gate stays inert (tests / minimal wiring). */
  permissions?: (userId: number) => PermissionSettings;
  /** Persist an "Always allow" pick from an approval prompt into the user's stored rules. */
  saveAlwaysAllow?: (userId: number, scope: PermissionScope, pattern: string) => void;
  /** Per-user brain-model permission, keyed by exec spec `elowen:<provider>/<model>`. Absent → no
   *  restriction (open mode / tests). Enforced on explicit picks; a saved-but-revoked default
   *  silently falls back to the server default instead of erroring. */
  execAllowed?: (userId: number, exec: string) => boolean;
  /** Build a Policy from an explicit project-id set captured in delegated execution scopes. */
  policyForProjects?: (projectIds: number[]) => Policy;
  /** The Elowen user that anchors platform channel sessions (their token drives the tools) — the admin. */
  platformOwner?: () => number | undefined;
  /** The forked sub-agent runner, when this process owns one. DAEMON-ONLY by construction: the runner
   *  itself is built WITHOUT it, which is what keeps a nested delegation inside the same runner instead
   *  of forking a runner from a runner. Absent ⇒ every delegated turn runs in-process, exactly as before
   *  the runner existed. Even when present it is used only while the operator's switch is on. */
  subagentRunner?: DelegatedTurnRunner;
  /** The typed sub-agent registry, resolved host-side when a delegate call names a `subagent_type`.
   *  Returns the SAME rebuildable instance the plugin catalog reads, so both see a reload's fresh set. */
  agents?: () => Map<string, AgentDef>;
  /** The user's PRIVATE long-term memory store. Threaded so the owner-chat memory tools can read/write
   *  it and the curator can persist post-turn facts. Absent (with memoryService) → memory disabled. */
  memoryStore?: MemoryStore;
  /** Retrieval + anti-duplication over the memory store. Present (with memoryStore) ⇒ owner turns get
   *  per-turn memory injection, the memory tools, and the post-turn curator. */
  memoryService?: MemoryService;
  /** Operator budget for mid-turn recall, read per search so a change applies to a running conversation. */
  liveRecallBudget?: () => { passes: number; count: number; bytes: number };
  /** Builds a CHEAP inference client for the post-turn memory curator (mirrors the overseer relay,
   *  keyed on autopilot.model). Returns null when no key/model is configured → the curator no-ops. */
  inference?: () => InferenceClient | null;
  /** Auto-categorizer handed to the curator so a newly-added durable memory is classified into one of
   *  the owner's categories (fire-and-forget). Absent → new memories are left uncategorized. */
  memoryCategorizer?: MemoryCategorizer;
  /** Operator cap on how many memories the post-turn curator may write from one exchange, read per run
   *  so a change applies without a restart. 0 switches automatic writing off. */
  memoryCuratorMaxOps?: () => number;
  /** Per-user memory category store — powers the owner's memory_category_* tools. */
  memoryCategoryStore?: MemoryCategoryStore;
  /** Each account's own values for plugins that declare a `userConfigSchema` — read by `ctx.userConfig()`
   *  and by the account's own settings routes. */
  userPluginConfig?: UserPluginConfigStore;
  /** Injected for tests; defaults to PI's createAgentSession. */
  createSession?: typeof createAgentSession;
  /** Injected for tests; builds the resource loader that carries the Elowen system prompt. A test passes
   *  `() => undefined` so no disk-touching loader is constructed. */
  resourceLoaderFactory?: (o: BrainResourceLoaderOptions) => ResourceLoader | undefined;
  /** Fired once an owner-chat turn the user started has settled with their own device off screen — the
   *  daemon wires it to a phone push, carrying the conversation name and the opening of the answer so the
   *  notification is readable without unlocking. Kept as an opaque callback so this seam never depends on
   *  the push module; a turn watched live never calls it. */
  notifyTurnComplete?: (userId: number, title: string, preview: string) => void;
  /** Report a platform turn to the team activity feed. Optional: a minimal wiring simply has no feed.
   *  Deliberately a plain callback — the brain layer owns no event bus, and the daemon supplies one. */
  recordActivity?: (e: { actorUserId: number | null; surface: string; target: string; detail: string }) => void;
}

/** Every tool name denied for a user's own sessions: the deny-list an admin set for them
 *  (`disabled_tools`), plus the tools of any `userGrantable` plugin they hold no grant for.
 *
 *  One resolver so the three places that mint a ToolPolicy — owner chat, a channel's linked sender and a
 *  delegated child — cannot drift into three different answers about what a user may reach. An unknown
 *  user id resolves to "no grants", which withholds a grant-gated tool rather than handing it out.
 */
export function deniedToolsForUser(d: Pick<BrainDeps, 'users' | 'plugins'>, userId: number): string[] {
  const u = d.users.get(userId);
  const ungranted = ungrantedPluginTools(
    { is_admin: u?.is_admin === true, granted_plugins: u?.granted_plugins ?? [] },
    d.plugins?.peek(),
  );
  const own = u?.disabled_tools ?? [];
  return ungranted.length ? [...own, ...ungranted] : [...own];
}
