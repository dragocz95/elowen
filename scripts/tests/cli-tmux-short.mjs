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
  latestFrame,
  paneLines,
  readFrames,
  writeReport,
} from './cli-tmux-support.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const fixture = join(here, 'fixtures/cli-tmux-brain.mjs');
const cli = join(repo, 'dist/cli/bin.js');
const size = { columns: 96, rows: 24 };
const token = 'e2e-token';

if (spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status !== 0) {
  console.log('SKIP test:cli-tmux-short — tmux is not installed or not available on PATH.');
  process.exit(0);
}

const temp = mkdtempSync(join(tmpdir(), 'elowen-cli-tmux-short-'));
const artifactDir = createArtifactDir('short');
const home = join(temp, 'home');
const config = join(temp, 'config');
const logPath = join(temp, 'mock-requests.jsonl');
const ttyStatePath = join(temp, 'tty-state.txt');
const startGatePath = join(temp, 'start-gate');
const terminalWriteLog = join(artifactDir, 'terminal-writes.log');
const perfLog = join(artifactDir, 'perf.jsonl');
const reportPath = join(artifactDir, 'report.json');
const session = 'short';
const tmuxServer = createTmuxServer('short');
mkdirSync(home, { recursive: true });
mkdirSync(config, { recursive: true });

let mock = null;
let failed = false;
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function tmux(args) {
  return tmuxServer.run(args);
}

function hasSession() {
  return tmuxServer.hasSession(session);
}

function capture(ansi = false) {
  if (!hasSession()) return '';
  return tmux(['capture-pane', '-p', ...(ansi ? ['-e'] : []), '-t', session]);
}

const activeCaptures = [];
function saveActive(label, options = {}) {
  const saved = captureState({
    tmux: tmuxServer, session, artifactDir, label, perfLog, expectCursor: true, ...options,
  });
  activeCaptures.push(saved);
  return saved;
}

function saveRaw(label) {
  const plain = capture();
  const ansi = capture(true);
  const paths = { plain: join(artifactDir, `${label}.txt`), ansi: join(artifactDir, `${label}.ansi.txt`) };
  writeFileSync(paths.plain, plain);
  writeFileSync(paths.ansi, ansi);
  return { plain, ansi, paths };
}

function entries() {
  try {
    return readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
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
    await sleep(30);
  }
  throw new Error(`timed out waiting for ${label}${lastError ? ` (${lastError.message})` : ''}`);
}

function sendLiteral(text) {
  tmux(['send-keys', '-t', session, '-l', '--', text]);
}

function sendKey(key) {
  tmux(['send-keys', '-t', session, key]);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function startMock() {
  const child = spawn(process.execPath, [fixture], {
    cwd: repo,
    env: { ...process.env, ELOWEN_TMUX_LOG: logPath, ELOWEN_TMUX_SCENARIO: 'short-controls' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('exit', (code, signal) => {
    if (!failed && code !== 0) process.stderr.write(`mock brain exited early (${code ?? signal})\n${stderr}`);
  });
  const port = await waitFor('mock brain port', () => {
    const line = stdout.split('\n').find(Boolean);
    if (!line) return null;
    const parsed = JSON.parse(line);
    return Number.isInteger(parsed.port) ? parsed.port : null;
  }, 5_000);
  return { child, port };
}

try {
  const started = await startMock();
  mock = started.child;
  const base = `http://127.0.0.1:${started.port}`;
  const cliPrefix = [
    'env',
    `HOME=${shellQuote(home)}`,
    `XDG_CONFIG_HOME=${shellQuote(config)}`,
    `ELOWEN_URL=${shellQuote(base)}`,
    `ELOWEN_TOKEN=${shellQuote(token)}`,
    'ELOWEN_AUTOSTART=0',
    'ELOWEN_TUI_PERF=1',
    `ELOWEN_TUI_LOG=${shellQuote(perfLog)}`,
    'TERM=xterm-256color',
    shellQuote(process.execPath), shellQuote(cli), 'chat',
  ].join(' ');
  const freshCli = `${cliPrefix} --new`;
  const reopenedCli = `${cliPrefix} --session e2e-session`;
  const command = [
    `while [ ! -f ${shellQuote(startGatePath)} ]; do sleep 0.01; done`,
    'before=$(stty -g)', freshCli,
    `printf '\nE2E SHORT REOPENING\n'`, reopenedCli,
    'after=$(stty -g)',
    `printf '%s\\n%s\\n' "$before" "$after" > ${shellQuote(ttyStatePath)}`,
    `printf '\\nE2E SHORT SHELL RESTORED\\n'`, 'sleep 2',
  ].join('; ');

  tmux(['new-session', '-d', '-s', session, '-x', String(size.columns), '-y', String(size.rows), '-c', repo, command]);
  // Capture raw pane output outside the CLI. PI_TUI_WRITE_LOG performs a synchronous appendFileSync
  // inside every terminal.write and would contaminate the post-PI frame timing we are measuring.
  tmux(['pipe-pane', '-O', '-t', session, `cat > ${shellQuote(terminalWriteLog)}`]);
  writeFileSync(startGatePath, 'go\n');
  try { tmux(['set-option', '-t', session, 'window-size', 'manual']); } catch { /* older tmux */ }
  tmux(['resize-window', '-t', session, '-x', String(size.columns), '-y', String(size.rows)]);

  await waitFor('chat readiness', () => requests('/brain/stream').length === 1 && capture().includes('E2E Harness'));
  sendLiteral('Ahoj, jak se máš? :-)');
  sendKey('Enter');
  await waitFor('one short reply', () => capture().includes('E2E SHORT REPLY'));
  await waitFor('short idle event', () => entries().some((entry) => entry.kind === 'event' && entry.event?.usage?.totalTokens === 24));
  await sleep(100);

  const short = saveActive('01-one-short-message', { expectScrollbar: false });
  assert.equal(short.frame.maxScrollOffset, 0, 'one short exchange must stay below transcript overflow');

  const burstFramesBefore = liveFrames().length;
  sendLiteral('E2E CONTROL BURST');
  sendKey('Enter');
  await waitFor('rapid tool burst completion', () => capture().includes('E2E CONTROL BURST COMPLETE'));
  await waitFor('tool burst idle event', () => entries().some((entry) => entry.kind === 'event' && entry.event?.usage?.totalTokens === 3456));
  await sleep(120);

  const burst = saveActive('02-rapid-tool-control-burst', { expectScrollbar: true });
  assert.match(burst.plain, /E2E CONTROL BURST COMPLETE/, 'assistant tail must remain visible after rapid tool results');
  assert.doesNotMatch(burst.ansi, /\t|\r|\x1b\]0;unsafe-title|\x1b\[2J/, 'tool payload controls must not escape into the terminal frame');
  const burstFrames = liveFrames().slice(burstFramesBefore);
  assert.ok(burstFrames.length <= 12, `42-event burst must coalesce into <=12 frames (got ${burstFrames.length})`);
  assert.ok(burstFrames.some((frame) => (frame.reasons?.length ?? 0) >= 3),
    'rapid tool events must coalesce multiple render reasons into one frame');

  sendKey('PageUp');
  await waitFor('PageUp history chip', () => capture().includes('History +'));
  const scrolled = saveActive('03-page-up-after-burst', { expectScrollbar: true });
  assert.ok(scrolled.frame.scrollOffset > 0, 'PageUp must move to an older numeric history offset');
  sendKey('PageDown');
  await waitFor('PageDown tail', () => !capture().includes('History +'));

  tmux(['resize-window', '-t', session, '-x', '40', '-y', '15']);
  await waitFor('compact stable frame', () => capture().includes('Build') && paneLines(capture()).length === 15);
  const restoreRequestedAt = Date.now();
  tmux(['resize-window', '-t', session, '-x', String(size.columns), '-y', String(size.rows)]);
  await waitFor('restored frame', () => latestFrame(liveFrames(), size.columns, size.rows, restoreRequestedAt)
    && capture().includes('E2E CONTROL BURST COMPLETE') && paneLines(capture()).length === size.rows);
  saveActive('04-restored-after-resize', {
    expectScrollbar: true, forbiddenMarkers: ['Terminal too small'],
  });

  sendKey('C-c');
  await waitFor('single stop', () => requests('/brain/session/stop').length === 1);
  await waitFor('reopened stream', () => requests('/brain/stream').length === 2
    && capture().includes('E2E CONTROL BURST COMPLETE'), 8_000);
  const reopened = saveActive('05-reopened-same-conversation', { expectScrollbar: true });
  assert.match(reopened.plain, /E2E CONTROL BURST COMPLETE/, 'reopened session must hydrate the tool-burst history');
  assert.ok(reopened.frame.maxScrollOffset > 0, 'reopened damaged-looking history must retain a healthy scrollbar');

  sendLiteral('E2E REOPEN LIVENESS');
  sendKey('Enter');
  await waitFor('reopened liveness response', () => capture().includes('E2E REOPEN HEALTHY'));
  await waitFor('reopened idle event', () => entries().some((entry) => entry.kind === 'event'
    && entry.event?.usage?.totalTokens === 4567));
  const reopenedHealthy = saveActive('06-reopened-send-healthy', { expectScrollbar: true });
  assert.match(reopenedHealthy.plain, /E2E REOPEN HEALTHY/, 'reopened editor must send and render a new response');

  await waitFor('post-idle metadata settled', () => liveFrames().some((frame) => frame.pid === reopenedHealthy.frame.pid
    && frame.reasons?.includes('metadata:rate-limits') && frame.at >= reopenedHealthy.frame.at));
  const idleFrames = liveFrames().length;
  await sleep(850);
  assert.equal(liveFrames().length, idleFrames, 'hidden-panel idle CLI must render zero frames for >=750ms');

  sendKey('PageUp');
  await waitFor('reopened PageUp', () => capture().includes('History +'));
  const reopenedScrolled = saveActive('07-reopened-page-up', { expectScrollbar: true });
  assert.ok(reopenedScrolled.frame.scrollOffset > 0, 'reopened PageUp must retain numeric scroll state');
  sendKey('PageDown');
  await waitFor('reopened PageDown tail', () => !capture().includes('History +'));

  sendKey('C-c');
  await waitFor('second stop', () => requests('/brain/session/stop').length === 2);
  await waitFor('restored shell', () => capture().includes('E2E SHORT SHELL RESTORED'), 5_000);
  const shell = saveRaw('08-restored-shell');
  assert.match(shell.plain, /E2E SHORT SHELL RESTORED/, 'primary shell must remain readable after both runs');

  const ttyStates = readFileSync(ttyStatePath, 'utf8').trim().split('\n');
  assert.equal(ttyStates[1], ttyStates[0], 'raw/canonical/echo tty state must be restored exactly');
  const terminalWrites = readFileSync(terminalWriteLog, 'utf8');
  assert.ok(terminalWrites.lastIndexOf('\x1b[?1049l') > terminalWrites.lastIndexOf('\x1b[?1049h'), 'alternate screen must be left last');
  assert.ok(terminalWrites.lastIndexOf('\x1b[?1006l') > terminalWrites.lastIndexOf('\x1b[?1006h'), 'mouse reporting must be disabled last');

  const frames = readFrames(perfLog);
  const performance = analyzeFrameDiagnostics(frames);
  const scrollFrames = frames.filter((frame) => frame.reasons?.some((reason) => reason.includes('scroll')));
  const report = {
    passed: true,
    scenario: 'short-controls-reopen',
    metadata: collectMetadata(repo, cli, tmuxServer.name),
    captures: activeCaptures.map((captureEntry) => ({ label: captureEntry.label, ...captureEntry.paths })),
    frames: frames.length,
    scrollFrames: scrollFrames.length,
    performance,
    shortPaddingArtifact: false,
    toolControlsContained: true,
    oneMessageScrollbarAbsent: true,
    scrollbarVisible: true,
    reopenedSessionHealthy: true,
    idleFramesAfter850Ms: 0,
    terminalStateRestored: true,
  };
  writeReport(reportPath, report);
  console.log(`PASS test:cli-tmux-short — one-message threshold, coalesced burst, same-session reopen, input/scroll, and teardown verified. Report: ${reportPath}`);
} catch (error) {
  failed = true;
  process.stderr.write(`FAIL test:cli-tmux-short — ${error.stack ?? error}\n`);
  const pane = capture();
  if (pane) process.stderr.write(`\n--- tmux capture ---\n${pane}\n`);
  try { writeReport(reportPath, { passed: false, error: error.stack ?? String(error) }); } catch { /* best effort */ }
  process.stderr.write(`Machine report: ${reportPath}\n`);
  process.exitCode = 1;
} finally {
  if (hasSession()) {
    try { tmux(['kill-session', '-t', session]); } catch { /* best effort */ }
  }
  tmuxServer.killServer();
  if (mock && mock.exitCode === null && mock.signalCode === null) {
    mock.kill('SIGTERM');
    await Promise.race([new Promise((resolveExit) => mock.once('exit', resolveExit)), sleep(1_000)]);
    if (mock.exitCode === null && mock.signalCode === null) mock.kill('SIGKILL');
  }
  rmSync(temp, { recursive: true, force: true });
}
