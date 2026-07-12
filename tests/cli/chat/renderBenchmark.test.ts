import { describe, expect, it } from 'vitest';
import { getMarkdownTheme, initTheme } from '@earendil-works/pi-coding-agent';
import { TranscriptModel } from '../../../src/brain/transcriptModel.js';
import { ChatViewport } from '../../../src/cli/chat/chatViewport.js';
// The benchmark is an executable repository script rather than compiled application source.
// @ts-expect-error JavaScript benchmark modules intentionally have no declaration file.
import {
  VIEWPORT_FRAME_SAMPLES,
  VIEWPORT_HISTORY_PAIRS,
  loadViewportRuntime,
  runViewportBenchmark,
  summarizeViewportTimings,
  validateViewportBenchmarkReport,
} from '../../../scripts/tests/cli-render-benchmark.mjs';

const timingFields = (prefix: 'scroll' | 'stream', samples: number[]) => {
  const summary = summarizeViewportTimings(samples);
  return {
    [`${prefix}AvgMs`]: summary.average,
    [`${prefix}P95Ms`]: summary.p95,
    [`${prefix}MaxMs`]: summary.max,
    [`${prefix}SamplesMs`]: summary.samples,
  };
};

describe('CLI viewport benchmark contract', () => {
  it('uses the same conventional nearest-rank p95 as the pipeline benchmark', () => {
    expect(summarizeViewportTimings(Array.from({ length: 20 }, (_, index) => index + 1))).toEqual({
      average: 10.5,
      p95: 19,
      max: 20,
      samples: Array.from({ length: 20 }, (_, index) => index + 1),
    });
  });

  it('requires final structural viewport metrics in every result', () => {
    const report = {
      benchmark: 'cli-viewport-frame',
      samples: { scroll: 40, stream: 40 },
      results: [100, 1_000, 5_000].map((pairs) => ({
        pairs,
        turns: pairs * 2 + 1,
        initialMs: 1,
        ...timingFields('scroll', Array.from({ length: 40 }, () => 1)),
        ...timingFields('stream', Array.from({ length: 40 }, () => 2)),
        finalViewport: {
          renderMs: 1,
          transcriptRows: 20,
          transcriptRowsExact: false,
          visibleRows: 18,
          renderedTurns: 1,
          reconciledTurns: 1,
          indexedTurns: 14,
          cachedRows: 30,
          layoutVisits: 1,
          scrollOffset: 0,
          maxScrollOffset: 2,
          heightIndexOperations: 120,
          frameHeightIndexOperations: 20,
        },
      })),
    };
    expect(() => validateViewportBenchmarkReport(report)).not.toThrow();

    const missingMetrics = structuredClone(report);
    delete (missingMetrics.results[0] as { finalViewport?: unknown }).finalViewport;
    expect(() => validateViewportBenchmarkReport(missingMetrics)).toThrow(/finalViewport/);

    const fractionalMetrics = structuredClone(report);
    fractionalMetrics.results[0]!.finalViewport.renderedTurns = 0.5;
    expect(() => validateViewportBenchmarkReport(fractionalMetrics)).toThrow(/renderedTurns/);

    const slowFrame = structuredClone(report);
    const samples = [...Array.from({ length: 39 }, () => 1), 500];
    Object.assign(slowFrame.results[0]!, timingFields('scroll', samples));
    expect(() => validateViewportBenchmarkReport(slowFrame)).toThrow(/50ms/);
  });

  it('executes exact histories and sample counts through the production viewport/model classes', async () => {
    const transcriptLengths: number[] = [];
    let viewportRenders = 0;
    class InstrumentedTranscriptModel extends TranscriptModel {
      constructor(history: ConstructorParameters<typeof TranscriptModel>[0]) {
        transcriptLengths.push(history.length);
        super(history);
      }
    }
    class InstrumentedViewport extends ChatViewport {
      override render(width: number): string[] {
        viewportRenders++;
        return super.render(width);
      }
    }

    const report = await runViewportBenchmark({
      runtime: {
        initTheme,
        getMarkdownTheme,
        ChatViewport: InstrumentedViewport,
        TranscriptModel: InstrumentedTranscriptModel,
      },
    });

    expect(VIEWPORT_HISTORY_PAIRS).toEqual([100, 1_000, 5_000]);
    expect(VIEWPORT_FRAME_SAMPLES).toBe(40);
    expect(transcriptLengths).toEqual([200, 2_000, 10_000]);
    expect(viewportRenders).toBe(3 * (1 + VIEWPORT_FRAME_SAMPLES + 1 + VIEWPORT_FRAME_SAMPLES));
    expect(report.samples).toEqual({ scroll: 40, stream: 40 });
    expect(report.results.map((result: { pairs: number; turns: number }) => [result.pairs, result.turns]))
      .toEqual([[100, 201], [1_000, 2_001], [5_000, 10_001]]);
  });

  it('loads the built production viewport and transcript module paths', async () => {
    const requested: string[] = [];
    const importer = async (specifier: string): Promise<Record<string, unknown>> => {
      requested.push(specifier);
      if (specifier === '@earendil-works/pi-coding-agent') return { initTheme, getMarkdownTheme };
      if (specifier.endsWith('/dist/cli/chat/chatViewport.js')) return { ChatViewport };
      if (specifier.endsWith('/dist/brain/transcriptModel.js')) return { TranscriptModel };
      throw new Error(`unexpected import ${specifier}`);
    };
    await loadViewportRuntime('/tmp/elowen-benchmark-root', importer);
    expect(requested[0]).toBe('@earendil-works/pi-coding-agent');
    expect(requested[1]).toMatch(/\/dist\/cli\/chat\/chatViewport\.js$/);
    expect(requested[2]).toMatch(/\/dist\/brain\/transcriptModel\.js$/);
  });
});
