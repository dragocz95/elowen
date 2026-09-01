import { statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { UsageOriginStore } from '../../src/store/usageOriginStore.js';

export interface UsageResetPerformanceSample {
  durationMs: number;
  walBytes: number;
  chatCleared: number;
  originsCleared: number;
}

export function runUsageResetPerformanceSample(path: string): UsageResetPerformanceSample {
  const db = openDb(path, { migrate: false });
  try {
    const brain = new BrainStore(db);
    const origins = new UsageOriginStore(db);
    const started = performance.now();
    const result = brain.resetUsage(1, () => origins.clearForUser(1));
    const durationMs = performance.now() - started;
    let walBytes = 0;
    try { walBytes = statSync(`${path}-wal`).size; } catch { walBytes = 0; }
    return { durationMs, walBytes, ...result };
  } finally {
    db.close();
  }
}
