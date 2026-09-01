import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runUsageResetPerformanceSample } from './usageResetPerfChild.js';

const databasePath = process.env.ELOWEN_USAGE_RESET_PERF_DB;
const samplePath = process.env.ELOWEN_USAGE_RESET_PERF_SAMPLE;

describe('usage reset performance child', () => {
  it.skipIf(!databasePath || !samplePath)('measures one real BrainStore reset', () => {
    const sample = runUsageResetPerformanceSample(databasePath!);
    expect(Number.isFinite(sample.durationMs)).toBe(true);
    expect(Number.isFinite(sample.walBytes)).toBe(true);
    writeFileSync(samplePath!, JSON.stringify(sample));
  });
});
