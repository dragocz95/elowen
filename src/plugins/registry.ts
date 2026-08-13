import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { DelegatedChildBridge, EventPersistenceRow, KnownControls, PluginAgentCatalog, PluginReadinessCheck, PluginApiAccess, PluginApiRoute, PluginBrainWorker, PluginCapabilities, PluginCommand, PluginContext, PluginControl, PluginDb, PluginElowenCli, PluginEmbeddings, PluginHook, PluginHost, PluginHostConfig, PluginHostPrompts, PluginHostPush, PluginHostAdvisor, PluginHostStores, PluginHostTerminals, PluginHttpRoute, PluginLogger, PluginMcpTool, PluginModelOption, PluginPromptEntry, PluginProjectFiles, PluginService, PluginSkill, PluginWebUi, PlatformAdapter, ProviderCredentials, TurnContextContribution } from './api.js';
import type { TmuxDriver } from '../tmux/types.js';
import type { InferenceClient, RelayConfig } from '../inference/types.js';
import type { McpBridgeSnapshot } from './mcpSnapshot.js';
import type { ElowenEvent } from '../api/sse.js';
import { isEmbeddingConfigured } from '../embeddings/embeddingService.js';
import type { EmbeddingConfig } from '../embeddings/embeddingService.js';
import { commandsWithPlugins, isReservedCommandName, type PluginSlashCommand } from '../brain/slashCommands.js';
import type { PluginManifest } from './manifest.js';
import { assertPathAllowed, allowedRoots, defaultCwd, isAllAccess, currentAccess } from './pathGuard.js';
import { currentIdentity, currentElicitor, currentCardEmitter, currentSubagentEmitter, currentSubagentCompletionEmitter, currentWorkflowEmitter, currentWorkflowCompletionEmitter, currentTurnModel, currentWorkDir, currentSessionId } from './policyContext.js';
import { processRegistry } from '../brain/processRegistry.js';
import { subagentSessionId } from '../brain/sessionId.js';
import type { AskAnswer } from '../brain/events.js';
import { DEFAULT_BRAIN_LIMITS } from '../store/configStore.js';
import type { WorkflowExpansionRpc } from '../subagent/hostRpc.js';

/** Recursively collect every string value in a plugin's config slice — the set of provider ids the
 *  operator could legitimately have wired into THIS plugin. `resolveProvider()` is gated to this set so a
 *  plugin can reach only providers it was actually configured with (unless it declares a `providers`
 *  read capability). Bounded by the config's own depth (operator-authored, small). */
function collectStringValues(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') { into.add(value); return; }
  if (Array.isArray(value)) { for (const v of value) collectStringValues(v, into); return; }
  if (value && typeof value === 'object') { for (const v of Object.values(value)) collectStringValues(v, into); }
}

/** Whether a tool name is covered by a manifest's `provides.tools` declaration: an exact entry, or a
 *  `prefix*` pattern for a DYNAMIC tool surface whose names only exist at runtime — the mcp plugin
 *  bridges each configured server's tools as `mcp__<server>__<tool>` and cannot enumerate them ahead
 *  of time, so it declares `mcp__*`. Same `prefix*` convention as `icons`/`showOutput`. */
function toolDeclared(name: string, declared: readonly string[]): boolean {
  return declared.some((d) => (d.endsWith('*') ? name.startsWith(d.slice(0, -1)) : name === d));
}

/** The minimal shape of the SHARED embedder the registry exposes to plugins as `ctx.embeddings` — the
 *  public `embed`/`embedBatch` of the ONE EmbeddingService the memory subsystem uses. Kept structural so
 *  the registry never imports the concrete class; bootstrap passes the live instance. Signatures take a
 *  bound `(cfg, …)` — the registry binds the operator's Settings→Memory config internally, so the plugin
 *  can never point the shared key at a different model/endpoint. */
export interface PluginEmbedder {
  embed(cfg: EmbeddingConfig, text: string): Promise<Float32Array>;
  embedBatch(cfg: EmbeddingConfig, texts: string[]): Promise<Float32Array[]>;
}

/** EVERY method each KNOWN control must expose for `PluginRegistry.control()` to accept it — the runtime
 *  narrowing check that a registered blob really is the contract its key promises (a plugin registers
 *  an untyped `PluginControl`, so the shape is verified here, once, instead of at every call site).
 *  A control carrying more than one method must list them all: verifying only the first hands the caller
 *  a value typed as the WHOLE contract while a method may be missing, which then throws at the call site. */
const KNOWN_CONTROL_METHODS: { [K in keyof KnownControls]: readonly (keyof KnownControls[K] & string)[] } = {
  subagent: ['detachForeground', 'activeCount'],
  terminal: ['detachForeground', 'killForeground'],
  cron: ['pendingWakeupOriginSessionIds'],
  workflow: ['cancelForSession', 'detachForeground', 'activeCount', 'isWorkflowLive', 'addNodesFromSession'],
  mcp: ['listServers', 'bridgeSnapshot'],
  lsp: ['diagnosticsEnabled'],
  missions: ['engine', 'spawn', 'planFlow', 'planJobs', 'decisionQueue', 'missionGit', 'agents', 'gitLock', 'missions', 'liveTaskUsage', 'advisor', 'onTaskClosed'],
  tasks: ['store', 'readiness', 'usage'],
};

/** Aggregates every enabled plugin's contributions, and hands each plugin a PluginContext scoped to its
 *  own config slice + a name-prefixed logger. Populated once per daemon by the loader. */
/** What the host process actually has on hand for ctx.host — brainWorker resolves LIVE because
 *  bootstrap constructs it after the plugin load (late wiring, same as SpawnService.attachBrainWorker). */
export interface PluginHostWiring {
  tmux?: TmuxDriver;
  brainWorker?: () => PluginBrainWorker | undefined;
  elowenCli?: PluginElowenCli;
  stores?: PluginHostStores;
  prompts?: PluginHostPrompts;
  config?: PluginHostConfig;
  relayClient?: (cfg: RelayConfig) => InferenceClient;
  git?: PluginHost['git'] extends () => infer G ? G : never;
  /** Live accessor — the PushSender is constructed after the plugin load (bootstrap late wiring). */
  push?: () => PluginHostPush | undefined;
  /** Live accessor — chat-terminal/ticket services are constructed after the plugin load. */
  terminals?: () => PluginHostTerminals | undefined;
  /** Live accessor — the advisor collaborators are constructed after the plugin load. */
  advisor?: () => PluginHostAdvisor | undefined;
  /** The typed sub-agent catalog editor (core-owned; the subagent plugin's editor surface). */
  agentCatalog?: PluginAgentCatalog;
  /** The canonical lexical-and-symlink project path guard, kept in core for extracted file operations. */
  projectFiles?: PluginProjectFiles;
  /** Read ONE account's own values for ONE plugin (`ctx.userConfig()`). Not gated by a `reads` grant: a
   *  plugin reading its OWN per-account slice for the account already acting is the same authority as its
   *  instance-wide `ctx.config`. The identity is resolved by the context, never passed in by the plugin. */
  userPluginConfig?: (userId: number, plugin: string) => Record<string, unknown>;
}

export class PluginRegistry {
  readonly tools: ToolDefinition[] = [];
  /** Which plugin registered each tool (tool name → plugin name) — feeds per-role tool filtering. */
  readonly toolOwner = new Map<string, string>();
  readonly skills: PluginSkill[] = [];
  readonly promptFragments: string[] = [];
  readonly hooks: PluginHook[] = [];
  readonly turnContexts: TurnContextContribution[] = [];
  readonly platforms: PlatformAdapter[] = [];
  /** Inbound webhook mounts, keyed `<plugin>/<path>` — dispatched by the daemon's `/hooks` router. The
   *  key embeds the owning plugin's name, so two plugins can never contest one mount by construction. */
  readonly httpRoutes = new Map<string, { plugin: string; handler: PluginHttpRoute['handler'] }>();
  /** Authenticated API mounts, keyed `<plugin>/<path>` — dispatched by the daemon's `/plugins/:name/api`
   *  router. A key holds every method variant registered on that path (exact method beats method-less). */
  readonly apiRoutes = new Map<string, { plugin: string; routes: { method?: string; access: PluginApiAccess; handler: PluginApiRoute['handler'] }[] }>();
  /** ROOT-mounted authenticated plugin routes, keyed by the full absolute mount (e.g. '/missions',
   *  '/missions/overseer'). Served by the daemon's root fallback dispatcher with the same auth/access
   *  mechanics as `apiRoutes`; a mount that collides with a core route is skipped there (core wins). */
  readonly rootApiRoutes = new Map<string, { plugin: string; routes: { method?: string; access: PluginApiAccess; handler: PluginApiRoute['handler'] }[] }>();
  /** Host-managed background services (started after boot reconcile, cycled around plugin reloads) and
   *  boot reconciles (run sequentially BEFORE platforms serve turns). Both carry their owner for logs. */
  readonly services: { plugin: string; service: PluginService }[] = [];
  readonly bootReconciles: { plugin: string; fn: () => void | Promise<void> }[] = [];
  /** Per-user teardown handlers (see PluginContext.registerUserRemoved). A plugin that keeps per-user
   *  state OUTSIDE the core database — a data-dir folder, a JSON store — has no other way to hear that an
   *  account is gone, and nothing else reaps it: the leftovers keep that person's files and schedules on
   *  disk indefinitely. Run by the delete route before the user row disappears. */
  readonly userRemovedHandlers: { plugin: string; fn: (userId: number) => void | Promise<void> }[] = [];
  /** Plugin-contributed editable prompt templates: catalog entries (merged into the account UI catalog)
   *  and template sources keyed by BARE template name — bare so existing per-user overrides in
   *  `user_prompts` keep matching when a template migrates from core into a plugin. */
  readonly promptEntries: { plugin: string; entry: PluginPromptEntry }[] = [];
  readonly promptSources = new Map<string, { plugin: string; file: string }>();
  /** Plugin-contributed event→project resolvers (tenancy for core-shaped events whose data moved into a
   *  plugin). Consulted by eventProjectId after the core lookups; first non-null wins. */
  readonly eventProjectResolvers: { plugin: string; fn: (e: ElowenEvent) => number | null }[] = [];
  /** Activity-log persistence resolvers (see PluginContext.registerEventRowResolver). */
  readonly eventRowResolvers: { plugin: string; fn: (e: ElowenEvent) => EventPersistenceRow | null | undefined }[] = [];
  /** First-run readiness rows (see PluginContext.registerReadinessCheck). */
  readonly readinessChecks: { plugin: string; fn: () => PluginReadinessCheck | null | Promise<PluginReadinessCheck | null> }[] = [];
  /** Tools contributed to the daemon's OWN /mcp server (see PluginContext.registerMcpTool). The /mcp
   *  handler composes core + these per request, so this list needs no cache invalidation on reload. */
  readonly mcpTools: { plugin: string; tool: PluginMcpTool }[] = [];
  /** Live bus subscriptions this registry's plugins hold (ctx.subscribeEvents). Owned by the registry
   *  so a reload can detach the WHOLE old generation — a stale closure must never double-handle events
   *  beside its replacement. */
  readonly busSubscriptions: { plugin: string; off: () => void }[] = [];
  /** Browser UI bundles (manifest-declared, loader-resolved): absolute bundle path + content hash (pins
   *  the immutable serving URL) + the manifest's nav/settings menu metadata. */
  readonly webUi = new Map<string, PluginWebUi>();
  readonly controls = new Map<string, PluginControl>();
  /** For a control BUILT ON another one, the key of that dependency (`registerControl(…, {requires})`).
   *  Resolution consults it live, so a control whose domain has no owner is unreachable rather than
   *  half-working. Travels with its control through `merge`. */
  readonly controlRequires = new Map<string, string>();
  /** Plugin-contributed chat slash commands (prompt macros), keyed by command name (unique). */
  readonly commands = new Map<string, PluginCommand>();
  readonly commandOwner = new Map<string, string>();
  // Per-contribution ownership for the flat lists above — index-aligned with their sibling array, so
  // `skills[i]` was registered by `skillOwners[i]`. Tools use the `toolOwner` Map instead (tool names
  // are unique and drive per-role filtering); these lists allow duplicates (two plugins can register the
  // same hook name), so a Map would lose entries. Feeds the runtime plugin-contribution report.
  readonly skillOwners: string[] = [];
  /** For each entry of `skills`, the Elowen ACCOUNT it belongs to, or null for an instance-wide skill
   *  every session sees. Index-aligned with `skills` exactly as `skillOwners` is. A per-user skill is
   *  loaded into this one shared registry like any other and filtered at SPAWN, because the registry is a
   *  single memoized object for the whole daemon — there is no per-user generation of it to load into. */
  readonly skillOwnerUsers: (number | null)[] = [];
  readonly promptFragmentOwners: string[] = [];
  readonly hookOwners: string[] = [];
  readonly turnContextOwners: string[] = [];
  readonly platformOwners: string[] = [];
  readonly controlOwner = new Map<string, string>();
  /** Each plugin's declared capabilities (manifest `capabilities`, `{}` when absent), keyed by plugin
   *  name. The hook bus looks these up by owner to gate a hook's mutation patch (deny-by-default). The
   *  loader records this after a clean register+merge; the manifest is otherwise discarded. */
  readonly pluginCapabilities = new Map<string, PluginCapabilities>();
  /** Plugins whose manifest opted into PER-USER grants (`userGrantable`). Everything that gates a
   *  plugin per user — the API dispatcher, the UI listing, the brain's tool policy — asks here rather
   *  than re-reading manifests from disk, so the answer is the one this registry generation loaded. */
  readonly userGrantable = new Set<string>();
  /** Per-tool display icons declared across all plugin manifests (`icons`), keyed by tool name. Merged
   *  with the core defaults by `makeToolIconResolver` when the daemon stamps a `tool` event's icon. */
  readonly toolIcons = new Map<string, string>();
  /** Output-show patterns declared across all plugin manifests (`showOutput`) — exact tool names or
   *  `prefix*`. Merged with the core defaults (`BUILTIN_TOOL_OUTPUT_SHOWN`) into the one output policy
   *  the shared `messageView` renderer consults (`makeToolOutputPolicy`). Output is hidden by default;
   *  only these tools' output surfaces. */
  readonly toolShowOutput = new Set<string>();
  /** Tool names declared plan-safe across all plugin manifests (`planSafe`). Merged with the core's own
   *  (`BUILTIN_TOOL_PLAN_SAFE`) into the set plan mode composes from. Exact names only — see the manifest
   *  field's doc for why a `prefix*` would be unsafe here. */
  readonly toolPlanSafe = new Set<string>();
  /** Tool names whose owning plugin declares them deferred into ToolSearch by default. Unlike output
   *  policy patterns, this stores only exact registered names after owner-scoped expansion. */
  readonly toolDeferLoading = new Set<string>();

  /** Absorb another registry's contributions (the loader stages each plugin and merges on success).
   *  Tools, controls + commands are name-keyed and drive tool dispatch / admin routes / the slash menu, so
   *  a later plugin must not silently hijack a name a prior plugin owns. This join is the ONLY place two
   *  plugins' registries meet (each registers into its own staging registry), so cross-plugin collisions
   *  are enforced HERE — first-writer-wins, with `warn` surfacing the drop. */
  merge(other: PluginRegistry, warn?: (msg: string) => void): void {
    for (const t of other.tools) {
      const owner = other.toolOwner.get(t.name) ?? '?';
      const prior = this.toolOwner.get(t.name);
      // A dropped tool must not be pushed either: `toolOwner` drives per-role filtering AND the
      // contribution report, so keeping the definition would attribute it to the wrong plugin.
      if (prior && prior !== owner) { warn?.(`tool "${t.name}" from "${owner}" ignored — already registered by "${prior}"`); continue; }
      this.tools.push(t); this.toolOwner.set(t.name, owner);
    }
    this.skills.push(...other.skills);
    this.promptFragments.push(...other.promptFragments);
    this.hooks.push(...other.hooks);
    this.turnContexts.push(...other.turnContexts);
    this.platforms.push(...other.platforms);
    for (const [k, v] of other.controls) {
      const prior = this.controlOwner.get(k);
      const owner = other.controlOwner.get(k) ?? '?';
      if (prior && prior !== owner) { warn?.(`control "${k}" from "${owner}" ignored — already registered by "${prior}"`); continue; }
      this.controls.set(k, v); this.controlOwner.set(k, owner);
      // The dependency travels WITH the control: dropping it here would leave the merged registry
      // resolving a control whose domain may be absent — the exact half-working state it prevents.
      const requires = other.controlRequires.get(k);
      if (requires) this.controlRequires.set(k, requires);
    }
    for (const [k, v] of other.commands) {
      const prior = this.commandOwner.get(k);
      const owner = other.commandOwner.get(k) ?? '?';
      if (prior && prior !== owner) { warn?.(`command "/${k}" from "${owner}" ignored — already registered by "${prior}"`); continue; }
      this.commands.set(k, v); this.commandOwner.set(k, owner);
    }
    for (const [k, v] of other.httpRoutes) {
      const prior = this.httpRoutes.get(k);
      if (prior && prior.plugin !== v.plugin) { warn?.(`http route "/hooks/${k}" from "${v.plugin}" ignored — already registered by "${prior.plugin}"`); continue; }
      this.httpRoutes.set(k, v);
    }
    // Keys embed the plugin name, so cross-plugin collisions cannot happen by construction — copy as-is.
    for (const [k, v] of other.apiRoutes) this.apiRoutes.set(k, v);
    // Root mounts are a GLOBAL namespace: first registrant wins, a colliding sibling is skipped loudly.
    for (const [k, v] of other.rootApiRoutes) {
      const prior = this.rootApiRoutes.get(k);
      if (prior && prior.plugin !== v.plugin) { warn?.(`root api mount "${k}" from "${v.plugin}" ignored — already registered by "${prior.plugin}"`); continue; }
      this.rootApiRoutes.set(k, v);
    }
    this.services.push(...other.services);
    this.bootReconciles.push(...other.bootReconciles);
    this.userRemovedHandlers.push(...other.userRemovedHandlers);
    this.eventProjectResolvers.push(...other.eventProjectResolvers);
    this.eventRowResolvers.push(...other.eventRowResolvers);
    this.readinessChecks.push(...other.readinessChecks);
    // MCP tool names are a flat namespace on the daemon's /mcp server — first-writer-wins, like tools.
    for (const m of other.mcpTools) {
      const prior = this.mcpTools.find((x) => x.tool.name === m.tool.name);
      if (prior && prior.plugin !== m.plugin) { warn?.(`mcp tool "${m.tool.name}" from "${m.plugin}" ignored — already registered by "${prior.plugin}"`); continue; }
      this.mcpTools.push(m);
    }
    this.busSubscriptions.push(...other.busSubscriptions);
    for (const [k, v] of other.webUi) this.webUi.set(k, v);
    for (const p of other.promptEntries) {
      const prior = this.promptSources.get(p.entry.name);
      if (prior && prior.plugin !== p.plugin) { warn?.(`prompt "${p.entry.name}" from "${p.plugin}" ignored — already registered by "${prior.plugin}"`); continue; }
      this.promptEntries.push(p);
      const src = other.promptSources.get(p.entry.name);
      if (src) this.promptSources.set(p.entry.name, src);
    }
    this.skillOwners.push(...other.skillOwners);
    this.skillOwnerUsers.push(...other.skillOwnerUsers);
    this.promptFragmentOwners.push(...other.promptFragmentOwners);
    this.hookOwners.push(...other.hookOwners);
    this.turnContextOwners.push(...other.turnContextOwners);
    this.platformOwners.push(...other.platformOwners);
    for (const [k, v] of other.pluginCapabilities) this.pluginCapabilities.set(k, v);
    for (const n of other.userGrantable) this.userGrantable.add(n);
  }

  /** Detach every live bus subscription this registry's plugins hold — called on the OLD registry
   *  during a plugin reload, before the new generation subscribes. Idempotent. */
  disposeEventSubscriptions(): void {
    for (const s of this.busSubscriptions.splice(0)) {
      try { s.off(); } catch { /* the bus already dropped it */ }
    }
  }

  /** Resolve the handler for a `/hooks/…` request path (everything after `/hooks/`): exact mount first,
   *  then the longest declared prefix on a `/` boundary — the remainder reaches the handler as
   *  `PluginHttpRequest.path`. Undefined when nothing matches (the router 404s). */
  httpRoute(pathAfterHooks: string): { handler: PluginHttpRoute['handler']; remainder: string } | undefined {
    const clean = pathAfterHooks.replace(/^\/+|\/+$/g, '');
    const exact = this.httpRoutes.get(clean);
    if (exact) return { handler: exact.handler, remainder: '' };
    let at = clean.lastIndexOf('/');
    while (at > 0) {
      const hit = this.httpRoutes.get(clean.slice(0, at));
      if (hit) return { handler: hit.handler, remainder: clean.slice(at + 1) };
      at = clean.lastIndexOf('/', at - 1);
    }
    return undefined;
  }

  /** Resolve the handler for an authenticated `/plugins/<plugin>/api/<path>` request: exact mount first,
   *  then the longest declared prefix on a `/` boundary (the remainder reaches the handler). Within one
   *  mount an exact-method route beats a method-less one; no method match = undefined (the router 404s,
   *  which for a declared path with the wrong verb is indistinguishable from an unknown path — fine,
   *  nothing here is a discovery surface). */
  apiRoute(plugin: string, pathAfterApi: string, method: string): { handler: PluginApiRoute['handler']; access: PluginApiAccess; remainder: string } | undefined {
    const clean = pathAfterApi.replace(/^\/+|\/+$/g, '');
    const pick = (key: string, remainder: string) => {
      const entry = this.apiRoutes.get(`${plugin}/${key}`);
      if (!entry) return undefined;
      const route = entry.routes.find((r) => r.method === method) ?? entry.routes.find((r) => r.method === undefined);
      return route ? { handler: route.handler, access: route.access, remainder } : undefined;
    };
    const exact = pick(clean, '');
    if (exact) return exact;
    let at = clean.lastIndexOf('/');
    while (at > 0) {
      const hit = pick(clean.slice(0, at), clean.slice(at + 1));
      if (hit) return hit;
      at = clean.lastIndexOf('/', at - 1);
    }
    return undefined;
  }

  /** Resolve a ROOT-mounted plugin route for an absolute request path — the mount matching the MOST
   *  leading segments wins (literal mounts and ':param' pattern mounts compete on the same scale), and
   *  exact method beats method-less (same rules as {@link apiRoute}). Returns the owning mount too, so
   *  the dispatcher can apply its core-conflict skip set per mount. */
  rootApiRoute(path: string, method: string): { mount: string; plugin: string; handler: PluginApiRoute['handler']; access: PluginApiAccess; remainder: string; params: Record<string, string> } | undefined {
    const clean = '/' + path.replace(/^\/+|\/+$/g, '');
    const pick = (mount: string, remainder: string) => {
      const entry = this.rootApiRoutes.get(mount);
      if (!entry) return undefined;
      const route = entry.routes.find((r) => r.method === method) ?? entry.routes.find((r) => r.method === undefined);
      return route ? { mount, plugin: entry.plugin, handler: route.handler, access: route.access, remainder } : undefined;
    };
    const parts = clean.slice(1).split('/');
    // Every mount that could serve this path, ranked. Depth first: a mount naming more of the path is
    // the more specific owner, whether it names those segments literally or with ':param'. Ranking the
    // two KINDS separately (all literals, then all patterns) would let a one-segment literal mount
    // swallow a three-segment pattern of another plugin — the shape two plugins take when they share a
    // prefix (work's '/tasks' beside agents' '/tasks/:id/ask'). Literal beats pattern only at EQUAL
    // depth, where the literal genuinely describes the path more precisely.
    const candidates: { mount: string; remainder: string; params: Record<string, string>; literals: number; depth: number }[] = [];
    for (let depth = parts.length; depth >= 1; depth--) {
      const mount = '/' + parts.slice(0, depth).join('/');
      if (!this.rootApiRoutes.has(mount)) continue;
      candidates.push({ mount, remainder: parts.slice(depth).join('/'), params: {}, literals: depth, depth });
    }
    for (const mount of this.rootApiRoutes.keys()) {
      if (!mount.includes('/:')) continue;
      const msegs = mount.slice(1).split('/');
      if (msegs.length > parts.length) continue;
      const params: Record<string, string> = {};
      let literals = 0;
      let ok = true;
      for (let i = 0; i < msegs.length; i++) {
        const seg = msegs[i]!;
        if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(parts[i]!);
        else if (seg === parts[i]) literals++;
        else { ok = false; break; }
      }
      if (!ok) continue;
      candidates.push({ mount, remainder: parts.slice(msegs.length).join('/'), params, literals, depth: msegs.length });
    }
    // Deepest first; on a tie the mount whose segments are literal wins. A candidate whose mount has no
    // route for THIS method is skipped, so a shallower mount still serves the methods it declared.
    candidates.sort((a, b) => b.depth - a.depth || b.literals - a.literals);
    for (const candidate of candidates) {
      const hit = pick(candidate.mount, candidate.remainder);
      if (hit) return { ...hit, params: candidate.params };
    }
    return undefined;
  }

  /** Record a plugin's declared capabilities (from its parsed manifest). Called by the loader after a
   *  clean register+merge so the hook bus can gate that plugin's mutations. */
  setCapabilities(name: string, caps: PluginCapabilities): void {
    this.pluginCapabilities.set(name, caps);
  }

  /** The skills ONE session may see: every instance-wide skill, plus those owned by `userId`. Pass null
   *  for a session that serves nobody in particular (a shared channel, a task worker) — it then sees only
   *  the instance-wide set. The identical array is returned when no per-user skill exists at all, so an
   *  instance that never uses them renders a byte-identical system prompt. */
  skillsFor(userId: number | null | undefined): PluginSkill[] {
    if (!this.skillOwnerUsers.some((o) => o !== null)) return this.skills;
    return this.skills.filter((_, i) => {
      const owner = this.skillOwnerUsers[i] ?? null;
      return owner === null || (userId != null && owner === userId);
    });
  }

  /** Record whether a plugin opted into per-user grants (manifest `userGrantable`). Called by the
   *  loader alongside the other manifest facts, so the gate reads the generation that actually loaded. */
  setUserGrantable(name: string, on: boolean | undefined): void {
    if (on) this.userGrantable.add(name);
  }

  /** Record a plugin's manifest tool icons (from its parsed manifest `icons`). Called by the loader
   *  after a clean register+merge. First writer wins on a name clash (bundled dirs load first). */
  setIcons(icons?: Record<string, string>): void {
    for (const [tool, icon] of Object.entries(icons ?? {})) {
      if (typeof icon === 'string' && icon.trim() && !this.toolIcons.has(tool)) this.toolIcons.set(tool, icon);
    }
  }

  /** Record a plugin's manifest output-show patterns (from `showOutput`). Called by the loader after a
   *  clean register+merge, mirroring `setIcons`. Patterns are a set, so re-declaring one is idempotent. */
  setShowOutput(patterns?: string[]): void {
    for (const p of patterns ?? []) {
      if (typeof p === 'string' && p.trim()) this.toolShowOutput.add(p.trim());
    }
  }

  /** Record a plugin's manifest plan-safe tool names (from `planSafe`). Called by the loader after a
   *  clean register+merge, mirroring `setShowOutput`. A name is dropped unless the plugin also declared
   *  it in `provides.tools`: the same reason registerTool is gated there — a manifest must not be able to
   *  vouch for a tool it does not own, least of all to widen what plan mode composes. */
  setPlanSafe(names: string[] | undefined, provides: PluginManifest['provides'], warn?: (msg: string) => void): void {
    for (const n of names ?? []) {
      if (typeof n !== 'string' || !n.trim()) continue;
      const name = n.trim();
      if (provides?.tools && !provides.tools.includes(name)) {
        warn?.(`planSafe '${name}' ignored: not declared in provides.tools`);
        continue;
      }
      this.toolPlanSafe.add(name);
    }
  }

  /** Expand one plugin manifest's deferred-tool defaults against the merged registry. A pattern may match
   *  only tools owned by `owner`, so it cannot defer a sibling's tool; the result stores exact names only. */
  setDeferLoading(owner: string, patterns: string[] | undefined, warn?: (msg: string) => void): void {
    for (const raw of patterns ?? []) {
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const pattern = raw.trim();
      const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : undefined;
      const matches = [...this.toolOwner.entries()]
        .filter(([name, toolOwner]) => toolOwner === owner && (prefix === undefined ? name === pattern : name.startsWith(prefix)))
        .map(([name]) => name);
      if (matches.length === 0) {
        warn?.(`deferLoading '${pattern}' ignored: no matching tools registered by '${owner}'`);
        continue;
      }
      for (const name of matches) this.toolDeferLoading.add(name);
    }
  }

  /** Whether a registered control is present AND carries every method its key promises. Deliberately
   *  ignores `controlRequires` (one level, no recursion): it answers "does this domain have a real
   *  owner", which is what a dependency check needs and what makes a dependency cycle impossible. */
  private controlResolves(name: string): boolean {
    const raw: unknown = this.controls.get(name);
    if (!raw) return false;
    const methods: readonly string[] | undefined = KNOWN_CONTROL_METHODS[name as keyof KnownControls];
    if (!methods) return true; // a control core does not call by key — presence is all there is to check
    const blob = raw as Record<string, unknown>;
    return !methods.some((method) => typeof blob[method] !== 'function');
  }

  /** Resolve a KNOWN plugin control already narrowed to its typed contract, or undefined when no plugin
   *  registered it (or it lacks the expected method). The one place an opaque `PluginControl` is narrowed
   *  for core callers, so no call site needs an `as unknown as` cast.
   *
   *  A control that declared `requires` also stops resolving while that domain has no owner. The point is
   *  that a dependent subsystem then looks EXACTLY like a disabled one to every caller, instead of
   *  handing out accessors that throw halfway through a request — callers already degrade honestly for
   *  the disabled case, and there is no second failure mode to teach them. */
  control<K extends keyof KnownControls>(name: K): KnownControls[K] | undefined {
    if (!this.controlResolves(name)) return undefined;
    const requires = this.controlRequires.get(name);
    if (requires !== undefined && !this.controlResolves(requires)) return undefined;
    return this.controls.get(name) as unknown as KnownControls[K];
  }

  /** Build the context passed to one plugin's `register()`. `config` is that plugin's own slice;
   *  `dataRoot` hosts per-plugin writable dirs (tests fall back to the OS tmpdir). */
  contextFor(name: string, config: Record<string, unknown>, logger: PluginLogger, dataRoot?: string, notify?: (text: string, channelId?: string) => Promise<void>, listModels?: () => Promise<PluginModelOption[]>, resolveProvider?: (id: string) => ProviderCredentials | null, caps?: PluginCapabilities, provides?: PluginManifest['provides'], answerQuestion?: (id: string, answers: AskAnswer[]) => boolean, embedder?: PluginEmbedder, embeddingConfig?: () => EmbeddingConfig, allToolNames?: () => string[], timezone?: () => string, subagentTypes?: () => { name: string; description: string }[], requestReload?: () => void, allChatCommands?: () => PluginSlashCommand[], delegateContextChars?: () => number, delegatedChildren?: DelegatedChildBridge, mcpBridgeSnapshot?: McpBridgeSnapshot, delegatedTurnsOutOfProcess?: () => boolean, delegatedWorkflowExpansionAvailable?: () => boolean, workflowExpansionRpc?: WorkflowExpansionRpc, pluginDb?: (plugin: string) => PluginDb, publishEvent?: (e: ElowenEvent) => void, host?: PluginHostWiring, subscribeEvents?: (fn: (e: ElowenEvent) => void) => () => void, resolveControl?: <K extends keyof KnownControls>(name: K) => KnownControls[K] | undefined, deleteEvents?: (target: string) => void): PluginContext {
    const scoped: PluginLogger = {
      info: (m) => logger.info(`[plugin:${name}] ${m}`),
      warn: (m) => logger.warn(`[plugin:${name}] ${m}`),
      error: (m) => logger.error(`[plugin:${name}] ${m}`),
    };
    // Runtime capability enforcement (deny-by-default, non-fatal — mirrors the hook bus: a refused
    // contribution is dropped + warned, the plugin still loads). `caps`/`provides` come from the
    // manifest via the loader; when omitted (direct contextFor unit tests) enforcement stays inert.
    const capabilities = caps ?? {};
    // Provider ids the operator wired into this plugin's own config — the allowlist for resolveProvider.
    const configProviderIds = new Set<string>();
    collectStringValues(config, configProviderIds);
    const baseResolveProvider = resolveProvider ?? (() => null);
    // Deny-by-default embeddings gate: the shared embedder is reachable only when the plugin declared
    // `reads:['embeddings']`. An existing plugin without it sees isConfigured()===false and rejecting
    // embed*(), so this adds zero capability to already-installed plugins.
    const embeddingsAllowed = capabilities.reads?.includes('embeddings') ?? false;
    // The LIVE, usable embedding config (Settings → Memory), or null when embeddings are disabled or the
    // capability is absent. Read on EVERY call so a model change applies without a reload.
    const liveEmbeddingConfig = (): EmbeddingConfig | null => {
      if (!embeddingsAllowed) return null;
      const cfg = embeddingConfig?.();
      return cfg && isEmbeddingConfigured(cfg) ? cfg : null;
    };
    const embeddings: PluginEmbeddings = {
      isConfigured: () => liveEmbeddingConfig() !== null,
      descriptor: () => {
        const cfg = liveEmbeddingConfig();
        if (!cfg) return null;
        return { provider: cfg.providerId ?? cfg.baseUrl ?? '', model: cfg.model, dimensions: cfg.dimensions ?? null };
      },
      embed: async (text) => {
        if (!embeddingsAllowed) throw new Error("embeddings read capability not declared (add reads:['embeddings'] to the plugin manifest)");
        const cfg = liveEmbeddingConfig();
        if (!cfg) throw new Error('embeddings not configured (set the embedding model in Settings → Memory)');
        if (!embedder) throw new Error('embeddings service not available');
        return embedder.embed(cfg, text);
      },
      embedBatch: async (texts) => {
        if (!embeddingsAllowed) throw new Error("embeddings read capability not declared (add reads:['embeddings'] to the plugin manifest)");
        const cfg = liveEmbeddingConfig();
        if (!cfg) throw new Error('embeddings not configured (set the embedding model in Settings → Memory)');
        if (!embedder) throw new Error('embeddings service not available');
        return embedder.embedBatch(cfg, texts);
      },
    };
    return {
      // Enforce the manifest's declared tool surface: when a plugin declares `provides.tools`, it may
      // register ONLY those names (an undeclared tool is refused). A manifest that omits the list stays
      // unconstrained — older manifests predate this, and plugins are owner-installed (defense-in-depth,
      // not a fortress): the value is that an honest manifest can't be silently out-registered.
      registerTool: (t) => {
        if (provides?.tools && !toolDeclared(t.name, provides.tools)) {
          scoped.warn(`registerTool('${t.name}') refused: not declared in manifest provides.tools`);
          return;
        }
        this.tools.push(t); this.toolOwner.set(t.name, name);
      },
      registerSkill: (s, opts) => {
        this.skills.push(s);
        this.skillOwners.push(name);
        this.skillOwnerUsers.push(opts?.ownerUserId ?? null);
      },
      registerControl: (key, control, opts) => {
        const clean = key.trim();
        if (!clean) { scoped.warn('registerControl refused: empty name'); return; }
        // Cross-plugin collisions (a second plugin hijacking a control name like 'mcp') are caught at
        // merge() time — this staging registry only ever holds THIS plugin, so within it last-writer-wins
        // is just the plugin overriding its own control.
        this.controls.set(clean, control);
        this.controlOwner.set(clean, name);
        // A control built on a sibling's domain: recorded here, enforced at resolution (see control()),
        // never at registration — the domain's owner may well load after this plugin does.
        const requires = opts?.requires?.trim();
        if (requires) this.controlRequires.set(clean, requires);
        else this.controlRequires.delete(clean);
      },
      // Cross-plugin capability resolution (see PluginContext.control). Deny-by-default behind
      // `reads:['controls']`, and WARN-and-undefined rather than throw when refused — same shape as
      // resolveProvider, because the caller already has to handle the "owner is disabled" undefined and
      // a throw would only turn a mis-declared manifest into a crash on an unrelated code path.
      // `resolveControl` closes over the MERGED registry (wired by the loader, like allToolNames), never
      // over this staging one: the owner may register long after this plugin did.
      control<K extends keyof KnownControls>(key: K): KnownControls[K] | undefined {
        if (!capabilities.reads?.includes('controls')) {
          scoped.warn(`control('${key}') denied: no 'controls' read capability declared`);
          return undefined;
        }
        return resolveControl?.(key);
      },
      registerCommand: (command) => {
        const clean = command.name?.trim() ?? '';
        // 1–32 chars, kebab-case. (The collision with another plugin's command is enforced at merge().)
        if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(clean)) { scoped.warn(`registerCommand refused: "${command.name}" is not kebab-case (a-z, 0-9, dashes)`); return; }
        if (isReservedCommandName(clean)) { scoped.warn(`registerCommand refused: "${clean}" shadows a built-in or reserved command`); return; }
        if (typeof command.prompt !== 'string' || !command.prompt.trim()) { scoped.warn(`registerCommand refused: "${clean}" has an empty prompt`); return; }
        this.commands.set(clean, { name: clean, description: command.description ?? '', prompt: command.prompt, surfaces: command.surfaces });
        this.commandOwner.set(clean, name);
      },
      // The SINGLE source for a chat surface's command menu: built-ins (surface-scoped, admin included so
      // an operator-run adapter sees /restart) PLUS every plugin-contributed prompt command, each carrying
      // its `kind` so the adapter can tell a native/control command from a plugin prompt macro. Reads the
      // MERGED registry lazily (allChatCommands closes over it, like allToolNames) so a plugin registered
      // later — or a reload — is reflected without a stale snapshot.
      chatCommands: (surface) => commandsWithPlugins(surface, true, allChatCommands?.() ?? []).map(
        ({ name: commandName, description, kind, adminOnly }) => ({ name: commandName, description, kind, ...(adminOnly ? { adminOnly } : {}) }),
      ),
      registerSystemPromptFragment: (f) => { this.promptFragments.push(f); this.promptFragmentOwners.push(name); },
      registerHook: (h) => { this.hooks.push(h); this.hookOwners.push(name); },
      registerTurnContext: (render, options) => {
        const placement = options?.placement === 'after-user' ? 'after-user' : 'before-user';
        this.turnContexts.push({ render, placement });
        this.turnContextOwners.push(name);
      },
      // Same allowlist rule as tools, against `provides.platforms` (Discord/cron/subagent are here).
      registerPlatform: (p) => {
        if (provides?.platforms && !provides.platforms.includes(p.name)) {
          scoped.warn(`registerPlatform('${p.name}') refused: not declared in manifest provides.platforms`);
          return;
        }
        this.platforms.push(p); this.platformOwners.push(name);
      },
      // Stricter than platforms — STRICT deny-by-default: a webhook mount is a public HTTP surface, so it
      // must be explicitly declared in `provides.httpRoutes` (no unconstrained legacy fallback).
      registerHttpRoute: (route) => {
        const clean = route.path?.trim().replace(/^\/+|\/+$/g, '') ?? '';
        if (!/^[a-z0-9][a-z0-9\-/]*$/.test(clean) || clean.split('/').some((seg) => !seg)) {
          scoped.warn(`registerHttpRoute('${route.path}') refused: path must be lowercase slash-separated segments`);
          return;
        }
        if (!provides?.httpRoutes?.includes(clean)) {
          scoped.warn(`registerHttpRoute('${clean}') refused: not declared in manifest provides.httpRoutes`);
          return;
        }
        this.httpRoutes.set(`${name}/${clean}`, { plugin: name, handler: route.handler });
      },
      // Same STRICT deny-by-default as webhooks: an authenticated route is still new HTTP surface, so it
      // must be declared in `provides.apiRoutes`. The access level is validated here so a typo cannot
      // silently register a route the dispatcher would then treat as its default.
      registerApiRoute: (route) => {
        const clean = route.path?.trim().replace(/^\/+|\/+$/g, '') ?? '';
        // A bare mount ('' path) is meaningful only WITH rootMount — the namespaced surface always has
        // a path segment after /api/.
        if ((clean !== '' || route.rootMount === undefined) && (!/^[a-z0-9][a-z0-9\-/]*$/.test(clean) || clean.split('/').some((seg) => !seg))) {
          scoped.warn(`registerApiRoute('${route.path}') refused: path must be lowercase slash-separated segments`);
          return;
        }
        if (route.access !== 'admin' && route.access !== 'user' && route.access !== 'agent') {
          scoped.warn(`registerApiRoute('${clean}') refused: access must be admin, user or agent`);
          return;
        }
        if (route.rootMount !== undefined) {
          // Root mount: absolute lowercase path, and the FULL mount must be declared (with the leading
          // slash) in provides.apiRoutes — the manifest stays the single audit surface for what a
          // plugin serves. Trust: plugins are admin-installed by definition (bundled or marketplace),
          // so the root namespace is not a wider grant than the namespaced one — just a wider PATH.
          const mount = route.rootMount.trim().replace(/\/+$/g, '');
          // Segments are lowercase literals or ':param' placeholders (e.g. '/tasks/:id/ask') — a
          // pattern mount lets a plugin grandfather a core path family with an id in the middle.
          const segsOk = mount.startsWith('/') && mount.slice(1).split('/').every((seg) =>
            /^[a-z0-9][a-z0-9\-]*$/.test(seg) || /^:[a-zA-Z][a-zA-Z0-9]*$/.test(seg));
          if (!segsOk) {
            scoped.warn(`registerApiRoute rootMount '${route.rootMount}' refused: must be an absolute lowercase path (segments may be ':param')`);
            return;
          }
          const full = clean ? `${mount}/${clean}` : mount;
          if (!provides?.apiRoutes?.includes(full)) {
            scoped.warn(`registerApiRoute('${full}') refused: root mount not declared in manifest provides.apiRoutes`);
            return;
          }
          const entry = this.rootApiRoutes.get(full) ?? { plugin: name, routes: [] };
          entry.routes.push({ ...(route.method ? { method: route.method.toUpperCase() } : {}), access: route.access, handler: route.handler });
          this.rootApiRoutes.set(full, entry);
          return;
        }
        if (!provides?.apiRoutes?.includes(clean)) {
          scoped.warn(`registerApiRoute('${clean}') refused: not declared in manifest provides.apiRoutes`);
          return;
        }
        const key = `${name}/${clean}`;
        const entry = this.apiRoutes.get(key) ?? { plugin: name, routes: [] };
        entry.routes.push({ ...(route.method ? { method: route.method.toUpperCase() } : {}), access: route.access, handler: route.handler });
        this.apiRoutes.set(key, entry);
      },
      registerService: (service) => {
        if (!service?.name?.trim() || typeof service.start !== 'function' || typeof service.stop !== 'function') {
          scoped.warn('registerService refused: a service needs a name and start/stop functions');
          return;
        }
        this.services.push({ plugin: name, service });
      },
      registerBootReconcile: (fn) => { this.bootReconciles.push({ plugin: name, fn }); },
      registerUserRemoved: (fn) => { this.userRemovedHandlers.push({ plugin: name, fn }); },
      // Event-bus reach decides what tenants SEE, so both verbs ride one explicit mutates:['events']
      // grant. Publishing throws (like db()): a plugin built around events cannot degrade meaningfully.
      publishEvent: (event) => {
        if (!capabilities.mutates?.includes('events')) throw new Error(`plugin "${name}" did not declare the mutates:['events'] capability`);
        if (!publishEvent) throw new Error('no event bus wired for plugins in this process');
        // Stamp the publisher on a plugin-shaped event — a plugin never publishes as another plugin.
        publishEvent(event.type === 'plugin' ? { ...event, plugin: name } : event);
      },
      // The feed's delete verb. Same grant as publishing (both decide what a tenant sees), but absence
      // degrades instead of throwing: the rows are a log, and a process without one simply has nothing
      // to purge — unlike publishing, where silence would lose the event itself.
      deleteEventsForTarget: (target) => {
        if (!capabilities.mutates?.includes('events')) throw new Error(`plugin "${name}" did not declare the mutates:['events'] capability`);
        deleteEvents?.(target);
      },
      registerEventProjectResolver: (fn) => {
        if (!capabilities.mutates?.includes('events')) { scoped.warn(`registerEventProjectResolver refused: missing mutates:['events'] capability`); return; }
        this.eventProjectResolvers.push({ plugin: name, fn });
      },
      registerEventRowResolver: (fn) => {
        if (!capabilities.mutates?.includes('events')) { scoped.warn(`registerEventRowResolver refused: missing mutates:['events'] capability`); return; }
        this.eventRowResolvers.push({ plugin: name, fn });
      },
      // Display-only onboarding rows — no capability gate; the check runs with only what the plugin
      // already holds through its other (gated) seams.
      registerReadinessCheck: (fn) => { this.readinessChecks.push({ plugin: name, fn }); },
      // Daemon-MCP tools: STRICT deny-by-default against `provides.mcpTools` (the surface is new, so
      // there is no legacy manifest to tolerate). Handlers are pure REST proxies over the caller's
      // token, so no capability gate applies — the REST layer's own auth is the boundary.
      registerMcpTool: (tool) => {
        const clean = tool?.name?.trim() ?? '';
        if (!/^[a-z0-9][a-z0-9_]*$/.test(clean)) { scoped.warn(`registerMcpTool refused: "${tool?.name}" is not snake_case (a-z, 0-9, underscores)`); return; }
        if (!provides?.mcpTools?.includes(clean)) {
          scoped.warn(`registerMcpTool('${clean}') refused: not declared in manifest provides.mcpTools`);
          return;
        }
        this.mcpTools.push({ plugin: name, tool });
      },
      subscribeEvents: (fn) => {
        if (!capabilities.mutates?.includes('events')) throw new Error(`plugin "${name}" did not declare the mutates:['events'] capability`);
        if (!subscribeEvents) throw new Error('no event bus wired for plugins in this process');
        const off = subscribeEvents(fn);
        const entry = { plugin: name, off };
        this.busSubscriptions.push(entry);
        return () => {
          off();
          const at = this.busSubscriptions.indexOf(entry);
          if (at >= 0) this.busSubscriptions.splice(at, 1);
        };
      },
      // Editable prompt templates. Shadowing what the model reads is a prompt mutation, so it rides the
      // existing mutates:['prompt'] grant. Names stay BARE (`worker`, not `agents/worker`) — the
      // override key in `user_prompts` must survive a template migrating from core into a plugin.
      registerPrompts: ({ dir, entries }) => {
        if (!capabilities.mutates?.includes('prompt')) { scoped.warn(`registerPrompts refused: missing mutates:['prompt'] capability`); return; }
        for (const entry of entries) {
          const clean = entry.name?.trim() ?? '';
          if (!/^[a-z0-9][a-z0-9/_-]*$/.test(clean)) { scoped.warn(`registerPrompts refused: bad template name "${entry.name}"`); continue; }
          const file = join(dir, `${clean}.md`);
          // Fail at register time, not first render: a missing template would otherwise surface as a
          // mid-turn read error long after the toggle that broke it.
          if (!existsSync(file)) { scoped.warn(`registerPrompts refused: "${clean}" has no template file at ${file}`); continue; }
          if (this.promptSources.has(clean)) { scoped.warn(`registerPrompts refused: duplicate template "${clean}"`); continue; }
          this.promptSources.set(clean, { plugin: name, file });
          this.promptEntries.push({ plugin: name, entry: { ...entry, name: clean } });
        }
      },
      // DB reach is a real grant: deny-by-default via `reads:['db']`, and throwing (not warning) because
      // a plugin that expected a database cannot degrade meaningfully — better one clear load error.
      db: () => {
        if (!capabilities.reads?.includes('db')) throw new Error(`plugin "${name}" did not declare the reads:['db'] capability`);
        if (!pluginDb) throw new Error('no database wired for plugins in this process');
        return pluginDb(name);
      },
      // Host capabilities for core-subsystem extraction. Each accessor carries its own deny-by-default
      // reads grant and THROWS when refused or unwired — a subsystem built on these must not half-work.
      host: {
        tmux: () => {
          if (!capabilities.reads?.includes('tmux')) throw new Error(`plugin "${name}" did not declare the reads:['tmux'] capability`);
          if (!host?.tmux) throw new Error('no tmux driver wired for plugins in this process');
          return host.tmux;
        },
        brainWorker: () => {
          if (!capabilities.reads?.includes('brain-worker')) throw new Error(`plugin "${name}" did not declare the reads:['brain-worker'] capability`);
          const worker = host?.brainWorker?.();
          if (!worker) throw new Error('the brain worker is not available in this process (daemon-only, wired after boot)');
          return worker;
        },
        elowenCli: () => {
          if (!capabilities.reads?.includes('elowen-cli')) throw new Error(`plugin "${name}" did not declare the reads:['elowen-cli'] capability`);
          if (!host?.elowenCli) throw new Error('no elowen CLI wiring for plugins in this process');
          return host.elowenCli;
        },
        stores: () => {
          if (!capabilities.reads?.includes('stores')) throw new Error(`plugin "${name}" did not declare the reads:['stores'] capability`);
          if (!host?.stores) throw new Error('no store seams wired for plugins in this process');
          return host.stores;
        },
        prompts: () => {
          if (!capabilities.reads?.includes('prompts')) throw new Error(`plugin "${name}" did not declare the reads:['prompts'] capability`);
          if (!host?.prompts) throw new Error('no prompt service wired for plugins in this process');
          return host.prompts;
        },
        config: () => {
          if (!capabilities.reads?.includes('config')) throw new Error(`plugin "${name}" did not declare the reads:['config'] capability`);
          if (!host?.config) throw new Error('no workspace config wired for plugins in this process');
          return host.config;
        },
        relayClient: (cfg) => {
          if (!capabilities.reads?.includes('inference')) throw new Error(`plugin "${name}" did not declare the reads:['inference'] capability`);
          if (!host?.relayClient) throw new Error('no relay client factory wired for plugins in this process');
          return host.relayClient(cfg);
        },
        git: () => {
          if (!capabilities.reads?.includes('git')) throw new Error(`plugin "${name}" did not declare the reads:['git'] capability`);
          if (!host?.git) throw new Error('no git reader wired for plugins in this process');
          return host.git;
        },
        push: () => {
          if (!capabilities.reads?.includes('push')) throw new Error(`plugin "${name}" did not declare the reads:['push'] capability`);
          const sender = host?.push?.();
          if (!sender) throw new Error('the push transport is not available in this process (daemon-only, wired after boot)');
          return sender;
        },
        terminals: () => {
          if (!capabilities.reads?.includes('terminals')) throw new Error(`plugin "${name}" did not declare the reads:['terminals'] capability`);
          const t = host?.terminals?.();
          if (!t) throw new Error('the terminal controls are not available in this process (daemon-only, wired after boot)');
          return t;
        },
        advisor: () => {
          if (!capabilities.reads?.includes('terminals')) throw new Error(`plugin "${name}" did not declare the reads:['terminals'] capability`);
          const a = host?.advisor?.();
          if (!a) throw new Error('the advisor collaborators are not available in this process (daemon-only, wired after boot)');
          return a;
        },
        agentCatalog: () => {
          if (!capabilities.reads?.includes('agent-catalog')) throw new Error(`plugin "${name}" did not declare the reads:['agent-catalog'] capability`);
          if (!host?.agentCatalog) throw new Error('no agent catalog wired for plugins in this process');
          return host.agentCatalog;
        },
        projectFiles: () => {
          if (!capabilities.reads?.includes('project-files')) throw new Error(`plugin "${name}" did not declare the reads:['project-files'] capability`);
          if (!host?.projectFiles) throw new Error('no project file guard wired for plugins in this process');
          return host.projectFiles;
        },
      },
      // The host owns a REAL timer: fake test timers do not reach plugin module scope (a plugin loads as
      // a native module), so a plugin-held setInterval is untestable and easy to leak. Unref'd — a
      // plugin tick must never keep a draining process alive.
      registerInterval: (intervalName, fn, ms) => {
        let timer: ReturnType<typeof setInterval> | null = null;
        this.services.push({
          plugin: name,
          service: {
            name: intervalName,
            start: () => {
              timer = setInterval(() => {
                try {
                  const out = fn();
                  if (out && typeof (out as Promise<void>).catch === 'function') (out as Promise<void>).catch((e) => scoped.warn(`interval '${intervalName}' tick failed: ${e instanceof Error ? e.message : String(e)}`));
                } catch (e) { scoped.warn(`interval '${intervalName}' tick failed: ${e instanceof Error ? e.message : String(e)}`); }
              }, ms);
              timer.unref?.();
            },
            stop: () => { if (timer) { clearInterval(timer); timer = null; } },
          },
        });
      },
      assertPathAllowed,
      allowedRoots,
      defaultCwd,
      workDir: currentWorkDir,
      // Every tool name in the LIVE merged registry. The loader supplies the merged view; without it (a
      // direct contextFor in a unit test) this falls back to the plugin's own staging tools.
      toolNames: () => (allToolNames ? allToolNames() : this.tools.map((t) => t.name)),
      // The operator's configured zone; with no host wiring, the machine's own — which is exactly the
      // behaviour every wall-clock consumer had before the setting existed.
      timezone: () => timezone?.() || Intl.DateTimeFormat().resolvedOptions().timeZone,
      delegateContextChars: () => delegateContextChars?.() ?? DEFAULT_BRAIN_LIMITS.delegateContextChars,
      // Absent, not undefined, when nothing was handed down: the `mcp` plugin branches on presence, and
      // "the daemon told us it bridges nothing" (an empty array) must stay distinguishable from "nobody
      // told us anything" (a plain daemon, which connects at boot).
      ...(mcpBridgeSnapshot ? { mcpBridgeSnapshot } : {}),
      isAdminSession: isAllAccess,
      currentAccess,
      currentIdentity,
      currentSessionId,
      // The parent anchor is read from the HOST's own turn scope, never taken from the plugin: that is
      // the whole scoping boundary for all three calls. Outside a prompt turn there is no conversation to
      // scope to, so listing is empty and reading/continuing are refused rather than using "any parent".
      subagentRuns: (limit) => {
        const parentSessionId = currentSessionId();
        return parentSessionId && delegatedChildren ? delegatedChildren.runs(parentSessionId, limit) : [];
      },
      // The plugin mints the channel id as `sub-<jobId>`; the router keys the session as
      // subagentSessionId(channelId). Rebuild that here so the single source of the prefix stays in
      // sessionId.ts, never a literal in the plugin. No scope check: it is a pure id derivation, and the
      // ownership guard lives in readSubagent/continueSubagent/stopSubagent where the id is actually used.
      subagentSessionForJob: (jobId) => subagentSessionId(`sub-${jobId}`),
      readSubagent: (sessionId) => {
        const parentSessionId = currentSessionId();
        if (!parentSessionId || !delegatedChildren) {
          throw new Error('reading a sub-agent is only available inside a conversation turn');
        }
        return delegatedChildren.read(parentSessionId, sessionId);
      },
      continueSubagent: (sessionId, text, onEvent, model) => {
        const parentSessionId = currentSessionId();
        if (!parentSessionId || !delegatedChildren) {
          return Promise.reject(new Error('continuing a sub-agent is only available inside a conversation turn'));
        }
        return delegatedChildren.continue(parentSessionId, sessionId, text, currentAccess(), onEvent, model);
      },
      stopSubagent: (sessionId) => {
        const parentSessionId = currentSessionId();
        if (!parentSessionId || !delegatedChildren) {
          return Promise.reject(new Error('stopping a sub-agent is only available inside a conversation turn'));
        }
        return delegatedChildren.stop(parentSessionId, sessionId);
      },
      currentWorkDir,
      // Reads the turn-bound elicitor off the same AsyncLocalStorage as currentIdentity — no dependency
      // to thread through contextFor. Throws outside an interactive turn (worker/cron sessions wire none).
      askUser: (questions) => {
        const e = currentElicitor();
        if (!e) throw new Error('askUser is only available inside an interactive prompt turn');
        return e(questions);
      },
      answerQuestion: answerQuestion ?? (() => false),
      // Fire-and-forget display card into the current conversation (no-op outside an interactive turn —
      // e.g. cron/worker sessions wire no emitter). Reads the emitter off the same ALS as askUser.
      emitCard: (card) => { currentCardEmitter()?.(card); },
      processes: processRegistry,
      subagentEmitter: currentSubagentEmitter,
      subagentCompletionEmitter: currentSubagentCompletionEmitter,
      workflowEmitter: currentWorkflowEmitter,
      workflowCompletionEmitter: currentWorkflowCompletionEmitter,
      // False when unwired (unit tests, worker contexts): those processes run every delegation in-process.
      delegatedTurnsOutOfProcess: delegatedTurnsOutOfProcess ?? (() => false),
      // Capability and client are intentionally separate. The daemon advertises what its remote children
      // will receive; only a runner process holds the client that can call back upward.
      delegatedWorkflowExpansionAvailable: delegatedWorkflowExpansionAvailable ?? (() => false),
      // The reverse client mutates a LIVE daemon-owned DAG, so it is handed out on a DECLARED capability
      // (`mutates:['workflow-dag']`) rather than to a plugin the loader recognizes by name — the same
      // deny-by-default shape as the event sinks above. Null, never a throw: "this process has no runner
      // RPC" is already a legitimate state every caller handles (the daemon itself is one).
      workflowExpansionRpc: () => (capabilities.mutates?.includes('workflow-dag') ? workflowExpansionRpc ?? null : null),
      currentModel: currentTurnModel,
      notify: notify ?? (async () => { /* no notification sink wired */ }),
      listModels: listModels ?? (async () => []),
      subagentTypes: subagentTypes ?? (() => []),
      requestReload: requestReload ?? (() => { /* no reloader wired (unit-test / worker context) */ }),
      // Gate central-key access (deny-by-default): a plugin may resolve a provider only if that id was
      // wired into its OWN config, or it declared a `providers` read capability. Stops any enabled
      // plugin from lifting an unrelated provider's key straight out of the central list.
      resolveProvider: (id: string) => {
        const allowed = configProviderIds.has(id) || (capabilities.reads?.includes('providers') ?? false);
        if (!allowed) {
          scoped.warn(`resolveProvider('${id}') denied: id not in this plugin's config and no 'providers' read capability declared`);
          return null;
        }
        return baseResolveProvider(id);
      },
      embeddings,
      dataDir: () => {
        const dir = join(dataRoot ?? join(tmpdir(), 'elowen-plugins-data'), name);
        mkdirSync(dir, { recursive: true });
        return dir;
      },
      config,
      // Per-account values resolve at CALL time, from the identity of whoever is acting right now — the
      // same AsyncLocalStorage `currentIdentity()` reads. Capturing them at register time would freeze one
      // account's credentials into a plugin shared by everyone.
      userConfig: () => {
        const userId = currentIdentity()?.elowenUserId;
        const read = host?.userPluginConfig;
        if (userId === undefined || !read) return null;
        return read(userId, name);
      },
      logger: scoped,
    };
  }
}
