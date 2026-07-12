import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  aggregateTmuxReports,
  analyzeActiveCapture,
  analyzeFrameDiagnostics,
  captureState,
  createArtifactDir,
  decodeLastOsc52,
  historyOffset,
  readFrames,
  readJsonLines,
  resolveArtifactDir,
  summarizeFrameDiagnostics,
} from './cli-tmux-support.mjs';

const frame = (overrides = {}) => ({
  type: 'frame',
  sequence: 1,
  at: 10,
  reasons: ['scroll:wheel'],
  forced: false,
  prepareMs: 1,
  queueMs: 2,
  rootRenderMs: 4,
  piTailMs: 1,
  transcriptMs: 2,
  totalMs: 8,
  transcriptRows: 80,
  visibleRows: 4,
  renderedTurns: 0,
  reconciledTurns: 0,
  indexedTurns: 4,
  cachedRows: 24,
  layoutVisits: 8,
  scrollOffset: 12,
  maxScrollOffset: 72,
  heightIndexOperations: 16,
  terminal: { columns: 40, rows: 10 },
  sections: {
    header: 1, transcript: 4, cards: 0, subagents: 0, queue: 0,
    attachments: 0, editor: 3, status: 1, hints: 1,
  },
  rootRows: 10,
  maxVisibleWidth: 40,
  reverseSpans: [{ stage: 'constrained', row: 7, from: 0, to: 1 }],
  ...overrides,
});

test('active capture analyzer enforces the terminal frame contract', () => {
  const plain = [
    ' elowen E2E Harness ----------------',
    ' transcript row',
    ' transcript row',
    ' transcript row',
    ' transcript row                 █',
    '----------------------------------------',
    '',
    '----------------------------------------',
    '  Build · e2e-model mock high',
    '  enter send · ctrl+c quit',
  ].join('\n') + '\n';
  const result = analyzeActiveCapture({
    label: 'valid', plain, ansi: plain, columns: 40, rows: 10,
    cursor: { x: 2, y: 6 }, frame: frame(), expectCursor: true,
  });
  assert.equal(result.rows, 10);
  assert.equal(result.statusRows, 1);
  assert.equal(result.maxVisibleWidth, 40);
  assert.equal(result.scrollbarVisible, true);
});

test('active capture analyzer rejects a duplicate footer and a reverse-video blank band', () => {
  const duplicate = `${'x\n'.repeat(6)}  Build · e2e-model mock high\n  Build · e2e-model mock high\nx\nx\n`;
  assert.throws(() => analyzeActiveCapture({
    label: 'duplicate', plain: duplicate, ansi: duplicate,
    columns: 40, rows: 10, cursor: { x: 0, y: 8 }, frame: frame(),
  }), /exactly one real status row/);

  const plain = `${'x\n'.repeat(8)}  Build · e2e-model mock high\nx\n`;
  const ansi = plain.replace('x\n', '\x1b[7m                    \x1b[0m\n');
  assert.throws(() => analyzeActiveCapture({
    label: 'band', plain, ansi, columns: 40, rows: 10,
    cursor: { x: 0, y: 8 }, frame: frame(),
  }), /reverse-video blank band/);
  assert.throws(() => analyzeActiveCapture({
    label: 'band-cannot-be-globally-whitelisted', plain, ansi, columns: 40, rows: 10,
    cursor: { x: 0, y: 8 }, frame: frame(), allowSelection: true,
  }), /reverse-video blank band/);
});

test('active capture analyzer recognizes the single compact fallback status row', () => {
  const plain = [
    ' elowen E2E Har… ───', 'Terminal too smal...', '20×10 · recommend...', '', '', '',
    '─'.repeat(20), '', '─'.repeat(20), '  Build… /var/www/e…',
  ].join('\n') + '\n';
  const tinyFrame = frame({
    terminal: { columns: 20, rows: 10 }, rootRows: 10, maxVisibleWidth: 20,
    scrollOffset: 0, maxScrollOffset: 0,
    sections: {
      header: 1, transcript: 3, cards: 0, subagents: 0, queue: 0,
      attachments: 0, editor: 3, status: 1, hints: 2,
    },
  });
  const result = analyzeActiveCapture({
    label: 'tiny', plain, ansi: plain, columns: 20, rows: 10,
    cursor: { x: 2, y: 7 }, frame: tinyFrame, expectCursor: false,
  });
  assert.equal(result.statusRows, 1);
});

test('frame diagnostics enforce root rows, width, section totals, and ordinary 50 ms budget', () => {
  assert.doesNotThrow(() => analyzeFrameDiagnostics([frame()]));
  assert.throws(() => analyzeFrameDiagnostics([frame({ rootRows: 11 })]), /rootRows/);
  assert.throws(() => analyzeFrameDiagnostics([frame({ rootRows: 9 })]), /rootRows/);
  assert.throws(() => analyzeFrameDiagnostics([frame({ maxVisibleWidth: 41 })]), /visible width/);
  assert.throws(() => analyzeFrameDiagnostics([frame({ maxVisibleWidth: 39 })]), /visible width/);
  assert.throws(() => analyzeFrameDiagnostics([frame({ sections: { ...frame().sections, editor: 2 } })]), /section total/);
  assert.throws(() => analyzeFrameDiagnostics([frame({ totalMs: 51 })]), /ordinary frame/);
  assert.throws(() => analyzeFrameDiagnostics([frame({ totalMs: null })]), /totalMs/);
  assert.throws(() => analyzeFrameDiagnostics([frame({ queueMs: '2' })]), /queueMs/);
  assert.throws(() => analyzeFrameDiagnostics([frame({ piTailMs: -1 })]), /piTailMs/);
  assert.doesNotThrow(() => analyzeFrameDiagnostics([frame({ forced: true, totalMs: 80, reasons: ['resize'] })]));
});

test('frame summary separates forced outliers, scroll work, coalescing and idle deltas', () => {
  const summary = summarizeFrameDiagnostics([
    frame({ at: 1, totalMs: 6 }),
    frame({ at: 2, totalMs: 12, reasons: ['scroll:wheel', 'animation:mascot'] }),
    frame({ at: 3, totalMs: 70, forced: true, reasons: ['resize'] }),
  ]);
  assert.deepEqual(summary.ordinaryMs, { p95: 12, max: 12 });
  assert.deepEqual(summary.forcedMs, { p95: 70, max: 70 });
  assert.equal(summary.scroll.frames, 2);
  assert.equal(summary.coalescedFrames, 1);
  assert.equal(summary.scroll.maxRenderedTurns, 0);
});

test('OSC-52 decoder and history parser expose real terminal evidence', () => {
  const first = Buffer.from('old').toString('base64');
  const last = Buffer.from('E2E HISTORY MARKER 89\nstable row one').toString('base64');
  assert.equal(decodeLastOsc52(`\x1b]52;c;${first}\x07tail\x1b]52;c;${last}\x07`),
    'E2E HISTORY MARKER 89\nstable row one');
  assert.equal(historyOffset('History +123 lines'), 123);
  assert.equal(historyOffset('at tail'), 0);
});

test('artifact root is stable and scenario-scoped', () => {
  assert.equal(resolveArtifactDir('/tmp/elowen-e2e', 'short'), '/tmp/elowen-e2e/short');
});

test('strict JSONL reads reject malformed complete and truncated final records', () => {
  const root = mkdtempSync(join(tmpdir(), 'elowen-tmux-jsonl-strict-'));
  const path = join(root, 'perf.jsonl');
  try {
    writeFileSync(path, '{"type":"frame"}\nnot-json\n');
    assert.throws(() => readJsonLines(path), /perf\.jsonl:2|line 2|JSONL/iu);

    writeFileSync(path, '{"type":"frame"}\n{"type":"frame"');
    assert.throws(() => readFrames(path), /perf\.jsonl:2|line 2|JSONL/iu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('live JSONL reads tolerate only a missing file or the current trailing partial record', () => {
  const root = mkdtempSync(join(tmpdir(), 'elowen-tmux-jsonl-live-'));
  const missing = join(root, 'missing.jsonl');
  const path = join(root, 'perf.jsonl');
  try {
    assert.deepEqual(readJsonLines(missing, { live: true }), []);

    writeFileSync(path, '{"type":"frame","sequence":1}\n{"type":"frame"');
    assert.deepEqual(readFrames(path, { live: true }).map((entry) => entry.sequence), [1]);

    writeFileSync(path, '{"type":"frame","sequence":1}\nnot-json\n{"type":"frame"');
    assert.throws(() => readJsonLines(path, { live: true }), /perf\.jsonl:2|line 2|JSONL/iu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('configured artifact scenarios reject stale non-empty directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'elowen-tmux-artifact-root-'));
  const previous = process.env.ELOWEN_TMUX_ARTIFACT_ROOT;
  process.env.ELOWEN_TMUX_ARTIFACT_ROOT = root;
  try {
    const scenario = createArtifactDir('short');
    writeFileSync(join(scenario, 'stale.jsonl'), '{}\n');
    assert.throws(() => createArtifactDir('short'), /not empty|fresh/iu);
  } finally {
    if (previous == null) delete process.env.ELOWEN_TMUX_ARTIFACT_ROOT;
    else process.env.ELOWEN_TMUX_ARTIFACT_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

const validPane = () => [
  ' elowen E2E Harness ----------------', ' transcript row', ' transcript row', ' transcript row',
  ' transcript row                 █', '----------------------------------------', '',
  '----------------------------------------', '  Build · e2e-model mock high', '  enter send · ctrl+c quit',
].join('\n') + '\n';

test('capture retries until plain and ANSI belong to one completed frame sequence', () => {
  const root = mkdtempSync(join(tmpdir(), 'elowen-tmux-capture-sequence-'));
  const perf = join(root, 'perf.jsonl');
  writeFileSync(perf, `${JSON.stringify(frame({ sequence: 1 }))}\n`);
  let plainCaptures = 0;
  let ansiCaptures = 0;
  const tmux = {
    run(args) {
      if (args[0] === 'display-message') return '40\t10\t2\t6\t123\t0\n';
      if (args[0] === 'capture-pane' && args.includes('-e')) {
        ansiCaptures++;
        if (ansiCaptures === 1) writeFileSync(perf,
          `${JSON.stringify(frame({ sequence: 1 }))}\n${JSON.stringify(frame({ sequence: 2, at: 11 }))}\n`);
        return validPane();
      }
      if (args[0] === 'capture-pane') { plainCaptures++; return validPane(); }
      throw new Error(`unexpected tmux call: ${args.join(' ')}`);
    },
  };
  try {
    const captured = captureState({
      tmux, session: 'test', artifactDir: root, label: 'stable', perfLog: perf, expectCursor: true,
    });
    assert.equal(captured.frame.sequence, 2);
    assert.equal(plainCaptures, 2);
    assert.equal(ansiCaptures, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('capture gives up after six unstable completed frame sequences', () => {
  const root = mkdtempSync(join(tmpdir(), 'elowen-tmux-capture-unstable-'));
  const perf = join(root, 'perf.jsonl');
  let sequence = 1;
  let ansiCaptures = 0;
  writeFileSync(perf, `${JSON.stringify(frame({ sequence }))}\n`);
  const tmux = {
    run(args) {
      if (args[0] === 'display-message') return '40\t10\t2\t6\t123\t0\n';
      if (args[0] === 'capture-pane' && args.includes('-e')) {
        ansiCaptures++;
        sequence++;
        writeFileSync(perf, `${JSON.stringify(frame({ sequence, at: 10 + sequence }))}\n`, { flag: 'a' });
        return validPane();
      }
      if (args[0] === 'capture-pane') return validPane();
      throw new Error(`unexpected tmux call: ${args.join(' ')}`);
    },
  };
  try {
    assert.throws(() => captureState({
      tmux, session: 'test', artifactDir: root, label: 'unstable', perfLog: perf, expectCursor: true,
    }), /after 6 attempts/u);
    assert.equal(ansiCaptures, 6);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const metadata = (commit = 'abc') => ({
  commit, branch: 'refactor/test', node: 'v22.23.1', tmux: 'tmux 3.4', cli: '/x/dist/cli/bin.js',
});

function writeRound(root, round, { omitSignals = false, mixedCommit = false, ordinaryMax = 37, nullTiming = false } = {}) {
  for (const scenario of ['short', 'long']) {
    const dir = join(root, `round-${round}`, scenario);
    mkdirSync(dir, { recursive: true });
    const captures = ['plain', 'ansi', 'state'].reduce((paths, kind) => {
      const path = join(dir, `capture.${kind === 'state' ? 'json' : `${kind}.txt`}`);
      writeFileSync(path, kind === 'state' ? '{}\n' : 'capture\n');
      paths[kind] = path;
      return paths;
    }, {});
    writeFileSync(join(dir, 'report.json'), JSON.stringify({
      passed: true, scenario, captures: [{ label: 'capture', ...captures }],
      metadata: metadata(mixedCommit && scenario === 'long' ? 'def' : 'abc'),
      performance: {
        ordinaryMs: { p95: nullTiming ? null : ordinaryMax - 1, max: ordinaryMax },
        forcedMs: { p95: 50, max: 60 },
      },
    }));
  }
  if (!omitSignals) {
    const dir = join(root, `round-${round}`, 'signals');
    mkdirSync(dir, { recursive: true });
    const cases = ['SIGTERM', 'SIGHUP'].map((signal) => ({
      passed: true, signal, metadata: metadata(), terminalStateRestored: true, shellReadable: true,
      performance: { ordinaryMs: { p95: 0, max: 0 }, forcedMs: { p95: 10, max: 10 } },
    }));
    writeFileSync(join(dir, 'report.json'), JSON.stringify({ passed: true, metadata: metadata(), cases }));
  }
}

test('aggregate analyzer requires two complete short+long+signals rounds with one build identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'elowen-tmux-analyzer-'));
  try {
    writeRound(root, 1, { ordinaryMax: 31 });
    writeRound(root, 2, { ordinaryMax: 37 });
    const summary = aggregateTmuxReports(root, { expectedRounds: 2 });
    assert.equal(summary.rounds, 2);
    assert.equal(summary.scenarios, 6);
    assert.equal(summary.captures, 4);
    assert.equal(summary.ordinaryMs.max, 37);
    assert.deepEqual(summary.commits, ['abc']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('aggregate analyzer rejects absent signals, mixed builds, over-budget frames and null timing', () => {
  const cases = [
    [{ omitSignals: true }, /signals/u],
    [{ mixedCommit: true }, /identity|commit|build/iu],
    [{ ordinaryMax: 51 }, /50|ordinary/iu],
    [{ nullTiming: true }, /p95|number|finite/iu],
  ];
  for (const [options, pattern] of cases) {
    const root = mkdtempSync(join(tmpdir(), 'elowen-tmux-analyzer-negative-'));
    try {
      writeRound(root, 1, options);
      assert.throws(() => aggregateTmuxReports(root, { expectedRounds: 1 }), pattern);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('aggregate analyzer rejects missing or empty capture evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'elowen-tmux-analyzer-captures-'));
  try {
    writeRound(root, 1);
    const reportPath = join(root, 'round-1', 'short', 'report.json');
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    const realPlain = report.captures[0].plain;
    report.captures[0].plain = join(root, 'does-not-exist.txt');
    writeFileSync(reportPath, JSON.stringify(report));
    assert.throws(() => aggregateTmuxReports(root, { expectedRounds: 1 }), /capture|exist|evidence/iu);

    report.captures[0].plain = realPlain;
    writeFileSync(report.captures[0].state, '');
    writeFileSync(reportPath, JSON.stringify(report));
    assert.throws(() => aggregateTmuxReports(root, { expectedRounds: 1 }), /capture|non-empty|evidence/iu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
