import { statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { UsageOriginStore } from '../../src/store/usageOriginStore.js';

/** Repetitions per database. The reset is a few milliseconds of real work, so a single sample on a busy
 *  host measures the scheduler; the minimum of a handful measures the work. */
export const REPEATS = 5;

export interface UsageResetPerformanceSample {
  /** Fastest reset observed against the LARGE corpus. */
  durationMs: number;
  /** Fastest reset observed against the small control corpus, on this same machine in this same process.
   *  The guard compares the two rather than checking a millisecond budget: what has to hold is that the
   *  reset is bounded work, not work proportional to the retained requests. */
  controlMs: number;
  walBytes: number;
  chatCleared: number;
  originsCleared: number;
}

/** Reset repeatedly and return the fastest observation. Each call advances the usage epoch by one, which
 *  is idempotent work of exactly the same shape, so the repetitions cost what the first one costs. */
function fastestReset(path: string, onFirst?: (result: { chatCleared: number; originsCleared: number }) => void): number {
  const db = openDb(path, { migrate: false });
  try {
    const brain = new BrainStore(db);
    const origins = new UsageOriginStore(db);
    let best = Infinity;
    for (let i = 0; i < REPEATS; i += 1) {
      const started = performance.now();
      const result = brain.resetUsage(1, () => origins.clearForUser(1));
      best = Math.min(best, performance.now() - started);
      if (i === 0) onFirst?.(result);
    }
    return best;
  } finally {
    db.close();
  }
}

export function runUsageResetPerformanceSample(path: string, controlPath: string): UsageResetPerformanceSample {
  let first = { chatCleared: 0, originsCleared: 0 };
  let walBytes = 0;
  const durationMs = fastestReset(path, (result) => {
    first = result;
    // Sampled after the FIRST reset: the bound is on what one reset writes, not on five.
    try { walBytes = statSync(`${path}-wal`).size; } catch { walBytes = 0; }
  });
  const controlMs = fastestReset(controlPath);
  return { durationMs, controlMs, walBytes, ...first };
}
