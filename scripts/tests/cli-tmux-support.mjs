import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';

import { visibleWidth } from '@earendil-works/pi-tui';

const STATUS_ROW = /^\s+(?:Build|Plan)(?:\s+·\s+\S+|…)/u;

export function paneLines(value) {
  if (value === '') return [];
  return (value.endsWith('\n') ? value.slice(0, -1) : value).split('\n');
}

export function resolveArtifactDir(root, scenario) {
  return resolve(root, scenario);
}

export function createArtifactDir(scenario) {
  const configured = process.env.ELOWEN_TMUX_ARTIFACT_ROOT?.trim();
  const dir = configured
    ? resolveArtifactDir(configured, scenario)
    : mkdtempSync(join(tmpdir(), `elowen-tui-${scenario}-artifacts-`));
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function tmuxServerName(label = 'e2e') {
  const nonce = Math.random().toString(36).slice(2, 10);
  return `elowen-${label}-${process.pid}-${nonce}`.replace(/[^a-zA-Z0-9_.-]/gu, '-').slice(0, 96);
}

/** A run owns a whole tmux server (`-L`), not merely a session in the user's shared server. */
export function createTmuxServer(label = 'e2e') {
  const server = tmuxServerName(label);
  const prefix = ['-L', server];
  const run = (args, options = {}) => execFileSync('tmux', [...prefix, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options,
  });
  const status = (args) => spawnSync('tmux', [...prefix, ...args], { stdio: 'ignore' }).status;
  return {
    name: server,
    run,
    status,
    hasSession(session) { return status(['has-session', '-t', session]) === 0; },
    killServer() { spawnSync('tmux', [...prefix, 'kill-server'], { stdio: 'ignore' }); },
  };
}

export function readJsonLines(path) {
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

export function readFrames(path) {
  return readJsonLines(path).filter((entry) => entry.type === 'frame');
}

export function latestFrame(frames, columns, rows, since = 0) {
  return [...frames].reverse().find((frame) => frame.at >= since
    && frame.terminal?.columns === columns && frame.terminal?.rows === rows) ?? null;
}

function terminalState(tmux, session) {
  const value = tmux.run([
    'display-message', '-p', '-t', session,
    '#{window_width}\t#{window_height}\t#{cursor_x}\t#{cursor_y}\t#{pane_pid}\t#{pane_dead}',
  ]).trim().split('\t');
  return {
    columns: Number(value[0]), rows: Number(value[1]),
    cursor: { x: Number(value[2]), y: Number(value[3]) },
    panePid: Number(value[4]), paneDead: value[5] === '1',
  };
}

/** Save one plain/ANSI/state triplet and bind it to the most recent diagnosed frame of that geometry. */
export function captureState({
  tmux, session, artifactDir, label, perfLog, expectCursor = true,
  allowSelection = false, forbiddenMarkers = [], expectScrollbar, allowScrollbarOcclusion = false,
}) {
  const state = terminalState(tmux, session);
  const plain = tmux.run(['capture-pane', '-p', '-t', session]);
  const ansi = tmux.run(['capture-pane', '-p', '-e', '-t', session]);
  const frames = readFrames(perfLog);
  const frame = latestFrame(frames, state.columns, state.rows);
  assert.ok(frame, `${label}: no diagnosed frame matches ${state.columns}x${state.rows}`);
  const input = {
    label, plain, ansi, columns: state.columns, rows: state.rows, cursor: state.cursor, frame,
    expectCursor, allowSelection, forbiddenMarkers, expectScrollbar, allowScrollbarOcclusion,
  };
  const analysis = analyzeActiveCapture(input);
  const plainPath = join(artifactDir, `${label}.txt`);
  const ansiPath = join(artifactDir, `${label}.ansi.txt`);
  const statePath = join(artifactDir, `${label}.state.json`);
  writeFileSync(plainPath, plain);
  writeFileSync(ansiPath, ansi);
  writeFileSync(statePath, `${JSON.stringify({ ...state, frame, analysis }, null, 2)}\n`);
  return { ...input, ...state, analysis, paths: { plain: plainPath, ansi: ansiPath, state: statePath } };
}

function sectionTotal(sections) {
  return Object.values(sections ?? {}).reduce((sum, value) => sum + Number(value || 0), 0);
}

function transcriptRows(plain, frame) {
  const lines = paneLines(plain);
  const start = Number(frame.sections?.header ?? 0);
  return lines.slice(start, start + Number(frame.sections?.transcript ?? 0));
}

function hasScrollbar(plain, frame) {
  return transcriptRows(plain, frame).some((line) => {
    const index = line.indexOf('█');
    if (index < 0) return false;
    const before = line[index - 1] ?? '';
    const after = line[index + 1] ?? '';
    return before !== '█' && before !== '░' && after !== '█' && after !== '░';
  });
}

function assertNoAnsiBlankBand(label, ansi, columns, allowSelection) {
  const reverseBlank = /\x1b\[[0-9;]*7[0-9;]*m +(?:\x1b\[[0-9;]*m)?/gu;
  if (!allowSelection) {
    for (const match of ansi.matchAll(reverseBlank)) {
      const spaces = (match[0].match(/ +/u) ?? [''])[0].length;
      // tmux `capture-pane -e` can keep the cursor SGR open across a following padding cell even though
      // the application's diagnosed constrained span is exactly one cell. The reported corruption is a
      // broad band; 4+ empty cells remains strict while avoiding that tmux serialization artefact.
      assert.ok(spaces < 4, `${label}: reverse-video blank band spans ${spaces} cells`);
    }
  }
  // A stale white/light background row is the other observed form of the artifact. Only reject a
  // genuinely broad empty run; semantic coloured cells and the one-cell editor cursor stay valid.
  const lightBackground = /\x1b\[(?:47|107|48;5;(?:1[5][0-9]|2(?:3[1-9]|4[0-9]|5[0-5]))|48;2;(?:2[3-5][0-9]);(?:2[3-5][0-9]);(?:2[3-5][0-9]))m +/gu;
  for (const match of ansi.matchAll(lightBackground)) {
    const spaces = (match[0].match(/ +$/u) ?? [''])[0].length;
    assert.ok(spaces < Math.max(4, Math.floor(columns / 2)),
      `${label}: light-background blank band spans ${spaces} cells`);
  }
}

export function analyzeActiveCapture({
  label, plain, ansi, columns, rows, cursor, frame, expectCursor = false,
  allowSelection = false, forbiddenMarkers = [], expectScrollbar, allowScrollbarOcclusion = false,
}) {
  const lines = paneLines(plain);
  assert.equal(lines.length, rows, `${label}: pane must contain exactly ${rows} rows`);
  const widths = lines.map((line) => visibleWidth(line));
  const maxWidth = Math.max(0, ...widths);
  assert.ok(widths.every((width) => width <= columns), `${label}: captured row exceeds ${columns} columns`);
  assert.equal(frame.terminal?.columns, columns, `${label}: diagnostic columns mismatch`);
  assert.equal(frame.terminal?.rows, rows, `${label}: diagnostic rows mismatch`);
  assert.ok(frame.rootRows <= rows, `${label}: diagnostic rootRows ${frame.rootRows} exceeds ${rows}`);
  assert.ok(frame.maxVisibleWidth <= columns,
    `${label}: diagnostic visible width ${frame.maxVisibleWidth} exceeds ${columns}`);
  assert.equal(sectionTotal(frame.sections), frame.rootRows,
    `${label}: diagnostic section total must equal rootRows`);
  const statuses = lines.filter((line) => STATUS_ROW.test(line));
  assert.equal(statuses.length, 1, `${label}: exactly one real status row is required`);
  for (const marker of forbiddenMarkers) assert.ok(!plain.includes(marker), `${label}: stale marker remains: ${marker}`);
  assertNoAnsiBlankBand(label, ansi, columns, allowSelection);
  const reverseSpans = (frame.reverseSpans ?? []).filter((span) => span.stage === 'constrained');
  if (!allowSelection) {
    assert.ok(reverseSpans.every((span) => span.to - span.from <= 1),
      `${label}: diagnostic reverse-video span is wider than one cursor cell`);
  }
  if (expectCursor && Number(frame.sections?.editor ?? 0) > 0) {
    const beforeEditor = ['header', 'transcript', 'cards', 'subagents', 'queue', 'attachments']
      .reduce((sum, key) => sum + Number(frame.sections?.[key] ?? 0), 0);
    const editorEnd = beforeEditor + Number(frame.sections.editor) - 1;
    assert.ok(cursor.y >= beforeEditor && cursor.y <= editorEnd,
      `${label}: cursor row ${cursor.y} must remain in editor ${beforeEditor}..${editorEnd}`);
    assert.ok(cursor.x >= 0 && cursor.x < columns, `${label}: cursor column ${cursor.x} must fit pane`);
  }
  const scrollbarVisible = hasScrollbar(plain, frame);
  const shouldHaveScrollbar = expectScrollbar ?? Number(frame.maxScrollOffset) > 0;
  if (!allowScrollbarOcclusion) {
    assert.equal(scrollbarVisible, shouldHaveScrollbar,
      `${label}: scrollbar visibility must match ${shouldHaveScrollbar ? 'overflow' : 'non-overflow'} state`);
  }
  return {
    rows: lines.length, columns, maxVisibleWidth: maxWidth,
    statusRows: statuses.length, scrollbarVisible, scrollbarExpected: shouldHaveScrollbar,
    scrollbarOccludedByOverlay: allowScrollbarOcclusion && shouldHaveScrollbar && !scrollbarVisible,
    cursor: { ...cursor },
    rootRows: frame.rootRows, sectionTotal: sectionTotal(frame.sections),
  };
}

export function analyzeFrameDiagnostics(frames, { ordinaryLimitMs = 50 } = {}) {
  assert.ok(frames.length > 0, 'perf diagnostics must contain frames');
  for (const [index, frame] of frames.entries()) {
    const prefix = `frame ${index}`;
    assert.ok(frame.rootRows <= frame.terminal.rows,
      `${prefix}: rootRows ${frame.rootRows} exceeds terminal rows ${frame.terminal.rows}`);
    assert.ok(frame.maxVisibleWidth <= frame.terminal.columns,
      `${prefix}: visible width ${frame.maxVisibleWidth} exceeds terminal columns ${frame.terminal.columns}`);
    assert.equal(sectionTotal(frame.sections), frame.rootRows, `${prefix}: section total must equal rootRows`);
    if (!frame.forced) assert.ok(frame.totalMs < ordinaryLimitMs,
      `${prefix}: ordinary frame ${frame.totalMs} ms exceeds ${ordinaryLimitMs} ms`);
    assert.ok(Number(frame.scrollOffset) <= Number(frame.maxScrollOffset),
      `${prefix}: scrollOffset exceeds maxScrollOffset`);
  }
  return summarizeFrameDiagnostics(frames);
}

function percentile(values, percent) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * percent) - 1)] ?? 0;
}

function timing(values) {
  return { p95: percentile(values, 0.95), max: Math.max(0, ...values) };
}

export function summarizeFrameDiagnostics(frames) {
  const ordinary = frames.filter((frame) => !frame.forced);
  const forced = frames.filter((frame) => frame.forced);
  const scroll = frames.filter((frame) => frame.reasons?.some((reason) => reason.includes('scroll')));
  const mascot = frames.filter((frame) => frame.reasons?.some((reason) => reason.includes('mascot')));
  return {
    frames: frames.length,
    ordinaryFrames: ordinary.length,
    forcedFrames: forced.length,
    ordinaryMs: timing(ordinary.map((frame) => Number(frame.totalMs)).filter(Number.isFinite)),
    ordinaryQueueMs: timing(ordinary.map((frame) => Number(frame.queueMs)).filter(Number.isFinite)),
    ordinaryRootRenderMs: timing(ordinary.map((frame) => Number(frame.rootRenderMs)).filter(Number.isFinite)),
    forcedMs: timing(forced.map((frame) => Number(frame.totalMs)).filter(Number.isFinite)),
    coalescedFrames: frames.filter((frame) => (frame.reasons?.length ?? 0) > 1).length,
    scroll: {
      frames: scroll.length,
      p95Ms: percentile(scroll.map((frame) => Number(frame.totalMs)).filter(Number.isFinite), 0.95),
      maxMs: Math.max(0, ...scroll.map((frame) => Number(frame.totalMs)).filter(Number.isFinite)),
      maxRenderedTurns: Math.max(0, ...scroll.map((frame) => Number(frame.renderedTurns ?? 0))),
      maxReconciledTurns: Math.max(0, ...scroll.map((frame) => Number(frame.reconciledTurns ?? 0))),
      maxLayoutVisits: Math.max(0, ...scroll.map((frame) => Number(frame.layoutVisits ?? 0))),
      maxHeightIndexOperations: Math.max(0, ...scroll.map((frame) => Number(frame.heightIndexOperations ?? 0))),
    },
    mascot: {
      frames: mascot.length,
      maxRenderedTurns: Math.max(0, ...mascot.map((frame) => Number(frame.renderedTurns ?? 0))),
    },
  };
}

export function historyOffset(plain) {
  const match = /History \+(\d+) lines/u.exec(plain);
  return match ? Number(match[1]) : 0;
}

export function decodeLastOsc52(terminalWrites) {
  const matches = [...terminalWrites.matchAll(/\x1b\]52;c;([A-Za-z0-9+/=]+)(?:\x07|\x1b\\)/gu)];
  const payload = matches.at(-1)?.[1];
  return payload ? Buffer.from(payload, 'base64').toString('utf8') : null;
}

export function collectMetadata(repo, cli, tmuxName) {
  const command = (file, args) => execFileSync(file, args, { cwd: repo, encoding: 'utf8' }).trim();
  return {
    generatedAt: new Date().toISOString(),
    commit: command('git', ['rev-parse', 'HEAD']),
    branch: command('git', ['branch', '--show-current']),
    node: process.version,
    tmux: command('tmux', ['-V']),
    tmuxServer: tmuxName,
    cli: resolve(cli),
  };
}

export function writeReport(path, report) {
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

function reportPaths(root) {
  const found = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) visit(path);
      else if (entry === 'report.json' && ['short', 'long'].includes(basename(dirname(path)))) found.push(path);
    }
  };
  visit(root);
  return found.sort();
}

/** Aggregate consecutive deterministic rounds and fail closed when either short/long evidence is absent. */
export function aggregateTmuxReports(root, { expectedRounds = 2 } = {}) {
  const absolute = resolve(root);
  const reports = reportPaths(absolute).map((path) => ({
    path,
    round: relative(absolute, path).split(/[\\/]/u)[0],
    scenario: basename(dirname(path)),
    value: JSON.parse(readFileSync(path, 'utf8')),
  }));
  const rounds = [...new Set(reports.map((entry) => entry.round))].sort();
  assert.equal(rounds.length, expectedRounds,
    `tmux aggregate requires ${expectedRounds} rounds (found ${rounds.length}: ${rounds.join(', ')})`);
  for (const round of rounds) {
    const scenarios = reports.filter((entry) => entry.round === round).map((entry) => entry.scenario).sort();
    assert.deepEqual(scenarios, ['long', 'short'], `${round}: both long and short reports are required exactly once`);
  }
  for (const entry of reports) {
    assert.equal(entry.value.passed, true, `${entry.path}: scenario did not pass`);
    assert.ok(entry.value.metadata?.commit && entry.value.metadata?.node
      && entry.value.metadata?.tmux && entry.value.metadata?.cli,
    `${entry.path}: commit/Node/tmux/CLI metadata is required`);
    assert.ok(entry.value.performance?.ordinaryMs, `${entry.path}: performance summary is required`);
  }
  const number = (path, fallback = 0) => Number.isFinite(Number(path)) ? Number(path) : fallback;
  return {
    passed: true,
    root: absolute,
    rounds: rounds.length,
    scenarios: reports.length,
    captures: reports.reduce((sum, entry) => sum + (Array.isArray(entry.value.captures)
      ? entry.value.captures.length : number(entry.value.captures)), 0),
    commits: [...new Set(reports.map((entry) => entry.value.metadata.commit))].sort(),
    ordinaryMs: {
      p95: Math.max(0, ...reports.map((entry) => number(entry.value.performance.ordinaryMs.p95))),
      max: Math.max(0, ...reports.map((entry) => number(entry.value.performance.ordinaryMs.max))),
    },
    forcedMs: {
      p95: Math.max(0, ...reports.map((entry) => number(entry.value.performance.forcedMs?.p95))),
      max: Math.max(0, ...reports.map((entry) => number(entry.value.performance.forcedMs?.max))),
    },
    reports: reports.map((entry) => ({ round: entry.round, scenario: entry.scenario, path: entry.path })),
  };
}
