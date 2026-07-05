/** Where a run's cost figure came from — so the UI/logs never present an estimate as a fact:
 *  - `provider_reported`: the provider returned the actual billed cost (OpenRouter's `usage.cost`,
 *    opencode's recorded `cost`). This is the truth.
 *  - `calculated`: we derived it from a price sheet (no provider figure available). An estimate.
 *  - `unavailable`: no cost figure at all (e.g. claude/codex transcripts don't record one). */
export type CostSource = 'provider_reported' | 'calculated' | 'unavailable';

/** Normalized token usage for one agent run. Portable across executors: figures come either from a
 *  coding CLI's on-disk transcript (opencode / claude / codex) or from the embedded brain's live PI
 *  session (+ the provider's reported cost, when it sends one). */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  /** Reasoning/thinking tokens when the provider breaks them out. A SUBSET of `output` (output already
   *  includes them) — kept separately for display only, never added into totals. 0 when unknown. */
  reasoning: number;
  /** The run's cost. Interpret strictly via `costSource`: a number with `provider_reported` is billed
   *  truth; with `calculated` it's a price-sheet estimate; null (or `unavailable`) means no figure. */
  costUsd: number | null;
  /** ISO 4217-ish currency of `costUsd` (practically always 'USD'); null when there is no cost. */
  currency: string | null;
  /** Provenance of `costUsd` — see CostSource. */
  costSource: CostSource;
  /** Small, non-sensitive provider usage object (tokens + cost only) kept for debugging a
   *  provider_reported figure. Never contains prompt/response content or PII. Absent otherwise. */
  rawUsageMetadata?: Record<string, unknown> | null;
}

export const EMPTY_USAGE: TokenUsage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0,
  reasoning: 0, costUsd: null, currency: null, costSource: 'unavailable',
};

/** Tolerate small clock skew between when orca marks a task in_progress and when the CLI
 *  actually opens its session (a few seconds of startup). */
export const SESSION_MATCH_SKEW_MS = 15_000;
