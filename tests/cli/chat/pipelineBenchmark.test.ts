import { describe, expect, it } from 'vitest';
// The benchmark is an executable repository script rather than compiled application source.
// @ts-expect-error JavaScript benchmark modules intentionally have no declaration file.
import { PIPELINE_HISTORY_TURNS, validatePipelineBenchmarkReport } from '../../../scripts/tests/cli-pipeline-benchmark.mjs';

describe('CLI whole-pipeline benchmark contract', () => {
  it('reports reducer and complete event-to-frame timings for every required history size', () => {
    expect(PIPELINE_HISTORY_TURNS).toEqual([200, 10_000, 40_000]);

    const report = {
      benchmark: 'cli-brain-event-to-frame',
      samples: 2,
      results: PIPELINE_HISTORY_TURNS.map((historyTurns: number) => ({
        historyTurns,
        eventType: 'subagent',
        reducerMs: { average: 1, p95: 2 },
        eventToFrameMs: { average: 3, p95: 4 },
      })),
    };

    expect(() => validatePipelineBenchmarkReport(report)).not.toThrow();
  });

  it('rejects a render-only result that omits reducer timing', () => {
    const renderOnly = {
      benchmark: 'cli-brain-event-to-frame',
      samples: 1,
      results: PIPELINE_HISTORY_TURNS.map((historyTurns: number) => ({
        historyTurns,
        eventType: 'subagent',
        eventToFrameMs: { average: 1, p95: 1 },
      })),
    };

    expect(() => validatePipelineBenchmarkReport(renderOnly)).toThrow(/reducerMs/);
  });
});
