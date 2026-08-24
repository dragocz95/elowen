/** THE BOOT RECOVERY CONTRACT.
 *
 *  Four substrates recover interrupted work at boot — durable delegation rows, the workflow engine's
 *  on-disk journal, and the park marker on a session row, which owner conversations and ordinary platform
 *  channel turns PARTITION between them — and they are DELIBERATELY different: each stores, validates and
 *  terminalizes in the way its own failure mode demands. What they share is only the ORCHESTRATION around
 *  them: claim before the platforms open, resume after they are up, in a declared order, with one
 *  provider's failure never taking the others down, and one summary line each so a boot can be read whole.
 *
 *  This module owns exactly that shared part and nothing else. A provider keeps its own storage, its own
 *  transactions, its own fail-closed validation and its own durable user notice — folding those in here
 *  would produce an abstraction strictly worse than the duplication it replaces. */

/** Context handed to every provider's CLAIM pass.
 *
 *  It deliberately carries NO boot id. Boot identity belongs to the durable substrate: the delegation
 *  store stamps `owner_boot_id` from the id the daemon set on it at startup, and that stamp IS the
 *  compare-and-swap fence that makes "everything still marked running is a zombie" safe. Handing
 *  providers a second copy would create a second source of truth for the one value the fence turns on. */
export interface RecoveryClaimContext {
  /** Wall clock at the start of the claim pass, so every provider in one boot reads the same instant. */
  readonly now: number;
}

/** What ONE item's resume DID, as classified by the provider that owns it.
 *
 *  The coordinator only TALLIES these into that provider's boot summary line. It never infers an outcome
 *  from durable state it does not own, and never acts on one: reporting stays orchestration, deciding
 *  stays with the substrate. Every value below is a state the provider has already made durable. */
export type RecoveryOutcome =
  /** The interrupted work ran again AND its result reached whoever was waiting — a respawned delegation
   *  whose answer is queued, a DAG the engine took back, a conversation continued and delivered. */
  | 'resumed'
  /** Durably given up on: a terminal state, plus whatever notice that substrate can still deliver to the
   *  people affected. Nothing will retry it, by design — that is what separates it from `failed`. */
  | 'terminalized'
  /** Deliberately not resumed, and never this boot's to act on: a claim superseded by another provider, a
   *  marker belonging to a different sweep, or a race the user's own message already won. */
  | 'released'
  /** None of the above — the boot did not give this item what it needed, and did not close it out either.
   *  Usually the provider kept its marker so a later boot retries within that substrate's cap; it also
   *  covers a resume whose answer became durable but never reached its reader. The provider logs the
   *  diagnosis; the summary only counts it. A resume that THROWS is counted here too, by the coordinator. */
  | 'failed';

/** One recoverable substrate, seen by the coordinator only through claim → order → resume.
 *
 *  `Item` is whatever that substrate claims (a run row, a workflow snapshot, a parked session row); the
 *  coordinator never inspects it and only ever hands it straight back to `resume`. */
export interface RecoveryProvider<Item> {
  /** Stable id, referenced by other providers' {@link dependsOn} and used in every log line. */
  readonly id: string;
  /** Providers whose claim AND resume must both finish before this one's — e.g. a parked owner turn may
   *  be waiting on a delegation whose recovered result has to be queued first. Provider-level only: an
   *  ordering WITHIN one provider's items belongs in {@link order}, which can see the items themselves. */
  readonly dependsOn?: readonly string[];
  /** Resume this provider's items CONCURRENTLY instead of one after another. Off by default: a serial
   *  sweep is what keeps a fleet of interrupted delegations from stampeding a freshly booted daemon, and
   *  it is what makes a deepest-first {@link order} mean anything at all. On only where the items really
   *  are independent turns (parked owner conversations, which resume exactly as they would in normal
   *  operation). Serial: the first throwing item aborts the rest of THIS provider's sweep, exactly like
   *  the hand-wired loop it replaces. Concurrent: every item runs, and each failure is logged on its own. */
  readonly parallel?: boolean;
  /** SYNCHRONOUS, and runs BEFORE the platforms start. Take durable ownership of whatever this boot must
   *  recover and return it. It must be synchronous because the whole point is that no inbound turn — and
   *  no client connecting the moment the port opens — can observe a stale `running` row as live. */
  claim(ctx: RecoveryClaimContext): readonly Item[];
  /** Optional item-level ordering, applied just before the resume pass. This exists because a real
   *  constraint can be a graph over the CLAIMED ITEMS rather than between providers: an interrupted
   *  delegation must be respawned deepest-first, and which claim is deeper is a property of the claim set
   *  itself. Must be pure — it may be called with an empty list and its result is used as-is. */
  order?(items: readonly Item[]): readonly Item[];
  /** ASYNCHRONOUS, and runs AFTER the platforms are up, because a recovery turn goes through the ordinary
   *  channel path. Everything durable about the outcome — terminal state, the attempt cap, the user's
   *  notice, refusing an unsafe replay — belongs to the provider, never to the coordinator; the returned
   *  {@link RecoveryOutcome} only REPORTS which of those the provider already did. */
  resume(item: Item): Promise<RecoveryOutcome>;
}

/** The log sink the coordinator reports isolation failures to (the daemon's own logger satisfies it). */
export interface RecoveryLog {
  info(message: string): void;
  error(message: string, error?: unknown): void;
}
