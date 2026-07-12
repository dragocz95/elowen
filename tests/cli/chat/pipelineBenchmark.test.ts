import { describe, expect, it } from 'vitest';
import { getMarkdownTheme, initTheme } from '@earendil-works/pi-coding-agent';
import { TranscriptModel } from '../../../src/brain/transcriptModel.js';
import { ChatViewport } from '../../../src/cli/chat/chatViewport.js';
// The benchmark is an executable repository script rather than compiled application source.
// @ts-expect-error JavaScript benchmark modules intentionally have no declaration file.
import {
  PIPELINE_HISTORY_TURNS,
  PIPELINE_SAMPLE_COUNT,
  PIPELINE_FRAME_LIMIT_MS,
  runPipelineBenchmark,
  summarizeTimings,
  validatePipelineBenchmarkReport,
} from '../../../scripts/tests/cli-pipeline-benchmark.mjs';

const timing = (sampleCount: number, value: number) => ({
  average: value,
  p95: value,
  max: value,
  samples: Array.from({ length: sampleCount }, () => value),
});

const sampledCounter = (sampleCount: number, value: number, maximumKey: string, totalKey = 'total') => ({
  [totalKey]: value * sampleCount,
  [maximumKey]: value,
  samples: Array.from({ length: sampleCount }, () => value),
});

const sampledState = (sampleCount: number, value: number) => ({
  initial: value,
  final: value,
  min: value,
  max: value,
  maxDeltaPerFrame: 0,
  samples: Array.from({ length: sampleCount }, () => value),
});

const boundedOperations = (sampleCount: number) => ({
  reducerTurnVisits: sampledCounter(sampleCount, 1, 'maxPerEvent'),
  viewportTurnVisits: sampledCounter(sampleCount, 1, 'maxPerFrame'),
  renderedTurns: sampledCounter(sampleCount, 0, 'maxPerFrame'),
  reconciledTurns: sampledCounter(sampleCount, 1, 'maxPerFrame'),
  indexedTurns: sampledState(sampleCount, 13),
  cachedRows: sampledState(sampleCount, 26),
  layoutVisits: sampledCounter(sampleCount, 0, 'maxPerFrame'),
  heightIndexOperations: sampledCounter(sampleCount, 80, 'maxDeltaPerFrame', 'totalDelta'),
  scrollOffset: sampledState(sampleCount, 0),
  maxScrollOffset: sampledState(sampleCount, 8),
});

describe('CLI whole-pipeline benchmark contract', () => {
  it('reports reducer and complete event-to-frame timings for every required history size', () => {
    expect(PIPELINE_HISTORY_TURNS).toEqual([200, 10_000, 40_000]);
    expect(PIPELINE_SAMPLE_COUNT).toBe(20);
    expect(PIPELINE_FRAME_LIMIT_MS).toBe(50);

    const report = {
      benchmark: 'cli-brain-event-to-frame',
      samples: 20,
      results: PIPELINE_HISTORY_TURNS.map((historyTurns: number) => ({
        historyTurns,
        eventType: 'subagent',
        reducerMs: timing(20, 1),
        eventToFrameMs: timing(20, 3),
        operations: boundedOperations(20),
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
        eventToFrameMs: timing(1, 1),
        operations: boundedOperations(1),
      })),
    };

    expect(() => validatePipelineBenchmarkReport(renderOnly)).toThrow(/reducerMs/);
  });

  it('retains the slowest sample and rejects any ordinary frame above fifty milliseconds', () => {
    const reducerSamples = Array.from({ length: 20 }, () => 1);
    const eventSamples = [...Array.from({ length: 19 }, () => 2), 500];
    const report = {
      benchmark: 'cli-brain-event-to-frame',
      samples: 20,
      results: PIPELINE_HISTORY_TURNS.map((historyTurns: number) => ({
        historyTurns,
        eventType: 'subagent',
        reducerMs: summarizeTimings(reducerSamples),
        eventToFrameMs: summarizeTimings(eventSamples),
        operations: boundedOperations(20),
      })),
    };
    expect(report.results[0]?.eventToFrameMs.max).toBe(500);
    expect(() => validatePipelineBenchmarkReport(report)).toThrow(/50ms|eventToFrameMs/);
  });

  it('rejects timing-only evidence and any steady event that visits more than one turn', () => {
    const timingOnly = {
      benchmark: 'cli-brain-event-to-frame',
      samples: 20,
      results: PIPELINE_HISTORY_TURNS.map((historyTurns: number) => ({
        historyTurns,
        eventType: 'subagent',
        reducerMs: timing(20, 1),
        eventToFrameMs: timing(20, 3),
      })),
    };
    expect(() => validatePipelineBenchmarkReport(timingOnly)).toThrow(/operations/);

    const unbounded = structuredClone(timingOnly);
    unbounded.results = PIPELINE_HISTORY_TURNS.map((historyTurns: number) => ({
      historyTurns,
      eventType: 'subagent',
      reducerMs: timing(20, 1),
      eventToFrameMs: timing(20, 3),
      operations: {
        ...boundedOperations(20),
        reducerTurnVisits: sampledCounter(20, 2, 'maxPerEvent'),
      },
    }));
    expect(() => validatePipelineBenchmarkReport(unbounded)).toThrow(/reducerTurnVisits/);
  });

  it('rejects zero, fractional and underreported structural samples', () => {
    const base = {
      benchmark: 'cli-brain-event-to-frame',
      samples: 20,
      results: PIPELINE_HISTORY_TURNS.map((historyTurns: number) => ({
        historyTurns,
        eventType: 'subagent',
        reducerMs: timing(20, 1),
        eventToFrameMs: timing(20, 3),
        operations: boundedOperations(20),
      })),
    };

    const zeroVisits = structuredClone(base);
    zeroVisits.results[0]!.operations.reducerTurnVisits = sampledCounter(20, 0, 'maxPerEvent');
    expect(() => validatePipelineBenchmarkReport(zeroVisits)).toThrow(/reducerTurnVisits/);

    const fractional = structuredClone(base);
    fractional.results[0]!.operations.viewportTurnVisits.samples[0] = 0.5;
    expect(() => validatePipelineBenchmarkReport(fractional)).toThrow(/viewportTurnVisits/);

    const underreported = structuredClone(base);
    underreported.results[0]!.operations.reconciledTurns.total = 19;
    expect(() => validatePipelineBenchmarkReport(underreported)).toThrow(/reconciledTurns/);

    const hiddenIndexDrop = structuredClone(base);
    hiddenIndexDrop.results[0]!.operations.indexedTurns.samples[0] = 0;
    expect(() => validatePipelineBenchmarkReport(hiddenIndexDrop)).toThrow(/indexedTurns/);
  });

  it('hard-gates viewport work independently of history depth', () => {
    const report = {
      benchmark: 'cli-brain-event-to-frame',
      samples: 20,
      results: PIPELINE_HISTORY_TURNS.map((historyTurns: number) => ({
        historyTurns,
        eventType: 'subagent',
        reducerMs: timing(20, 1),
        eventToFrameMs: timing(20, 3),
        operations: {
          ...boundedOperations(20),
          layoutVisits: sampledCounter(20, historyTurns, 'maxPerFrame'),
        },
      })),
    };
    expect(() => validatePipelineBenchmarkReport(report)).toThrow(/layoutVisits/);
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
      samples: 2,
      runtime: {
        initTheme,
        getMarkdownTheme,
        ChatViewport: InstrumentedViewport,
        TranscriptModel: InstrumentedTranscriptModel,
      },
    });

    expect(report.results.map((result: { historyTurns: number }) => result.historyTurns))
      .toEqual([200, 10_000, 40_000]);
    expect(visits).toEqual({ apply: 6, setState: 6, render: 9 });
    expect(report.results.every((result: { reducerMs: { average: number }; eventToFrameMs: { average: number } }) =>
      result.reducerMs.average >= 0 && result.eventToFrameMs.average >= result.reducerMs.average)).toBe(true);
    expect(report.results.every((result: { operations: ReturnType<typeof boundedOperations> }) =>
      result.operations.reducerTurnVisits.maxPerEvent <= 1
      && result.operations.viewportTurnVisits.maxPerFrame <= 1
      && result.operations.renderedTurns.maxPerFrame <= 1
      && result.operations.reconciledTurns.maxPerFrame <= 1
      && result.operations.indexedTurns.maxDeltaPerFrame <= 1
      && result.operations.cachedRows.max <= 2_048
      && result.operations.layoutVisits.maxPerFrame <= 1
      && result.operations.heightIndexOperations.maxDeltaPerFrame <= 512
      && result.operations.scrollOffset.max === 0)).toBe(true);
  });

  it('uses conventional nearest-rank p95 for twenty samples', () => {
    expect(summarizeTimings(Array.from({ length: 20 }, (_, index) => index + 1))).toEqual({
      average: 10.5,
      p95: 19,
      max: 20,
      samples: Array.from({ length: 20 }, (_, index) => index + 1),
    });
  });
});
