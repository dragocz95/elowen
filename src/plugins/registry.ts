import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { PluginCapabilities, PluginCommand, PluginContext, PluginControl, PluginEmbeddings, PluginHook, PluginLogger, PluginModelOption, PluginSkill, PlatformAdapter, ProviderCredentials } from './api.js';
import { isEmbeddingConfigured } from '../embeddings/embeddingService.js';
import type { EmbeddingConfig } from '../embeddings/embeddingService.js';
import { commandsFor, isBuiltinCommand } from '../brain/slashCommands.js';
import type { PluginManifest } from './manifest.js';
import { assertPathAllowed, allowedRoots, defaultCwd, isAllAccess, currentAccess } from './pathGuard.js';
import { currentIdentity, currentElicitor, currentCardEmitter, currentSubagentEmitter, currentTurnModel, currentWorkDir, currentSessionId } from './policyContext.js';
import { processRegistry } from '../brain/processRegistry.js';
import type { AskAnswer } from '../brain/events.js';

/** Recursively collect every string value in a plugin's config slice — the set of provider ids the
 *  operator could legitimately have wired into THIS plugin. `resolveProvider()` is gated to this set so a
 *  plugin can reach only providers it was actually configured with (unless it declares a `providers`
 *  read capability). Bounded by the config's own depth (operator-authored, small). */
function collectStringValues(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') { into.add(value); return; }
  if (Array.isArray(value)) { for (const v of value) collectStringValues(v, into); return; }
  if (value && typeof value === 'object') { for (const v of Object.values(value)) collectStringValues(v, into); }
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

/** Aggregates every enabled plugin's contributions, and hands each plugin a PluginContext scoped to its
 *  own config slice + a name-prefixed logger. Populated once per daemon by the loader. */
export class PluginRegistry {
  readonly tools: ToolDefinition[] = [];
  /** Which plugin registered each tool (tool name → plugin name) — feeds per-role tool filtering. */
  readonly toolOwner = new Map<string, string>();
  readonly skills: PluginSkill[] = [];
  readonly promptFragments: string[] = [];
  readonly hooks: PluginHook[] = [];
  readonly turnContexts: (() => string)[] = [];
  readonly platforms: PlatformAdapter[] = [];
  readonly controls = new Map<string, PluginControl>();
  /** Plugin-contributed chat slash commands (prompt macros), keyed by command name (unique). */
  readonly commands = new Map<string, PluginCommand>();
  readonly commandOwner = new Map<string, string>();
  // Per-contribution ownership for the flat lists above — index-aligned with their sibling array, so
  // `skills[i]` was registered by `skillOwners[i]`. Tools use the `toolOwner` Map instead (tool names
  // are unique and drive per-role filtering); these lists allow duplicates (two plugins can register the
  // same hook name), so a Map would lose entries. Feeds the runtime plugin-contribution report.
  readonly skillOwners: string[] = [];
  readonly promptFragmentOwners: string[] = [];
  readonly hookOwners: string[] = [];
  readonly turnContextOwners: string[] = [];
  readonly platformOwners: string[] = [];
  readonly controlOwner = new Map<string, string>();
  /** Each plugin's declared capabilities (manifest `capabilities`, `{}` when absent), keyed by plugin
   *  name. The hook bus looks these up by owner to gate a hook's mutation patch (deny-by-default). The
   *  loader records this after a clean register+merge; the manifest is otherwise discarded. */
  readonly pluginCapabilities = new Map<string, PluginCapabilities>();
  /** Per-tool display icons declared across all plugin manifests (`icons`), keyed by tool name. Merged
   *  with the core defaults by `makeToolIconResolver` when the daemon stamps a `tool` event's icon. */
  readonly toolIcons = new Map<string, string>();
  /** Output-show patterns declared across all plugin manifests (`showOutput`) — exact tool names or
   *  `prefix*`. Merged with the core defaults (`BUILTIN_TOOL_OUTPUT_SHOWN`) into the one output policy
   *  the shared `messageView` renderer consults (`makeToolOutputPolicy`). Output is hidden by default;
   *  only these tools' output surfaces. */
  readonly toolShowOutput = new Set<string>();

  /** Absorb another registry's contributions (the loader stages each plugin and merges on success).
   *  Controls + commands are name-keyed and drive admin routes / the slash menu, so a later plugin must
   *  not silently hijack a name a prior plugin owns. This join is the ONLY place two plugins' registries
   *  meet (each registers into its own staging registry), so cross-plugin collisions are enforced HERE —
   *  first-writer-wins, with `warn` surfacing the drop. */
  merge(other: PluginRegistry, warn?: (msg: string) => void): void {
    this.tools.push(...other.tools);
    for (const [k, v] of other.toolOwner) this.toolOwner.set(k, v);
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
    }
    for (const [k, v] of other.commands) {
      const prior = this.commandOwner.get(k);
      const owner = other.commandOwner.get(k) ?? '?';
      if (prior && prior !== owner) { warn?.(`command "/${k}" from "${owner}" ignored — already registered by "${prior}"`); continue; }
      this.commands.set(k, v); this.commandOwner.set(k, owner);
    }
    this.skillOwners.push(...other.skillOwners);
    this.promptFragmentOwners.push(...other.promptFragmentOwners);
    this.hookOwners.push(...other.hookOwners);
    this.turnContextOwners.push(...other.turnContextOwners);
    this.platformOwners.push(...other.platformOwners);
    for (const [k, v] of other.pluginCapabilities) this.pluginCapabilities.set(k, v);
  }

  /** Record a plugin's declared capabilities (from its parsed manifest). Called by the loader after a
   *  clean register+merge so the hook bus can gate that plugin's mutations. */
  setCapabilities(name: string, caps: PluginCapabilities): void {
    this.pluginCapabilities.set(name, caps);
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

  /** Build the context passed to one plugin's `register()`. `config` is that plugin's own slice;
   *  `dataRoot` hosts per-plugin writable dirs (tests fall back to the OS tmpdir). */
  contextFor(name: string, config: Record<string, unknown>, logger: PluginLogger, dataRoot?: string, notify?: (text: string, channelId?: string) => Promise<void>, listModels?: () => Promise<PluginModelOption[]>, resolveProvider?: (id: string) => ProviderCredentials | null, caps?: PluginCapabilities, provides?: PluginManifest['provides'], answerQuestion?: (id: string, answers: AskAnswer[]) => boolean, embedder?: PluginEmbedder, embeddingConfig?: () => EmbeddingConfig): PluginContext {
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
        if (provides?.tools && !provides.tools.includes(t.name)) {
          scoped.warn(`registerTool('${t.name}') refused: not declared in manifest provides.tools`);
          return;
        }
        this.tools.push(t); this.toolOwner.set(t.name, name);
      },
      registerSkill: (s) => { this.skills.push(s); this.skillOwners.push(name); },
      registerControl: (key, control) => {
        const clean = key.trim();
        if (!clean) { scoped.warn('registerControl refused: empty name'); return; }
        // Cross-plugin collisions (a second plugin hijacking a control name like 'mcp') are caught at
        // merge() time — this staging registry only ever holds THIS plugin, so within it last-writer-wins
        // is just the plugin overriding its own control.
        this.controls.set(clean, control);
        this.controlOwner.set(clean, name);
      },
      registerCommand: (command) => {
        const clean = command.name?.trim() ?? '';
        // 1–32 chars, kebab-case. (The collision with another plugin's command is enforced at merge().)
        if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(clean)) { scoped.warn(`registerCommand refused: "${command.name}" is not kebab-case (a-z, 0-9, dashes)`); return; }
        if (isBuiltinCommand(clean)) { scoped.warn(`registerCommand refused: "${clean}" shadows a built-in command`); return; }
        if (typeof command.prompt !== 'string' || !command.prompt.trim()) { scoped.warn(`registerCommand refused: "${clean}" has an empty prompt`); return; }
        this.commands.set(clean, { name: clean, description: command.description ?? '', prompt: command.prompt, surfaces: command.surfaces });
        this.commandOwner.set(clean, name);
      },
      chatCommands: (surface) => commandsFor(surface, true).map(({ name: commandName, description, adminOnly }) => ({ name: commandName, description, ...(adminOnly ? { adminOnly } : {}) })),
      registerSystemPromptFragment: (f) => { this.promptFragments.push(f); this.promptFragmentOwners.push(name); },
      registerHook: (h) => { this.hooks.push(h); this.hookOwners.push(name); },
      registerTurnContext: (f) => { this.turnContexts.push(f); this.turnContextOwners.push(name); },
      // Same allowlist rule as tools, against `provides.platforms` (Discord/cron/subagent are here).
      registerPlatform: (p) => {
        if (provides?.platforms && !provides.platforms.includes(p.name)) {
          scoped.warn(`registerPlatform('${p.name}') refused: not declared in manifest provides.platforms`);
          return;
        }
        this.platforms.push(p); this.platformOwners.push(name);
      },
      assertPathAllowed,
      allowedRoots,
      defaultCwd,
      isAdminSession: isAllAccess,
      currentAccess,
      currentIdentity,
      currentSessionId,
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
      currentModel: currentTurnModel,
      notify: notify ?? (async () => { /* no notification sink wired */ }),
      listModels: listModels ?? (async () => []),
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
      logger: scoped,
    };
  }
}
