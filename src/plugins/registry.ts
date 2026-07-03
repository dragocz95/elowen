import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { PluginContext, PluginHook, PluginLogger, PluginSkill, PlatformAdapter, ProviderCredentials } from './api.js';
import { assertPathAllowed, allowedRoots, isAllAccess, currentAccess } from './pathGuard.js';
import { currentIdentity } from './policyContext.js';

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
  // Per-contribution ownership for the flat lists above — index-aligned with their sibling array, so
  // `skills[i]` was registered by `skillOwners[i]`. Tools use the `toolOwner` Map instead (tool names
  // are unique and drive per-role filtering); these lists allow duplicates (two plugins can register the
  // same hook name), so a Map would lose entries. Feeds the runtime plugin-contribution report.
  readonly skillOwners: string[] = [];
  readonly promptFragmentOwners: string[] = [];
  readonly hookOwners: string[] = [];
  readonly turnContextOwners: string[] = [];
  readonly platformOwners: string[] = [];

  /** Absorb another registry's contributions (the loader stages each plugin and merges on success). */
  merge(other: PluginRegistry): void {
    this.tools.push(...other.tools);
    for (const [k, v] of other.toolOwner) this.toolOwner.set(k, v);
    this.skills.push(...other.skills);
    this.promptFragments.push(...other.promptFragments);
    this.hooks.push(...other.hooks);
    this.turnContexts.push(...other.turnContexts);
    this.platforms.push(...other.platforms);
    this.skillOwners.push(...other.skillOwners);
    this.promptFragmentOwners.push(...other.promptFragmentOwners);
    this.hookOwners.push(...other.hookOwners);
    this.turnContextOwners.push(...other.turnContextOwners);
    this.platformOwners.push(...other.platformOwners);
  }

  /** Build the context passed to one plugin's `register()`. `config` is that plugin's own slice;
   *  `dataRoot` hosts per-plugin writable dirs (tests fall back to the OS tmpdir). */
  contextFor(name: string, config: Record<string, unknown>, logger: PluginLogger, dataRoot?: string, notify?: (text: string, channelId?: string) => Promise<void>, listModels?: () => Promise<{ provider: string; providerLabel: string; model: string }[]>, resolveProvider?: (id: string) => ProviderCredentials | null): PluginContext {
    const scoped: PluginLogger = {
      info: (m) => logger.info(`[plugin:${name}] ${m}`),
      warn: (m) => logger.warn(`[plugin:${name}] ${m}`),
      error: (m) => logger.error(`[plugin:${name}] ${m}`),
    };
    return {
      registerTool: (t) => { this.tools.push(t); this.toolOwner.set(t.name, name); },
      registerSkill: (s) => { this.skills.push(s); this.skillOwners.push(name); },
      registerSystemPromptFragment: (f) => { this.promptFragments.push(f); this.promptFragmentOwners.push(name); },
      registerHook: (h) => { this.hooks.push(h); this.hookOwners.push(name); },
      registerTurnContext: (f) => { this.turnContexts.push(f); this.turnContextOwners.push(name); },
      registerPlatform: (p) => { this.platforms.push(p); this.platformOwners.push(name); },
      assertPathAllowed,
      allowedRoots,
      isAdminSession: isAllAccess,
      currentAccess,
      currentIdentity,
      notify: notify ?? (async () => { /* no notification sink wired */ }),
      listModels: listModels ?? (async () => []),
      resolveProvider: resolveProvider ?? (() => null),
      dataDir: () => {
        const dir = join(dataRoot ?? join(tmpdir(), 'orca-plugins-data'), name);
        mkdirSync(dir, { recursive: true });
        return dir;
      },
      config,
      logger: scoped,
    };
  }
}
