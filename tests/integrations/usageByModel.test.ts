import { describe, it, expect } from 'vitest';
import { aggregateUsageByExec, execOfLabels } from '../../src/integrations/usage/byModel.js';
import type { TokenUsage } from '../../src/integrations/usage/types.js';

const u = (input: number, output: number, total: number, costUsd: number | null = null): TokenUsage =>
  ({ input, output, cacheRead: 0, cacheWrite: 0, total, costUsd });

describe('execOfLabels', () => {
  it('extracts the exec spec, or empty string', () => {
    expect(execOfLabels(['exec:sonnet', 'agent:x'])).toBe('sonnet');
    expect(execOfLabels(['exec:codex:gpt-5.5'])).toBe('codex:gpt-5.5');
    expect(execOfLabels(['agent:x'])).toBe('');
    expect(execOfLabels(undefined)).toBe('');
  });
});

describe('aggregateUsageByExec', () => {
  it('sums usage per exec, skipping label-less and usage-less tasks', () => {
    const tasks = [
      { id: 'a', labels: ['exec:sonnet'] },
      { id: 'b', labels: ['exec:opus'] },
      { id: 'c', labels: ['exec:sonnet'] },
      { id: 'd', labels: [] },            // no exec → skipped
      { id: 'e', labels: ['exec:opus'] }, // null usage → skipped
    ];
    const usage: Record<string, TokenUsage | null> = {
      a: u(100, 50, 150, 0.1),
      b: u(200, 80, 280, 0.2),
      c: u(10, 5, 15, null), // contributes tokens but no cost
      e: null,
    };
    const out = aggregateUsageByExec(tasks, (t) => usage[t.id] ?? null);

    expect(out).toEqual([
      { exec: 'sonnet', usage: { input: 110, output: 55, cacheRead: 0, cacheWrite: 0, total: 165, costUsd: 0.1 } },
      { exec: 'opus', usage: { input: 200, output: 80, cacheRead: 0, cacheWrite: 0, total: 280, costUsd: 0.2 } },
    ]);
  });

  it('returns an empty list when nothing has usage', () => {
    const tasks = [{ id: 'a', labels: ['exec:sonnet'] }];
    expect(aggregateUsageByExec(tasks, () => null)).toEqual([]);
  });
});
