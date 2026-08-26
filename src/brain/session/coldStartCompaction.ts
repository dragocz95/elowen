import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { parseDbTs } from '../../shared/time.js';
import { logger } from '../../shared/logger.js';
import { runCompaction } from '../events.js';
import { sessionHasWorkInFlight, type SessionQuiescenceDeps } from '../service/sessionQuiescence.js';
import { LONG_CACHE_TTL_MS } from './cacheTiming.js';

/** Cold-start auto-compaction policy: the pure decision pieces behind the turn runner's
 *  pre-turn compaction (BrainTurnRunner.maybeColdStartCompaction).
 *
 *  A conversation resumed after its prompt cache expired is compacted at the START of that turn,
 *  before its first provider request. The timing carries both halves of the argument:
 *
 *  - The cache is provably cold, so the summarization rewrite throws away no warm prefix — the same
 *    reason toolResultClearing waits for the cold gate before rewriting history.
 *  - The user is provably CONTINUING the conversation: the payment buys a cheaper request that is
 *    actually about to be made. A preventive timer-driven compaction of an idle conversation spends the
 *    full summarization price on a return that may never happen — for an abandoned 400k-token context
 *    that is $2+ of pure loss — which is why this deliberately is NOT a background sweep.
 *
 *  Firing earlier (while the cache is warm) buys nothing either: PI's summarization request never reads
 *  the conversation's cache at any time (pi-coding-agent `completeSummarization` sends the serialized
 *  history as a standalone request with `cacheRetention: "none"` and a fresh sessionId), so it always
 *  pays full input price on the whole history.
 *
 *  No latch or once-per-epoch bookkeeping is needed here, unlike the retired 60 s sweep: the trigger IS
 *  the turn, the turn appends fresh messages, and the gate closes with them. A failed attempt is not
 *  retried within the turn either — the turn just runs on the full context, and the circuit breaker
 *  counts the failure through its own session subscription. */

/** Anthropic's cache-write multiplier depends on the TTL the previous request actually used: 5-minute
 *  entries cost 1.25× plain input, while 1-hour entries cost 2×. An unknown stamp is priced as short — the
 *  stricter break-even — so a conversation predating this process is never compacted on an optimistic guess. */
function cacheWritePerInput(lastRequestCacheTtlMs: number | undefined): number {
  return lastRequestCacheTtlMs !== undefined && lastRequestCacheTtlMs >= LONG_CACHE_TTL_MS ? 2 : 1.25;
}

const OUTPUT_PER_INPUT = 5;

/** Whether compacting BEFORE the turn's first provider request beats running the turn on the full
 *  history. With context C, post-compaction floor F, summary output S and cache-write multiplier W:
 *
 *  - skip:    the turn's first request re-caches the full cold history       → W·C
 *  - compact: summarization reads the history at full input price, emits the summary as output, and the
 *             turn then re-caches only the floor                              → C + 5·S + W·F
 *
 *  Compact iff (W−1)·C ≥ W·F + 5·S. For short retention this is C ≥ 5·F + 20·S;
 *  for Elowen's default 1-hour retention it is C ≥ 2·F + 5·S.
 *
 *  This counts a single cold return only. Every later turn favors the compacted side further (cache
 *  reads at 0.1× over a smaller prefix), so the bound remains conservative. */
export function coldCompactionWorthwhile(
  contextTokens: number, floorTokens: number, summaryOutputTokens: number,
  lastRequestCacheTtlMs?: number,
): boolean {
  const cacheWrite = cacheWritePerInput(lastRequestCacheTtlMs);
  return (cacheWrite - 1) * contextTokens
    >= cacheWrite * floorTokens + OUTPUT_PER_INPUT * summaryOutputTokens;
}

/** How long a conversation must have been quiet before its prompt cache is DEFINITELY cold — the TTL of
 *  the last provider request plus a 1-minute buffer (the same buffer idleThresholdMs uses).
 *
 *  Deliberately NOT derived from the CURRENT env: `PI_CACHE_RETENTION` can differ between the process
 *  that made the last request and this one (a daemon restart that switched long → short), and gating on
 *  the current value would open the gate over a still-warm hour-long cache. The turn runner stamps
 *  `cacheTtlMs(process.env)` onto the live session after each prompt it runs, so a known value is the
 *  TTL the requests were actually made under; a session whose history predates this process has no
 *  stamp and falls back to the LONGEST TTL pi-ai ever uses — fail-closed, at worst delaying the
 *  compaction, never rewriting a warm prefix. */
export function coldCompactionGateMs(lastRequestCacheTtlMs: number | undefined): number {
  return (lastRequestCacheTtlMs ?? LONG_CACHE_TTL_MS) + 60_000;
}

export type ColdCompactionAssessment =
  | { eligible: true; contextTokens: number; floorTokens: number }
  | { eligible: false; reason: 'auto-compact-off' | 'breaker' | 'not-worthwhile' };

/** The per-session facts the assessment needs, provided as thunks by the session factory (which owns
 *  the live proactive flag, the circuit breaker and the token estimates). Read at assessment time, not
 *  captured — a live settings change or a breaker trip must reach the very next turn. */
export interface ColdCompactionInputs {
  /** The session's auto-compact toggle. A cold-start compaction is an AUTOMATIC compaction, so a user
   *  who switched auto-compact off must not get one from a turn trigger either. */
  proactive(): boolean;
  /** Whether the compaction circuit breaker currently refuses automatic compaction — the same
   *  `blocks('threshold')` rule PI's own threshold attempts are gated on, so this trigger can never
   *  sneak past a tripped or provably-pointless state. */
  breakerBlocks(): boolean;
  /** Estimated current context tokens (provider-usage based, so it includes the fixed cost). */
  contextTokens(): number;
  /** Estimated post-compaction floor: fixed cost + summary allowance + retained tail. */
  floorTokens(): number;
  /** Expected summary size in OUTPUT tokens — the factory's summary allowance, the same number the
   *  post-compaction floor already budgets for the summary's presence in context. */
  summaryOutputTokens(): number;
}

export type AssessColdCompaction = (lastRequestCacheTtlMs?: number) => ColdCompactionAssessment;

export function assessColdCompaction(
  inputs: ColdCompactionInputs,
  lastRequestCacheTtlMs?: number,
): ColdCompactionAssessment {
  if (!inputs.proactive()) return { eligible: false, reason: 'auto-compact-off' };
  if (inputs.breakerBlocks()) return { eligible: false, reason: 'breaker' };

  const contextTokens = inputs.contextTokens();
  const floorTokens = inputs.floorTokens();
  if (!coldCompactionWorthwhile(contextTokens, floorTokens, inputs.summaryOutputTokens(), lastRequestCacheTtlMs)) {
    return { eligible: false, reason: 'not-worthwhile' };
  }
  return { eligible: true, contextTokens, floorTokens };
}

/** A session's last activity in epoch ms — the newest stored message vs the user's last explicit
 *  interaction, the same pair rolloverDue keys on. `interactedAt` moves on resume, model switch and
 *  manual compact even without a provider request, which can only DELAY the gate — the safe direction.
 *  0 means no activity on record (never cold-compact). */
export function lastActivityMs(lastMessageAt: string | undefined, interactedAt: number | undefined): number {
  return Math.max(parseDbTs(lastMessageAt), interactedAt ?? 0);
}

const coldLog = logger('brain-compaction');

/** What the trigger needs beyond the live session: the store it reads the last message time from, plus
 *  the two registries {@link sessionHasWorkInFlight} consults. Structural, so both the owner turn runner
 *  and the channel service satisfy it with the dependencies they already hold. */
export interface ColdStartCompactionDeps extends SessionQuiescenceDeps {
  store: SessionQuiescenceDeps['store'] & { lastMessageAt(sessionId: string): string | undefined };
}

/** The live-session facts the trigger reads. Structural on purpose: the policy is usable by both owner
 *  chat and platform channels without importing the concrete live-session module. */
export interface ColdCompactionSession {
  session: AgentSession;
  sessionId: string;
  interactedAt?: number;
  lastRequestCacheTtlMs?: number;
  assessColdCompaction?: AssessColdCompaction;
}

/** Compact the conversation at the START of a turn that follows a provably expired prompt cache — before
 *  its first provider request, under the lock the turn already holds.
 *
 *  This is the ONLY automatic cold-context compaction trigger; the previous 60 s idle sweep is gone.
 *  Timing it to the turn keeps the one genuine advantage of the idle timing (the cache is cold, so the
 *  rewrite forfeits no warm prefix) and removes the sweep's two losses: nothing is ever paid for a
 *  conversation nobody returns to, and the decision is made at the moment the user is provably
 *  continuing — the moment the compacted re-cache is actually about to be bought. See the module doc
 *  above for the break-even arithmetic.
 *
 *  It lives here rather than in the owner turn runner because a ROOM is where an expensive cold context
 *  actually accumulates: a long-lived cron channel keeps one conversation for weeks. The owner surface
 *  had the trigger and every platform channel silently did not.
 *
 *  Never throws and never blocks the turn on failure: a context that cannot be summarized still answers
 *  on its full history, and the circuit breaker counts the failure through its own session subscription.
 *  No loop guard is needed — the turn that follows appends fresh messages, which closes the gate until
 *  the next full idle-past-TTL epoch. */
export async function maybeColdStartCompaction(d: ColdStartCompactionDeps, live: ColdCompactionSession): Promise<void> {
  const assess = live.assessColdCompaction;
  if (!assess) return;
  if (live.session.isStreaming || live.session.isCompacting) return;
  const lastActivity = lastActivityMs(d.store.lastMessageAt(live.sessionId), live.interactedAt);
  if (lastActivity === 0 || Date.now() - lastActivity < coldCompactionGateMs(live.lastRequestCacheTtlMs)) return;
  // The shared fail-closed predicate (also the teardown's): a queued message, parked question,
  // running child/background job or armed goal means the context is not this turn's to rewrite.
  if (sessionHasWorkInFlight(d, live.sessionId)) return;
  const verdict = assess(live.lastRequestCacheTtlMs);
  if (!verdict.eligible) {
    coldLog.info(`cold-start compaction skipped on ${live.sessionId}: ${verdict.reason}`);
    return;
  }
  try {
    const result = await runCompaction(live.session);
    if (result.compacted) {
      coldLog.info(`cold-start compacted ${live.sessionId} (cache cold; est. ${verdict.contextTokens} → floor ~${verdict.floorTokens} tokens)`);
    }
  } catch (error) {
    coldLog.warn(`cold-start compaction failed on ${live.sessionId} — running the turn on the full context`, error);
  }
}
