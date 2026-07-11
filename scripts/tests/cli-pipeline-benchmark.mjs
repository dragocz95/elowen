import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export const PIPELINE_HISTORY_TURNS = Object.freeze([200, 10_000, 40_000]);

function finiteTiming(value) {
  return value
    && Number.isFinite(value.average)
    && value.average >= 0
    && Number.isFinite(value.p95)
    && value.p95 >= 0;
}

/** Keep the machine-readable baseline useful to later rewrite tasks. A render-only benchmark is not a
 * substitute: every required history must expose both the reducer cost and the complete event-to-frame
 * cost that also includes active-state selection, viewport handoff and rendering. */
export function validatePipelineBenchmarkReport(report) {
  if (report?.benchmark !== 'cli-brain-event-to-frame') throw new Error('unexpected benchmark name');
  if (!Number.isInteger(report.samples) || report.samples < 1) throw new Error('samples must be a positive integer');
  if (!Array.isArray(report.results)) throw new Error('results must be an array');
  for (const historyTurns of PIPELINE_HISTORY_TURNS) {
    const result = report.results.find((candidate) => candidate?.historyTurns === historyTurns);
    if (!result) throw new Error(`missing ${historyTurns}-turn history`);
    if (result.eventType !== 'subagent') throw new Error(`unexpected event type for ${historyTurns}-turn history`);
    if (!finiteTiming(result.reducerMs)) throw new Error(`missing or invalid reducerMs for ${historyTurns}-turn history`);
    if (!finiteTiming(result.eventToFrameMs)) throw new Error(`missing or invalid eventToFrameMs for ${historyTurns}-turn history`);
  }
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  const nearestRankIndex = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[Math.min(sorted.length - 1, nearestRankIndex)] ?? 0;
}

export function summarizeTimings(values) {
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    average: Number(average.toFixed(3)),
    p95: Number(percentile(values, 0.95).toFixed(3)),
  };
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function history(turns) {
  return Array.from({ length: turns }, (_, index) => index === 0
    ? {
        role: 'assistant',
        text: '',
        segments: [{ kind: 'tool', id: 'benchmark-delegate', name: 'delegate', detail: 'inspect the architecture' }],
      }
    : { role: 'assistant', text: `settled answer ${index}` });
}

async function loadRuntime(root) {
  const [{ initTheme, getMarkdownTheme }, { ChatViewport }, { TranscriptModel }] = await Promise.all([
    import('@earendil-works/pi-coding-agent'),
    import(pathToFileURL(resolve(root, 'dist/cli/chat/layout.js')).href),
    import(pathToFileURL(resolve(root, 'dist/brain/transcriptModel.js')).href),
  ]);
  return { initTheme, getMarkdownTheme, ChatViewport, TranscriptModel };
}

export async function runPipelineBenchmark({ root = process.cwd(), samples = 20, runtime } = {}) {
  root = resolve(root);
  samples = parsePositiveInteger(samples, 20);
  const { initTheme, getMarkdownTheme, ChatViewport, TranscriptModel } = runtime ?? await loadRuntime(root);
  initTheme();

  const results = [];
  for (const historyTurns of PIPELINE_HISTORY_TURNS) {
    const parentTranscript = new TranscriptModel(history(historyTurns));
    const state = { parentTranscript, childTranscript: null };
    const viewport = new ChatViewport(
      {
        transcript: parentTranscript,
        transcriptNotice: parentTranscript.view.notice,
        notice: '', modelName: 'benchmark', thinkingSeconds: 0,
      },
      getMarkdownTheme(), () => 18, () => 1, () => 80,
    );
    viewport.render(80);

    const reducerSamples = [];
    const eventToFrameSamples = [];
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
      parentTranscript.apply(event);
      reducerSamples.push(performance.now() - reducerStarted);

      // This deliberately mirrors the current application handoff instead of calling render in
      // isolation: apply the BrainEvent, publish parent state, select the active view, then frame it.
      state.parentTranscript = parentTranscript;
      const activeTranscript = state.childTranscript ?? state.parentTranscript;
      viewport.setState({
        transcript: activeTranscript,
        transcriptNotice: activeTranscript.view.notice,
        notice: '', modelName: 'benchmark', thinkingSeconds: 0,
      });
      viewport.render(80);
      eventToFrameSamples.push(performance.now() - eventStarted);
    }

    results.push({
      historyTurns,
      eventType: 'subagent',
      reducerMs: summarizeTimings(reducerSamples),
      eventToFrameMs: summarizeTimings(eventToFrameSamples),
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
    samples: samplesArg >= 0 ? process.argv[samplesArg + 1] : 20,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
