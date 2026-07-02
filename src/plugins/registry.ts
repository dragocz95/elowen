import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { PluginContext, PluginHook, PluginLogger, PluginSkill, PlatformAdapter } from './api.js';
import { assertPathAllowed, allowedRoots, isAllAccess, currentAccess } from './pathGuard.js';

/** Aggregates every enabled plugin's contributions, and hands each plugin a PluginContext scoped to its
 *  own config slice + a name-prefixed logger. Populated once per daemon by the loader. */
export class PluginRegistry {
  readonly tools: ToolDefinition[] = [];
  readonly skills: PluginSkill[] = [];
  readonly promptFragments: string[] = [];
  readonly hooks: PluginHook[] = [];
  readonly platforms: PlatformAdapter[] = [];

  /** Absorb another registry's contributions (the loader stages each plugin and merges on success). */
  merge(other: PluginRegistry): void {
    this.tools.push(...other.tools);
    this.skills.push(...other.skills);
    this.promptFragments.push(...other.promptFragments);
    this.hooks.push(...other.hooks);
    this.platforms.push(...other.platforms);
  }

  /** Build the context passed to one plugin's `register()`. `config` is that plugin's own slice;
   *  `dataRoot` hosts per-plugin writable dirs (tests fall back to the OS tmpdir). */
  contextFor(name: string, config: Record<string, unknown>, logger: PluginLogger, dataRoot?: string): PluginContext {
    const scoped: PluginLogger = {
      info: (m) => logger.info(`[plugin:${name}] ${m}`),
      warn: (m) => logger.warn(`[plugin:${name}] ${m}`),
      error: (m) => logger.error(`[plugin:${name}] ${m}`),
    };
    return {
      registerTool: (t) => { this.tools.push(t); },
      registerSkill: (s) => { this.skills.push(s); },
      registerSystemPromptFragment: (f) => { this.promptFragments.push(f); },
      registerHook: (h) => { this.hooks.push(h); },
      registerPlatform: (p) => { this.platforms.push(p); },
      assertPathAllowed,
      allowedRoots,
      isAdminSession: isAllAccess,
      currentAccess,
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
