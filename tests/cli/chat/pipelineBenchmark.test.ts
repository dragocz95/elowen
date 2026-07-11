import { describe, expect, it } from 'vitest';
import { getMarkdownTheme, initTheme } from '@earendil-works/pi-coding-agent';
import { TranscriptModel } from '../../../src/brain/transcriptModel.js';
import { ChatViewport } from '../../../src/cli/chat/chatViewport.js';
// The benchmark is an executable repository script rather than compiled application source.
// @ts-expect-error JavaScript benchmark modules intentionally have no declaration file.
import {
  PIPELINE_HISTORY_TURNS,
  runPipelineBenchmark,
  summarizeTimings,
  validatePipelineBenchmarkReport,
} from '../../../scripts/tests/cli-pipeline-benchmark.mjs';

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

  it('executes reduction, state handoff and viewport rendering at every required history size', async () => {
    const visits = { apply: 0, setState: 0, render: 0 };
    class InstrumentedViewport extends ChatViewport {
      override setState(next: Parameters<ChatViewport['setState']>[0]): void {
        visits.setState++;
        super.setState(next);
      }
      override render(width: number): string[] {
        visits.render++;
        return super.render(width);
      }
    }
    class InstrumentedTranscriptModel extends TranscriptModel {
      override apply(event: Parameters<TranscriptModel['apply']>[0]): boolean {
        visits.apply++;
        return super.apply(event);
      }
    }

    const report = await runPipelineBenchmark({
      samples: 1,
      runtime: {
        initTheme,
        getMarkdownTheme,
        ChatViewport: InstrumentedViewport,
        TranscriptModel: InstrumentedTranscriptModel,
      },
    });

    expect(report.results.map((result: { historyTurns: number }) => result.historyTurns))
      .toEqual([200, 10_000, 40_000]);
    expect(visits).toEqual({ apply: 3, setState: 3, render: 6 });
    expect(report.results.every((result: { reducerMs: { average: number }; eventToFrameMs: { average: number } }) =>
      result.reducerMs.average >= 0 && result.eventToFrameMs.average >= result.reducerMs.average)).toBe(true);
  });

  it('uses conventional nearest-rank p95 for twenty samples', () => {
    expect(summarizeTimings(Array.from({ length: 20 }, (_, index) => index + 1))).toEqual({
      average: 10.5,
      p95: 19,
    });
  });
});
