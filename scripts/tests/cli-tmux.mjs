import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const artifactDir = mkdtempSync(join(tmpdir(), 'elowen-tui-e2e-artifacts-'));
const home = join(temp, 'home');
const config = join(temp, 'config');
const logPath = join(temp, 'mock-requests.jsonl');
const ttyStatePath = join(temp, 'tty-state.txt');
const terminalWriteLog = join(artifactDir, 'terminal-writes.log');
const perfLog = join(artifactDir, 'perf.jsonl');
const reportPath = join(artifactDir, 'report.json');
const session = `elowen-cli-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
mkdirSync(home, { recursive: true });
mkdirSync(config, { recursive: true });

let mock = null;
let failed = false;

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function tmux(args, options = {}) {
  return execFileSync('tmux', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

function hasSession() {
  return spawnSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' }).status === 0;
}

function capture() {
  if (!hasSession()) return '';
  return tmux(['capture-pane', '-p', '-t', session]);
}

function captureAnsi() {
  if (!hasSession()) return '';
  return tmux(['capture-pane', '-p', '-e', '-t', session]);
}

function saveCapture(label) {
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
    `PI_TUI_WRITE_LOG=${shellQuote(terminalWriteLog)}`,
    `EDITOR=${shellQuote(`${process.execPath} ${editorFixture}`)}`,
    'TERM=xterm-256color',
    shellQuote(process.execPath),
    shellQuote(cli),
    'chat',
    '--new',
  ].join(' ');
  const command = [
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
  try { tmux(['set-option', '-t', session, 'window-size', 'manual']); } catch { /* older tmux */ }
  // A shared tmux server may inherit the size of an attached/larger client despite new-session's hint.
  // Force the isolated window after switching it to manual mode so the TUI receives a real 96x24 SIGWINCH.
  tmux(['resize-window', '-t', session, '-x', String(size.columns), '-y', String(size.rows)]);

  await waitFor('bound SSE stream', () => requests('/brain/stream').length === 1);
  await waitFor('chat input readiness', () => capture().includes('E2E Harness'));
  await waitFor('long history tail', () => capture().includes('E2E HISTORY MARKER 89'));
  const initialCapture = saveCapture('01-initial-long-history');
  assert.equal((initialCapture.match(/\bBuild\b/g) ?? []).length, 1, 'long-history frame must have one status row');

  sendKey('PageUp');
  await waitFor('PageUp history chip', () => capture().includes('History +'));
  saveCapture('02-page-up');
  sendKey('PageDown');
  await waitFor('PageDown returns to tail', () => !capture().includes('History +'));

  // Raw SGR wheel-up event through the same mouse path a real terminal uses.
  sendHex('1b', '5b', '3c', '36', '34', '3b', '31', '30', '3b', '31', '30', '4d');
  await waitFor('mouse wheel history chip', () => capture().includes('History +'));
  sendHex('1b', '5b', '3c', '36', '35', '3b', '31', '30', '3b', '31', '30', '4d');
  await waitFor('mouse wheel returns to tail', () => !capture().includes('History +'));

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

  // Resize through telemetry, compact, and tiny-fallback thresholds while SSE continues.
  resize(120, 30);
  await waitFor('120x30 telemetry during stream', () => capture().split('\n').filter((_, i, all) => i < all.length - 1 || all[i] !== '').length === 30
    && capture().includes('Context'));
  saveCapture('04-streaming-120x30');
  sendKey('C-p');
  await waitFor('telemetry hidden', () => !capture().includes('Context'));
  sendKey('C-p');
  await waitFor('telemetry restored', () => capture().includes('Context'));

  resize(40, 15);
  await waitFor('40x15 frame', () => capture().includes('Build') && capture().split('\n').length >= 15);
  const compactCapture = saveCapture('05-streaming-40x15');
  assert.equal((compactCapture.match(/\bBuild\b/g) ?? []).length, 1, '40x15 frame must keep one status row');

  resize(20, 10);
  await waitFor('20x10 fallback', () => capture().includes('Terminal too smal'));
  const tinyCapture = saveCapture('06-streaming-20x10');
  assert.equal((tinyCapture.match(/\bBuild\b/g) ?? []).length, 1, 'tiny fallback must keep one status row');
  assert.doesNotMatch(tinyCapture, /E2E HISTORY MARKER/, 'tiny fallback must not expose stale transcript rows');

  resize(size.columns, size.rows);
  await waitFor('96x24 restored streaming frame', () => capture().includes('E2E LONG PHASE') && !capture().includes('Terminal too smal'));
  saveCapture('07-streaming-restored');

  sendKey('Escape');
  await waitFor('first-Esc confirmation footer', () => capture().includes('esc again to interrupt'), 1_000);
  await sleep(200);
  assert.equal(requests('/brain/abort').length, 0, 'the first Esc must only arm interrupt confirmation');

  sendKey('Escape');
  await waitFor('exactly one abort request', () => requests('/brain/abort').length === 1);
  await sleep(150);
  assert.equal(requests('/brain/abort').length, 1, 'the second Esc must send exactly one abort');

  sendLiteral('E2E SECOND USER');
  sendKey('Enter');
  await waitFor('second turn final reply', () => capture().includes('E2E FINAL REPLY'));
  await waitFor('second turn idle', () => entries().some((entry) => entry.kind === 'event'
    && entry.event?.type === 'idle' && entry.event?.usage?.totalTokens === 2345));
  await sleep(120);

  resize(120, 30);
  await waitFor('Todo and telemetry panels after stream', () => capture().includes('Todos')
    && capture().includes('Context') && capture().includes('E2E FINAL REPLY'));
  const panelCapture = saveCapture('08-panels-after-stream');

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
  const scrollbarX = 120 - 46 - 3;
  const panelLines = expandedTodoCapture.endsWith('\n') ? expandedTodoCapture.slice(0, -1).split('\n') : expandedTodoCapture.split('\n');
  const thumbRow = panelLines.findIndex((line) => line.indexOf('█') === scrollbarX - 1) + 1;
  assert.ok(thumbRow > 0, '120x30 panel frame must expose the transcript thumb at the chat boundary');
  sendRaw(`\x1b[<0;${scrollbarX};${thumbRow}M`);
  sendRaw(`\x1b[<32;${scrollbarX};2M`);
  sendRaw(`\x1b[<0;${scrollbarX};2m`);
  await waitFor('mouse scrollbar drag history chip', () => capture().includes('History +'));
  const draggedCapture = saveCapture('10-scrollbar-drag-with-panel');
  assert.match(draggedCapture, /History \+\d+ lines/, 'dragging the visible thumb must move into history');
  const draggedLines = draggedCapture.endsWith('\n') ? draggedCapture.slice(0, -1).split('\n') : draggedCapture.split('\n');
  const draggedThumbRow = draggedLines.findIndex((line) => line.indexOf('█') === scrollbarX - 1) + 1;
  assert.ok(draggedThumbRow > 0, 'scrolled 120x30 frame must keep a draggable transcript thumb');
  sendRaw(`\x1b[<0;${scrollbarX};${draggedThumbRow}M`);
  sendRaw(`\x1b[<32;${scrollbarX};${thumbRow}M`);
  sendRaw(`\x1b[<0;${scrollbarX};${thumbRow}m`);
  await waitFor('scrollbar drag returns to tail', () => !capture().includes('History +'));

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
  saveCapture('12-help-modal');
  sendKey('Escape');
  await waitFor('commands modal closed', () => !capture().includes('enter run'));

  sendKey('C-p');
  await waitFor('post-stream telemetry hidden', () => !capture().includes('Context'));
  sendKey('C-p');
  await waitFor('post-stream telemetry shown', () => capture().includes('Context'));

  // Suggestion chrome must fit completely on a short terminal: both the header/hints and bottom border
  // are present in the same physical 40x15 pane, while keyboard navigation keeps working.
  resize(40, 15);
  await waitFor('short settled frame', () => capture().includes('Build') && capture().split('\n').length >= 15);
  sendLiteral('/');
  await waitFor('short slash menu', () => capture().includes('commands ·') && capture().includes('esc'));
  const slashCapture = saveCapture('13-short-slash-menu');
  assert.match(slashCapture, /╭/u, 'short slash menu must retain its top border');
  assert.match(slashCapture, /╰/u, 'short slash menu must retain its bottom border');
  assert.equal((slashCapture.endsWith('\n') ? slashCapture.slice(0, -1).split('\n') : slashCapture.split('\n')).length, 15,
    'short slash menu must not overflow the pane');
  sendKey('C-u');
  await waitFor('short slash menu closed', () => !capture().includes('commands ·'));

  // A production SSE ask event replaces the editor. Move to the final option on the constrained dock;
  // its moving window must reveal that option without clipping action hints or either border.
  sendLiteral('E2E ASK MENU');
  sendKey('Enter');
  await waitFor('short ask dock', () => capture().includes('Elowen needs a decision'));
  for (let index = 0; index < 11; index += 1) sendKey('Down');
  await waitFor('ask final option', () => capture().includes('Option 12'));
  const askCapture = saveCapture('14-short-ask-dock');
  assert.match(askCapture, /space toggle.*enter send.*esc cancel/, 'short ask dock must retain its action row');
  assert.match(askCapture, /╭/u, 'short ask dock must retain its top border');
  assert.match(askCapture, /╰/u, 'short ask dock must retain its bottom border');
  assert.equal((askCapture.endsWith('\n') ? askCapture.slice(0, -1).split('\n') : askCapture.split('\n')).length, 15,
    'short ask dock must not overflow the pane');
  sendKey('Enter');
  await waitFor('ask answer request', () => requests('/brain/answer').length === 1);
  await waitFor('ask turn resumes', () => capture().includes('E2E ASK ANSWER ACCEPTED'));

  sendKey('PageUp');
  await waitFor('post-stream PageUp', () => capture().includes('History +'));
  sendKey('PageDown');
  await waitFor('post-stream PageDown', () => !capture().includes('History +'));

  resize(size.columns, size.rows);
  await waitFor('final 96x24 frame', () => capture().includes('E2E FINAL REPLY') && capture().split('\n').length >= size.rows);

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
  saveCapture('16-restored-shell');

  const ttyStates = readFileSync(ttyStatePath, 'utf8').trim().split('\n');
  assert.equal(ttyStates.length, 2, 'the harness must capture tty state before and after chat');
  assert.equal(ttyStates[1], ttyStates[0], 'raw/canonical/echo tty state must be restored exactly');

  const terminalWrites = readFileSync(terminalWriteLog, 'utf8');
  assert.ok(terminalWrites.lastIndexOf('\x1b[?1049l') > terminalWrites.lastIndexOf('\x1b[?1049h'), 'alternate screen must be left last');
  assert.ok(terminalWrites.lastIndexOf('\x1b[?1006l') > terminalWrites.lastIndexOf('\x1b[?1006h'), 'mouse reporting must be disabled last');

  const startRequests = requests('/brain/start');
  const streamRequests = requests('/brain/stream');
  const stopRequests = requests('/brain/session/stop');
  assert.equal(startRequests.length, 1, 'the harness expects one session start');
  assert.equal(streamRequests.length, 1, 'the bound SSE must not duplicate or reconnect during the scenario');
  assert.equal(stopRequests.length, 1, 'Ctrl+C must send exactly one session stop');
  assert.equal(requests('/brain/abort').length, 1, 'only the confirmed double-Esc may abort');
  assert.equal(requests('/brain/send').length, 4, 'normal, queued multiline, final, and ask prompts must all reach the daemon');
  assert.equal(requests('/brain/answer').length, 1, 'the constrained ask dock must submit exactly one answer');
  assert.match(requests('/brain/send')[1].body.text, /E2E QUEUED LINE 1\nE2E QUEUED LINE 2/, 'queued prompt must preserve its newline');

  const startBody = startRequests[0].body;
  const streamQuery = streamRequests[0].query;
  const stopBody = stopRequests[0].body;
  assert.equal(typeof startBody.client, 'string');
  assert.ok(startBody.client.length > 0, 'start must carry a stable client id');
  assert.equal(startBody.generation, 1, 'first start must claim generation 1');
  assert.equal(streamQuery.client, startBody.client, 'SSE must attach the same stable client');
  assert.equal(Number(streamQuery.generation), startBody.generation, 'SSE must attach the current generation');
  assert.equal(stopBody.client, startBody.client, 'Ctrl+C stop must release the current stable client');
  assert.equal(stopBody.session, 'e2e-session', 'Ctrl+C stop must target the bound session');
  assert.ok(entries().filter((entry) => entry.kind === 'request').every((entry) => entry.authorization === 'ok'), 'every mock request must be authenticated');

  const perfFrames = readFileSync(perfLog, 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line)).filter((entry) => entry.type === 'frame');
  assert.ok(perfFrames.length > 0, 'perf diagnostics must capture real frames');
  assert.ok(perfFrames.every((frame) => frame.rootRows <= frame.terminal.rows), 'every diagnosed root frame must fit terminal rows');
  const frameTimes = perfFrames.map((frame) => Number(frame.totalMs)).filter(Number.isFinite).sort((a, b) => a - b);
  const p95 = frameTimes[Math.min(frameTimes.length - 1, Math.floor(frameTimes.length * 0.95))] ?? 0;
  const report = {
    passed: true,
    session,
    captures: 16,
    requests: entries().filter((entry) => entry.kind === 'request').length,
    frames: perfFrames.length,
    frameMs: { p95, max: frameTimes.at(-1) ?? 0 },
    terminalStateRestored: true,
    alternateScreenRestored: true,
    mouseReportingDisabled: true,
    scrollbarDragWithPanel: true,
    todoMoreExpandedByMouse: true,
    shortSlashMenuFit: true,
    shortAskDockFit: true,
    successfulExitStatusHidden: true,
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`PASS test:cli-tmux — long history, stream/queue/panels, resize 20x10..120x30, scroll/modal, and terminal restore verified. Report: ${reportPath}`);
} catch (error) {
  failed = true;
  const pane = capture();
  const log = entries().slice(-80);
  process.stderr.write(`FAIL test:cli-tmux — ${error.stack ?? error}\n`);
  if (pane) process.stderr.write(`\n--- tmux capture ---\n${pane}\n`);
  if (log.length) process.stderr.write(`\n--- mock request tail ---\n${log.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  try { writeFileSync(reportPath, `${JSON.stringify({ passed: false, error: error.stack ?? String(error) }, null, 2)}\n`); } catch { /* best effort */ }
  process.stderr.write(`\nMachine report: ${reportPath}\n`);
  process.exitCode = 1;
} finally {
  if (hasSession()) spawnSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' });
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
