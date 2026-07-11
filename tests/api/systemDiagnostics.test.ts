import { describe, expect, it } from 'vitest';
import { createSystemDiagnosticsReader, type CpuSnapshot } from '../../src/api/systemDiagnostics.js';

const snapshot = (idle: number, total: number): CpuSnapshot => ({ idle, total });

describe('createSystemDiagnosticsReader', () => {
  it('reports CPU from the interval between reads and current memory and uptime', () => {
    const samples = [snapshot(400, 1_000), snapshot(430, 1_100)];
    const read = createSystemDiagnosticsReader({
      cpuSnapshot: () => samples.shift()!,
      totalMemory: () => 16_000,
      freeMemory: () => 6_000,
      uptime: () => 12_345,
    });

    expect(read()).toEqual({
      cpuPercent: 70,
      memoryUsedBytes: 10_000,
      memoryTotalBytes: 16_000,
      uptimeSeconds: 12_345,
    });
  });

  it('clamps invalid host values to a finite non-negative response', () => {
    const read = createSystemDiagnosticsReader({
      cpuSnapshot: () => snapshot(Number.NaN, Number.NaN),
      totalMemory: () => -1,
      freeMemory: () => Number.POSITIVE_INFINITY,
      uptime: () => -20,
    });

    expect(read()).toEqual({
      cpuPercent: 0,
      memoryUsedBytes: 0,
      memoryTotalBytes: 0,
      uptimeSeconds: 0,
    });
  });
});
