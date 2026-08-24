import type { RecoveryClaimContext, RecoveryLog, RecoveryProvider } from './types.js';

/** A registered provider with its item type erased. The two casts that erasure needs live in
 *  {@link BootRecoveryCoordinator.register} and nowhere else: every item the coordinator holds came out of
 *  the same provider's own `claim`, so handing it back to that provider's `order`/`resume` is sound. */
interface ErasedProvider {
  readonly id: string;
  readonly dependsOn: readonly string[];
  readonly parallel: boolean;
  claim(ctx: RecoveryClaimContext): readonly unknown[];
  order(items: readonly unknown[]): readonly unknown[];
  resume(item: unknown): Promise<void>;
}

/** Order providers so every declared dependency precedes its dependents, keeping registration order among
 *  the ones that are free to go in any order (so the sequence is deterministic, not hash-order). An
 *  unknown dependency or a cycle THROWS: the boot chain's ordering is the whole safety property here, and
 *  silently running a broken order would be worse than not recovering at all. */
function sequenceProviders(providers: readonly ErasedProvider[]): ErasedProvider[] {
  const byId = new Map(providers.map((p) => [p.id, p]));
  for (const p of providers) {
    for (const dep of p.dependsOn) {
      if (!byId.has(dep)) throw new Error(`recovery provider '${p.id}' depends on '${dep}', which is not registered`);
    }
  }
  const sequenced: ErasedProvider[] = [];
  const settled = new Set<string>();
  const remaining = [...providers];
  while (remaining.length > 0) {
    const next = remaining.findIndex((p) => p.dependsOn.every((dep) => settled.has(dep)));
    if (next === -1) {
      throw new Error(`recovery providers have a dependency cycle: ${remaining.map((p) => p.id).join(', ')}`);
    }
    const [provider] = remaining.splice(next, 1);
    sequenced.push(provider!);
    settled.add(provider!.id);
  }
  return sequenced;
}

/** The boot recovery chain: registration, the synchronous claim pass, declared ordering, per-provider
 *  error isolation, and the resume pass that runs once the platforms are up. See ./types.ts for what this
 *  deliberately does NOT own.
 *
 *  The two passes are separate methods rather than one call because the gap between them is load-bearing:
 *  claiming happens before `startPlatforms` so nothing can observe a stale `running` row as live, and
 *  resuming happens after it because a recovery turn rides the ordinary channel path. */
export class BootRecoveryCoordinator {
  private readonly providers: ErasedProvider[] = [];
  private readonly claimed = new Map<string, readonly unknown[]>();
  /** The dependency-resolved run order, fixed by the claim pass and reused by the resume pass so both
   *  passes provably visit the providers in the SAME order. Undefined until claimAll ran. */
  private sequence: ErasedProvider[] | undefined;

  constructor(private readonly log: RecoveryLog) {}

  register<Item>(provider: RecoveryProvider<Item>): this {
    if (this.sequence) throw new Error(`recovery provider '${provider.id}' registered after the claim pass`);
    if (this.providers.some((p) => p.id === provider.id)) throw new Error(`duplicate recovery provider '${provider.id}'`);
    this.providers.push({
      id: provider.id,
      dependsOn: provider.dependsOn ?? [],
      parallel: provider.parallel ?? false,
      claim: (ctx) => provider.claim(ctx),
      order: (items) => provider.order?.(items as readonly Item[]) ?? items,
      resume: (item) => provider.resume(item as Item),
    });
    return this;
  }

  /** The registered chain as DECLARED: id, dependencies and resume mode, in registration order. The
   *  ordering constraints are this module's whole safety property, so they have to be observable — a trace
   *  of one run cannot tell a chain held together by real dependencies from one that merely happens to be
   *  registered in a working order. */
  plan(): { id: string; dependsOn: readonly string[]; parallel: boolean }[] {
    return this.providers.map((p) => ({ id: p.id, dependsOn: p.dependsOn, parallel: p.parallel }));
  }

  /** Boot phase 1 — SYNCHRONOUS, before the platforms start. Each provider takes durable ownership of its
   *  own orphaned work; what it returns is held for phase 2.
   *
   *  A throwing claim is isolated to its own provider (the rest of the chain still claims) and leaves that
   *  provider with nothing to resume THIS boot. It is deliberately not softened into a partial claim: a
   *  claim is the point where the durable substrate decides what it owns, so half of one is not a result
   *  the coordinator may invent. The work stays claimable — the row keeps its lifecycle and lease — and
   *  the next boot claims it again. */
  claimAll(now: number = Date.now()): void {
    if (this.sequence) throw new Error('boot recovery claim pass already ran');
    this.sequence = sequenceProviders(this.providers);
    const ctx: RecoveryClaimContext = { now };
    for (const provider of this.sequence) {
      try {
        const items = provider.claim(ctx);
        this.claimed.set(provider.id, items);
      } catch (e) {
        this.claimed.set(provider.id, []);
        this.log.error(`boot recovery: '${provider.id}' claim failed — nothing claimed for it this boot`, e);
      }
    }
  }

  /** Boot phase 2 — ASYNCHRONOUS, after the platforms are up. Resume each provider's claimed items in the
   *  same declared order, isolating one provider's failure from the rest (and from the boot announcement,
   *  which is why this never rejects).
   *
   *  Never softens a failure into success, never retries an item a provider refused, never clears a marker
   *  or writes a terminal state on a provider's behalf: an item that failed is left exactly as its own
   *  provider left it. */
  async resumeAll(): Promise<void> {
    if (!this.sequence) throw new Error('boot recovery resume pass ran before the claim pass');
    for (const provider of this.sequence) {
      // Taken, not read: the claims are handed to the resume pass exactly once, so a second resumeAll
      // (a wiring mistake) cannot drive the same recovered work twice.
      const items = this.claimed.get(provider.id) ?? [];
      this.claimed.set(provider.id, []);
      if (items.length === 0) continue;
      try {
        const ordered = provider.order(items);
        if (provider.parallel) {
          const settled = await Promise.allSettled(ordered.map((item) => provider.resume(item)));
          for (const outcome of settled) {
            if (outcome.status === 'rejected') this.log.error(`boot recovery: '${provider.id}' item failed`, outcome.reason);
          }
        } else {
          for (const item of ordered) await provider.resume(item);
        }
      } catch (e) {
        this.log.error(`boot recovery: '${provider.id}' resume pass failed`, e);
      }
    }
  }
}
