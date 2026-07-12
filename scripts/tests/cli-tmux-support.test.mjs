import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  distContentHash,
  EXPECTED_TMUX_CAPTURE_LABELS,
  historyOffset,
  readFrames,
  readJsonLines,
  resolveTmuxRunId,
  resolveArtifactDir,
  summarizeFrameDiagnostics,
} from './cli-tmux-support.mjs';

const frame = (overrides = {}) => ({
  type: 'frame',
  pid: 123,
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

test('tmux runner preserves an explicit round id and generates one shared local fallback', () => {
  assert.equal(resolveTmuxRunId({ ELOWEN_TMUX_RUN_ID: ' round-42 ' }, () => 'unused'), 'round-42');
  assert.equal(resolveTmuxRunId({}, () => 'deterministic'), 'local-deterministic');
});

test('dist content hash covers sorted relative paths and every file byte', () => {
  const root = mkdtempSync(join(tmpdir(), 'elowen-tmux-dist-hash-'));
  try {
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'entry.js'), 'one\n');
    writeFileSync(join(root, 'nested', 'worker.js'), 'two\n');
    const first = distContentHash(root);
    assert.match(first, /^[a-f0-9]{64}$/u);
    assert.equal(distContentHash(root), first);

    writeFileSync(join(root, 'nested', 'worker.js'), 'changed\n');
    assert.notEqual(distContentHash(root), first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test('strict JSONL rejects interior blank records instead of silently dropping evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'elowen-tmux-jsonl-blank-'));
  const path = join(root, 'perf.jsonl');
  try {
    writeFileSync(path, '{"type":"frame","sequence":1}\n\n{"type":"frame","sequence":2}\n');
    assert.throws(() => readJsonLines(path), /blank|JSONL|record|line 2/iu);
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

test('capture never binds a pane to the last complete frame while a newer JSONL record is partial', () => {
  const root = mkdtempSync(join(tmpdir(), 'elowen-tmux-capture-partial-frame-'));
  const perf = join(root, 'perf.jsonl');
  writeFileSync(perf, `${JSON.stringify(frame({ sequence: 1 }))}\n{"type":"frame","sequence":2`);
  const tmux = {
    run(args) {
      if (args[0] === 'display-message') return '40\t10\t2\t6\t123\t0\n';
      if (args[0] === 'capture-pane') return validPane();
      throw new Error(`unexpected tmux call: ${args.join(' ')}`);
    },
  };
  try {
    assert.throws(() => captureState({
      tmux, session: 'test', artifactDir: root, label: 'partial', perfLog: perf, expectCursor: true,
    }), /completed frame|attempt|capture/iu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const DIST_HASH = 'a'.repeat(64);
const OTHER_DIST_HASH = 'b'.repeat(64);
const buildIdentity = (commit, distSha256) => `git:${commit}:dist-sha256:${distSha256}`;
const metadata = (commit = 'abc', {
  runId = 'run-1', tmuxServer = 'tmux-1-short', distSha256 = DIST_HASH,
  generatedAt = new Date().toISOString(), completedAt = generatedAt,
} = {}) => ({
  generatedAt, completedAt,
  commit, branch: 'refactor/test', node: 'v22.23.1', tmux: 'tmux 3.4',
  tmuxServer, cli: '/x/dist/cli/bin.js', runId, distSha256,
  buildIdentity: buildIdentity(commit, distSha256),
});

function writeRound(root, round, {
  omitSignals = false, mixedCommit = false, mixedDistHash = false, mixedRunId = false,
  duplicateServer = false, wrongScenario = false, runId = `run-${round}`,
  ordinaryMax = 37, nullTiming = false, generatedAt,
} = {}) {
  for (const scenario of ['short', 'long']) {
    const dir = join(root, `round-${round}`, scenario);
    mkdirSync(dir, { recursive: true });
    const captureFrame = frame({ totalMs: ordinaryMax < 50 ? ordinaryMax : 37, at: 10 });
    const perfFrames = ordinaryMax < 50
      ? [captureFrame]
      : [captureFrame, frame({ sequence: 2, at: 11, totalMs: ordinaryMax })];
    const captures = EXPECTED_TMUX_CAPTURE_LABELS[scenario].map((label, captureIndex) => {
      const paths = { label };
      for (const kind of ['plain', 'ansi', 'state']) {
        const path = join(dir, `capture-${captureIndex}.${kind === 'state' ? 'json' : `${kind}.txt`}`);
        const analysis = analyzeActiveCapture({
          label, plain: validPane(), ansi: validPane(), columns: 40, rows: 10,
          cursor: { x: 2, y: 6 }, frame: captureFrame, expectCursor: true,
        });
        writeFileSync(path, kind === 'state'
          ? `${JSON.stringify({
              columns: 40, rows: 10, cursor: { x: 2, y: 6 }, frame: captureFrame, analysis,
              contract: { expectCursor: true, forbiddenMarkers: [], expectScrollbar: true, allowScrollbarOcclusion: false },
            })}\n`
          : validPane());
        paths[kind] = path;
      }
      return paths;
    });
    const perf = join(dir, 'perf.jsonl');
    const ttyState = join(dir, 'tty-state.txt');
    const terminalWrites = join(dir, 'terminal-writes.log');
    const restoredShell = join(dir, 'restored-shell.txt');
    writeFileSync(perf, [
      JSON.stringify({ type: 'lifecycle', action: 'start', pid: 123, at: 1 }),
      ...perfFrames.map((entry) => JSON.stringify(entry)),
      JSON.stringify({ type: 'lifecycle', action: 'stop', pid: 123, at: 20 }),
      ...(scenario === 'short' ? [
        JSON.stringify({ type: 'lifecycle', action: 'start', pid: 124, at: 21 }),
        JSON.stringify({ type: 'lifecycle', action: 'stop', pid: 124, at: 22 }),
      ] : []),
      '',
    ].join('\n'));
    writeFileSync(ttyState, 'tty-state\ntty-state\n');
    writeFileSync(terminalWrites,
      '\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006hframe\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?1049l');
    writeFileSync(restoredShell, scenario === 'short'
      ? 'E2E SHORT SHELL RESTORED\n'
      : 'E2E SHELL RESTORED\n');
    const commit = mixedCommit && scenario === 'long' ? 'def' : 'abc';
    const distSha256 = mixedDistHash && scenario === 'long' ? OTHER_DIST_HASH : DIST_HASH;
    const scenarioRunId = mixedRunId && scenario === 'long' ? `${runId}-other` : runId;
    const tmuxServer = duplicateServer ? `tmux-${round}-shared` : `tmux-${round}-${scenario}`;
    const performance = ordinaryMax < 50
      ? analyzeFrameDiagnostics(perfFrames)
      : analyzeFrameDiagnostics([frame({ totalMs: 37, at: 10 })]);
    if (ordinaryMax >= 50) performance.ordinaryMs = { p95: ordinaryMax, max: ordinaryMax };
    if (nullTiming) performance.ordinaryMs.p95 = null;
    writeFileSync(join(dir, 'report.json'), JSON.stringify({
      passed: true, scenario: wrongScenario && scenario === 'long' ? 'short' : scenario,
      captures,
      metadata: metadata(commit, { runId: scenarioRunId, tmuxServer, distSha256, ...(generatedAt ? { generatedAt, completedAt: generatedAt } : {}) }),
      evidence: { perf, ttyState, terminalWrites, restoredShell },
      performance,
    }));
  }
  if (!omitSignals) {
    const dir = join(root, `round-${round}`, 'signals');
    mkdirSync(dir, { recursive: true });
    const cases = ['SIGTERM', 'SIGHUP'].map((signal) => {
      const caseDir = join(dir, signal.toLowerCase());
      mkdirSync(caseDir, { recursive: true });
      const rawSignalFrame = frame({ forced: true, reasons: ['lifecycle:start'], totalMs: 10 });
      const before = ['plain', 'ansi', 'state'].reduce((paths, kind) => {
        const path = join(caseDir, `01-before-signal.${kind === 'state' ? 'json' : `${kind}.txt`}`);
        const analysis = analyzeActiveCapture({
          label: '01-before-signal', plain: validPane(), ansi: validPane(), columns: 40, rows: 10,
          cursor: { x: 2, y: 6 }, frame: rawSignalFrame, expectCursor: true,
        });
        writeFileSync(path, kind === 'state'
          ? `${JSON.stringify({
              columns: 40, rows: 10, cursor: { x: 2, y: 6 }, frame: rawSignalFrame, analysis,
              contract: { expectCursor: true, forbiddenMarkers: [], expectScrollbar: true, allowScrollbarOcclusion: false },
            })}\n`
          : validPane());
        paths[kind] = path;
        return paths;
      }, { label: '01-before-signal' });
      const restoredShell = join(caseDir, '02-restored-shell.txt');
      const ttyState = join(caseDir, 'tty-state.txt');
      const terminalWrites = join(caseDir, 'terminal-writes.log');
      const perf = join(caseDir, 'perf.jsonl');
      writeFileSync(restoredShell, `E2E ${signal} SHELL RESTORED\n`);
      writeFileSync(ttyState, 'tty-state\ntty-state\n');
      writeFileSync(terminalWrites,
        '\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006hframe\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?1049l');
      writeFileSync(perf, [
        JSON.stringify({ type: 'lifecycle', action: 'start', pid: 123, at: 1 }),
        JSON.stringify(rawSignalFrame),
        JSON.stringify({ type: 'lifecycle', action: 'stop', pid: 123, at: 20 }),
        '',
      ].join('\n'));
      return {
        passed: true, signal,
        metadata: metadata('abc', {
          runId, tmuxServer: `tmux-${round}-${signal.toLowerCase()}`,
          ...(generatedAt ? { generatedAt, completedAt: generatedAt } : {}),
        }),
        terminalStateRestored: true, shellReadable: true,
        performance: analyzeFrameDiagnostics([rawSignalFrame]),
        evidence: { before, restoredShell, ttyState, terminalWrites, perf },
      };
    });
    writeFileSync(join(dir, 'report.json'), JSON.stringify({
      passed: true, scenario: 'signals',
      metadata: metadata('abc', {
        runId, tmuxServer: `tmux-${round}-sigterm`,
        ...(generatedAt ? { generatedAt, completedAt: generatedAt } : {}),
      }), cases,
    }));
  }
}

const aggregateOptions = (expectedRounds = 1, overrides = {}) => ({
  expectedRounds, expectedCommit: 'abc', expectedDistHash: DIST_HASH, ...overrides,
});

test('aggregate analyzer requires two complete short+long+signals rounds with one build identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'elowen-tmux-analyzer-'));
  try {
    writeRound(root, 1, { ordinaryMax: 31 });
    writeRound(root, 2, { ordinaryMax: 37 });
    const summary = aggregateTmuxReports(root, aggregateOptions(2));
    assert.equal(summary.rounds, 2);
    assert.equal(summary.scenarios, 6);
    assert.equal(summary.captures, 90);
    assert.equal(summary.ordinaryMs.max, 37);
    assert.deepEqual(summary.commits, ['abc']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('aggregate analyzer can fail-close one freshly completed runner root directly', () => {
  const root = mkdtempSync(join(tmpdir(), 'elowen-tmux-analyzer-direct-round-'));
  try {
    writeRound(root, 1);
    const summary = aggregateTmuxReports(join(root, 'round-1'), aggregateOptions(1));
    assert.equal(summary.rounds, 1);
    assert.equal(summary.scenarios, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('aggregate analyzer rejects stale evidence and revalidates normal raw captures and perf', () => {
  const stale = mkdtempSync(join(tmpdir(), 'elowen-tmux-analyzer-stale-'));
  try {
    writeRound(stale, 1, { generatedAt: '2000-01-01T00:00:00.000Z' });
    assert.throws(() => aggregateTmuxReports(stale, aggregateOptions()), /stale|fresh|age|generated/iu);
  } finally {
    rmSync(stale, { recursive: true, force: true });
  }

  const captureRoot = mkdtempSync(join(tmpdir(), 'elowen-tmux-analyzer-raw-capture-'));
  try {
    writeRound(captureRoot, 1);
    const reportPath = join(captureRoot, 'round-1', 'short', 'report.json');
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    writeFileSync(report.captures[0].plain,
      `${'x\n'.repeat(6)}  Build · e2e-model mock high\n  Build · e2e-model mock high\nx\nx\n`);
    assert.throws(() => aggregateTmuxReports(captureRoot, aggregateOptions()), /status|footer|capture|rows/iu);
  } finally {
    rmSync(captureRoot, { recursive: true, force: true });
  }

  const framePayloadRoot = mkdtempSync(join(tmpdir(), 'elowen-tmux-analyzer-frame-payload-'));
  try {
    writeRound(framePayloadRoot, 1);
    const report = JSON.parse(readFileSync(join(framePayloadRoot, 'round-1', 'short', 'report.json'), 'utf8'));
    const statePath = report.captures[0].state;
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.frame = { ...state.frame, renderedTurns: 999, totalMs: 49 };
    writeFileSync(statePath, `${JSON.stringify(state)}\n`);
    assert.throws(() => aggregateTmuxReports(framePayloadRoot, aggregateOptions()), /capture|frame|raw|perf/iu);
  } finally {
    rmSync(framePayloadRoot, { recursive: true, force: true });
  }

  const perfRoot = mkdtempSync(join(tmpdir(), 'elowen-tmux-analyzer-raw-perf-'));
  try {
    writeRound(perfRoot, 1);
    const report = JSON.parse(readFileSync(join(perfRoot, 'round-1', 'long', 'report.json'), 'utf8'));
    writeFileSync(report.evidence.perf, `${JSON.stringify(frame({ totalMs: 55 }))}\n`);
    assert.throws(() => aggregateTmuxReports(perfRoot, aggregateOptions()), /50|ordinary|timing|perf/iu);
  } finally {
    rmSync(perfRoot, { recursive: true, force: true });
  }

  const scrollRoot = mkdtempSync(join(tmpdir(), 'elowen-tmux-analyzer-scroll-perf-'));
  try {
    writeRound(scrollRoot, 1);
    const reportPath = join(scrollRoot, 'round-1', 'long', 'report.json');
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    const corrupted = frame({ reasons: ['scroll:wheel'], renderedTurns: 999 });
    writeFileSync(report.evidence.perf, [
      JSON.stringify({ type: 'lifecycle', action: 'start', pid: 123, at: 1 }),
      JSON.stringify(corrupted),
      JSON.stringify({ type: 'lifecycle', action: 'stop', pid: 123, at: 20 }),
      '',
    ].join('\n'));
    // Even a matching forged report must not weaken the long-history operation limits.
    report.performance = analyzeFrameDiagnostics([corrupted]);
    writeFileSync(reportPath, JSON.stringify(report));
    assert.throws(() => aggregateTmuxReports(scrollRoot, aggregateOptions()), /scroll|rendered|viewport|bounded/iu);
  } finally {
    rmSync(scrollRoot, { recursive: true, force: true });
  }

  const shellRoot = mkdtempSync(join(tmpdir(), 'elowen-tmux-analyzer-shell-marker-'));
  try {
    writeRound(shellRoot, 1);
    const report = JSON.parse(readFileSync(join(shellRoot, 'round-1', 'long', 'report.json'), 'utf8'));
    writeFileSync(report.evidence.restoredShell, 'E2E BOGUS SHELL RESTORED\n');
    assert.throws(() => aggregateTmuxReports(shellRoot, aggregateOptions()), /shell|marker|long/iu);
  } finally {
    rmSync(shellRoot, { recursive: true, force: true });
  }
});

test('aggregate analyzer rejects a symlink supplied as the evidence root', {
  skip: process.platform === 'win32',
}, () => {
  const parent = mkdtempSync(join(tmpdir(), 'elowen-tmux-analyzer-root-link-'));
  const real = join(parent, 'real');
  const link = join(parent, 'linked');
  try {
    mkdirSync(real);
    writeRound(real, 1);
    symlinkSync(real, link, 'dir');
    assert.throws(() => aggregateTmuxReports(link, aggregateOptions()), /symlink|root|contain/iu);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('aggregate analyzer rejects an evidence root reached through a symlinked parent', {
  skip: process.platform === 'win32',
}, () => {
  const parent = mkdtempSync(join(tmpdir(), 'elowen-tmux-analyzer-parent-link-'));
  const realParent = join(parent, 'real-parent');
  const realRoot = join(realParent, 'evidence');
  const aliasParent = join(parent, 'alias-parent');
  try {
    mkdirSync(realRoot, { recursive: true });
    writeRound(realRoot, 1);
    symlinkSync(realParent, aliasParent, 'dir');
    assert.throws(() => aggregateTmuxReports(join(aliasParent, 'evidence'), aggregateOptions()),
      /canonical|symlink|parent|root/iu);
  } finally {
    rmSync(parent, { recursive: true, force: true });
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
      assert.throws(() => aggregateTmuxReports(root, aggregateOptions()), pattern);
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
    assert.throws(() => aggregateTmuxReports(root, aggregateOptions()), /capture|exist|evidence/iu);

    report.captures[0].plain = realPlain;
    writeFileSync(report.captures[0].state, '');
    writeFileSync(reportPath, JSON.stringify(report));
    assert.throws(() => aggregateTmuxReports(root, aggregateOptions()), /capture|non-empty|evidence/iu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('aggregate analyzer requires every checkpoint and owns the capture contract', () => {
  const omitted = mkdtempSync(join(tmpdir(), 'elowen-tmux-analyzer-checkpoints-'));
  try {
    writeRound(omitted, 1);
    const reportPath = join(omitted, 'round-1', 'short', 'report.json');
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    report.captures = report.captures.slice(0, 1);
    writeFileSync(reportPath, JSON.stringify(report));
    assert.throws(() => aggregateTmuxReports(omitted, aggregateOptions()), /checkpoint|capture|exactly|short/iu);
  } finally {
    rmSync(omitted, { recursive: true, force: true });
  }

  const contract = mkdtempSync(join(tmpdir(), 'elowen-tmux-analyzer-capture-contract-'));
  try {
    writeRound(contract, 1);
    const report = JSON.parse(readFileSync(join(contract, 'round-1', 'long', 'report.json'), 'utf8'));
    const statePath = report.captures[0].state;
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.cursor = { x: 999, y: 999 };
    state.contract = { expectCursor: false };
    delete state.analysis;
    writeFileSync(statePath, JSON.stringify(state));
    assert.throws(() => aggregateTmuxReports(contract, aggregateOptions()), /analysis|cursor|contract|state/iu);
  } finally {
    rmSync(contract, { recursive: true, force: true });
  }

  const identity = mkdtempSync(join(tmpdir(), 'elowen-tmux-analyzer-capture-frame-'));
  try {
    writeRound(identity, 1);
    const report = JSON.parse(readFileSync(join(identity, 'round-1', 'short', 'report.json'), 'utf8'));
    const statePath = report.captures[0].state;
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.frame.sequence += 100_000;
    state.frame.pid = 999_999;
    writeFileSync(statePath, JSON.stringify(state));
    assert.throws(() => aggregateTmuxReports(identity, aggregateOptions()), /frame|perf|identity|absent/iu);
  } finally {
    rmSync(identity, { recursive: true, force: true });
  }
});

test('aggregate analyzer binds every report to the expected HEAD and complete dist hash', () => {
  const cases = [
    [{}, aggregateOptions(1, { expectedCommit: 'expected-head' }), /commit|HEAD|expected/iu],
    [{}, aggregateOptions(1, { expectedDistHash: OTHER_DIST_HASH }), /dist|hash|build/iu],
    [{ mixedDistHash: true }, aggregateOptions(), /dist|hash|build|identity/iu],
  ];
  for (const [roundOptions, options, pattern] of cases) {
    const root = mkdtempSync(join(tmpdir(), 'elowen-tmux-analyzer-build-'));
    try {
      writeRound(root, 1, roundOptions);
      assert.throws(() => aggregateTmuxReports(root, options), pattern);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('aggregate analyzer requires one run id per round, unique rounds, unique tmux servers and matching scenario', () => {
  const oneRoundCases = [
    [{ mixedRunId: true }, /run.?id|round/iu],
    [{ duplicateServer: true }, /tmux|server|unique/iu],
    [{ wrongScenario: true }, /scenario|long|short/iu],
  ];
  for (const [roundOptions, pattern] of oneRoundCases) {
    const root = mkdtempSync(join(tmpdir(), 'elowen-tmux-analyzer-run-'));
    try {
      writeRound(root, 1, roundOptions);
      assert.throws(() => aggregateTmuxReports(root, aggregateOptions()), pattern);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const root = mkdtempSync(join(tmpdir(), 'elowen-tmux-analyzer-duplicate-run-'));
  try {
    writeRound(root, 1, { runId: 'same-run' });
    writeRound(root, 2, { runId: 'same-run' });
    assert.throws(() => aggregateTmuxReports(root, aggregateOptions(2)), /run.?id|unique|round/iu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('aggregate analyzer rejects copied stale rounds and capture paths outside their scenario', () => {
  const copied = mkdtempSync(join(tmpdir(), 'elowen-tmux-analyzer-copied-'));
  try {
    writeRound(copied, 1);
    writeRound(copied, 2);
    for (const scenario of ['short', 'long', 'signals']) {
      copyFileSync(join(copied, 'round-1', scenario, 'report.json'),
        join(copied, 'round-2', scenario, 'report.json'));
    }
    assert.throws(() => aggregateTmuxReports(copied, aggregateOptions(2)), /contain|scenario|run.?id|round/iu);
  } finally {
    rmSync(copied, { recursive: true, force: true });
  }

  const outside = mkdtempSync(join(tmpdir(), 'elowen-tmux-analyzer-outside-'));
  try {
    writeRound(outside, 1);
    const outsideCapture = join(outside, 'outside.txt');
    writeFileSync(outsideCapture, 'stale capture\n');
    const reportPath = join(outside, 'round-1', 'short', 'report.json');
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    report.captures[0].plain = outsideCapture;
    writeFileSync(reportPath, JSON.stringify(report));
    assert.throws(() => aggregateTmuxReports(outside, aggregateOptions()), /contain|scenario|capture/iu);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('aggregate analyzer revalidates contained signal capture, tty, shell, terminal protocol and strict perf evidence', () => {
  const mutations = [
    [(report) => rmSync(report.cases[0].evidence.restoredShell), /shell|evidence|exist/iu],
    [(report) => writeFileSync(report.cases[0].evidence.terminalWrites, ''), /terminal|evidence|empty/iu],
    [(report, root) => {
      const outside = join(root, 'outside-signal.txt');
      writeFileSync(outside, 'outside\n');
      report.cases[0].evidence.before.plain = outside;
    }, /contain|capture|scenario|signal/iu],
    [(report) => writeFileSync(report.cases[0].evidence.terminalWrites,
      '\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006h'),
    /alternate|mouse|terminal|order/iu],
    [(report) => writeFileSync(report.cases[0].evidence.terminalWrites,
      '\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006hframe\x1b[?1006l\x1b[?1000l\x1b[?1049l'),
    /1002|mouse|terminal|order/iu],
    [(report) => writeFileSync(report.cases[0].evidence.ttyState, 'before\nafter\n'), /tty|terminal state|restore/iu],
    [(report) => writeFileSync(report.cases[0].evidence.restoredShell, 'wrong shell\n'), /shell|marker|readable/iu],
    [(report) => writeFileSync(report.cases[0].evidence.perf, '{"type":"frame"'), /JSONL|perf|invalid/iu],
    [(report) => {
      const path = report.cases[0].evidence.perf;
      const entries = readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
      entries.find((entry) => entry.type === 'lifecycle' && entry.action === 'start').at = 30;
      writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
    }, /lifecycle|timestamp|monotonic|start|stop/iu],
    [(report) => {
      const perfPath = report.cases[0].evidence.perf;
      const entries = readFileSync(perfPath, 'utf8').trim().split('\n').map(JSON.parse);
      entries.find((entry) => entry.type === 'frame').pid = 999_999;
      writeFileSync(perfPath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
      const statePath = report.cases[0].evidence.before.state;
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      state.frame.pid = 999_999;
      writeFileSync(statePath, JSON.stringify(state));
    }, /pid|lifecycle|process/iu],
  ];
  for (const [mutate, pattern] of mutations) {
    const root = mkdtempSync(join(tmpdir(), 'elowen-tmux-analyzer-signal-evidence-'));
    try {
      writeRound(root, 1);
      const reportPath = join(root, 'round-1', 'signals', 'report.json');
      const report = JSON.parse(readFileSync(reportPath, 'utf8'));
      mutate(report, root);
      writeFileSync(reportPath, JSON.stringify(report));
      assert.throws(() => aggregateTmuxReports(root, aggregateOptions()), pattern);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
