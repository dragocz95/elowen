/** Effective model-output speed.
 *
 *  The canonical measurement lives at the provider-request seam
 *  (`src/brain/session/providerRequestRecorder.ts`). Each successful provider response contributes its
 *  canonical normalized output-token count and only the monotonic generation window from the accepted
 *  response stream start to the terminal stream event. Prompt construction, provider queue/connect wait,
 *  failed attempts, retry backoff, tool execution and user/elicitation waits are outside that window.
 *  Provider output usage already includes visible text, hidden reasoning and serialized tool-call output;
 *  tool results are input to a later request and never enter this numerator.
 *
 *  A turn spanning text → tool → text is therefore Σ successful model output / Σ successful generation
 *  seconds. Never average request rates and never divide by turn wall time.
 *
 *  This module is mirrored byte-for-byte into `web/lib/effectiveSpeed.ts` (the web cannot import
 *  `src/` — see `tests/contract/codeDiffMirror.test.ts` for why) — edit the source, then copy the
 *  mirror's body. Both sides must agree or the CLI and the stats page would average differently. */

/** One timed successful generation. Missing, non-finite or non-positive sides are unmeasurable. */
export interface SpeedSample { output: number; elapsedMs: number }

/** tokens/sec for one timed generation; null unless BOTH sides are finite and positive. No clipping, no
 *  minimum: a slow figure is a real observation and consumers decide whether it is useful to render. */
export function speedOf(output: number, elapsedMs: number): number | null {
  if (!Number.isFinite(output) || !Number.isFinite(elapsedMs) || output <= 0 || elapsedMs <= 0) return null;
  const speed = output / (elapsedMs / 1000);
  return Number.isFinite(speed) && speed > 0 ? speed : null;
}

/** Exact numerator and denominator accumulated across successful model requests in one turn/model identity. */
export interface SpeedAggregate { output: number; elapsedMs: number }

/** Add one valid sample exactly once. Invalid samples leave the previous aggregate untouched. */
export function addSpeedSample(aggregate: SpeedAggregate, sample: SpeedSample): SpeedAggregate {
  if (speedOf(sample.output, sample.elapsedMs) == null) return aggregate;
  return { output: aggregate.output + sample.output, elapsedMs: aggregate.elapsedMs + sample.elapsedMs };
}

/** A rate plus the output slice it was measured over — the shape `/usage/by-model` and the rollup
 *  buckets ship, so cross-bucket averages can recover each bucket's measured seconds. */
export interface SpeedPair { tps?: number | null; measuredOutput?: number }

/** Duration-weighted average speed across samples that measured BOTH sides: Σoutput / Σseconds.
 *  Recovering a sample's seconds from its MEASURED output over its rate (never from its total output)
 *  keeps untimed history out of the denominator. An arithmetic mean of rates would overweight small
 *  runs; weighting by total `output` would credit tokens no rate ever covered. */
export function weightedSpeedFromPairs(pairs: readonly SpeedPair[]): number | null {
  let output = 0;
  let seconds = 0;
  for (const pair of pairs) {
    const tps = pair.tps;
    const measured = pair.measuredOutput ?? 0;
    if (tps != null && Number.isFinite(tps) && tps > 0 && Number.isFinite(measured) && measured > 0) {
      output += measured;
      seconds += measured / tps;
    }
  }
  return speedOf(output, seconds * 1000);
}