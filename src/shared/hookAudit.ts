/** Outcome of a single mutating hook invocation, as observed by the brain's hook runner:
 *  - `ok`      — the hook ran and its patch (if any) was accepted.
 *  - `threw`   — the hook's run() rejected/threw; fail-open, no patch contributed.
 *  - `timeout` — the hook exceeded its per-hook budget; fail-open, no patch contributed.
 *  - `rejected`— the hook returned a patch but its owning plugin lacks the matching capability,
 *                so the patch was denied by the capability gate. */
type HookOutcome = 'ok' | 'threw' | 'timeout' | 'rejected';

/** One captured hook-execution record. `ts` is injected by the caller (Date.now() is not always
 *  reachable where the ring is written) so the ring stays pure and deterministic in tests. `changed`
 *  names what the accepted patch mutated (e.g. `turnContext`); absent when nothing was applied. */
export interface HookAuditEntry {
  ts: number;
  plugin: string;
  hook: string;
  durationMs: number;
  outcome: HookOutcome;
  changed?: string;
}

/** A bounded, in-memory ring of the most recent hook-execution records. The brain's hook runner is
 *  the sole writer (record()); the admin plugins API is the reader (forPlugin/recent). It exists so
 *  operators can see, per plugin, whether a mutating hook ran, how long it took, and whether its
 *  patch was accepted, rejected by the capability gate, or failed open — without any new plumbing
 *  inside plugins. Pure, no I/O; the caller supplies `ts`. Mirrors {@link PluginLogBuffer}. */
export class HookAuditBuffer {
  private readonly ring: HookAuditEntry[] = [];
  private readonly cap: number;

  constructor(cap = 500) {
    this.cap = Math.max(1, cap);
  }

  /** Append newest-last, evicting the oldest once the cap is exceeded. The full entry (including its
   *  caller-supplied `ts`) is recorded verbatim. */
  record(entry: HookAuditEntry): void {
    this.ring.push(entry);
    if (this.ring.length > this.cap) this.ring.shift();
  }

  /** The named plugin's records, newest-first. `limit` bounds the tail returned (default 200), never
   *  exceeding what's retained in the ring. */
  forPlugin(name: string, limit = 200): HookAuditEntry[] {
    const out: HookAuditEntry[] = [];
    for (const e of this.ring) {
      if (e.plugin === name) out.push(e);
    }
    out.reverse();
    return limit >= out.length ? out : out.slice(0, limit);
  }

  /** All retained records, newest-first. `limit` bounds the tail returned (default 200), never
   *  exceeding what's retained in the ring. */
  recent(limit = 200): HookAuditEntry[] {
    const out = this.ring.slice().reverse();
    return limit >= out.length ? out : out.slice(0, limit);
  }
}
