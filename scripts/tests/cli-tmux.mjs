import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeFrameDiagnostics,
  captureState,
  collectMetadata,
  createArtifactDir,
  createTmuxServer,
  decodeLastOsc52,
  historyOffset,
  latestFrame,
  paneLines,
  readFrames,
  writeReport,
} from './cli-tmux-support.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const fixture = join(here, 'fixtures/cli-tmux-brain.mjs');
const editorFixture = join(here, 'fixtures/cli-editor.mjs');
const cli = join(repo, 'dist/cli/bin.js');
const size = { columns: 96, rows: 24 };
const token = 'e2e-token';

if (spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status !== 0) {
  console.log('SKIP test:cli-tmux — tmux is not installed or not available on PATH.');
  process.exit(0);
}

const temp = mkdtempSync(join(tmpdir(), 'elowen-cli-tmux-'));
const artifactDir = createArtifactDir('long');
const home = join(temp, 'home');
const config = join(temp, 'config');
const logPath = join(temp, 'mock-requests.jsonl');
const ttyStatePath = join(temp, 'tty-state.txt');
const startGatePath = join(temp, 'start-gate');
const terminalWriteLog = join(artifactDir, 'terminal-writes.log');
const perfLog = join(artifactDir, 'perf.jsonl');
const reportPath = join(artifactDir, 'report.json');
const session = 'long';
const tmuxServer = createTmuxServer('long');
mkdirSync(home, { recursive: true });
mkdirSync(config, { recursive: true });

let mock = null;
let failed = false;

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function tmux(args, options = {}) {
  return tmuxServer.run(args, options);
}

function hasSession() {
  return tmuxServer.hasSession(session);
}

function capture() {
  if (!hasSession()) return '';
  return tmux(['capture-pane', '-p', '-t', session]);
}

function captureAnsi() {
  if (!hasSession()) return '';
  return tmux(['capture-pane', '-p', '-e', '-t', session]);
}

const activeCaptures = [];
function saveCapture(label, options = {}) {
  const saved = captureState({
    tmux: tmuxServer, session, artifactDir, label, perfLog, expectCursor: true, ...options,
  });
  activeCaptures.push(saved);
  return saved.plain;
}

function saveRawCapture(label) {
  const plain = capture();
  const ansi = captureAnsi();
  writeFileSync(join(artifactDir, `${label}.txt`), plain);
  writeFileSync(join(artifactDir, `${label}.ansi.txt`), ansi);
  return plain;
}

function entries() {
  try {
    return readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try { return [JSON.parse(line)]; }
        catch { return []; }
      });
  } catch {
    return [];
  }
}

function requests(path) {
  return entries().filter((entry) => entry.kind === 'request' && entry.path === path);
}

function liveFrames() {
  return readFrames(perfLog, { live: true });
}

async function waitFor(label, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(40);
  }
  const suffix = lastError ? ` (${lastError.message})` : '';
  throw new Error(`timed out waiting for ${label}${suffix}`);
}

function sendLiteral(text) {
  tmux(['send-keys', '-t', session, '-l', '--', text]);
}

function sendKey(key) {
  tmux(['send-keys', '-t', session, key]);
}

function sendHex(...bytes) {
  tmux(['send-keys', '-H', '-t', session, ...bytes]);
}

function sendRaw(value) {
  sendHex(...Array.from(Buffer.from(value), (byte) => byte.toString(16).padStart(2, '0')));
}

function resize(columns, rows) {
  tmux(['resize-window', '-t', session, '-x', String(columns), '-y', String(rows)]);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function blankBetween(lines, fromPattern, toPattern) {
  const from = lines.findIndex((line) => fromPattern.test(line));
  const to = lines.findIndex((line, index) => index > from && toPattern.test(line));
  return from >= 0 && to > from && lines
    .slice(from + 1, to)
    .some((line) => (line.split(/[│█]/u, 1)[0] ?? line).trim() === '');
}

async function resizeDiagnosed(columns, rows, label, predicate = () => true) {
  const requestedAt = Date.now();
  resize(columns, rows);
  await waitFor(`${label} diagnosed ${columns}x${rows}`, () => {
    const diagnosed = latestFrame(liveFrames(), columns, rows, requestedAt);
    const plain = capture();
    return diagnosed && paneLines(plain).length === rows && predicate(plain, diagnosed);
  });
}

function scrollbarThumb(plain, frame) {
  const lines = paneLines(plain);
  const start = Number(frame.sections?.header ?? 0);
  const height = Number(frame.sections?.transcript ?? 0);
  for (let index = start; index < start + height; index += 1) {
    const line = lines[index] ?? '';
    for (let column = 0; column < line.length; column += 1) {
      if (line[column] !== '█') continue;
      const before = line[column - 1];
      const after = line[column + 1];
      if ((before && '█░'.includes(before)) || (after && '█░'.includes(after))) continue;
      return { x: column + 1, y: index + 1 };
    }
  }
  return null;
}

function panelMeterRows(plain) {
  return paneLines(plain).filter((line) => /[█░]{4,}/u.test(line));
}

async function startMock() {
  const child = spawn(process.execPath, [fixture], {
    cwd: repo,
    env: { ...process.env, ELOWEN_TMUX_LOG: logPath, ELOWEN_TMUX_LONG: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('exit', (code, signal) => {
    if (!failed && code !== 0) {
      process.stderr.write(`mock brain exited early (${code ?? signal})\n${stderr}`);
    }
  });
  const ready = await waitFor('mock brain port', () => {
    const line = stdout.split('\n').find(Boolean);
    if (!line) return null;
    const parsed = JSON.parse(line);
    return Number.isInteger(parsed.port) ? parsed.port : null;
  }, 5_000);
  return { child, port: ready, stderr: () => stderr };
}

try {
  const started = await startMock();
  mock = started.child;
  const base = `http://127.0.0.1:${started.port}`;
  const cliCommand = [
    'env',
    `HOME=${shellQuote(home)}`,
    `XDG_CONFIG_HOME=${shellQuote(config)}`,
    `ELOWEN_URL=${shellQuote(base)}`,
    `ELOWEN_TOKEN=${shellQuote(token)}`,
    'ELOWEN_AUTOSTART=0',
    `ELOWEN_TUI_PERF=1`,
    `ELOWEN_TUI_LOG=${shellQuote(perfLog)}`,
    `EDITOR=${shellQuote(`${process.execPath} ${editorFixture}`)}`,
    'TERM=xterm-256color',
    shellQuote(process.execPath),
    shellQuote(cli),
    'chat',
    '--new',
  ].join(' ');
  const command = [
    `while [ ! -f ${shellQuote(startGatePath)} ]; do sleep 0.01; done`,
    'before=$(stty -g)',
    cliCommand,
    'after=$(stty -g)',
    `printf '%s\\n%s\\n' "$before" "$after" > ${shellQuote(ttyStatePath)}`,
    `printf '\\nE2E SHELL RESTORED\\n'`,
    'sleep 2',
  ].join('; ');

  tmux([
    'new-session', '-d', '-s', session,
    '-x', String(size.columns), '-y', String(size.rows), '-c', repo,
    command,
  ]);
  tmux(['pipe-pane', '-O', '-t', session, `cat > ${shellQuote(terminalWriteLog)}`]);
  writeFileSync(startGatePath, 'go\n');
  try { tmux(['set-option', '-t', session, 'window-size', 'manual']); } catch { /* older tmux */ }
  // A shared tmux server may inherit the size of an attached/larger client despite new-session's hint.
  // Force the isolated window after switching it to manual mode so the TUI receives a real 96x24 SIGWINCH.
  tmux(['resize-window', '-t', session, '-x', String(size.columns), '-y', String(size.rows)]);

  await waitFor('bound SSE stream', () => requests('/brain/stream').length === 1);
  await waitFor('chat input readiness', () => capture().includes('E2E Harness'));
  await waitFor('long history tail', () => capture().includes('E2E HISTORY MARKER 89'));
  const initialCapture = saveCapture('01-initial-long-history');
  assert.equal((initialCapture.match(/\bBuild\b/g) ?? []).length, 1, 'long-history frame must have one status row');

  // The real composer grows one content row at a time through six, then becomes a cursor-following
  // viewport. Arrow navigation must reveal both ends without submitting the draft.
  const composerGrowth = [];
  const sendsBeforeDraft = requests('/brain/send').length;
  for (let line = 1; line <= 8; line += 1) {
    if (line > 1) sendKey('C-j');
    const marker = `E2E ML${String(line).padStart(2, '0')} UNIQUE`;
    sendLiteral(marker);
    const expectedRows = Math.min(line, 6) + 2;
    const diagnosed = await waitFor(`multiline row ${line}`, () => {
      const current = latestFrame(liveFrames(), size.columns, size.rows);
      return capture().includes(marker) && current?.sections?.editor === expectedRows ? current : null;
    });
    composerGrowth.push({ line, editorRows: diagnosed.sections.editor, contentRows: diagnosed.sections.editor - 2 });
    if (line === 1 || line === 6 || line === 8) saveCapture(`01b-multiline-${line}-rows`);
  }
  assert.deepEqual(composerGrowth.map((entry) => entry.contentRows), [1, 2, 3, 4, 5, 6, 6, 6],
    'composer must grow 1..6 content rows and cap lines 7/8 at six');
  assert.equal(requests('/brain/send').length, sendsBeforeDraft, 'multiline cursor navigation must not submit');

  for (let index = 0; index < 7; index += 1) sendKey('Up');
  await waitFor('multiline Up reveals first line', () => capture().includes('E2E ML01 UNIQUE'));
  const multilineTop = saveCapture('01c-multiline-up-reveals-head');
  assert.match(multilineTop, /E2E ML01 UNIQUE/, 'repeated Up must reveal the early unique line');
  assert.equal(requests('/brain/send').length, sendsBeforeDraft, 'Up must never submit the draft');
  for (let index = 0; index < 7; index += 1) sendKey('Down');
  await waitFor('multiline Down returns tail', () => capture().includes('E2E ML08 UNIQUE'));
  const multilineTail = saveCapture('01d-multiline-down-returns-tail');
  assert.match(multilineTail, /E2E ML08 UNIQUE/, 'Down must return the visible cursor to the tail');

  // Clear each logical line without Enter (Ctrl+U clears to line start; Backspace joins the newline).
  for (let line = 8; line >= 1; line -= 1) {
    sendKey('C-u');
    if (line > 1) sendKey('BSpace');
  }
  await waitFor('multiline draft cleared', () => !/E2E ML\d/u.test(capture()));
  assert.equal(requests('/brain/send').length, sendsBeforeDraft, 'clearing the draft must not send it');

  await resizeDiagnosed(40, 15, 'wrapped draft compact');
  const wrappedDraft = `E2E WRAP HEAD ${'x'.repeat(90)} E2E WRAP TAIL`;
  sendLiteral(wrappedDraft);
  await waitFor('wrapped compact cursor tail', () => capture().includes('E2E WRAP TAIL'));
  saveCapture('01e-wrapped-cursor-40x15');
  await resizeDiagnosed(80, 24, 'wrapped draft wider', (plain) => plain.includes('E2E WRAP TAIL'));
  saveCapture('01f-wrapped-cursor-after-resize');
  sendKey('C-u');
  await waitFor('wrapped draft cleared', () => !capture().includes('E2E WRAP'));
  await resizeDiagnosed(size.columns, size.rows, 'restore after composer checks',
    (plain) => plain.includes('E2E HISTORY MARKER 89'));

  sendKey('PageUp');
  await waitFor('PageUp history chip', () => capture().includes('History +'));
  const pageUpCapture = saveCapture('02-page-up');
  const pageUpOffset = historyOffset(pageUpCapture);
  assert.ok(pageUpOffset > 0, 'PageUp must increase the numeric history offset');

  const copyRows = paneLines(pageUpCapture);
  const copyStart = copyRows.findIndex((line) => line.includes('stable row one'));
  const copyEnd = copyRows.findIndex((line, index) => index > copyStart && line.includes('stable row two'));
  assert.ok(copyStart >= 0 && copyEnd > copyStart, 'PageUp capture must expose two deterministic copy rows');
  sendRaw(`\x1b[<0;4;${copyStart + 1}M`);
  sendRaw(`\x1b[<32;4;${copyEnd + 1}M`);
  sendRaw(`\x1b[<0;4;${copyEnd + 1}m`);
  const copiedText = await waitFor('OSC-52 drag copy', () => {
    const writes = readFileSync(terminalWriteLog, 'utf8');
    const decoded = decodeLastOsc52(writes);
    return decoded?.includes('stable row one') && decoded.includes('stable row two') ? decoded : null;
  });
  assert.match(copiedText, /stable row one[\s\S]*stable row two/u,
    'real SGR drag selection must copy the expected visible transcript text');
  saveCapture('02b-drag-copy-complete');
  sendKey('PageDown');
  await waitFor('PageDown returns to tail', () => !capture().includes('History +'));

  // Raw SGR wheel-up event through the same mouse path a real terminal uses.
  sendHex('1b', '5b', '3c', '36', '34', '3b', '31', '30', '3b', '31', '30', '4d');
  await waitFor('mouse wheel history chip', () => capture().includes('History +'));
  const wheelUpOffset = historyOffset(capture());
  assert.ok(wheelUpOffset > 0, 'wheel-up must move toward older history');
  for (let index = 0; index < 8; index += 1) sendHex('1b', '5b', '3c', '36', '34', '3b', '31', '30', '3b', '31', '30', '4d');
  await waitFor('rapid wheel burst advances history', () => historyOffset(capture()) > wheelUpOffset);
  sendHex('1b', '5b', '3c', '36', '35', '3b', '31', '30', '3b', '31', '30', '4d');
  for (let index = 0; index < 16; index += 1) sendHex('1b', '5b', '3c', '36', '35', '3b', '31', '30', '3b', '31', '30', '4d');
  await waitFor('mouse wheel returns to tail', () => historyOffset(capture()) === 0);

  sendLiteral('E2E FIRST USER');
  sendKey('Enter');
  await waitFor('first streaming tool', () => capture().includes('E2E LONG PHASE'));

  // A real multiline prompt sent during the active turn must become one visible queued message.
  sendLiteral('E2E QUEUED LINE 1');
  sendKey('C-j');
  sendLiteral('E2E QUEUED LINE 2');
  sendKey('Enter');
  await waitFor('queued message strip', () => capture().includes('QUEUED') && capture().includes('E2E QUEUED LINE'));
  saveCapture('03-streaming-queued');

  // A rapid geometry sweep crosses every reported small/fallback/panel threshold while SSE keeps
  // mutating the tail. Each step waits for a post-resize diagnosed frame, then runs the common analyzer.
  const resizeSweep = [
    [20, 10], [32, 12], [40, 15], [80, 24], [103, 24], [104, 24], [120, 30], [180, 50],
  ];
  for (const [columns, rows] of resizeSweep) {
    await resizeDiagnosed(columns, rows, `streaming sweep ${columns}x${rows}`, (plain) => {
      if (columns === 20) return plain.includes('Terminal too smal');
      if (columns === 103) return !plain.includes('Context') && !plain.includes('Terminal too smal');
      if (columns >= 104) return plain.includes('Context');
      return plain.includes('Build') && !plain.includes('Terminal too smal');
    });
    const sweepCapture = saveCapture(`04-streaming-${columns}x${rows}`, {
      forbiddenMarkers: columns === 20 ? ['E2E HISTORY MARKER'] : ['Terminal too small'],
    });
    assert.equal(activeCaptures.at(-1).analysis.statusRows, 1,
      `${columns}x${rows} sweep frame must keep one real status row`);
    if (columns === 103) assert.doesNotMatch(sweepCapture, /Context/, '103 columns must hide telemetry cleanly');
    if (columns === 104) assert.match(sweepCapture, /Context/, '104 columns must show telemetry at the exact boundary');
  }

  await resizeDiagnosed(120, 30, 'return to telemetry toggle', (plain) => plain.includes('Context'));
  sendKey('C-p');
  await waitFor('telemetry hidden', () => !capture().includes('Context'));
  saveCapture('04b-streaming-telemetry-hidden');
  sendKey('C-p');
  await waitFor('telemetry restored', () => capture().includes('Context'));
  await resizeDiagnosed(size.columns, size.rows, '96x24 restored streaming frame',
    (plain) => plain.includes('E2E LONG PHASE') && !plain.includes('Terminal too smal'));
  saveCapture('07-streaming-restored');

  sendKey('Escape');
  await waitFor('first-Esc confirmation footer', () => capture().includes('esc again to interrupt'), 1_000);
  await sleep(200);
  assert.equal(requests('/brain/abort').length, 0, 'the first Esc must only arm interrupt confirmation');

  sendKey('Escape');
  await waitFor('exactly one abort request', () => requests('/brain/abort').length === 1);
  await waitFor('queued strip cleared by abort', () => !capture().includes('QUEUED'));
  assert.equal(requests('/brain/abort').length, 1, 'the second Esc must send exactly one abort');

  sendLiteral('E2E SECOND USER');
  sendKey('Enter');
  await waitFor('second turn final reply', () => capture().includes('E2E FINAL REPLY'));
  await waitFor('second turn idle', () => entries().some((entry) => entry.kind === 'event'
    && entry.event?.type === 'idle' && entry.event?.usage?.totalTokens === 2345));
  await sleep(120);

  resize(120, 30);
  await waitFor('Todo and telemetry panels after stream', () => capture().includes('Todos')
    && capture().includes('Context') && capture().includes('Limits pro') && capture().includes('E2E FINAL REPLY'));
  const panelCapture = saveCapture('08-panels-after-stream');
  assert.match(panelCapture, /Sub-agent click verify the CLI panels/u,
    'settled delegated work must remain visible as a drill-in row');

  // Real ctrl+o follows the same production sub-agent cycle path as clicking the row. The child has a
  // unique persisted history fixture, and Esc must restore the untouched parent tail.
  sendKey('C-o');
  await waitFor('sub-agent child history', () => capture().includes('E2E CHILD UNIQUE HISTORY'));
  const childCapture = saveCapture('08a-subagent-drill-in');
  assert.match(childCapture, /E2E CHILD UNIQUE HISTORY/, 'sub-agent drill-in must hydrate its child transcript');
  sendKey('Escape');
  await waitFor('return from sub-agent', () => capture().includes('E2E FINAL REPLY')
    && !capture().includes('E2E CHILD UNIQUE HISTORY'));
  saveCapture('08b-subagent-return-parent');

  // Drag the actual panel edge until InputRouter's 36-column minimum. Context and both OAuth windows
  // must use the same █/░ vocabulary, fit the rail, and never resurrect the old ▰/▱ design.
  const dividerBefore = 120 - 46; // InputRouter's panelLeftEdge for the production default width.
  const narrowEdgeX = 120 - 36 + 1;
  sendRaw(`\x1b[<0;${dividerBefore};6M`);
  sendRaw(`\x1b[<32;${narrowEdgeX};6M`);
  sendRaw(`\x1b[<0;${narrowEdgeX};6m`);
  await waitFor('36-column telemetry resize', () => panelMeterRows(capture())
    .some((row) => (row.match(/[█░]{4,}/u)?.[0].length ?? 0) === 32)
    && capture().includes('Limits pro'));
  const narrowPanelCapture = saveCapture('08c-telemetry-36-columns');
  assert.doesNotMatch(narrowPanelCapture, /[▰▱]/u, 'all telemetry meters must use only █/░ glyphs');
  const meterRows = panelMeterRows(narrowPanelCapture);
  assert.ok(meterRows.length >= 3, 'narrow panel must retain Context, 5h, and weekly meter rails');
  assert.ok(meterRows.every((row) => /^[^█░]*[█░]+[^█░]*$/u.test(row)),
    'each narrow telemetry meter must be one aligned contiguous █/░ run');
  assert.match(narrowPanelCapture, /5h[\s█░]+23%/u, '5h OAuth meter must fit at 36 columns');
  assert.match(narrowPanelCapture, /weekly[\s█░]+14%/u, 'weekly OAuth meter must fit at 36 columns');

  // The clipped Todo summary is a real mouse target. Its ANSI underline communicates affordance; one
  // click must expand the card through the same shell hit-testing used in production.
  const todoLines = panelCapture.endsWith('\n') ? panelCapture.slice(0, -1).split('\n') : panelCapture.split('\n');
  const moreRow = todoLines.findIndex((line) => /\+\d+ more/.test(line)) + 1;
  assert.ok(moreRow > 0, 'clipped Todos must expose a +N more row');
  const moreAnsiLine = captureAnsi().split('\n')[moreRow - 1] ?? '';
  assert.match(moreAnsiLine, /\x1b\[4m/, 'the +N more affordance must be underlined');
  sendRaw(`\x1b[<0;24;${moreRow}M`);
  sendRaw(`\x1b[<0;24;${moreRow}m`);
  await waitFor('expanded Todo tail', () => capture().includes('verify terminal cleanup'));
  const expandedTodoCapture = saveCapture('09-expanded-todos');

  // Grab the actual red transcript thumb immediately beside the right panel and drag it upward using
  // raw SGR mouse press/motion/release events. This exercises the production mouse parser and shell
  // routing, not just ChatViewport methods.
  const tailFrame = activeCaptures.at(-1).frame;
  const tailThumb = scrollbarThumb(expandedTodoCapture, tailFrame);
  assert.ok(tailThumb, '120x30 panel frame must expose the transcript thumb at the diagnosed chat boundary');
  sendRaw(`\x1b[<0;${tailThumb.x};${tailThumb.y}M`);
  sendRaw(`\x1b[<32;${tailThumb.x};2M`);
  sendRaw(`\x1b[<0;${tailThumb.x};2m`);
  await waitFor('mouse scrollbar drag history chip', () => capture().includes('History +'));
  const draggedCapture = saveCapture('10-scrollbar-drag-with-panel');
  const draggedOffset = historyOffset(draggedCapture);
  assert.ok(draggedOffset > 0, 'upward thumb drag must increase the numeric history offset');
  const draggedThumb = scrollbarThumb(draggedCapture, activeCaptures.at(-1).frame);
  assert.ok(draggedThumb && draggedThumb.y < tailThumb.y,
    'upward drag must move both the red thumb and history offset toward older rows');
  sendRaw(`\x1b[<0;${draggedThumb.x};${draggedThumb.y}M`);
  sendRaw(`\x1b[<32;${draggedThumb.x};${tailThumb.y}M`);
  sendRaw(`\x1b[<0;${draggedThumb.x};${tailThumb.y}m`);
  await waitFor('scrollbar drag returns to tail', () => historyOffset(capture()) === 0);

  await waitFor('mascot frame after visible-panel drag', () => liveFrames()
    .some((frame) => frame.reasons?.some((reason) => reason.includes('animation:mascot'))), 4_000);
  const mascotFrames = liveFrames()
    .filter((frame) => frame.reasons?.some((reason) => reason.includes('animation:mascot')));
  assert.ok(mascotFrames.every((frame) => frame.renderedTurns === 0),
    'mascot-only frames must reuse the prepared transcript without settled-turn rendering');

  sendKey('C-p');
  await waitFor('telemetry hidden before idle check', () => !capture().includes('Context'));
  await sleep(120);
  const hiddenIdleStart = liveFrames().length;
  await sleep(800);
  assert.equal(liveFrames().length, hiddenIdleStart,
    'hidden telemetry must produce zero decorative/idle frames for >=750ms');
  saveCapture('10b-hidden-panel-idle-zero');
  sendKey('C-p');
  await waitFor('telemetry shown after idle check', () => capture().includes('Context'));
  await resizeDiagnosed(103, 24, 'narrow panel cancellation', (plain) => !plain.includes('Context'));
  await sleep(120);
  const narrowIdleStart = liveFrames().length;
  await sleep(800);
  assert.equal(liveFrames().length, narrowIdleStart,
    '103-column hidden-by-threshold panel must own no idle timer');
  saveCapture('10c-narrow-panel-idle-zero');
  await resizeDiagnosed(120, 30, 'restore panel after idle checks', (plain) => plain.includes('Context'));

  sendLiteral('/editor');
  sendKey('Enter');
  await waitFor('external editor resume', () => capture().includes('E2E EDITOR DRAFT')
    && capture().includes('E2E FINAL REPLY'));
  const editorCapture = saveCapture('11-external-editor-return');
  assert.equal((editorCapture.match(/\bBuild\b/g) ?? []).length, 1, 'external-editor repaint must not duplicate status');
  sendKey('C-u');

  sendLiteral('/help');
  sendKey('Enter');
  await waitFor('commands modal', () => capture().includes('Commands') && capture().includes('enter run'));
  saveCapture('12-help-modal', {
    expectCursor: false, allowScrollbarOcclusion: true,
  });
  sendKey('Escape');
  await waitFor('commands modal closed', () => !capture().includes('enter run'));

  sendKey('C-p');
  await waitFor('post-stream telemetry hidden', () => !capture().includes('Context'));
  sendKey('C-p');
  await waitFor('post-stream telemetry shown', () => capture().includes('Context'));

  // Suggestion chrome must fit completely on a short terminal: both the header/hints and bottom border
  // are present in the same physical 40x15 pane, while keyboard navigation keeps working.
  await resizeDiagnosed(40, 15, 'short settled frame', (plain) => plain.includes('Build'));
  sendLiteral('/');
  await waitFor('short slash menu', () => capture().includes('commands ·') && capture().includes('esc'));
  const slashCapture = saveCapture('13-short-slash-menu');
  assert.match(slashCapture, /╭/u, 'short slash menu must retain its top border');
  assert.match(slashCapture, /╰/u, 'short slash menu must retain its bottom border');
  assert.equal((slashCapture.endsWith('\n') ? slashCapture.slice(0, -1).split('\n') : slashCapture.split('\n')).length, 15,
    'short slash menu must not overflow the pane');
  await resizeDiagnosed(32, 12, 'open slash live reflow', (plain) => plain.includes('commands ·'));
  const slashReflow = saveCapture('13b-open-slash-reflow-32x12');
  assert.match(slashReflow, /╭/u, 'resized open slash menu must retain its top border');
  assert.match(slashReflow, /╰/u, 'resized open slash menu must retain its bottom border');
  await resizeDiagnosed(40, 15, 'open slash restore', (plain) => plain.includes('commands ·'));
  sendKey('C-u');
  await waitFor('short slash menu closed', () => !capture().includes('commands ·'));

  // A production SSE ask event replaces the editor. Move to the final option on the constrained dock;
  // its moving window must reveal that option without clipping action hints or either border.
  sendLiteral('E2E ASK MENU');
  sendKey('Enter');
  await waitFor('short ask dock', () => capture().includes('Elowen needs a decision'));
  for (let index = 0; index < 11; index += 1) sendKey('Down');
  await waitFor('ask final option', () => capture().includes('Option 12'));
  const askCapture = saveCapture('14-short-ask-dock', { expectCursor: false });
  assert.match(askCapture, /space toggle[\s\S]*enter send[\s\S]*esc cancel/u,
    'short ask dock must retain every action hint');
  assert.match(askCapture, /╭/u, 'short ask dock must retain its top border');
  assert.match(askCapture, /╰/u, 'short ask dock must retain its bottom border');
  assert.equal((askCapture.endsWith('\n') ? askCapture.slice(0, -1).split('\n') : askCapture.split('\n')).length, 15,
    'short ask dock must not overflow the pane');
  await resizeDiagnosed(32, 12, 'open ask live reflow', (plain) => plain.includes('Elowen needs a decision'));
  const askReflow = saveCapture('14b-open-ask-reflow-32x12', { expectCursor: false });
  assert.match(askReflow, /space toggle[\s\S]*enter send[\s\S]*esc cancel/u,
    'resized open ask dock must retain every action hint');
  assert.match(askReflow, /Option 12/u, 'resized ask window must keep the selected final option visible');
  assert.equal((askReflow.endsWith('\n') ? askReflow.slice(0, -1).split('\n') : askReflow.split('\n')).length, 12,
    '32x12 ask dock must not overflow the pane');
  await resizeDiagnosed(40, 15, 'open ask restore', (plain) => plain.includes('Option 12'));
  sendKey('Enter');
  await waitFor('ask answer request', () => requests('/brain/answer').length === 1);
  await waitFor('ask turn resumes', () => capture().includes('E2E ASK ANSWER ACCEPTED'));

  sendKey('PageUp');
  await waitFor('post-stream PageUp', () => capture().includes('History +'));
  sendKey('PageDown');
  await waitFor('post-stream PageDown', () => !capture().includes('History +'));

  await resizeDiagnosed(size.columns, size.rows, 'final 96x24 frame',
    (plain) => plain.includes('E2E FINAL REPLY'));

  const finalCapture = saveCapture('15-final-96x24');
  const finalLines = finalCapture.endsWith('\n') ? finalCapture.slice(0, -1).split('\n') : finalCapture.split('\n');
  assert.equal(finalLines.length, size.rows, `tmux pane must remain exactly ${size.rows} rows tall`);
  assert.equal((finalCapture.match(/\bBuild\b/g) ?? []).length, 1, 'status metadata must contain exactly one Build row');
  assert.match(panelCapture, /E2E SECOND USER/, 'second user turn must render in its settled capture');
  assert.match(panelCapture, /E2E TOOL OUTPUT/, 'final tool output must render in its settled capture');
  assert.match(panelCapture, /E2E FINAL REPLY/, 'final assistant text must render in its settled capture');
  assert.doesNotMatch(panelCapture, /\[?exit 0\]?/i, 'successful tool status must not render exit 0');
  assert.ok(blankBetween(todoLines, /E2E SECOND USER/, /npm run e2e-demo/), 'user turn and tool block need a blank separator');
  assert.ok(blankBetween(todoLines, /E2E TOOL OUTPUT/, /E2E FINAL REPLY/), 'tool output and final answer need a blank separator');
  assert.match(finalCapture, /E2E ASK ANSWER ACCEPTED/, 'the resumed ask turn must remain at the final tail');

  sendKey('C-c');
  await waitFor('one session stop request', () => requests('/brain/session/stop').length === 1);
  await waitFor('restored shell marker', () => capture().includes('E2E SHELL RESTORED'), 5_000);
  const restoredShell = saveRawCapture('16-restored-shell');
  assert.match(restoredShell, /E2E SHELL RESTORED/, 'primary shell must be readable after normal teardown');
  assert.doesNotMatch(restoredShell, /MaxListenersExceededWarning|\bat\s+\S+\s+\([^)]*\.js:\d+/u,
    'primary shell must contain no listener warning or stack trace');

  const ttyStates = readFileSync(ttyStatePath, 'utf8').trim().split('\n');
  assert.equal(ttyStates.length, 2, 'the harness must capture tty state before and after chat');
  assert.equal(ttyStates[1], ttyStates[0], 'raw/canonical/echo tty state must be restored exactly');

  const terminalWrites = readFileSync(terminalWriteLog, 'utf8');
  assert.ok(terminalWrites.lastIndexOf('\x1b[?1049l') > terminalWrites.lastIndexOf('\x1b[?1049h'), 'alternate screen must be left last');
  assert.ok(terminalWrites.lastIndexOf('\x1b[?1006l') > terminalWrites.lastIndexOf('\x1b[?1006h'), 'mouse reporting must be disabled last');

  const startRequests = requests('/brain/start');
  const streamRequests = requests('/brain/stream');
  const parentStreamRequests = streamRequests.filter((request) => request.query.session === 'e2e-session');
  const childStreamRequests = streamRequests.filter((request) => request.query.session === 'e2e-child');
  const stopRequests = requests('/brain/session/stop');
  assert.equal(startRequests.length, 1, 'the harness expects one session start');
  assert.equal(parentStreamRequests.length, 1, 'the bound parent SSE must not duplicate or reconnect');
  assert.equal(childStreamRequests.length, 1, 'sub-agent drill-in must open exactly one child SSE');
  assert.equal(stopRequests.length, 1, 'Ctrl+C must send exactly one session stop');
  assert.equal(requests('/brain/abort').length, 1, 'only the confirmed double-Esc may abort');
  assert.equal(requests('/brain/send').length, 4, 'normal, queued multiline, final, and ask prompts must all reach the daemon');
  assert.equal(requests('/brain/answer').length, 1, 'the constrained ask dock must submit exactly one answer');
  assert.match(requests('/brain/send')[1].body.text, /E2E QUEUED LINE 1\nE2E QUEUED LINE 2/, 'queued prompt must preserve its newline');

  const startBody = startRequests[0].body;
  const streamQuery = parentStreamRequests[0].query;
  const stopBody = stopRequests[0].body;
  assert.equal(typeof startBody.client, 'string');
  assert.ok(startBody.client.length > 0, 'start must carry a stable client id');
  assert.equal(startBody.generation, 1, 'first start must claim generation 1');
  assert.equal(streamQuery.client, startBody.client, 'SSE must attach the same stable client');
  assert.equal(Number(streamQuery.generation), startBody.generation, 'SSE must attach the current generation');
  assert.equal(stopBody.client, startBody.client, 'Ctrl+C stop must release the current stable client');
  assert.equal(stopBody.session, 'e2e-session', 'Ctrl+C stop must target the bound session');
  assert.ok(entries().filter((entry) => entry.kind === 'request').every((entry) => entry.authorization === 'ok'), 'every mock request must be authenticated');

  const perfEntries = readFileSync(perfLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const perfFrames = perfEntries.filter((entry) => entry.type === 'frame');
  const performance = analyzeFrameDiagnostics(perfFrames);
  assert.ok(performance.scroll.maxRenderedTurns <= 12, 'scroll rendering must stay viewport-bounded');
  assert.ok(performance.scroll.maxReconciledTurns <= 12, 'scroll reconciliation must stay viewport-bounded');
  assert.ok(performance.scroll.maxLayoutVisits <= 64, 'scroll layout visits must not scale with 180 settled turns');
  assert.ok(performance.scroll.maxHeightIndexOperations <= 512, 'scroll height-index work must remain bounded');
  assert.equal(performance.mascot.maxRenderedTurns, 0, 'mascot frames must never render settled turns');
  const lifecycleStop = [...perfEntries].reverse().find((entry) => entry.type === 'lifecycle' && entry.action === 'stop');
  assert.ok(lifecycleStop, 'perf log must contain one terminal lifecycle stop');
  assert.ok(perfFrames.every((frame) => frame.at <= lifecycleStop.at), 'no frame may render after terminal stop');
  const report = {
    passed: true,
    scenario: 'long-history-complete',
    metadata: collectMetadata(repo, cli, tmuxServer.name),
    session,
    captures: activeCaptures.map((captureEntry) => ({ label: captureEntry.label, ...captureEntry.paths })),
    requests: entries().filter((entry) => entry.kind === 'request').length,
    frames: perfFrames.length,
    performance,
    composerGrowth,
    copiedText: copiedText.slice(0, 200),
    rapidResizeDimensions: resizeSweep.map(([columns, rows]) => `${columns}x${rows}`),
    hiddenIdleFramesAfter800Ms: 0,
    narrowIdleFramesAfter800Ms: 0,
    terminalStateRestored: true,
    alternateScreenRestored: true,
    mouseReportingDisabled: true,
    scrollbarDragWithPanel: true,
    subagentDrillIn: true,
    dragToCopyOsc52: true,
    telemetryMetersAt36Columns: true,
    todoMoreExpandedByMouse: true,
    shortSlashMenuFit: true,
    shortSlashLiveResize: true,
    shortAskDockFit: true,
    shortAskLiveResize: true,
    successfulExitStatusHidden: true,
  };
  writeReport(reportPath, report);

  console.log(`PASS test:cli-tmux — long history, multiline, stream/queue, 20x10..180x50 resize, panel/subagent/copy/modal, and teardown verified. Report: ${reportPath}`);
} catch (error) {
  failed = true;
  const pane = capture();
  const log = entries().slice(-80);
  process.stderr.write(`FAIL test:cli-tmux — ${error.stack ?? error}\n`);
  if (pane) process.stderr.write(`\n--- tmux capture ---\n${pane}\n`);
  if (log.length) process.stderr.write(`\n--- mock request tail ---\n${log.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  try { writeReport(reportPath, { passed: false, error: error.stack ?? String(error) }); } catch { /* best effort */ }
  process.stderr.write(`\nMachine report: ${reportPath}\n`);
  process.exitCode = 1;
} finally {
  if (hasSession()) {
    try { tmux(['kill-session', '-t', session]); } catch { /* best effort */ }
  }
  tmuxServer.killServer();
  if (mock && mock.exitCode === null && mock.signalCode === null) {
    mock.kill('SIGTERM');
    await Promise.race([
      new Promise((resolveExit) => mock.once('exit', resolveExit)),
      sleep(1_000),
    ]);
    if (mock.exitCode === null && mock.signalCode === null) mock.kill('SIGKILL');
  }
  rmSync(temp, { recursive: true, force: true });
}
