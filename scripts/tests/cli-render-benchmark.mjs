import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const rootArg = process.argv.indexOf('--root');
const root = resolve(rootArg >= 0 ? process.argv[rootArg + 1] : process.cwd());
const [{ initTheme, getMarkdownTheme }, { ChatViewport }, { TranscriptModel }] = await Promise.all([
  import('@earendil-works/pi-coding-agent'),
  import(pathToFileURL(resolve(root, 'dist/cli/chat/chatViewport.js')).href),
  import(pathToFileURL(resolve(root, 'dist/brain/transcriptModel.js')).href),
]);
initTheme();

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

function history(pairs) {
  return Array.from({ length: pairs }, (_, index) => [
    { role: 'user', text: `question ${index}` },
    { role: 'assistant', text: `## answer ${index}\n\n- evidence one\n- evidence two\n\nmarker ${index}` },
  ]).flat();
}

const results = [];
for (const pairs of [100, 1_000, 5_000]) {
  const transcript = new TranscriptModel(history(pairs));
  const viewport = new ChatViewport(
    { transcript, transcriptNotice: transcript.notice, notice: '', modelName: 'benchmark', thinkingSeconds: 0 },
    getMarkdownTheme(), () => 18, () => 1, () => 80,
  );
  const initialStarted = performance.now();
  viewport.render(80);
  const initialMs = performance.now() - initialStarted;
  const frameMs = [];
  for (let index = 0; index < 40; index += 1) {
    viewport.scroll(index % 2 === 0 ? 3 : -3);
    const started = performance.now();
    viewport.render(80);
    frameMs.push(performance.now() - started);
  }
  transcript.apply({ type: 'text', delta: '' });
  viewport.setState({ transcript, transcriptNotice: transcript.notice, notice: '', modelName: 'benchmark', thinkingSeconds: 0 });
  viewport.render(80);
  const streamMs = [];
  for (let index = 0; index < 40; index += 1) {
    transcript.apply({ type: 'text', delta: ` token-${index}` });
    viewport.setState({ transcript, transcriptNotice: transcript.notice, notice: '', modelName: 'benchmark', thinkingSeconds: 0 });
    const started = performance.now();
    viewport.render(80);
    streamMs.push(performance.now() - started);
  }
  results.push({
    pairs,
    turns: transcript.turnCount,
    initialMs: Number(initialMs.toFixed(3)),
    scrollAvgMs: Number((frameMs.reduce((sum, value) => sum + value, 0) / frameMs.length).toFixed(3)),
    scrollP95Ms: Number(percentile(frameMs, 0.95).toFixed(3)),
    streamAvgMs: Number((streamMs.reduce((sum, value) => sum + value, 0) / streamMs.length).toFixed(3)),
    streamP95Ms: Number(percentile(streamMs, 0.95).toFixed(3)),
  });
}

process.stdout.write(`${JSON.stringify({ root, node: process.version, results }, null, 2)}\n`);
