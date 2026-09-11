/** WEB MIRROR of `src/shared/effectiveSpeed.ts` — the web cannot import `src/` (Turbopack resolves
 *  imports relative to the web root; see `tests/contract/codeDiffMirror.test.ts`). Edit the SOURCE
 *  first, then copy its body over this one; the contract test keeps them byte-identical.
 *
 *  Effective generation speed, as the CLIENT observed it.
 *
 *  The canonical measurement lives at the provider-request seam
 *  (`src/brain/session/providerRequestRecorder.ts`): a logical model call is timed with a MONOTONIC
 *  clock from its initiation — before the provider's response headers are awaited — to the stream's
 *  terminal event. PI-level auto-retries and their backoff belong to the SAME logical request and are
 *  included; tool execution between model calls is a different seam and is never included. The
 *  numerator is whatever output tokens the provider reports for the delivered response, reasoning and
 *  tool-call tokens included — this is an effective end-to-end rate, NOT a pure decode rate.
 *
 *  This module is mirrored byte-for-byte into `web/lib/effectiveSpeed.ts` (the web cannot import
 *  `src/` — see `tests/contract/codeDiffMirror.test.ts` for why) — edit the source, then copy the
 *  mirror's body. Both sides must agree or the CLI and the stats page would average differently. */

/** One timed generation: the provider-reported output tokens and the monotonic ms they were measured
 *  over. Missing usage is never invented: a sample with a non-positive side is unmeasurable. */
export interface SpeedSample { output: number; elapsedMs: number }

/** tokens/sec for one timed generation; null unless BOTH sides are positive. No clipping, no minimum —
 *  a slow or absurd figure is a real observation about that call, and consumers label it. */
export function speedOf(output: number, elapsedMs: number): number | null {
  return output > 0 && elapsedMs > 0 ? output / (elapsedMs / 1000) : null;
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
    if (tps != null && tps > 0 && measured > 0) {
      output += measured;
      seconds += measured / tps;
    }
  }
  return seconds > 0 ? output / seconds : null;
}