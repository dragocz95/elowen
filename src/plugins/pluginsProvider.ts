import type { PluginRegistry } from './registry.js';

/** The ONE memoized plugin registry for the whole daemon. Every consumer (brain chat sessions, elowen-exec
 *  brain workers, platform adapters) resolves through this shared instance, so flipping a plugin on/off
 *  invalidates ALL of them at once — a per-service memo would leave some consumers running on a stale
 *  registry until a daemon restart. Loading stays lazy: plugins load on first use, not at boot. */
export class PluginRegistryProvider {
  private memo: Promise<PluginRegistry> | undefined;

  constructor(private load: () => Promise<PluginRegistry>) {}

  get(): Promise<PluginRegistry> {
    if (!this.memo) {
      const p = this.load();
      // Memoize the PROMISE (so concurrent first callers share one load), but shed it on rejection —
      // otherwise a transient load failure (FS blip, a manifest mid-edit) would be cached forever and
      // every consumer would stay broken until the next toggle or a daemon restart.
      p.catch(() => { if (this.memo === p) this.memo = undefined; });
      this.memo = p;
    }
    return this.memo;
  }

  /** Drop the memo so the next get() reloads from disk/config. Callers restart their sessions
   *  themselves — this only guarantees a fresh registry for everything spawned afterwards. */
  invalidate(): void {
    this.memo = undefined;
  }
}
