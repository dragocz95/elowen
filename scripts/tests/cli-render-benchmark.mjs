import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const VIEWPORT_HISTORY_PAIRS = Object.freeze([100, 1_000, 5_000]);
export const VIEWPORT_FRAME_SAMPLES = 40;
export const VIEWPORT_FRAME_LIMIT_MS = 50;

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  const nearestRankIndex = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[Math.min(sorted.length - 1, nearestRankIndex)] ?? 0;
}

export function summarizeViewportTimings(values) {
  const samples = [...values];
  const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  return {
    average: Number(average.toFixed(3)),
    p95: Number(percentile(samples, 0.95).toFixed(3)),
    max: Number(Math.max(...samples).toFixed(3)),
    samples,
  };
}

function finiteNonNegative(value) {
  return Number.isFinite(value) && value >= 0;
}

function validateFrameTimings(result, prefix, pairs) {
  const average = result[`${prefix}AvgMs`];
  const p95 = result[`${prefix}P95Ms`];
  const maximum = result[`${prefix}MaxMs`];
  const samples = result[`${prefix}SamplesMs`];
  if (!Array.isArray(samples) || samples.length !== VIEWPORT_FRAME_SAMPLES
    || samples.some((sample) => !finiteNonNegative(sample))) {
    throw new Error(`missing or invalid ${prefix}SamplesMs for ${pairs}-pair history`);
  }
  const expected = summarizeViewportTimings(samples);
  if (average !== expected.average || p95 !== expected.p95 || maximum !== expected.max) {
    throw new Error(`inconsistent ${prefix} timing summary for ${pairs}-pair history`);
  }
  if (maximum < p95 || maximum < average || maximum > VIEWPORT_FRAME_LIMIT_MS
    || samples.some((sample) => sample > VIEWPORT_FRAME_LIMIT_MS)) {
    throw new Error(`${prefix} frame exceeds ${VIEWPORT_FRAME_LIMIT_MS}ms for ${pairs}-pair history`);
  }
}

export function validateViewportBenchmarkReport(report) {
  if (report?.benchmark !== 'cli-viewport-frame') throw new Error('unexpected benchmark name');
  if (report?.samples?.scroll !== VIEWPORT_FRAME_SAMPLES || report?.samples?.stream !== VIEWPORT_FRAME_SAMPLES) {
    throw new Error(`viewport benchmark requires ${VIEWPORT_FRAME_SAMPLES} scroll and stream samples`);
  }
  if (!Array.isArray(report.results)) throw new Error('results must be an array');
  if (report.results.length !== VIEWPORT_HISTORY_PAIRS.length) throw new Error('unexpected viewport result count');
  for (const pairs of VIEWPORT_HISTORY_PAIRS) {
    const result = report.results.find((candidate) => candidate?.pairs === pairs);
    if (!result) throw new Error(`missing ${pairs}-pair history`);
    if (result.turns !== pairs * 2 + 1) throw new Error(`unexpected turn count for ${pairs}-pair history`);
    if (!finiteNonNegative(result.initialMs)) throw new Error(`missing or invalid initialMs for ${pairs}-pair history`);
    validateFrameTimings(result, 'scroll', pairs);
    validateFrameTimings(result, 'stream', pairs);
    const metrics = result.finalViewport;
    if (!metrics || typeof metrics !== 'object') throw new Error(`missing finalViewport for ${pairs}-pair history`);
    for (const key of [
      'transcriptRows', 'visibleRows', 'renderedTurns', 'reconciledTurns', 'indexedTurns',
      'cachedRows', 'layoutVisits', 'scrollOffset', 'maxScrollOffset', 'heightIndexOperations',
      'frameHeightIndexOperations',
    ]) {
      if (!Number.isSafeInteger(metrics[key]) || metrics[key] < 0) {
        throw new Error(`missing or invalid finalViewport.${key} for ${pairs}-pair history`);
      }
    }
    if (!finiteNonNegative(metrics.renderMs)) throw new Error(`missing or invalid finalViewport.renderMs for ${pairs}-pair history`);
    if (typeof metrics.transcriptRowsExact !== 'boolean') {
      throw new Error(`missing or invalid finalViewport.transcriptRowsExact for ${pairs}-pair history`);
    }
    if (metrics.renderedTurns > 1 || metrics.reconciledTurns > 1 || metrics.layoutVisits > 1
      || metrics.indexedTurns > 64 || metrics.cachedRows > 2_048
      || metrics.frameHeightIndexOperations > 512 || metrics.scrollOffset > metrics.maxScrollOffset) {
      throw new Error(`unbounded finalViewport metrics for ${pairs}-pair history`);
    }
  }
}

function history(pairs) {
  return Array.from({ length: pairs }, (_, index) => [
    { role: 'user', text: `question ${index}` },
    { role: 'assistant', text: `## answer ${index}\n\n- evidence one\n- evidence two\n\nmarker ${index}` },
  ]).flat();
}

export async function loadViewportRuntime(root, importer = (specifier) => import(specifier)) {
  const [{ initTheme, getMarkdownTheme }, { ChatViewport }, { TranscriptModel }] = await Promise.all([
    importer('@earendil-works/pi-coding-agent'),
    importer(pathToFileURL(resolve(root, 'dist/cli/chat/chatViewport.js')).href),
    importer(pathToFileURL(resolve(root, 'dist/brain/transcriptModel.js')).href),
  ]);
  return { initTheme, getMarkdownTheme, ChatViewport, TranscriptModel };
}

export async function runViewportBenchmark({ root = process.cwd(), runtime } = {}) {
  root = resolve(root);
  const { initTheme, getMarkdownTheme, ChatViewport, TranscriptModel } = runtime ?? await loadViewportRuntime(root);
  initTheme();

  const results = [];
  for (const pairs of VIEWPORT_HISTORY_PAIRS) {
    const transcript = new TranscriptModel(history(pairs));
    const viewport = new ChatViewport(
      { transcript, transcriptNotice: transcript.notice, notice: '', modelName: 'benchmark', thinkingSeconds: 0 },
      getMarkdownTheme(), () => 18, () => 1, () => 80,
    );
    const initialStarted = performance.now();
    viewport.render(80);
    const initialMs = performance.now() - initialStarted;
    const frameMs = [];
    for (let index = 0; index < VIEWPORT_FRAME_SAMPLES; index += 1) {
      viewport.scroll(index % 2 === 0 ? 3 : -3);
      const started = performance.now();
      viewport.render(80);
      frameMs.push(performance.now() - started);
    }
    transcript.apply({ type: 'text', delta: '' });
    viewport.setState({ transcript, transcriptNotice: transcript.notice, notice: '', modelName: 'benchmark', thinkingSeconds: 0 });
    viewport.render(80);
    const streamMs = [];
    for (let index = 0; index < VIEWPORT_FRAME_SAMPLES; index += 1) {
      transcript.apply({ type: 'text', delta: ` token-${index}` });
      viewport.setState({ transcript, transcriptNotice: transcript.notice, notice: '', modelName: 'benchmark', thinkingSeconds: 0 });
      const started = performance.now();
      viewport.render(80);
      streamMs.push(performance.now() - started);
    }
    const scroll = summarizeViewportTimings(frameMs);
    const stream = summarizeViewportTimings(streamMs);
    results.push({
      pairs,
      turns: transcript.turnCount,
      initialMs: Number(initialMs.toFixed(3)),
      scrollAvgMs: scroll.average,
      scrollP95Ms: scroll.p95,
      scrollMaxMs: scroll.max,
      scrollSamplesMs: scroll.samples,
      streamAvgMs: stream.average,
      streamP95Ms: stream.p95,
      streamMaxMs: stream.max,
      streamSamplesMs: stream.samples,
      finalViewport: viewport.metrics(),
    });
  }

  const report = {
    benchmark: 'cli-viewport-frame',
    root,
    node: process.version,
    samples: { scroll: VIEWPORT_FRAME_SAMPLES, stream: VIEWPORT_FRAME_SAMPLES },
    results,
  };
  validateViewportBenchmarkReport(report);
  return report;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  const rootArg = process.argv.indexOf('--root');
  const report = await runViewportBenchmark({
    root: rootArg >= 0 ? process.argv[rootArg + 1] : process.cwd(),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
