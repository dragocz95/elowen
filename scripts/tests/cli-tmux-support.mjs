import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { visibleWidth } from '@earendil-works/pi-tui';

const STATUS_ROW = /^\s+(?:Build|Plan)(?:\s+·\s+\S+|…)/u;

export const EXPECTED_TMUX_CAPTURE_LABELS = Object.freeze({
  goal: Object.freeze([
    '01-goal-active', '02-goal-elapsed', '03-goal-active-40x15', '04-goal-active-restored',
    '05-goal-reconnected', '06-goal-complete', '07-post-goal-input',
  ]),
  short: Object.freeze([
    '01-one-short-message', '02-rapid-tool-control-burst', '03-page-up-after-burst',
    '04-restored-after-resize', '05-reopened-same-conversation', '06-reopened-send-healthy',
    '07-reopened-page-up',
  ]),
  long: Object.freeze([
    '01-initial-long-history', '01b-multiline-1-rows', '01b-multiline-6-rows',
    '01b-multiline-8-rows', '01c-multiline-up-reveals-head', '01d-multiline-down-returns-tail',
    '01e-wrapped-cursor-40x15', '01f-wrapped-cursor-after-resize', '02-page-up',
    '02b-drag-copy-complete', '03-streaming-queued', '03a-compacting-queued',
    '03b-queued-delivered', '04-streaming-20x10',
    '04-streaming-32x12', '04-streaming-40x15', '04-streaming-80x24', '04-streaming-103x24',
    '04-streaming-104x24', '04-streaming-120x30', '04-streaming-180x50',
    '04b-streaming-telemetry-hidden', '07-streaming-restored', '08-panels-after-stream',
    '08a-subagent-drill-in', '08b-subagent-return-parent', '08c-telemetry-36-columns',
    '09-expanded-todos', '10-scrollbar-drag-with-panel', '10b-hidden-panel-idle-zero',
    '10c-narrow-panel-idle-zero', '11-external-editor-return', '12-help-modal',
    '13-short-slash-menu', '13b-open-slash-reflow-32x12', '14-short-ask-dock',
    '14b-open-ask-reflow-32x12', '15-final-96x24',
  ]),
  signals: Object.freeze(['01-before-signal']),
});

export function paneLines(value) {
  if (value === '') return [];
  return (value.endsWith('\n') ? value.slice(0, -1) : value).split('\n');
}

export function resolveArtifactDir(root, scenario) {
  return resolve(root, scenario);
}

/** Deterministic identity for the complete compiled tree, including relative paths and empty directories. */
export function distContentHash(root) {
  const hash = createHash('sha256');
  const visit = (dir, prefix = '') => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((left, right) => (
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    ));
    if (entries.length === 0) hash.update(`directory\0${prefix}\0`);
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        hash.update(`directory\0${relativePath}\0`);
        visit(path, relativePath);
      } else if (entry.isFile()) {
        const content = readFileSync(path);
        hash.update(`file\0${relativePath}\0${content.length}\0`);
        hash.update(content);
        hash.update('\0');
      } else if (entry.isSymbolicLink()) {
        hash.update(`symlink\0${relativePath}\0${readlinkSync(path)}\0`);
      } else {
        throw new Error(`unsupported dist entry: ${path}`);
      }
    }
  };
  visit(resolve(root));
  return hash.digest('hex');
}

export function buildContentIdentity(commit, distSha256) {
  return `git:${commit}:dist-sha256:${distSha256}`;
}

/** One ID shared by every scenario in a built run. Final evidence supplies it explicitly; the convenience
 * npm command generates one fallback once in its parent runner and propagates it to all child scenarios. */
export function resolveTmuxRunId(env = process.env, generate = randomUUID) {
  return env.ELOWEN_TMUX_RUN_ID?.trim() || `local-${generate()}`;
}

export function createArtifactDir(scenario) {
  const configured = process.env.ELOWEN_TMUX_ARTIFACT_ROOT?.trim();
  const dir = configured
    ? resolveArtifactDir(configured, scenario)
    : mkdtempSync(join(tmpdir(), `elowen-tui-${scenario}-artifacts-`));
  mkdirSync(dir, { recursive: true });
  if (configured) {
    const stale = readdirSync(dir);
    assert.equal(stale.length, 0,
      `${scenario}: configured artifact directory must be fresh (not empty: ${stale.join(', ')})`);
  }
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

export function readJsonLinesSnapshot(path, { live = false } = {}) {
  let source;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    if (live && error?.code === 'ENOENT') return { values: [], trailingPartial: false };
    throw error;
  }
  const terminated = source.endsWith('\n');
  const lines = source.split('\n');
  if (terminated) lines.pop();
  const values = [];
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) {
      if (source.length === 0) continue;
      throw new SyntaxError(`${path}:${index + 1}: blank JSONL record`);
    }
    try {
      values.push(JSON.parse(line));
    } catch (error) {
      const trailingPartial = live && !terminated && index === lines.length - 1;
      if (trailingPartial) {
        // A completed older frame is not safe capture evidence while the next record is being appended.
        // Expose this state to captureState so it retries instead of binding a new pane to stale metrics.
        return { values, trailingPartial: true };
      }
      throw new SyntaxError(`${path}:${index + 1}: invalid JSONL record (${error.message})`, { cause: error });
    }
  }
  return { values, trailingPartial: false };
}

export function readJsonLines(path, options) {
  return readJsonLinesSnapshot(path, options).values;
}

export function readFrames(path, options) {
  return readJsonLines(path, options).filter((entry) => entry.type === 'frame');
}

function readFrameSnapshot(path) {
  const snapshot = readJsonLinesSnapshot(path, { live: true });
  return { frames: snapshot.values.filter((entry) => entry.type === 'frame'), trailingPartial: snapshot.trailingPartial };
}

export function latestFrame(frames, columns, rows, since = 0) {
  return [...frames].reverse().find((frame) => frame.at >= since
    && frame.terminal?.columns === columns && frame.terminal?.rows === rows) ?? null;
}

function frameIdentity(frame) {
  return frame ? `${frame.pid ?? 'unknown'}:${frame.sequence}:${frame.at}` : null;
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
  forbiddenMarkers = [], expectScrollbar, allowScrollbarOcclusion = false,
}) {
  let stable = null;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const beforeSnapshot = readFrameSnapshot(perfLog);
    const before = beforeSnapshot.frames.at(-1) ?? null;
    const stateBefore = terminalState(tmux, session);
    const plain = tmux.run(['capture-pane', '-p', '-t', session]);
    const ansi = tmux.run(['capture-pane', '-p', '-e', '-t', session]);
    const stateAfter = terminalState(tmux, session);
    const afterSnapshot = readFrameSnapshot(perfLog);
    if (beforeSnapshot.trailingPartial || afterSnapshot.trailingPartial) continue;
    const after = afterSnapshot.frames.at(-1) ?? null;
    const sameFrame = before && after && frameIdentity(before) === frameIdentity(after);
    const sameGeometry = stateBefore.columns === stateAfter.columns && stateBefore.rows === stateAfter.rows
      && after?.terminal?.columns === stateAfter.columns && after?.terminal?.rows === stateAfter.rows;
    if (sameFrame && sameGeometry) {
      stable = { state: stateAfter, plain, ansi, frame: after };
      break;
    }
  }
  assert.ok(stable, `${label}: could not capture plain and ANSI inside one completed frame sequence after 6 attempts`);
  const { state, plain, ansi, frame } = stable;
  const input = {
    label, plain, ansi, columns: state.columns, rows: state.rows, cursor: state.cursor, frame,
    expectCursor, forbiddenMarkers, expectScrollbar, allowScrollbarOcclusion,
  };
  const analysis = analyzeActiveCapture(input);
  const plainPath = join(artifactDir, `${label}.txt`);
  const ansiPath = join(artifactDir, `${label}.ansi.txt`);
  const statePath = join(artifactDir, `${label}.state.json`);
  writeFileSync(plainPath, plain);
  writeFileSync(ansiPath, ansi);
  writeFileSync(statePath, `${JSON.stringify({
    ...state,
    frame,
    analysis,
    contract: { expectCursor, forbiddenMarkers, expectScrollbar, allowScrollbarOcclusion },
  }, null, 2)}\n`);
  return { ...input, ...state, analysis, paths: { plain: plainPath, ansi: ansiPath, state: statePath } };
}

function nonNegativeNumber(value, label, { integer = false, positive = false } = {}) {
  assert.equal(typeof value, 'number', `${label} must be an actual number`);
  assert.ok(Number.isFinite(value), `${label} must be finite`);
  assert.ok(positive ? value > 0 : value >= 0, `${label} must be ${positive ? 'positive' : 'nonnegative'}`);
  if (integer) assert.ok(Number.isInteger(value), `${label} must be an integer`);
  return value;
}

function sectionTotal(sections, label = 'frame.sections') {
  assert.ok(sections && typeof sections === 'object' && !Array.isArray(sections), `${label} must be an object`);
  const entries = Object.entries(sections);
  assert.ok(entries.length > 0, `${label} must not be empty`);
  return entries.reduce((sum, [name, value]) => sum
    + nonNegativeNumber(value, `${label}.${name}`, { integer: true }), 0);
}

function validateFrame(frame, prefix, ordinaryLimitMs = 50) {
  assert.ok(frame && typeof frame === 'object' && !Array.isArray(frame), `${prefix} must be an object`);
  nonNegativeNumber(frame.sequence, `${prefix}.sequence`, { integer: true, positive: true });
  nonNegativeNumber(frame.at, `${prefix}.at`);
  assert.ok(Array.isArray(frame.reasons) && frame.reasons.length > 0
    && frame.reasons.every((reason) => typeof reason === 'string' && reason.length > 0),
  `${prefix}.reasons must be non-empty strings`);
  assert.equal(typeof frame.forced, 'boolean', `${prefix}.forced must be a boolean`);
  for (const name of ['prepareMs', 'queueMs', 'rootRenderMs', 'piTailMs', 'transcriptMs', 'totalMs']) {
    nonNegativeNumber(frame[name], `${prefix}.${name}`);
  }
  for (const name of [
    'transcriptRows', 'visibleRows', 'renderedTurns', 'reconciledTurns', 'indexedTurns', 'cachedRows',
    'layoutVisits', 'scrollOffset', 'maxScrollOffset', 'heightIndexOperations', 'rootRows', 'maxVisibleWidth',
  ]) nonNegativeNumber(frame[name], `${prefix}.${name}`, { integer: true });
  if (frame.transcriptRowsExact != null) assert.equal(typeof frame.transcriptRowsExact, 'boolean',
    `${prefix}.transcriptRowsExact must be a boolean`);
  assert.ok(frame.terminal && typeof frame.terminal === 'object', `${prefix}.terminal must be an object`);
  const columns = nonNegativeNumber(frame.terminal.columns, `${prefix}.terminal.columns`, { integer: true, positive: true });
  const rows = nonNegativeNumber(frame.terminal.rows, `${prefix}.terminal.rows`, { integer: true, positive: true });
  assert.equal(frame.rootRows, rows, `${prefix}: rootRows must equal terminal rows`);
  assert.equal(frame.maxVisibleWidth, columns, `${prefix}: visible width must equal terminal columns`);
  assert.equal(sectionTotal(frame.sections, `${prefix}.sections`), frame.rootRows,
    `${prefix}: section total must equal rootRows`);
  assert.ok(frame.scrollOffset <= frame.maxScrollOffset, `${prefix}: scrollOffset exceeds maxScrollOffset`);
  if (!frame.forced) assert.ok(frame.totalMs < ordinaryLimitMs,
    `${prefix}: ordinary frame ${frame.totalMs} ms exceeds ${ordinaryLimitMs} ms`);
  for (const [index, span] of (frame.reverseSpans ?? []).entries()) {
    assert.ok(span && typeof span === 'object', `${prefix}.reverseSpans[${index}] must be an object`);
    assert.ok(span.stage === 'raw' || span.stage === 'constrained', `${prefix}.reverseSpans[${index}].stage is invalid`);
    for (const name of ['row', 'from', 'to']) nonNegativeNumber(span[name],
      `${prefix}.reverseSpans[${index}].${name}`, { integer: true });
    assert.ok(span.to >= span.from, `${prefix}.reverseSpans[${index}] has a negative span`);
  }
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

function assertNoAnsiBlankBand(label, ansi, columns) {
  const sgrBlank = /\x1b\[([0-9;]*)m( +)/gu;
  for (const [row, line] of paneLines(ansi).entries()) {
    for (const match of line.matchAll(sgrBlank)) {
      const parameters = match[1].split(';');
      if (!parameters.includes('7')) continue;
      const spaces = match[2].length;
      // tmux `capture-pane -e` can keep the cursor SGR open across a following padding cell even though
      // the application's diagnosed constrained span is exactly one cell. The reported corruption is a
      // broad band; 4+ empty cells remains strict while avoiding that tmux serialization artefact.
      assert.ok(spaces < 4, `${label}: reverse-video blank band spans ${spaces} cells on row ${row}`);
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
  forbiddenMarkers = [], expectScrollbar, allowScrollbarOcclusion = false,
}) {
  validateFrame(frame, `${label}.frame`);
  const lines = paneLines(plain);
  assert.equal(lines.length, rows, `${label}: pane must contain exactly ${rows} rows`);
  const widths = lines.map((line) => visibleWidth(line));
  const maxWidth = Math.max(0, ...widths);
  assert.ok(widths.every((width) => width <= columns), `${label}: captured row exceeds ${columns} columns`);
  assert.equal(frame.terminal?.columns, columns, `${label}: diagnostic columns mismatch`);
  assert.equal(frame.terminal?.rows, rows, `${label}: diagnostic rows mismatch`);
  assert.equal(frame.rootRows, rows, `${label}: diagnostic rootRows must equal ${rows}`);
  assert.equal(frame.maxVisibleWidth, columns, `${label}: diagnostic visible width must equal ${columns}`);
  const statuses = lines.filter((line) => STATUS_ROW.test(line));
  assert.equal(statuses.length, 1, `${label}: exactly one real status row is required`);
  for (const marker of forbiddenMarkers) assert.ok(!plain.includes(marker), `${label}: stale marker remains: ${marker}`);
  assertNoAnsiBlankBand(label, ansi, columns);
  const reverseSpans = (frame.reverseSpans ?? []).filter((span) => span.stage === 'constrained');
  assert.ok(reverseSpans.every((span) => span.to - span.from <= 1),
    `${label}: diagnostic reverse-video span is wider than one cursor cell`);
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
    validateFrame(frame, `frame ${index}`, ordinaryLimitMs);
  }
  return summarizeValidatedFrames(frames);
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
  assert.ok(frames.length > 0, 'perf diagnostics must contain frames');
  for (const [index, frame] of frames.entries()) validateFrame(frame, `frame ${index}`);
  return summarizeValidatedFrames(frames);
}

function summarizeValidatedFrames(frames) {
  const ordinary = frames.filter((frame) => !frame.forced);
  const forced = frames.filter((frame) => frame.forced);
  const scroll = frames.filter((frame) => frame.reasons?.some((reason) => reason.includes('scroll')));
  const mascot = frames.filter((frame) => frame.reasons?.some((reason) => reason.includes('mascot')));
  return {
    frames: frames.length,
    ordinaryFrames: ordinary.length,
    forcedFrames: forced.length,
    ordinaryMs: timing(ordinary.map((frame) => frame.totalMs)),
    ordinaryQueueMs: timing(ordinary.map((frame) => frame.queueMs)),
    ordinaryRootRenderMs: timing(ordinary.map((frame) => frame.rootRenderMs)),
    ordinaryPiTailMs: timing(ordinary.map((frame) => frame.piTailMs)),
    forcedMs: timing(forced.map((frame) => frame.totalMs)),
    coalescedFrames: frames.filter((frame) => (frame.reasons?.length ?? 0) > 1).length,
    scroll: {
      frames: scroll.length,
      p95Ms: percentile(scroll.map((frame) => frame.totalMs), 0.95),
      maxMs: Math.max(0, ...scroll.map((frame) => frame.totalMs)),
      maxRenderedTurns: Math.max(0, ...scroll.map((frame) => frame.renderedTurns)),
      maxReconciledTurns: Math.max(0, ...scroll.map((frame) => frame.reconciledTurns)),
      maxLayoutVisits: Math.max(0, ...scroll.map((frame) => frame.layoutVisits)),
      maxHeightIndexOperations: Math.max(0, ...scroll.map((frame) => frame.heightIndexOperations)),
    },
    mascot: {
      frames: mascot.length,
      maxRenderedTurns: Math.max(0, ...mascot.map((frame) => frame.renderedTurns)),
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

export function collectMetadata(repo, cli, tmuxName, env = process.env) {
  const command = (file, args) => execFileSync(file, args, { cwd: repo, encoding: 'utf8' }).trim();
  const commit = command('git', ['rev-parse', 'HEAD']);
  const distSha256 = distContentHash(join(repo, 'dist'));
  const runId = env.ELOWEN_TMUX_RUN_ID?.trim();
  assert.ok(runId, 'ELOWEN_TMUX_RUN_ID is required for reproducible tmux evidence');
  return {
    generatedAt: new Date().toISOString(),
    commit,
    branch: command('git', ['branch', '--show-current']),
    node: process.version,
    tmux: command('tmux', ['-V']),
    tmuxServer: tmuxName,
    cli: resolve(cli),
    runId,
    distSha256,
    buildIdentity: buildContentIdentity(commit, distSha256),
  };
}

/** Close a scenario's identity transaction. Metadata is sampled before the CLI process starts; this
 * second snapshot rejects a concurrent checkout/rebuild instead of relabelling already-running code. */
export function completeMetadata(started, repo) {
  const command = (file, args) => execFileSync(file, args, { cwd: repo, encoding: 'utf8' }).trim();
  const commit = command('git', ['rev-parse', 'HEAD']);
  const distSha256 = distContentHash(join(repo, 'dist'));
  assert.equal(commit, started.commit, 'Git HEAD changed while the tmux scenario was running');
  assert.equal(distSha256, started.distSha256, 'dist changed while the tmux scenario was running');
  assert.equal(started.buildIdentity, buildContentIdentity(commit, distSha256),
    'scenario start metadata does not match its completed build');
  return { ...started, completedAt: new Date().toISOString() };
}

export function writeReport(path, report) {
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

function reportPaths(root) {
  const requestedRoot = resolve(root);
  assert.ok(!lstatSync(requestedRoot).isSymbolicLink(),
    `tmux evidence root must not be a symlink: ${requestedRoot}`);
  const realRoot = realpathSync(requestedRoot);
  const found = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      assert.ok(!entry.isSymbolicLink(), `tmux evidence tree must not contain symlinks: ${path}`);
      if (entry.isDirectory()) visit(path);
      else if (entry.name === 'report.json' && ['goal', 'short', 'long', 'signals'].includes(basename(dirname(path)))) found.push(path);
    }
  };
  visit(realRoot);
  return found.sort();
}

function nonEmptyString(value, label) {
  assert.ok(typeof value === 'string' && value.trim().length > 0, `${label} must be a non-empty string`);
  return value;
}

function metadataIdentity(value, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  const identity = {};
  for (const field of [
    'generatedAt', 'completedAt', 'commit', 'branch', 'node', 'tmux', 'tmuxServer', 'cli', 'runId', 'distSha256', 'buildIdentity',
  ]) {
    identity[field] = nonEmptyString(value[field], `${label}.${field}`);
  }
  assert.ok(Number.isFinite(Date.parse(identity.generatedAt)), `${label}.generatedAt must be an ISO timestamp`);
  assert.ok(Number.isFinite(Date.parse(identity.completedAt)), `${label}.completedAt must be an ISO timestamp`);
  assert.ok(Date.parse(identity.completedAt) >= Date.parse(identity.generatedAt),
    `${label}.completedAt must not precede generatedAt`);
  assert.match(identity.distSha256, /^[a-f0-9]{64}$/u, `${label}.distSha256 must be a SHA-256 digest`);
  assert.equal(identity.buildIdentity, buildContentIdentity(identity.commit, identity.distSha256),
    `${label}.buildIdentity must bind the Git commit to the complete dist hash`);
  return identity;
}

function timingSummary(value, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  const p95 = nonNegativeNumber(value.p95, `${label}.p95`);
  const max = nonNegativeNumber(value.max, `${label}.max`);
  assert.ok(p95 <= max, `${label}.p95 must not exceed max`);
  return { p95, max };
}

function performanceSummary(value, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  const ordinaryMs = timingSummary(value.ordinaryMs, `${label}.ordinaryMs`);
  const forcedMs = timingSummary(value.forcedMs, `${label}.forcedMs`);
  assert.ok(ordinaryMs.max < 50, `${label}.ordinaryMs.max ${ordinaryMs.max} must remain below 50 ms`);
  return { ordinaryMs, forcedMs };
}

function evidenceFile(value, label, scenarioDir) {
  const input = nonEmptyString(value, label);
  const path = isAbsolute(input) ? resolve(input) : resolve(scenarioDir, input);
  const lexical = relative(scenarioDir, path);
  assert.ok(lexical && !lexical.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    && lexical !== '..' && !isAbsolute(lexical), `${label} must be contained inside ${scenarioDir}`);
  let size = 0;
  let realPath = null;
  try {
    size = statSync(path).size;
    realPath = realpathSync(path);
  } catch { /* asserted below */ }
  assert.ok(size > 0 && realPath, `${label} evidence must exist and be non-empty: ${path}`);
  const realRoot = realpathSync(scenarioDir);
  const realRelative = relative(realRoot, realPath);
  assert.ok(realRelative && !realRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    && realRelative !== '..' && !isAbsolute(realRelative), `${label} must not escape its scenario via symlink`);
  return path;
}

function expectedCaptureContract(scenario, captureLabel) {
  const forbiddenMarkers = captureLabel === '04-restored-after-resize'
    ? ['Terminal too small']
    : captureLabel === '04-streaming-20x10'
      ? ['E2E HISTORY MARKER']
      : /^04-streaming-(?:32x12|40x15|80x24|103x24|104x24|120x30|180x50)$/u.test(captureLabel)
        ? ['Terminal too small']
        : [];
  return {
    expectCursor: !['12-help-modal', '14-short-ask-dock', '14b-open-ask-reflow-32x12'].includes(captureLabel),
    forbiddenMarkers,
    allowScrollbarOcclusion: captureLabel === '12-help-modal',
  };
}

function captureEvidence(value, label, scenarioDir, scenario, rawFramesByIdentity) {
  assert.ok(Array.isArray(value) && value.length > 0, `${label} must contain capture evidence`);
  const expectedLabels = EXPECTED_TMUX_CAPTURE_LABELS[scenario];
  assert.ok(expectedLabels, `${label}: unknown capture scenario ${scenario}`);
  assert.deepEqual(value.map((capture) => capture?.label), expectedLabels,
    `${label}: every required ${scenario} checkpoint must appear exactly once and in order`);
  const usedPaths = new Set();
  for (const [index, capture] of value.entries()) {
    const captureLabel = nonEmptyString(capture?.label, `${label}[${index}].label`);
    const plainPath = evidenceFile(capture?.plain, `${label}[${index}].plain`, scenarioDir);
    const ansiPath = evidenceFile(capture?.ansi, `${label}[${index}].ansi`, scenarioDir);
    const statePath = evidenceFile(capture?.state, `${label}[${index}].state`, scenarioDir);
    for (const [field, path] of [['plain', plainPath], ['ansi', ansiPath], ['state', statePath]]) {
      const realPath = realpathSync(path);
      assert.ok(!usedPaths.has(realPath), `${label}[${index}].${field} reuses evidence path ${realPath}`);
      usedPaths.add(realPath);
    }
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.ok(state.analysis && typeof state.analysis === 'object' && !Array.isArray(state.analysis),
      `${label}[${index}].state must contain the capture-time analysis`);
    const contract = expectedCaptureContract(scenario, captureLabel);
    const plain = readFileSync(plainPath, 'utf8');
    if (scenario === 'goal') {
      if (/^0[1-5]-/u.test(captureLabel)) assert.match(plain, /\bGoal\b/u,
        `${label}[${index}]: active/reconnected goal capture must show the goal indicator`);
      else assert.doesNotMatch(plain, /◆\s*Goal/u,
        `${label}[${index}]: completed goal capture must not retain the active indicator`);
    }
    const identity = frameIdentity(state.frame);
    const rawFrame = identity ? rawFramesByIdentity.get(identity) : null;
    assert.ok(rawFrame,
      `${label}[${index}]: capture frame ${identity ?? 'missing'} is absent from raw perf evidence`);
    assert.deepEqual(state.frame, rawFrame,
      `${label}[${index}]: capture frame payload differs from its raw perf frame`);
    const analysis = analyzeActiveCapture({
      label: captureLabel,
      plain,
      ansi: readFileSync(ansiPath, 'utf8'),
      columns: state.columns,
      rows: state.rows,
      cursor: state.cursor,
      frame: rawFrame,
      expectCursor: contract.expectCursor,
      forbiddenMarkers: contract.forbiddenMarkers,
      allowScrollbarOcclusion: contract.allowScrollbarOcclusion,
    });
    assert.deepEqual(analysis, state.analysis,
      `${label}[${index}]: persisted capture analysis differs from analyzer-owned raw evidence contract`);
  }
  return value.length;
}

function rawFrameMap(frames, label) {
  const result = new Map();
  for (const [index, frame] of frames.entries()) {
    const identity = frameIdentity(frame);
    assert.ok(identity, `${label}[${index}] is missing a frame identity`);
    assert.ok(!result.has(identity), `${label} contains duplicate frame identity ${identity}`);
    result.set(identity, frame);
  }
  return result;
}

function lifecycleEvidence(entries, label, expectedCycles) {
  let active = false;
  let activePid = null;
  let lastSequence = 0;
  let cycles = 0;
  let previousAt = -Infinity;
  for (const [index, entry] of entries.entries()) {
    if (entry.type !== 'frame' && entry.type !== 'lifecycle') continue;
    const at = nonNegativeNumber(entry.at, `${label}[${index}].at`);
    assert.ok(at >= previousAt, `${label}: lifecycle/frame timestamps must be monotonic`);
    previousAt = at;
    if (entry.type === 'frame') {
      assert.ok(active, `${label}: frame ${entry.sequence ?? index} is outside an active lifecycle`);
      const pid = nonNegativeNumber(entry.pid, `${label}[${index}].pid`, { integer: true, positive: true });
      assert.equal(pid, activePid, `${label}: frame pid ${pid} differs from active lifecycle pid ${activePid}`);
      const sequence = nonNegativeNumber(entry.sequence, `${label}[${index}].sequence`, { integer: true, positive: true });
      assert.ok(sequence > lastSequence, `${label}: frame sequence must increase within one lifecycle`);
      lastSequence = sequence;
      continue;
    }
    if (entry.action === 'start') {
      assert.equal(active, false, `${label}: lifecycle start cannot precede the prior stop`);
      activePid = nonNegativeNumber(entry.pid, `${label}[${index}].pid`, { integer: true, positive: true });
      active = true;
      lastSequence = 0;
      cycles++;
    } else if (entry.action === 'stop') {
      assert.equal(active, true, `${label}: lifecycle stop must follow a start`);
      const pid = nonNegativeNumber(entry.pid, `${label}[${index}].pid`, { integer: true, positive: true });
      assert.equal(pid, activePid, `${label}: lifecycle stop pid ${pid} differs from active pid ${activePid}`);
      active = false;
      activePid = null;
    }
  }
  assert.equal(active, false, `${label}: final lifecycle did not stop`);
  assert.equal(cycles, expectedCycles, `${label}: expected exactly ${expectedCycles} complete lifecycle cycles`);
}

function terminalProtocolEvidence(path, label) {
  const writes = readFileSync(path, 'utf8');
  for (const [name, enabled, disabled] of [
    ['alternate screen', '\x1b[?1049h', '\x1b[?1049l'],
    ['mouse reporting 1000', '\x1b[?1000h', '\x1b[?1000l'],
    ['mouse reporting 1002', '\x1b[?1002h', '\x1b[?1002l'],
    ['mouse reporting 1006', '\x1b[?1006h', '\x1b[?1006l'],
  ]) {
    const enabledAt = writes.lastIndexOf(enabled);
    const disabledAt = writes.lastIndexOf(disabled);
    assert.ok(enabledAt >= 0 && disabledAt > enabledAt, `${label}: ${name} must be disabled after it was enabled`);
  }
}

function normalScenarioEvidence(report, label, scenarioDir) {
  const evidence = report.evidence;
  assert.ok(evidence && typeof evidence === 'object' && !Array.isArray(evidence), `${label}.evidence must be an object`);
  const perfPath = evidenceFile(evidence.perf, `${label}.evidence.perf`, scenarioDir);
  const ttyPath = evidenceFile(evidence.ttyState, `${label}.evidence.ttyState`, scenarioDir);
  const writesPath = evidenceFile(evidence.terminalWrites, `${label}.evidence.terminalWrites`, scenarioDir);
  const shellPath = evidenceFile(evidence.restoredShell, `${label}.evidence.restoredShell`, scenarioDir);
  const perfEntries = readJsonLines(perfPath);
  lifecycleEvidence(perfEntries, `${label}.evidence.perf`, report.scenario === 'short' ? 2 : 1);
  const frames = perfEntries.filter((entry) => entry.type === 'frame');
  const performance = analyzeFrameDiagnostics(frames);
  const reported = performanceSummary(report.performance, `${label}.performance`);
  assert.deepEqual(reported.ordinaryMs, performance.ordinaryMs, `${label}: reported ordinary timing differs from raw perf`);
  assert.deepEqual(reported.forcedMs, performance.forcedMs, `${label}: reported forced timing differs from raw perf`);
  assert.deepEqual(report.performance, performance, `${label}: reported performance differs from raw perf evidence`);
  if (report.scenario === 'long') {
    assert.equal(report.compactionBusyVisible, true, `${label}.compactionBusyVisible must be true`);
    assert.equal(report.queuedEchoDelayed, true, `${label}.queuedEchoDelayed must be true`);
    assert.ok(performance.scroll.maxRenderedTurns <= 12,
      `${label}: long scroll rendered too many turns (${performance.scroll.maxRenderedTurns})`);
    assert.ok(performance.scroll.maxReconciledTurns <= 12,
      `${label}: long scroll reconciled too many turns (${performance.scroll.maxReconciledTurns})`);
    assert.ok(performance.scroll.maxLayoutVisits <= 64,
      `${label}: long scroll layout work is not viewport-bounded (${performance.scroll.maxLayoutVisits})`);
    assert.ok(performance.scroll.maxHeightIndexOperations <= 512,
      `${label}: long scroll height-index work is not bounded (${performance.scroll.maxHeightIndexOperations})`);
    assert.equal(performance.mascot.maxRenderedTurns, 0,
      `${label}: mascot frames must not render settled turns`);
  }
  if (report.scenario === 'goal') {
    for (const field of [
      'goalStartingNoticeAbsent', 'goalElapsedAdvanced', 'goalVisibleAt40x15',
      'reconnectSnapshotApplied', 'staleKickoffResponseIgnored', 'goalRemovedAtCompletion',
      'postGoalInputAccepted', 'terminalStateRestored',
    ]) assert.equal(report[field], true, `${label}.${field} must be true`);
    assert.equal(report.idleFramesAfter1100Ms, 0, `${label}: completed goal must leave no idle render timer`);
    const requestsPath = evidenceFile(evidence.requests, `${label}.evidence.requests`, scenarioDir);
    const requests = readJsonLines(requestsPath);
    assert.ok(requests.filter((entry) => entry.kind === 'request' && entry.path === '/brain/stream').length >= 2,
      `${label}: goal scenario must prove a stream reconnect`);
    assert.ok(requests.some((entry) => entry.kind === 'snapshot' && entry.goalStatus === 'active'),
      `${label}: reconnect must carry an active authoritative goal snapshot`);
    assert.ok(requests.some((entry) => entry.kind === 'event' && entry.event?.type === 'goal' && entry.event.goal?.status === 'done'),
      `${label}: goal scenario must contain a streamed done transition`);
    assert.ok(requests.some((entry) => entry.kind === 'goal-http-response' && entry.status === 'active'),
      `${label}: goal scenario must exercise an adversarial stale HTTP completion`);
  }
  const tty = readFileSync(ttyPath, 'utf8').trim().split('\n');
  assert.equal(tty.length, 2, `${label}: tty evidence must contain before and after states`);
  assert.ok(tty[0] && tty[1] && tty[0] === tty[1], `${label}: tty state was not restored exactly`);
  const shell = readFileSync(shellPath, 'utf8');
  const expectedShellMarker = report.scenario === 'short'
    ? 'E2E SHORT SHELL RESTORED'
    : report.scenario === 'long' ? 'E2E SHELL RESTORED'
      : report.scenario === 'goal' ? 'E2E GOAL SHELL RESTORED' : null;
  assert.ok(expectedShellMarker && shell.includes(expectedShellMarker),
    `${label}: exact ${report.scenario} restored shell marker is missing`);
  assert.doesNotMatch(shell, /MaxListenersExceededWarning|\bat\s+\S+\s+\([^)]*\.js:\d+/u,
    `${label}: restored shell contains a warning or stack trace`);
  terminalProtocolEvidence(writesPath, label);
  return { performance, rawFramesByIdentity: rawFrameMap(frames, `${label}.evidence.perf.frames`) };
}

function signalEvidence(signalCase, label, signalsDir) {
  const signal = nonEmptyString(signalCase.signal, `${label}.signal`);
  const caseDir = join(signalsDir, signal.toLowerCase());
  const realSignalsDir = realpathSync(signalsDir);
  const realCaseDir = realpathSync(caseDir);
  const caseRelative = relative(realSignalsDir, realCaseDir);
  assert.ok(caseRelative && !caseRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    && caseRelative !== '..' && !isAbsolute(caseRelative), `${label} evidence directory must stay inside signals`);
  const evidence = signalCase.evidence;
  assert.ok(evidence && typeof evidence === 'object' && !Array.isArray(evidence), `${label}.evidence must be an object`);
  const shellPath = evidenceFile(evidence.restoredShell, `${label}.evidence.restoredShell`, caseDir);
  const ttyPath = evidenceFile(evidence.ttyState, `${label}.evidence.ttyState`, caseDir);
  const writesPath = evidenceFile(evidence.terminalWrites, `${label}.evidence.terminalWrites`, caseDir);
  const perfPath = evidenceFile(evidence.perf, `${label}.evidence.perf`, caseDir);

  const shell = readFileSync(shellPath, 'utf8');
  assert.match(shell, new RegExp(`E2E ${signal} SHELL RESTORED`, 'u'), `${label}: restored shell marker is missing`);
  assert.doesNotMatch(shell, /MaxListenersExceededWarning|\bat\s+\S+\s+\([^)]*\.js:\d+/u,
    `${label}: restored shell contains a warning or stack trace`);

  const tty = readFileSync(ttyPath, 'utf8').trim().split('\n');
  assert.equal(tty.length, 2, `${label}: tty evidence must contain before and after states`);
  assert.ok(tty[0] && tty[1], `${label}: tty states must be non-empty`);
  assert.equal(tty[1], tty[0], `${label}: tty state was not restored exactly`);

  terminalProtocolEvidence(writesPath, label);

  const perfEntries = readJsonLines(perfPath);
  lifecycleEvidence(perfEntries, `${label}.evidence.perf`, 1);
  const frames = perfEntries.filter((entry) => entry.type === 'frame');
  const performance = analyzeFrameDiagnostics(frames);
  const captures = captureEvidence(
    [evidence.before], `${label}.evidence.before`, caseDir, 'signals',
    rawFrameMap(frames, `${label}.evidence.perf.frames`),
  );
  const reported = performanceSummary(signalCase.performance, `${label}.performance`);
  assert.deepEqual(reported.ordinaryMs, performance.ordinaryMs, `${label}: reported ordinary timing differs from raw perf`);
  assert.deepEqual(reported.forcedMs, performance.forcedMs, `${label}: reported forced timing differs from raw perf`);
  assert.deepEqual(signalCase.performance, performance, `${label}: reported performance differs from raw perf evidence`);
  return { captures, performance };
}

/** Aggregate consecutive deterministic rounds and fail closed unless every scenario and artifact agrees. */
export function aggregateTmuxReports(root, {
  expectedRounds = 2,
  repo = process.cwd(),
  expectedCommit = null,
  expectedDistHash = null,
  now = Date.now(),
  maxEvidenceAgeMs = 60 * 60_000,
  clockSkewMs = 60_000,
} = {}) {
  const requestedRoot = resolve(root);
  const absolute = realpathSync(requestedRoot);
  assert.equal(absolute, requestedRoot,
    `tmux evidence root and every parent component must be canonical (symlink found): ${requestedRoot}`);
  const command = (file, args) => execFileSync(file, args, { cwd: repo, encoding: 'utf8' }).trim();
  const requiredCommit = nonEmptyString(expectedCommit ?? command('git', ['rev-parse', 'HEAD']), 'expected commit');
  const requiredDistHash = nonEmptyString(expectedDistHash ?? distContentHash(join(repo, 'dist')), 'expected dist hash');
  assert.match(requiredDistHash, /^[a-f0-9]{64}$/u, 'expected dist hash must be a SHA-256 digest');
  const reports = reportPaths(absolute).map((path) => {
    const parts = relative(absolute, path).split(/[\\/]/u);
    const directScenarioRoot = parts.length === 2 && ['goal', 'short', 'long', 'signals'].includes(parts[0]);
    return {
      path,
      round: directScenarioRoot ? basename(absolute) : parts[0],
      scenario: basename(dirname(path)),
      value: JSON.parse(readFileSync(path, 'utf8')),
    };
  });
  const rounds = [...new Set(reports.map((entry) => entry.round))].sort();
  assert.equal(rounds.length, expectedRounds,
    `tmux aggregate requires ${expectedRounds} rounds (found ${rounds.length}: ${rounds.join(', ')})`);
  for (const round of rounds) {
    const scenarios = reports.filter((entry) => entry.round === round).map((entry) => entry.scenario).sort();
    assert.deepEqual(scenarios, ['goal', 'long', 'short', 'signals'],
      `${round}: goal, short, long and signals reports are required exactly once`);
  }
  const stableIdentities = [];
  const runIdsByRound = new Map(rounds.map((round) => [round, new Set()]));
  const executionServers = [];
  const performance = [];
  let captures = 0;
  const recordMetadata = (value, label, round, execution = false) => {
    const identity = metadataIdentity(value, label);
    const startedAt = Date.parse(identity.generatedAt);
    const completedAt = Date.parse(identity.completedAt);
    assert.ok(completedAt - startedAt <= maxEvidenceAgeMs,
      `${label}: scenario duration exceeds the accepted evidence window`);
    assert.ok(completedAt <= now + clockSkewMs, `${label}: completion timestamp is in the future`);
    assert.ok(now - completedAt <= maxEvidenceAgeMs, `${label}: stale tmux evidence is not accepted`);
    assert.equal(identity.commit, requiredCommit, `${label}.commit must match expected HEAD ${requiredCommit}`);
    assert.equal(identity.distSha256, requiredDistHash, `${label}.distSha256 must match the current dist build`);
    assert.equal(identity.buildIdentity, buildContentIdentity(requiredCommit, requiredDistHash),
      `${label}.buildIdentity must match the expected build`);
    runIdsByRound.get(round).add(identity.runId);
    if (execution) executionServers.push(identity.tmuxServer);
    stableIdentities.push({
      commit: identity.commit, branch: identity.branch, node: identity.node, tmux: identity.tmux,
      cli: identity.cli, distSha256: identity.distSha256, buildIdentity: identity.buildIdentity,
    });
    return identity;
  };
  for (const entry of reports) {
    assert.equal(entry.value.passed, true, `${entry.path}: scenario did not pass`);
    assert.equal(entry.value.scenario, entry.scenario,
      `${entry.path}: report scenario must match its ${entry.scenario} directory`);
    recordMetadata(entry.value.metadata, `${entry.path}.metadata`, entry.round, entry.scenario !== 'signals');
    if (entry.scenario === 'signals') {
      assert.ok(Array.isArray(entry.value.cases), `${entry.path}.cases must be an array`);
      assert.deepEqual(entry.value.cases.map((item) => item.signal).sort(), ['SIGHUP', 'SIGTERM'],
        `${entry.path}: SIGTERM and SIGHUP cases are required exactly once`);
      for (const [index, signalCase] of entry.value.cases.entries()) {
        assert.equal(signalCase.passed, true, `${entry.path}.cases[${index}] did not pass`);
        assert.equal(signalCase.terminalStateRestored, true,
          `${entry.path}.cases[${index}] did not restore terminal state`);
        assert.equal(signalCase.shellReadable, true, `${entry.path}.cases[${index}] did not restore a readable shell`);
        recordMetadata(signalCase.metadata, `${entry.path}.cases[${index}].metadata`, entry.round, true);
        const raw = signalEvidence(signalCase, `${entry.path}.cases[${index}]`, dirname(entry.path));
        captures += raw.captures;
        performance.push(raw.performance);
      }
    } else {
      const raw = normalScenarioEvidence(entry.value, entry.path, dirname(entry.path));
      captures += captureEvidence(
        entry.value.captures, `${entry.path}.captures`, dirname(entry.path), entry.scenario,
        raw.rawFramesByIdentity,
      );
      performance.push(raw.performance);
    }
  }
  const identityKeys = [...new Set(stableIdentities.map((identity) => JSON.stringify(identity)))];
  assert.equal(identityKeys.length, 1, 'all tmux reports must have one identical commit/build identity');
  const roundRunIds = rounds.map((round) => {
    const ids = [...runIdsByRound.get(round)];
    assert.equal(ids.length, 1, `${round}: every scenario must share exactly one ELOWEN_TMUX_RUN_ID`);
    return ids[0];
  });
  assert.equal(new Set(roundRunIds).size, roundRunIds.length, 'every tmux round must use a unique run id');
  assert.equal(new Set(executionServers).size, executionServers.length,
    'every tmux scenario execution must use a unique tmux server');
  return {
    passed: true,
    root: absolute,
    rounds: rounds.length,
    scenarios: reports.length,
    captures,
    commits: [requiredCommit],
    distSha256: requiredDistHash,
    runIds: roundRunIds,
    ordinaryMs: {
      p95: Math.max(0, ...performance.map((entry) => entry.ordinaryMs.p95)),
      max: Math.max(0, ...performance.map((entry) => entry.ordinaryMs.max)),
    },
    forcedMs: {
      p95: Math.max(0, ...performance.map((entry) => entry.forcedMs.p95)),
      max: Math.max(0, ...performance.map((entry) => entry.forcedMs.max)),
    },
    reports: reports.map((entry) => ({ round: entry.round, scenario: entry.scenario, path: entry.path })),
  };
}
