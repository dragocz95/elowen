#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  analyzeFrameDiagnostics,
  captureState,
  collectMetadata,
  completeMetadata,
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
const initialSize = { columns: 112, rows: 26 };
const narrowSize = { columns: 40, rows: 15 };
const token = 'e2e-token';

if (spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status !== 0) {
  console.log('SKIP test:cli-tmux-goal — tmux is not installed or not available on PATH.');
  process.exit(0);
}

const temp = mkdtempSync(join(tmpdir(), 'elowen-cli-tmux-goal-'));
const artifactDir = createArtifactDir('goal');
const project = join(temp, 'isolated-goal-project');
const home = join(temp, 'home');
const config = join(temp, 'config');
const logPath = join(artifactDir, 'mock-requests.jsonl');
const ttyStatePath = join(artifactDir, 'tty-state.txt');
const terminalWriteLog = join(artifactDir, 'terminal-writes.log');
const perfLog = join(artifactDir, 'perf.jsonl');
const projectEvidence = join(artifactDir, 'isolated-project.json');
const reportPath = join(artifactDir, 'report.json');
const startGatePath = join(temp, 'start-gate');
const session = 'goal';
const tmuxServer = createTmuxServer('goal');
const startedMetadata = collectMetadata(repo, cli, tmuxServer.name);
mkdirSync(project, { recursive: true });
mkdirSync(home, { recursive: true });
mkdirSync(config, { recursive: true });
writeFileSync(join(project, 'README.md'), '# Isolated Elowen goal E2E\n');
assert.equal(spawnSync('git', ['init', '-q'], { cwd: project }).status, 0, 'isolated test project must initialize as git');
const projectRoot = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: project, encoding: 'utf8' }).stdout.trim();
assert.equal(projectRoot, project, 'tmux E2E must run in its own git project');
writeFileSync(projectEvidence, `${JSON.stringify({ path: project, gitRoot: projectRoot }, null, 2)}\n`);

let mock = null;
let failed = false;
const captures = [];
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function tmux(args) { return tmuxServer.run(args); }
function hasSession() { return tmuxServer.hasSession(session); }
function capture(ansi = false) {
  if (!hasSession()) return '';
  return tmux(['capture-pane', '-p', ...(ansi ? ['-e'] : []), '-t', session]);
}
function saveActive(label, options = {}) {
  const saved = captureState({
    tmux: tmuxServer, session, artifactDir, label, perfLog, expectCursor: true, ...options,
  });
  captures.push(saved);
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
  try { return readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)); }
  catch { return []; }
}
function requests(path) { return entries().filter((entry) => entry.kind === 'request' && entry.path === path); }
function liveFrames() { return readFrames(perfLog, { live: true }); }
async function waitFor(label, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = predicate();
      if (value) return value;
    } catch (error) { lastError = error; }
    await sleep(30);
  }
  throw new Error(`timed out waiting for ${label}${lastError ? ` (${lastError.message})` : ''}`);
}
function sendLiteral(text) { tmux(['send-keys', '-t', session, '-l', '--', text]); }
function sendKey(key) { tmux(['send-keys', '-t', session, key]); }
function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

async function startMock() {
  const child = spawn(process.execPath, [fixture], {
    cwd: repo,
    env: { ...process.env, ELOWEN_TMUX_LOG: logPath, ELOWEN_TMUX_SCENARIO: 'goal' },
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
  const command = [
    `while [ ! -f ${shellQuote(startGatePath)} ]; do sleep 0.01; done`,
    'before=$(stty -g)',
    [
      'env',
      `HOME=${shellQuote(home)}`,
      `XDG_CONFIG_HOME=${shellQuote(config)}`,
      `ELOWEN_URL=${shellQuote(base)}`,
      `ELOWEN_TOKEN=${shellQuote(token)}`,
      'ELOWEN_AUTOSTART=0',
      'ELOWEN_TUI_PERF=1',
      `ELOWEN_TUI_LOG=${shellQuote(perfLog)}`,
      'TERM=xterm-256color',
      shellQuote(process.execPath), shellQuote(cli), 'chat', '--new',
    ].join(' '),
    'after=$(stty -g)',
    `printf '%s\\n%s\\n' "$before" "$after" > ${shellQuote(ttyStatePath)}`,
    `printf '\\nE2E GOAL SHELL RESTORED\\n'`,
    'sleep 2',
  ].join('; ');

  tmux(['new-session', '-d', '-s', session, '-x', String(initialSize.columns), '-y', String(initialSize.rows), '-c', project, command]);
  tmux(['pipe-pane', '-O', '-t', session, `cat > ${shellQuote(terminalWriteLog)}`]);
  writeFileSync(startGatePath, 'go\n');
  try { tmux(['set-option', '-t', session, 'window-size', 'manual']); } catch { /* older tmux */ }
  tmux(['resize-window', '-t', session, '-x', String(initialSize.columns), '-y', String(initialSize.rows)]);

  await waitFor('goal chat readiness', () => requests('/brain/stream').length === 1 && capture().includes('E2E Harness'));
  const startRequest = requests('/brain/start')[0];
  assert.equal(startRequest?.body?.cwd, project, 'CLI must bind the isolated test project cwd');

  sendLiteral('/goal E2E autonomous goal indicator');
  sendKey('Enter');
  await waitFor('active goal chip and real transcript', () => {
    const pane = capture();
    return pane.includes('Goal') && pane.includes('E2E GOAL TOOL');
  });
  const active = saveActive('01-goal-active', { expectScrollbar: false });
  assert.match(active.plain, /Goal\s+0\/4/u, 'active goal chip must expose turn progress');
  assert.doesNotMatch(active.plain, /starting persistent goal/iu, 'long kickoff request must never leave a starting notice');

  await waitFor('goal elapsed tick', () => /Goal\s+0\/4\s+·\s+[1-4]s/u.test(capture()), 3_000);
  const elapsed = saveActive('02-goal-elapsed', { expectScrollbar: false });
  assert.match(elapsed.plain, /Goal\s+0\/4\s+·\s+[1-4]s/u, 'goal elapsed time must advance while kickoff is pending');

  tmux(['resize-window', '-t', session, '-x', String(narrowSize.columns), '-y', String(narrowSize.rows)]);
  const narrowRequestedAt = Date.now();
  await waitFor('narrow active goal frame', () => latestFrame(liveFrames(), narrowSize.columns, narrowSize.rows, narrowRequestedAt)
    && paneLines(capture()).length === narrowSize.rows && capture().includes('Goal'));
  const narrow = saveActive('03-goal-active-40x15', { expectScrollbar: false });
  assert.match(narrow.plain, /Goal\s+0\/4/u, 'active goal must remain visible at 40x15');

  tmux(['resize-window', '-t', session, '-x', String(initialSize.columns), '-y', String(initialSize.rows)]);
  const restoredRequestedAt = Date.now();
  await waitFor('restored active goal frame', () => latestFrame(liveFrames(), initialSize.columns, initialSize.rows, restoredRequestedAt)
    && paneLines(capture()).length === initialSize.rows && capture().includes('Goal'));
  saveActive('04-goal-active-restored', { expectScrollbar: false });

  await waitFor('goal completion state', () => entries().some((entry) => entry.kind === 'event'
    && entry.event?.type === 'goal' && entry.event.goal?.status === 'done') && !capture().includes('◆ Goal'), 8_000);
  const completed = saveActive('05-goal-complete', { expectScrollbar: false });
  assert.match(completed.plain, /E2E GOAL COMPLETE/u, 'settled goal transcript must stay visible');
  assert.doesNotMatch(completed.plain, /◆ Goal|starting persistent goal/iu, 'completed goal status must disappear cleanly');

  sendLiteral('E2E verify editor after goal');
  sendKey('Enter');
  await waitFor('post-goal input response', () => capture().includes('E2E POST-GOAL INPUT ACCEPTED'));
  await waitFor('post-goal idle metadata', () => entries().some((entry) => entry.kind === 'event'
    && entry.event?.usage?.totalTokens === 80));
  const afterGoal = saveActive('06-post-goal-input', { expectScrollbar: false });
  assert.match(afterGoal.plain, /E2E POST-GOAL INPUT ACCEPTED/u, 'editor must remain usable after goal completion');
  assert.doesNotMatch(afterGoal.plain, /◆ Goal/u);

  await sleep(250);
  const idleFrames = liveFrames().length;
  await sleep(1_100);
  assert.equal(liveFrames().length, idleFrames, 'completed goal must leave no persistent render timer');

  sendKey('C-c');
  await waitFor('goal session stop', () => requests('/brain/session/stop').length === 1);
  await waitFor('goal shell restored', () => capture().includes('E2E GOAL SHELL RESTORED'), 5_000);
  const shell = saveRaw('07-restored-shell');
  const ttyStates = readFileSync(ttyStatePath, 'utf8').trim().split('\n');
  assert.equal(ttyStates[1], ttyStates[0], 'raw/canonical/echo tty state must be restored exactly');
  const terminalWrites = readFileSync(terminalWriteLog, 'utf8');
  assert.ok(terminalWrites.lastIndexOf('\x1b[?1049l') > terminalWrites.lastIndexOf('\x1b[?1049h'), 'alternate screen must be left last');
  assert.ok(terminalWrites.lastIndexOf('\x1b[?1006l') > terminalWrites.lastIndexOf('\x1b[?1006h'), 'mouse reporting must be disabled last');

  const frames = readFrames(perfLog);
  const performance = analyzeFrameDiagnostics(frames);
  const report = {
    passed: true,
    scenario: 'goal',
    case: 'active-elapsed-resize-complete-liveness',
    metadata: completeMetadata(startedMetadata, repo),
    isolatedProject: { evidence: projectEvidence, cwdObserved: startRequest.body.cwd },
    captures: captures.map((entry) => ({ label: entry.label, ...entry.paths })),
    evidence: {
      perf: perfLog,
      ttyState: ttyStatePath,
      terminalWrites: terminalWriteLog,
      restoredShell: shell.paths.plain,
      requests: logPath,
    },
    frames: frames.length,
    performance,
    goalStartingNoticeAbsent: true,
    goalElapsedAdvanced: true,
    goalVisibleAt40x15: true,
    goalRemovedAtCompletion: true,
    postGoalInputAccepted: true,
    idleFramesAfter1100Ms: 0,
    terminalStateRestored: true,
  };
  writeReport(reportPath, report);
  console.log(`PASS test:cli-tmux-goal — live goal, elapsed time, resize, completion, editor liveness and teardown verified. Report: ${reportPath}`);
} catch (error) {
  failed = true;
  process.stderr.write(`FAIL test:cli-tmux-goal — ${error.stack ?? error}\n`);
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
