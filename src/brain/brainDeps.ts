import type { createAgentSession, AuthStorage, ResourceLoader } from '@earendil-works/pi-coding-agent';
import type { PluginRegistryProvider } from '../plugins/pluginsProvider.js';
import type { HookAuditBuffer } from '../shared/hookAudit.js';
import type { Policy } from '../plugins/policy.js';
import type { BrainStore } from '../store/brainStore.js';
import type { BrainRuntimeConfig } from './providers.js';
import type { MemoryCategorizer } from './memoryCategorizer.js';
import type { MemoryCategoryStore } from '../store/memoryCategoryStore.js';
import type { MemoryStore } from '../store/memoryStore.js';
import type { MemoryService } from './memoryService.js';
import type { InferenceClient } from '../inference/types.js';
import type { PermissionScope, PermissionSettings } from './toolPermissions.js';
import type { BrainLimits } from '../store/configStore.js';
import type { BrainResourceLoaderOptions } from './session/factory.js';

// The daemon-wiring seam of the brain, in its own module so the service/* units can depend on it
// without importing the BrainService facade back (keeps the dependency graph acyclic — depcruise
// no-circular is a hard gate).
export interface BrainDeps {
  store: BrainStore;
  users: {
    ensureAdvisorToken(userId: number): string;
    get(userId: number): { name?: string; username?: string; is_admin?: boolean; disabled_tools?: string[] } | null | undefined;
  };
  /** The provider set, or a live resolver so provider/OAuth changes apply without a daemon restart.
   *  A resolver returning null means "nothing configured yet" — `start` fails with a clear error. */
  config: BrainRuntimeConfig | (() => BrainRuntimeConfig | null);
  /** Credential store for the brain's providers (OAuth tokens live here). Default: in-memory. */
  authStorage?: AuthStorage;
  /** Renders the brain's system prompt from the editable `advisor` template (per-user override aware). */
  prompts: { render(name: string, vars: Record<string, string>, userId?: number): string };
  /** Daemon REST base the brain's tools call (ELOWEN_URL). */
  url: string;
  /** Working dir for the in-memory session (not a repo checkout). Default: process.cwd(). */
  cwd?: string;
  /** The daemon's primary project checkout — the final turn-workDir fallback for an all-access chat
   *  with no client-reported cwd (the daemon process itself runs at `/` under systemd). */
  projectPath?: () => string | undefined;
  /** The daemon-wide shared plugin registry (lazy-loaded, memoized, invalidated on plugin toggles).
   *  Shared with the brain workers and platform adapters so ALL consumers reload together. Absent →
   *  brain runs exactly as before plugins existed. */
  plugins?: PluginRegistryProvider;
  /** Bounded ring the mutating-hook runner writes one record per hook to (owner chat, per turn). Absent
   *  → hook executions aren't audited. Shared with the admin per-plugin hook-audit route. */
  hookAudit?: HookAuditBuffer;
  /** Resolves the repo-access Policy for a user; carried into plugin tool execution via AsyncLocalStorage. */
  policy?: (userId: number) => Policy;
  /** Per-user CLI/brain settings: an optional model override (empty → configured default) + auto-compact
   *  toggle and its user-tunable threshold percentage. */
  userSettings?: (userId: number) => { model?: string; modelProvider?: string; visionModel?: string; visionModelProvider?: string; thinkingLevel?: string; autoCompact?: boolean; autoCompactAt?: number; advisorStyle?: string; autoRecall?: boolean; autoSave?: boolean };
  /** The user's active personality profile as a ready-to-append system-prompt chunk, or undefined when
   *  none is pinned (delegates to PersonalityService.activeAppend). Appended AFTER the persona in
   *  appendSystemPrompt — the cache-safe seam. For Discord `userId` is the channel owner and `platform`
   *  is 'discord', so it resolves the owner's one Discord persona (the locked shared-channel decision). */
  activePersonality?: (userId: number, platform: string) => string | undefined;
  /** The assistant's configured display identity (Settings → Elowen AI). Absent → 'Elowen'. */
  agentName?: () => string;
  /** Max agent steps (model round-trips) per run before the turn is aborted (Settings → Elowen AI). Read
   *  fresh each turn so a config change applies without a session restart. Absent or ≤0 → unlimited. */
  maxSteps?: () => number;
  /** Operator-tunable brain limits (Settings → Elowen AI → Limits): tool-output caps, elicitation timeout,
   *  memory recall size, goal turn budget + safety ceiling, live-channel cap. Read fresh so a config
   *  change applies without a restart. Absent (minimal/test wiring) → the built-in defaults. */
  brainLimits?: () => BrainLimits;
  /** Resolve a platform sender (e.g. a Discord id) to the Elowen user who claimed it in their account
   *  settings. Lets channel turns carry a verified identity line for registered users. */
  resolvePlatformUser?: (platform: string, platformUserId: string) => { id: number; name: string; username?: string; admin: boolean } | null;
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
  /** Build a Policy from an explicit project-id set (platform role mappings resolve through this). */
  policyForProjects?: (projectIds: number[]) => Policy;
  /** The Elowen user that anchors platform channel sessions (their token drives the tools) — the admin. */
  platformOwner?: () => number | undefined;
  /** The user's PRIVATE long-term memory store. Threaded so the owner-chat memory tools can read/write
   *  it and the curator can persist post-turn facts. Absent (with memoryService) → memory disabled. */
  memoryStore?: MemoryStore;
  /** Retrieval + anti-duplication over the memory store. Present (with memoryStore) ⇒ owner turns get
   *  per-turn memory injection, the memory tools, and the post-turn curator. */
  memoryService?: MemoryService;
  /** Builds a CHEAP inference client for the post-turn memory curator (mirrors the overseer relay,
   *  keyed on autopilot.model). Returns null when no key/model is configured → the curator no-ops. */
  inference?: () => InferenceClient | null;
  /** Auto-categorizer handed to the curator so a newly-added durable memory is classified into one of
   *  the owner's categories (fire-and-forget). Absent → new memories are left uncategorized. */
  memoryCategorizer?: MemoryCategorizer;
  /** Per-user memory category store — powers the owner's memory_category_* tools. */
  memoryCategoryStore?: MemoryCategoryStore;
  /** Injected for tests; defaults to PI's createAgentSession. */
  createSession?: typeof createAgentSession;
  /** Injected for tests; builds the resource loader that carries the Elowen system prompt. A test passes
   *  `() => undefined` so no disk-touching loader is constructed. */
  resourceLoaderFactory?: (o: BrainResourceLoaderOptions) => ResourceLoader | undefined;
}
