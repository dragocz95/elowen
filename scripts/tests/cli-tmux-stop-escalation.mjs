// Keypress-path E2E for the escalating stop, driving the REAL CLI inside tmux against the fake brain
// fixture's `stop-escalation` scenario: Esc arms the two-press interrupt, Esc again fires the graceful
// /brain/abort — which the fixture deliberately does NOT let end the turn (the production wedge: a long
// foreground command pins the aborted turn) — and the NEXT Esc escalates to POST /brain/commands/kill.
// The request log proves the exact HTTP sequence; pane captures prove the user saw the armed hint, the
// escalation notice, and the kill outcome. Skips cleanly when tmux is absent.
// Run with: npm run test:cli-tmux:stop

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  analyzeFrameDiagnostics,
  captureState,
  collectMetadata,
  completeMetadata,
  createArtifactDir,
  createOwnedTempDir,
  createTmuxServer,
  readFrames,
  resolveTmuxRunId,
  writeReport,
} from './cli-tmux-support.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const fixture = join(here, 'fixtures/cli-tmux-brain.mjs');
const cli = join(repo, 'dist/cli/bin.js');
const artifactDir = createArtifactDir('stop-escalation');
const token = 'e2e-token';

if (spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status !== 0) {
  console.log('SKIP test:cli-tmux-stop-escalation — tmux is not installed or not available on PATH.');
  process.exit(0);
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

async function waitFor(label, predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await sleep(30);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  const temp = createOwnedTempDir('elowen-cli-stop-escalation-');
  const home = join(temp, 'home');
  const config = join(temp, 'config');
  const logPath = join(temp, 'requests.jsonl');
  const startGatePath = join(temp, 'start-gate');
  const perfLog = join(artifactDir, 'perf.jsonl');
  mkdirSync(home, { recursive: true });
  mkdirSync(config, { recursive: true });
  const tmux = createTmuxServer('stop-escalation');
  const startedMetadata = collectMetadata(repo, cli, tmux.name, {
    ...process.env,
    ELOWEN_TMUX_RUN_ID: resolveTmuxRunId(process.env),
  });
  const session = 'stop-escalation';
  let mock;
  try {
    mock = spawn(process.execPath, [fixture], {
      cwd: repo,
      env: { ...process.env, ELOWEN_TMUX_LOG: logPath, ELOWEN_TMUX_SCENARIO: 'stop-escalation' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    mock.stdout.setEncoding('utf8');
    mock.stdout.on('data', (chunk) => { stdout += chunk; });
    const port = await waitFor('fixture port', () => {
      const line = stdout.split('\n').find(Boolean);
      return line ? JSON.parse(line).port : null;
    });
    const cliCommand = [
      'env', `HOME=${shellQuote(home)}`, `XDG_CONFIG_HOME=${shellQuote(config)}`,
      `ELOWEN_URL=${shellQuote(`http://127.0.0.1:${port}`)}`, `ELOWEN_TOKEN=${shellQuote(token)}`,
      'ELOWEN_AUTOSTART=0', 'ELOWEN_TUI_PERF=1', `ELOWEN_TUI_LOG=${shellQuote(perfLog)}`,
      'TERM=xterm-256color',
      shellQuote(process.execPath), shellQuote(cli), 'chat', '--new',
    ].join(' ');
    const command = [
      `while [ ! -f ${shellQuote(startGatePath)} ]; do sleep 0.01; done`,
      cliCommand, 'sleep 2',
    ].join('; ');
    tmux.run(['new-session', '-d', '-s', session, '-x', '100', '-y', '30', '-c', repo, command]);
    writeFileSync(startGatePath, 'go\n');
    try { tmux.run(['set-option', '-t', session, 'window-size', 'manual']); } catch { /* older tmux */ }
    tmux.run(['resize-window', '-t', session, '-x', '100', '-y', '30']);

    const entries = () => {
      try { return readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse); }
      catch { return []; }
    };
    const requested = (path) => entries().filter((entry) => entry.kind === 'request' && entry.path === path);
    const capture = () => tmux.run(['capture-pane', '-p', '-t', session]);
    const sendKey = (key) => tmux.run(['send-keys', '-t', session, key]);

    // 1) Active chat with the long turn running (foreground command pinned).
    await waitFor('active chat', () => requested('/brain/stream').length > 0 && capture().includes('E2E Harness'));
    tmux.run(['send-keys', '-t', session, '-l', '--', 'E2E RUN THE LONG JOB']);
    sendKey('Enter');
    await waitFor('the long tool running', () => capture().includes('E2E LONG PHASE'), 12_000);
    captureState({ tmux, session, artifactDir, label: '01-long-turn-running', perfLog, expectCursor: true });
    // The escalation notice is set ONCE, at abort time, and only when the CLI already knows a foreground
    // command is running — that arrives as a separate `process` event. Pressing Esc before it lands aborts
    // without ever advertising the escalation. Only a test hits this (it presses within milliseconds of the
    // turn starting; a human never does), so gate on the footer hint the very same state drives.
    await waitFor('the foreground command visible to the CLI', () => capture().includes('background command'), 12_000);

    // 2) Esc presses arm and then fire the graceful abort. Press-by-press with the log as the oracle:
    //    each press either arms the 1.8 s window or (inside it) aborts, so a slow frame can never wedge
    //    the sequence — the next press simply re-arms.
    for (let press = 0; press < 6 && requested('/brain/abort').length === 0; press += 1) {
      sendKey('Escape');
      await waitFor('abort issued or interrupt armed', () =>
        requested('/brain/abort').length > 0 || capture().includes('esc again to interrupt'), 1_200)
        .catch(() => { /* window may have expired between press and capture — the next press re-arms */ });
    }
    assert.ok(requested('/brain/abort').length > 0, 'Esc-Esc must issue the graceful /brain/abort');
    assert.equal(requested('/brain/commands/kill').length, 0, 'the graceful abort must not kill anything yet');

    // 3) The turn is still pinned (the fixture never idles on abort) — the escalation notice appears.
    await waitFor('the escalation notice', () => capture().includes('esc again to kill the running command'), 12_000);
    captureState({ tmux, session, artifactDir, label: '02-escalation-advertised', perfLog, expectCursor: true });

    // 4) The next Esc escalates to the hard kill and the turn finally unwinds.
    sendKey('Escape');
    await waitFor('the kill request', () => requested('/brain/commands/kill').length > 0, 12_000);
    const kill = requested('/brain/commands/kill').at(-1);
    assert.equal(kill.body?.session, 'e2e-session', 'the kill must carry the bound session');
    assert.ok(kill.body?.client && kill.body?.generation, 'the Esc-path kill rides the client-generation fence');
    await waitFor('the kill outcome notice', () => capture().includes('killed 1 foreground command'), 12_000);
    await waitFor('the turn settling to idle', () => capture().includes('⏎ send'), 12_000);
    captureState({ tmux, session, artifactDir, label: '03-killed-and-idle', perfLog, expectCursor: true });

    const performance = analyzeFrameDiagnostics(readFrames(perfLog));
    writeReport(join(artifactDir, 'report.json'), {
      passed: true,
      scenario: 'stop-escalation',
      metadata: completeMetadata(startedMetadata, repo),
      performance,
      sequence: {
        aborts: requested('/brain/abort').length,
        kills: requested('/brain/commands/kill').length,
        killBinding: { session: kill.body?.session, fenced: Boolean(kill.body?.client && kill.body?.generation) },
      },
    });
    console.log(`PASS test:cli-tmux-stop-escalation — Esc armed, Esc aborted, Esc escalated to the kill. Report: ${join(artifactDir, 'report.json')}`);
  } finally {
    if (tmux.hasSession(session)) {
      try { tmux.run(['kill-session', '-t', session]); } catch { /* best effort */ }
    }
    tmux.killServer();
    if (mock && mock.exitCode === null && mock.signalCode === null) {
      mock.kill('SIGTERM');
      await Promise.race([new Promise((resolveExit) => mock.once('exit', resolveExit)), sleep(1_000)]);
      if (mock.exitCode === null && mock.signalCode === null) mock.kill('SIGKILL');
    }
    rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`FAIL test:cli-tmux-stop-escalation — ${error.stack ?? error}\n`);
  process.exitCode = 1;
});
