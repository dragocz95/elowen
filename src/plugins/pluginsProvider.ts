import type { PluginRegistry } from './registry.js';

/** The ONE memoized plugin registry for the whole daemon. Every consumer (brain chat sessions, elowen-exec
 *  brain workers, platform adapters) resolves through this shared instance, so flipping a plugin on/off
 *  invalidates ALL of them at once — a per-service memo would leave some consumers running on a stale
 *  registry until a daemon restart. Loading stays lazy: plugins load on first use, not at boot. */
export class PluginRegistryProvider {
  private memo: Promise<PluginRegistry> | undefined;
  private lastGood: PluginRegistry | undefined;

  constructor(private load: () => Promise<PluginRegistry>) {}

  get(): Promise<PluginRegistry> {
    if (!this.memo) {
      // Memoize the PROMISE (so concurrent first callers share one load), but shed it on rejection so a
      // transient load failure (FS blip, a manifest mid-edit, a package build wiping dist/plugins) is
      // retried on the next call instead of being cached forever. While the reload is failing, keep
      // serving the LAST GOOD registry: a session spawned during the bad window must never silently run
      // with a partial toolset — staying on the previous registry is always the safer answer.
      const p = this.load().then(
        (registry) => { this.lastGood = registry; return registry; },
        (err: unknown) => {
          if (this.memo === p) this.memo = undefined;
          if (this.lastGood) return this.lastGood;
          throw err;
        },
      );
      this.memo = p;
    }
    return this.memo;
  }

  /** The last successfully loaded registry, without awaiting one. For the few callers that must answer
   *  SYNCHRONOUSLY inside a turn (resolving which plugin owns a tool while a tool policy is minted) and
   *  can only ever run after a registry has loaded. Undefined before the first load: no plugin has
   *  contributed anything yet, so a caller that gets undefined must fall back to the answer that says
   *  nothing about plugins at all (an empty deny-list denies nothing, because there is nothing to deny). */
  peek(): PluginRegistry | undefined {
    return this.lastGood;
  }

  /** Drop the memo so the next get() reloads from disk/config. Callers restart their sessions
   *  themselves — this only guarantees a fresh registry for everything spawned afterwards. */
  invalidate(): void {
    this.memo = undefined;
  }
}
