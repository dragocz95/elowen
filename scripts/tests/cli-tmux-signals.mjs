import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
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
  readFrames,
  writeReport,
} from './cli-tmux-support.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const fixture = join(here, 'fixtures/cli-tmux-brain.mjs');
const cli = join(repo, 'dist/cli/bin.js');
const root = createArtifactDir('signals');
const token = 'e2e-token';

if (spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status !== 0) {
  console.log('SKIP test:cli-tmux-signals — tmux is not installed or not available on PATH.');
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

async function runSignal(signal) {
  const slug = signal.toLowerCase();
  const artifactDir = join(root, slug);
  mkdirSync(artifactDir, { recursive: true });
  const temp = mkdtempSync(join(tmpdir(), `elowen-cli-${slug}-`));
  const home = join(temp, 'home');
  const config = join(temp, 'config');
  const logPath = join(temp, 'requests.jsonl');
  const ttyPath = join(artifactDir, 'tty-state.txt');
  const startGatePath = join(temp, 'start-gate');
  const perfLog = join(artifactDir, 'perf.jsonl');
  const writeLog = join(artifactDir, 'terminal-writes.log');
  mkdirSync(home, { recursive: true });
  mkdirSync(config, { recursive: true });
  const tmux = createTmuxServer(slug);
  const session = slug;
  let mock;
  try {
    mock = spawn(process.execPath, [fixture], {
      cwd: repo,
      env: { ...process.env, ELOWEN_TMUX_LOG: logPath, ELOWEN_TMUX_SCENARIO: 'short-controls' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    mock.stdout.setEncoding('utf8');
    mock.stdout.on('data', (chunk) => { stdout += chunk; });
    const port = await waitFor(`${signal} fixture`, () => {
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
      'before=$(stty -g)', cliCommand, 'after=$(stty -g)',
      `printf '%s\\n%s\\n' "$before" "$after" > ${shellQuote(ttyPath)}`,
      `printf '\\nE2E ${signal} SHELL RESTORED\\n'`, 'sleep 2',
    ].join('; ');
    tmux.run(['new-session', '-d', '-s', session, '-x', '80', '-y', '24', '-c', repo, command]);
    tmux.run(['pipe-pane', '-O', '-t', session, `cat > ${shellQuote(writeLog)}`]);
    writeFileSync(startGatePath, 'go\n');
    try { tmux.run(['set-option', '-t', session, 'window-size', 'manual']); } catch { /* older tmux */ }
    tmux.run(['resize-window', '-t', session, '-x', '80', '-y', '24']);
    const entries = () => {
      try { return readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse); }
      catch { return []; }
    };
    await waitFor(`${signal} active chat`, () => entries().some((entry) => entry.path === '/brain/stream')
      && tmux.run(['capture-pane', '-p', '-t', session]).includes('E2E Harness'));
    const before = captureState({
      tmux, session, artifactDir, label: '01-before-signal', perfLog, expectCursor: true,
    });
    const panePid = Number(tmux.run(['display-message', '-p', '-t', session, '#{pane_pid}']).trim());
    const childPid = await waitFor(`${signal} CLI pid`, () => {
      try {
        return Number(execFileSync('pgrep', ['-P', String(panePid)], { encoding: 'utf8' }).trim().split('\n')[0]);
      } catch { return null; }
    });
    process.kill(childPid, signal);
    const marker = `E2E ${signal} SHELL RESTORED`;
    await waitFor(`${signal} restored shell`, () => tmux.run(['capture-pane', '-p', '-t', session]).includes(marker));
    const shell = tmux.run(['capture-pane', '-p', '-t', session]);
    const restoredShellPath = join(artifactDir, '02-restored-shell.txt');
    writeFileSync(restoredShellPath, shell);
    assert.match(shell, new RegExp(marker), `${signal}: shell marker must be readable`);
    assert.doesNotMatch(shell, /MaxListenersExceededWarning|\bat\s+\S+\s+\([^)]*\.js:\d+/u);
    const tty = readFileSync(ttyPath, 'utf8').trim().split('\n');
    assert.equal(tty[1], tty[0], `${signal}: tty mode must restore exactly`);
    const writes = readFileSync(writeLog, 'utf8');
    assert.ok(writes.lastIndexOf('\x1b[?1049l') > writes.lastIndexOf('\x1b[?1049h'), `${signal}: alternate screen off last`);
    assert.ok(writes.lastIndexOf('\x1b[?1006l') > writes.lastIndexOf('\x1b[?1006h'), `${signal}: mouse mode off last`);
    const performance = analyzeFrameDiagnostics(readFrames(perfLog));
    const report = {
      passed: true, signal, metadata: collectMetadata(repo, cli, tmux.name), performance,
      terminalStateRestored: true, shellReadable: true,
      evidence: {
        before: { label: before.label, ...before.paths },
        restoredShell: restoredShellPath,
        ttyState: ttyPath,
        terminalWrites: writeLog,
        perf: perfLog,
      },
    };
    writeReport(join(artifactDir, 'report.json'), report);
    return report;
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

try {
  const reports = [];
  for (const signal of ['SIGTERM', 'SIGHUP']) reports.push(await runSignal(signal));
  writeReport(join(root, 'report.json'), {
    passed: true, scenario: 'signals', metadata: reports[0].metadata, cases: reports,
  });
  console.log(`PASS test:cli-tmux-signals — SIGTERM and SIGHUP restored tty, mouse, alt screen and shell. Report: ${join(root, 'report.json')}`);
} catch (error) {
  process.stderr.write(`FAIL test:cli-tmux-signals — ${error.stack ?? error}\n`);
  process.exitCode = 1;
}
