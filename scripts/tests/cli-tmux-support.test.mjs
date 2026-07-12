import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  aggregateTmuxReports,
  analyzeActiveCapture,
  analyzeFrameDiagnostics,
  decodeLastOsc52,
  historyOffset,
  resolveArtifactDir,
  summarizeFrameDiagnostics,
} from './cli-tmux-support.mjs';

const frame = (overrides = {}) => ({
  type: 'frame',
  at: 10,
  reasons: ['scroll:wheel'],
  forced: false,
  prepareMs: 1,
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
  assert.throws(() => analyzeFrameDiagnostics([frame({ maxVisibleWidth: 41 })]), /visible width/);
  assert.throws(() => analyzeFrameDiagnostics([frame({ sections: { ...frame().sections, editor: 2 } })]), /section total/);
  assert.throws(() => analyzeFrameDiagnostics([frame({ totalMs: 51 })]), /ordinary frame/);
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

test('aggregate analyzer requires two complete short+long rounds and reports their worst ordinary frame', () => {
  const root = mkdtempSync(join(tmpdir(), 'elowen-tmux-analyzer-'));
  try {
    for (const [round, max] of [[1, 31], [2, 37]]) {
      for (const scenario of ['short', 'long']) {
        const dir = join(root, `round-${round}`, scenario);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'report.json'), JSON.stringify({
          passed: true, scenario, captures: [{ label: 'capture' }],
          metadata: { commit: 'abc', node: 'v22', tmux: 'tmux 3.4', cli: '/x/dist/cli/bin.js' },
          performance: { ordinaryMs: { p95: max - 1, max }, forcedMs: { p95: 50, max: 60 } },
        }));
      }
    }
    const summary = aggregateTmuxReports(root, { expectedRounds: 2 });
    assert.equal(summary.rounds, 2);
    assert.equal(summary.scenarios, 4);
    assert.equal(summary.captures, 4);
    assert.equal(summary.ordinaryMs.max, 37);
    assert.deepEqual(summary.commits, ['abc']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
