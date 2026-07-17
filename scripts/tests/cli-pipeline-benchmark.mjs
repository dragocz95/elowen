import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export const PIPELINE_HISTORY_TURNS = Object.freeze([200, 10_000, 40_000]);
export const PIPELINE_SAMPLE_COUNT = 20;
export const PIPELINE_FRAME_LIMIT_MS = 50;

const PIPELINE_OPERATION_LIMITS = Object.freeze({
  steadyTurnVisits: 1,
  renderedTurns: 1,
  reconciledTurns: 1,
  indexedTurns: 64,
  cachedRows: 2_048,
  layoutVisits: 1,
  heightIndexOperations: 512,
  scrollOffset: 0,
  maxScrollOffset: 64,
});

function finiteCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateTiming(name, value, sampleCount) {
  if (!value || !Array.isArray(value.samples) || value.samples.length !== sampleCount
    || value.samples.some((sample) => !Number.isFinite(sample) || sample < 0)) {
    throw new Error(`missing or invalid ${name}.samples`);
  }
  const expected = summarizeTimings(value.samples);
  if (value.average !== expected.average || value.p95 !== expected.p95 || value.max !== expected.max) {
    throw new Error(`inconsistent ${name} summary`);
  }
  if (value.max < value.p95 || value.max < value.average) throw new Error(`inconsistent ${name} order`);
  if (value.max > PIPELINE_FRAME_LIMIT_MS
    || value.samples.some((sample) => sample > PIPELINE_FRAME_LIMIT_MS)) {
    throw new Error(`${name} exceeds ordinary frame limit of ${PIPELINE_FRAME_LIMIT_MS}ms`);
  }
}

function validateCounter(
  name,
  value,
  sampleCount,
  { maxPerSample, perSampleKey, totalKey = 'total', expectedPerSample, minimumPerSample = 0 },
) {
  if (!value || !Array.isArray(value.samples) || value.samples.length !== sampleCount
    || value.samples.some((sample) => !finiteCount(sample))) {
    throw new Error(`missing or invalid operations.${name}`);
  }
  const total = value.samples.reduce((sum, sample) => sum + sample, 0);
  const maximum = max(value.samples);
  if (!finiteCount(value[totalKey]) || !finiteCount(value[perSampleKey])
    || value[totalKey] !== total || value[perSampleKey] !== maximum) {
    throw new Error(`inconsistent operations.${name}`);
  }
  if (value.samples.some((sample) => sample < minimumPerSample || sample > maxPerSample)) {
    throw new Error(`unbounded operations.${name}`);
  }
  if (expectedPerSample != null && value.samples.some((sample) => sample !== expectedPerSample)) {
    throw new Error(`unexpected operations.${name}`);
  }
}

function validateStateCount(name, value, sampleCount, limit, expectedDelta, expectedValue) {
  if (!value || !Array.isArray(value.samples) || value.samples.length !== sampleCount
    || value.samples.some((sample) => !finiteCount(sample))
    || !['initial', 'final', 'min', 'max', 'maxDeltaPerFrame'].every((key) => finiteCount(value[key]))) {
    throw new Error(`missing or invalid operations.${name}`);
  }
  const all = [value.initial, ...value.samples];
  let previous = value.initial;
  let maximumDelta = 0;
  for (const sample of value.samples) {
    maximumDelta = Math.max(maximumDelta, Math.abs(sample - previous));
    previous = sample;
  }
  if (value.final !== (value.samples.at(-1) ?? value.initial)
    || value.min !== Math.min(...all)
    || value.max !== max(all)
    || value.maxDeltaPerFrame !== maximumDelta) {
    throw new Error(`inconsistent operations.${name}`);
  }
  if (value.max > limit) {
    throw new Error(`unbounded operations.${name}`);
  }
  if (expectedDelta != null && maximumDelta !== expectedDelta) {
    throw new Error(`unexpected operations.${name} delta`);
  }
  if (expectedValue != null && all.some((sample) => sample !== expectedValue)) {
    throw new Error(`unexpected operations.${name}`);
  }
}

function validateOperations(value, sampleCount) {
  if (!value || typeof value !== 'object') throw new Error('missing operations');
  validateCounter('reducerTurnVisits', value.reducerTurnVisits, sampleCount, {
    maxPerSample: PIPELINE_OPERATION_LIMITS.steadyTurnVisits, perSampleKey: 'maxPerEvent', expectedPerSample: 1,
  });
  validateCounter('viewportTurnVisits', value.viewportTurnVisits, sampleCount, {
    maxPerSample: PIPELINE_OPERATION_LIMITS.steadyTurnVisits, perSampleKey: 'maxPerFrame', expectedPerSample: 1,
  });
  validateCounter('renderedTurns', value.renderedTurns, sampleCount, {
    maxPerSample: PIPELINE_OPERATION_LIMITS.renderedTurns, perSampleKey: 'maxPerFrame', expectedPerSample: 0,
  });
  validateCounter('reconciledTurns', value.reconciledTurns, sampleCount, {
    maxPerSample: PIPELINE_OPERATION_LIMITS.reconciledTurns, perSampleKey: 'maxPerFrame', expectedPerSample: 1,
  });
  validateStateCount('indexedTurns', value.indexedTurns, sampleCount, PIPELINE_OPERATION_LIMITS.indexedTurns, 0);
  validateStateCount('cachedRows', value.cachedRows, sampleCount, PIPELINE_OPERATION_LIMITS.cachedRows, 0);
  validateCounter('layoutVisits', value.layoutVisits, sampleCount, {
    maxPerSample: PIPELINE_OPERATION_LIMITS.layoutVisits, perSampleKey: 'maxPerFrame', expectedPerSample: 0,
  });
  validateCounter('heightIndexOperations', value.heightIndexOperations, sampleCount, {
    maxPerSample: PIPELINE_OPERATION_LIMITS.heightIndexOperations,
    perSampleKey: 'maxDeltaPerFrame', totalKey: 'totalDelta', minimumPerSample: 1,
  });
  validateStateCount('scrollOffset', value.scrollOffset, sampleCount, PIPELINE_OPERATION_LIMITS.scrollOffset, 0, 0);
  validateStateCount('maxScrollOffset', value.maxScrollOffset, sampleCount, PIPELINE_OPERATION_LIMITS.maxScrollOffset, 0);
}

/** Keep the machine-readable baseline useful to later rewrite tasks. A render-only benchmark is not a
 * substitute: every required history must expose both the reducer cost and the complete event-to-frame
 * cost that also includes active-state selection, viewport handoff and rendering. */
export function validatePipelineBenchmarkReport(report) {
  if (report?.benchmark !== 'cli-brain-event-to-frame') throw new Error('unexpected benchmark name');
  if (!Number.isInteger(report.samples) || report.samples < 1) throw new Error('samples must be a positive integer');
  if (!Array.isArray(report.results)) throw new Error('results must be an array');
  if (report.results.length !== PIPELINE_HISTORY_TURNS.length) throw new Error('unexpected pipeline result count');
  for (const historyTurns of PIPELINE_HISTORY_TURNS) {
    const result = report.results.find((candidate) => candidate?.historyTurns === historyTurns);
    if (!result) throw new Error(`missing ${historyTurns}-turn history`);
    if (result.eventType !== 'subagent') throw new Error(`unexpected event type for ${historyTurns}-turn history`);
    validateTiming('reducerMs', result.reducerMs, report.samples);
    validateTiming('eventToFrameMs', result.eventToFrameMs, report.samples);
    for (let index = 0; index < report.samples; index += 1) {
      if (result.reducerMs.samples[index] > result.eventToFrameMs.samples[index]) {
        throw new Error(`reducerMs exceeds eventToFrameMs at sample ${index}`);
      }
    }
    validateOperations(result.operations, report.samples);
  }
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  const nearestRankIndex = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[Math.min(sorted.length - 1, nearestRankIndex)] ?? 0;
}

export function summarizeTimings(values) {
  const samples = [...values];
  const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  return {
    average: Number(average.toFixed(3)),
    p95: Number(percentile(samples, 0.95).toFixed(3)),
    max: Number(max(samples).toFixed(3)),
    samples,
  };
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function max(values) {
  return values.length > 0 ? Math.max(...values) : 0;
}

function counter(values, perSampleKey, totalKey = 'total') {
  return {
    [totalKey]: values.reduce((sum, value) => sum + value, 0),
    [perSampleKey]: max(values),
    samples: [...values],
  };
}

function stateCount(initial, values) {
  const all = [initial, ...values];
  const result = {
    initial,
    final: values.at(-1) ?? initial,
    min: Math.min(...all),
    max: max(all),
    samples: [...values],
  };
  let previous = initial;
  const deltas = values.map((value) => {
    const delta = Math.abs(value - previous);
    previous = value;
    return delta;
  });
  result.maxDeltaPerFrame = max(deltas);
  return result;
}

function range(initial, values) {
  return stateCount(initial, values);
}

function history(turns) {
  return Array.from({ length: turns }, (_, index) => index === 0
    ? {
        role: 'assistant',
        text: '',
        segments: [{ kind: 'tool', id: 'benchmark-delegate', name: 'Delegate', detail: 'inspect the architecture' }],
      }
    : { role: 'assistant', text: `settled answer ${index}` });
}

async function loadRuntime(root) {
  const [{ initTheme, getMarkdownTheme }, { ChatViewport }, { TranscriptModel }] = await Promise.all([
    import('@earendil-works/pi-coding-agent'),
    import(pathToFileURL(resolve(root, 'dist/cli/chat/chatViewport.js')).href),
    import(pathToFileURL(resolve(root, 'dist/brain/transcriptModel.js')).href),
  ]);
  return { initTheme, getMarkdownTheme, ChatViewport, TranscriptModel };
}

export async function runPipelineBenchmark({ root = process.cwd(), samples = PIPELINE_SAMPLE_COUNT, runtime } = {}) {
  root = resolve(root);
  samples = parsePositiveInteger(samples, 20);
  const { initTheme, getMarkdownTheme, ChatViewport, TranscriptModel } = runtime ?? await loadRuntime(root);
  initTheme();

  const results = [];
  for (const historyTurns of PIPELINE_HISTORY_TURNS) {
    let turnVisits = 0;
    const parentTranscript = new TranscriptModel(history(historyTurns), {
      onTurnVisit: () => { turnVisits += 1; },
    });
    const state = { parentTranscript, childTranscript: null };
    const viewport = new ChatViewport(
      {
        transcript: parentTranscript,
        transcriptNotice: parentTranscript.notice,
        notice: '', modelName: 'benchmark', thinkingSeconds: 0,
      },
      getMarkdownTheme(), () => 18, () => 1, () => 80,
    );
    viewport.render(80);
    const initialMetrics = viewport.metrics();

    const reducerSamples = [];
    const eventToFrameSamples = [];
    const reducerTurnVisits = [];
    const viewportTurnVisits = [];
    const renderedTurns = [];
    const reconciledTurns = [];
    const indexedTurns = [];
    const cachedRows = [];
    const layoutVisits = [];
    const heightIndexOperations = [];
    const scrollOffsets = [];
    const maxScrollOffsets = [];
    for (let index = 0; index < samples; index += 1) {
      const event = {
        type: 'subagent',
        id: 'benchmark-delegate',
        sessionId: 'benchmark-child',
        status: 'running',
        task: 'inspect the architecture',
        detail: `sample ${index}`,
        tools: index + 1,
        seconds: index,
      };
      const eventStarted = performance.now();
      const reducerStarted = performance.now();
      const visitsBeforeReducer = turnVisits;
      parentTranscript.apply(event);
      reducerSamples.push(performance.now() - reducerStarted);
      reducerTurnVisits.push(turnVisits - visitsBeforeReducer);

      // This deliberately mirrors the current application handoff instead of calling render in
      // isolation: apply the BrainEvent, publish parent state, select the active view, then frame it.
      state.parentTranscript = parentTranscript;
      const activeTranscript = state.childTranscript ?? state.parentTranscript;
      const visitsBeforeViewport = turnVisits;
      viewport.setState({
        transcript: activeTranscript,
        transcriptNotice: activeTranscript.notice,
        notice: '', modelName: 'benchmark', thinkingSeconds: 0,
      });
      viewport.render(80);
      const metrics = viewport.metrics();
      eventToFrameSamples.push(performance.now() - eventStarted);
      viewportTurnVisits.push(turnVisits - visitsBeforeViewport);
      renderedTurns.push(metrics.renderedTurns);
      reconciledTurns.push(metrics.reconciledTurns);
      indexedTurns.push(metrics.indexedTurns);
      cachedRows.push(metrics.cachedRows);
      layoutVisits.push(metrics.layoutVisits);
      heightIndexOperations.push(metrics.frameHeightIndexOperations);
      scrollOffsets.push(metrics.scrollOffset);
      maxScrollOffsets.push(metrics.maxScrollOffset);
    }

    results.push({
      historyTurns,
      eventType: 'subagent',
      reducerMs: summarizeTimings(reducerSamples),
      eventToFrameMs: summarizeTimings(eventToFrameSamples),
      operations: {
        reducerTurnVisits: counter(reducerTurnVisits, 'maxPerEvent'),
        viewportTurnVisits: counter(viewportTurnVisits, 'maxPerFrame'),
        renderedTurns: counter(renderedTurns, 'maxPerFrame'),
        reconciledTurns: counter(reconciledTurns, 'maxPerFrame'),
        indexedTurns: stateCount(initialMetrics.indexedTurns, indexedTurns),
        cachedRows: stateCount(initialMetrics.cachedRows, cachedRows),
        layoutVisits: counter(layoutVisits, 'maxPerFrame'),
        heightIndexOperations: counter(heightIndexOperations, 'maxDeltaPerFrame', 'totalDelta'),
        scrollOffset: range(initialMetrics.scrollOffset, scrollOffsets),
        maxScrollOffset: range(initialMetrics.maxScrollOffset, maxScrollOffsets),
      },
    });
  }

  const report = {
    benchmark: 'cli-brain-event-to-frame',
    root,
    node: process.version,
    samples,
    results,
  };
  validatePipelineBenchmarkReport(report);
  return report;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  const rootArg = process.argv.indexOf('--root');
  const samplesArg = process.argv.indexOf('--samples');
  const report = await runPipelineBenchmark({
    root: rootArg >= 0 ? process.argv[rootArg + 1] : process.cwd(),
    samples: samplesArg >= 0 ? process.argv[samplesArg + 1] : PIPELINE_SAMPLE_COUNT,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
