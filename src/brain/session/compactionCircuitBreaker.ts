import type { AgentSessionEvent, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { logger } from '../../shared/logger.js';

const log = logger('brain-compaction');

/** What triggered a compaction, as PI reports it on both `session_before_compact` and `compaction_end`. */
type CompactionReason = 'manual' | 'threshold' | 'overflow';

/** Consecutive failed AUTOMATIC compactions after which a session stops attempting them.
 *
 *  A context that cannot be summarized fails identically on every retry — one tool result that alone
 *  exceeds the window, a summary the model refuses — and PI re-checks the threshold after every single
 *  turn. Without a stop, each following turn spends one summarization request that cannot succeed, for
 *  the rest of the session's life. Claude Code measured exactly this failure mode at fleet scale before
 *  adding the same guard.
 *
 *  Three is high enough that a transient provider failure never trips it — PI's own retry budget is
 *  already spent INSIDE each one of those three attempts, so three failures mean three exhausted retry
 *  chains — and low enough that an irrecoverable session wastes three calls rather than thousands. Kept
 *  as the DEFAULT of the operator-tunable `compactionFailureLimit` knob (Elowen AI → Limits). */
export const DEFAULT_COMPACTION_FAILURE_LIMIT = 3;

/** The limit in force, resolved live — the same module-level-resolver seam `toolResultClearing` uses for
 *  its spill thresholds. Injected once at bootstrap; defaults to {@link DEFAULT_COMPACTION_FAILURE_LIMIT}
 *  so tests and any un-wired path keep the historical behaviour. */
let compactionFailureLimit: () => number = () => DEFAULT_COMPACTION_FAILURE_LIMIT;
export function setCompactionFailureLimit(resolve: () => number): void { compactionFailureLimit = resolve; }

/** Read per compaction outcome, never cached at spawn, so a Limits change reaches sessions that are
 *  already running. Floored at 1 at the point of use: a stored 0 would trip the breaker before a session
 *  had attempted anything, turning a tuning knob into "never compact automatically". */
function failureLimit(): number {
  return Math.max(1, Math.round(compactionFailureLimit()));
}

/** What the user is told when the breaker trips. The session cannot recover on its own from here, so
 *  this is a terminal condition they have to act on, not a transient status notice. */
export function compactionStoppedMessage(failures: number): string {
  return `Automatic context compaction failed ${failures} times in a row, so it has been stopped for this conversation — every further attempt would spend a model call that cannot succeed. This conversation can no longer shrink its own context: start a new one, or run /compact yourself once the oversized content is out of the way.`;
}

/** What the user is told when a threshold is physically unreachable. Distinct from a failure: the
 *  compactions SUCCEEDED, they just cannot do their job — the post-compaction context still sits at or
 *  above the trigger, so PI would fire again on the next turn at full summarization cost. */
export function compactionUnreachableMessage(floorTokens: number, triggerTokens: number): string {
  return `Automatic context compaction cannot shrink this conversation below its threshold: after a compaction the context still measures about ${floorTokens} tokens, at or above the ${triggerTokens}-token point automatic compaction fires at. Retrying would keep spending summarization requests that cannot help, so automatic threshold compaction has been stopped for this conversation. /compact still works, and a new conversation is the reliable fix.`;
}

/** The live view of the compaction settings that determine whether the threshold is reachable. The
 *  factory mutates `trigger` whenever the user's percentage is (re)applied, so the breaker always
 *  compares against the trigger actually in force. Absent a budget entirely, the guard is inert and the
 *  breaker behaves exactly as it did before. */
export interface CompactionThresholdBudget {
  /** The effective trigger in force: contextWindow − reserveTokens (null while unknown). */
  trigger: number | null;
  /** Estimated never-shrinking request cost — system prompt + tool definitions, chars/4 (see
   *  estimateFixedCostTokens). The post-compaction floor is this plus what PI measured it kept. */
  fixedCostTokens: number;
  /** A compaction must land at least this far below the trigger to count as useful. Absorbs measurement
   *  noise between the chars/4 estimate and the provider's real tokenizer, and encodes that a compaction
   *  buying less than this of working room is not worth its summarization cost. */
  floorMargin: number;
  /** The never-shrinking prefill (system prompt + tool definitions) the user's percentage is measured
   *  ON TOP OF, so "80% full" means 80% of what a conversation can actually use. Seeded from the rendered
   *  prompt at spawn, replaced by the provider's own figure once a request reports one, and cleared by a
   *  compaction — the prefill is stable, but the tools and system prompt behind it are not.
   *
   *  It lives here rather than on LiveBrain because only the factory's own threshold arithmetic reads it,
   *  and this is already the shared mutable holder for the numbers that define the trigger. */
  prefillBaseline: number | null;
}

export interface CompactionCircuitBreakerOptions {
  sessionId: string;
  /** Reported ONCE per trip, so the user learns the conversation stopped managing its own context.
   *  Callers route it to whatever channel they already use for terminal session errors. */
  onTripped?: (message: string) => void;
  /** Live budget for the unreachable-threshold guard. The factory provides it and mutates its trigger on
   *  every percentage change; without it the guard never engages. */
  thresholdBudget?: CompactionThresholdBudget;
}

export interface CompactionCircuitBreaker {
  /** Registers the cancel gate on PI's extension API (pass to the resource loader's factories). */
  extension: (pi: ExtensionAPI) => void;
  /** Feed PI's session event stream: this is what counts compaction outcomes. */
  observe: (event: AgentSessionEvent) => void;
  /** Whether a compaction with this reason is currently refused. The gate and the tests share this one
   *  rule instead of each restating the threshold. */
  blocks: (reason: CompactionReason) => boolean;
  /** Re-evaluate the unreachable-threshold guard against the budget currently in force. Called by the
   *  factory after a live threshold change, and with an explicit `floorEstimate` at spawn to seed the
   *  guard BEFORE the first (provably pointless) summarization request. Detection only — the user-facing
   *  report waits for the first threshold compaction the guard actually refuses. */
  applyBudget: (floorEstimate?: number | null) => void;
}

/** Stop a session from retrying a compaction that keeps failing.
 *
 *  Per-session state lives in this closure — the same pattern `toolResultClearing` uses for its latch —
 *  and holds nothing but counters, so it can never leak between sessions and never keeps a session
 *  object (or its messages) alive once the session itself is dropped. */
export function createCompactionCircuitBreaker(options: CompactionCircuitBreakerOptions): CompactionCircuitBreaker {
  let consecutiveFailures = 0;
  /** A compaction attempt is in flight (PI emitted `compaction_start`). PI also reports exhausted
   *  overflow recovery as a bare `compaction_end` with no attempt behind it; that one spent nothing and
   *  must not count against the budget. */
  let attemptStarted = false;
  let reported = false;
  // Unreachable-threshold state: the last measured post-compaction floor and whether it proves the
  // threshold cannot be honored. Deliberately separate from the failure counter — a successful-but-
  // pointless compaction must NOT reset this the way a success resets failures, and a run of failures
  // must not stop counting just because the floor is also too high.
  let lastFloorEstimate: number | null = null;
  let pointless = false;
  let pointlessReported = false;

  const tripped = (): boolean => consecutiveFailures >= failureLimit();

  /** A threshold compaction is pointless when the last measured post-compaction floor — fixed cost plus
   *  what PI kept — sits within {@link CompactionThresholdBudget.floorMargin} of the trigger: the next
   *  attempt would summarize the same un-shrinkable context again and buy no working room. One measured
   *  floor is enough evidence: the floor is what it is until a smaller summary or a higher trigger.
   *  State only — reporting waits for a refusal, because this runs at every spawn via the seed. */
  const evaluatePointless = (): void => {
    const budget = options.thresholdBudget;
    if (!budget || lastFloorEstimate === null || budget.trigger === null) return;
    pointless = lastFloorEstimate + budget.floorMargin >= budget.trigger;
    if (!pointless) pointlessReported = false;
  };

  const blocks = (reason: CompactionReason): boolean => reason !== 'manual' && (tripped() || (reason === 'threshold' && pointless));

  /** Reported at the FIRST refused threshold compaction, not when the condition is detected: the seeded
   *  detection runs on every respawn, and a conversation that never grows near its trigger must not open
   *  with an error about a compaction it will never attempt. The refusal is the moment the condition
   *  actually costs the user something, so that is when they are told. */
  const reportPointless = (): void => {
    const trigger = options.thresholdBudget?.trigger;
    if (pointlessReported || lastFloorEstimate === null || trigger == null) return;
    pointlessReported = true;
    log.warn(
      `post-compaction context (est. ${lastFloorEstimate} tokens incl. system+tools) stays at/above the ${trigger}-token auto-compact trigger on ${options.sessionId}; `
      + 'automatic threshold compaction stopped — each further attempt would loop at full summarization cost',
    );
    options.onTripped?.(compactionUnreachableMessage(lastFloorEstimate, trigger));
  };

  const extension = (pi: ExtensionAPI): void => {
    // A manual /compact is never refused: it is the user's own recovery lever, and succeeding with it
    // resets the counter. Only the attempts PI repeats unattended are stopped.
    pi.on('session_before_compact', (event) => {
      if (!blocks(event.reason)) return undefined;
      // Failure trips carry their own report (at trip time); only a refusal whose operative cause is the
      // unreachable threshold announces that condition.
      if (event.reason === 'threshold' && pointless && !tripped()) reportPointless();
      return { cancel: true };
    });
  };

  const observe = (event: AgentSessionEvent): void => {
    if (event.type === 'compaction_start') {
      attemptStarted = true;
      return;
    }
    if (event.type !== 'compaction_end') return;
    const started = attemptStarted;
    attemptStarted = false;
    // `aborted` covers both the user cancelling and this breaker's own cancel — neither is evidence that
    // compaction cannot work, so neither moves the counter.
    if (event.aborted) return;
    if (event.result != null) {
      consecutiveFailures = 0;
      reported = false;
      // Measure the post-compaction floor from what PI itself estimated it kept after the reload, plus
      // the never-shrinking fixed cost — the two together are what the next shouldCompact check sees.
      // Extension-supplied compactions carry no estimate; keep the last known floor in that case.
      if (event.result.estimatedTokensAfter !== undefined) {
        lastFloorEstimate = (options.thresholdBudget?.fixedCostTokens ?? 0) + event.result.estimatedTokensAfter;
        evaluatePointless();
      }
      return;
    }
    if (!started) return;
    consecutiveFailures += 1;
    // Below the limit the session is free again — including after an operator RAISED the limit past a
    // count that had already tripped it, which must be able to trip (and report) a second time.
    if (!tripped()) { reported = false; return; }
    if (reported) return;
    reported = true;
    log.warn(`compaction failed ${consecutiveFailures} times in a row on ${options.sessionId}; automatic compaction is now stopped for this session`);
    options.onTripped?.(compactionStoppedMessage(consecutiveFailures));
  };

  const applyBudget = (floorEstimate?: number | null): void => {
    if (floorEstimate !== undefined) lastFloorEstimate = floorEstimate;
    evaluatePointless();
  };

  return { extension, observe, blocks, applyBudget };
}
