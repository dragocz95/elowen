import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { visibleWidth } from '@earendil-works/pi-tui';

const STATUS_ROW = /^\s+(?:Build|Plan)(?:\s+·\s+\S+|…)/u;

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

export function readJsonLines(path, { live = false } = {}) {
  let source;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    if (live && error?.code === 'ENOENT') return [];
    throw error;
  }
  const terminated = source.endsWith('\n');
  const lines = source.split('\n');
  if (terminated) lines.pop();
  const values = [];
  for (const [index, line] of lines.entries()) {
    if (!line) continue;
    try {
      values.push(JSON.parse(line));
    } catch (error) {
      const trailingPartial = live && !terminated && index === lines.length - 1;
      if (trailingPartial) break;
      throw new SyntaxError(`${path}:${index + 1}: invalid JSONL record (${error.message})`, { cause: error });
    }
  }
  return values;
}

export function readFrames(path, options) {
  return readJsonLines(path, options).filter((entry) => entry.type === 'frame');
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
    const before = readFrames(perfLog, { live: true }).at(-1) ?? null;
    const stateBefore = terminalState(tmux, session);
    const plain = tmux.run(['capture-pane', '-p', '-t', session]);
    const ansi = tmux.run(['capture-pane', '-p', '-e', '-t', session]);
    const stateAfter = terminalState(tmux, session);
    const after = readFrames(perfLog, { live: true }).at(-1) ?? null;
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
  writeFileSync(statePath, `${JSON.stringify({ ...state, frame, analysis }, null, 2)}\n`);
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

export function writeReport(path, report) {
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

function reportPaths(root) {
  const found = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) visit(path);
      else if (entry === 'report.json' && ['short', 'long', 'signals'].includes(basename(dirname(path)))) found.push(path);
    }
  };
  visit(root);
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
    'generatedAt', 'commit', 'branch', 'node', 'tmux', 'tmuxServer', 'cli', 'runId', 'distSha256', 'buildIdentity',
  ]) {
    identity[field] = nonEmptyString(value[field], `${label}.${field}`);
  }
  assert.ok(Number.isFinite(Date.parse(identity.generatedAt)), `${label}.generatedAt must be an ISO timestamp`);
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

function captureEvidence(value, label, scenarioDir) {
  assert.ok(Array.isArray(value) && value.length > 0, `${label} must contain capture evidence`);
  for (const [index, capture] of value.entries()) {
    nonEmptyString(capture?.label, `${label}[${index}].label`);
    for (const field of ['plain', 'ansi', 'state']) {
      evidenceFile(capture?.[field], `${label}[${index}].${field}`, scenarioDir);
    }
  }
  return value.length;
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
  const captures = captureEvidence([evidence.before], `${label}.evidence.before`, caseDir);
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

  const writes = readFileSync(writesPath, 'utf8');
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

  const perfEntries = readJsonLines(perfPath);
  const starts = perfEntries.filter((entry) => entry.type === 'lifecycle' && entry.action === 'start');
  const stops = perfEntries.filter((entry) => entry.type === 'lifecycle' && entry.action === 'stop');
  assert.equal(starts.length, 1, `${label}: perf evidence must contain exactly one lifecycle start`);
  assert.equal(stops.length, 1, `${label}: perf evidence must contain exactly one lifecycle stop`);
  const frames = perfEntries.filter((entry) => entry.type === 'frame');
  const performance = analyzeFrameDiagnostics(frames);
  assert.ok(frames.every((frame) => frame.at <= stops[0].at), `${label}: a frame rendered after lifecycle stop`);
  const reported = performanceSummary(signalCase.performance, `${label}.performance`);
  assert.deepEqual(reported.ordinaryMs, performance.ordinaryMs, `${label}: reported ordinary timing differs from raw perf`);
  assert.deepEqual(reported.forcedMs, performance.forcedMs, `${label}: reported forced timing differs from raw perf`);
  return { captures, performance };
}

/** Aggregate consecutive deterministic rounds and fail closed unless every scenario and artifact agrees. */
export function aggregateTmuxReports(root, {
  expectedRounds = 2,
  repo = process.cwd(),
  expectedCommit = null,
  expectedDistHash = null,
} = {}) {
  const absolute = resolve(root);
  const command = (file, args) => execFileSync(file, args, { cwd: repo, encoding: 'utf8' }).trim();
  const requiredCommit = nonEmptyString(expectedCommit ?? command('git', ['rev-parse', 'HEAD']), 'expected commit');
  const requiredDistHash = nonEmptyString(expectedDistHash ?? distContentHash(join(repo, 'dist')), 'expected dist hash');
  assert.match(requiredDistHash, /^[a-f0-9]{64}$/u, 'expected dist hash must be a SHA-256 digest');
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
    assert.deepEqual(scenarios, ['long', 'short', 'signals'],
      `${round}: short, long and signals reports are required exactly once`);
  }
  const stableIdentities = [];
  const runIdsByRound = new Map(rounds.map((round) => [round, new Set()]));
  const executionServers = [];
  const performance = [];
  let captures = 0;
  const recordMetadata = (value, label, round, execution = false) => {
    const identity = metadataIdentity(value, label);
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
      captures += captureEvidence(entry.value.captures, `${entry.path}.captures`, dirname(entry.path));
      performance.push(performanceSummary(entry.value.performance, `${entry.path}.performance`));
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
