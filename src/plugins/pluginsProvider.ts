import type { PluginRegistry } from './registry.js';

/** The ONE memoized plugin registry for the whole daemon. Every consumer (brain chat sessions, orca-exec
 *  brain workers, platform adapters) resolves through this shared instance, so flipping a plugin on/off
 *  invalidates ALL of them at once — a per-service memo would leave some consumers running on a stale
 *  registry until a daemon restart. Loading stays lazy: buildApp is sync, plugins load on first use. */
export class PluginRegistryProvider {
  private memo: Promise<PluginRegistry> | undefined;

  constructor(private load: () => Promise<PluginRegistry>) {}

  get(): Promise<PluginRegistry> {
    this.memo ??= this.load();
    return this.memo;
  }

  /** Drop the memo so the next get() reloads from disk/config. Callers restart their sessions
   *  themselves — this only guarantees a fresh registry for everything spawned afterwards. */
  invalidate(): void {
    this.memo = undefined;
  }
}
