import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const fixture = join(here, 'fixtures/cli-tmux-brain.mjs');
const cli = join(repo, 'dist/cli/bin.js');
const size = { columns: 96, rows: 24 };
const token = 'e2e-token';

if (spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status !== 0) {
  console.log('SKIP test:cli-tmux — tmux is not installed or not available on PATH.');
  process.exit(0);
}

const temp = mkdtempSync(join(tmpdir(), 'elowen-cli-tmux-'));
const home = join(temp, 'home');
const config = join(temp, 'config');
const logPath = join(temp, 'mock-requests.jsonl');
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

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function blankBetween(lines, fromPattern, toPattern) {
  const from = lines.findIndex((line) => fromPattern.test(line));
  const to = lines.findIndex((line, index) => index > from && toPattern.test(line));
  return from >= 0 && to > from && lines
    .slice(from + 1, to)
    .some((line) => line.replace(/[│█]\s*$/, '').trim() === '');
}

async function startMock() {
  const child = spawn(process.execPath, [fixture], {
    cwd: repo,
    env: { ...process.env, ELOWEN_TMUX_LOG: logPath },
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
  const command = [
    'env',
    `HOME=${shellQuote(home)}`,
    `XDG_CONFIG_HOME=${shellQuote(config)}`,
    `ELOWEN_URL=${shellQuote(base)}`,
    `ELOWEN_TOKEN=${shellQuote(token)}`,
    'ELOWEN_AUTOSTART=0',
    'TERM=xterm-256color',
    shellQuote(process.execPath),
    shellQuote(cli),
    'chat',
    '--new',
  ].join(' ');

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

  sendLiteral('E2E FIRST USER');
  sendKey('Enter');
  await waitFor('first streaming tool', () => capture().includes('E2E LONG PHASE'));

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

  const finalCapture = capture();
  const finalLines = finalCapture.endsWith('\n') ? finalCapture.slice(0, -1).split('\n') : finalCapture.split('\n');
  assert.equal(finalLines.length, size.rows, `tmux pane must remain exactly ${size.rows} rows tall`);
  assert.equal((finalCapture.match(/\bBuild\b/g) ?? []).length, 1, 'status metadata must contain exactly one Build row');
  assert.match(finalCapture, /E2E SECOND USER/, 'second user turn must render');
  assert.match(finalCapture, /E2E TOOL OUTPUT/, 'final tool output must render');
  assert.match(finalCapture, /E2E FINAL REPLY/, 'final assistant text must render');
  assert.ok(blankBetween(finalLines, /E2E SECOND USER/, /npm run e2e-demo/), 'user turn and tool block need a blank separator');
  assert.ok(blankBetween(finalLines, /E2E TOOL OUTPUT/, /E2E FINAL REPLY/), 'tool output and final answer need a blank separator');

  sendKey('C-c');
  await waitFor('one session stop request', () => requests('/brain/session/stop').length === 1);
  await waitFor('tmux pane exit', () => !hasSession(), 5_000);

  const startRequests = requests('/brain/start');
  const streamRequests = requests('/brain/stream');
  const stopRequests = requests('/brain/session/stop');
  assert.equal(startRequests.length, 1, 'the harness expects one session start');
  assert.equal(streamRequests.length, 1, 'the bound SSE must not duplicate or reconnect during the scenario');
  assert.equal(stopRequests.length, 1, 'Ctrl+C must send exactly one session stop');
  assert.equal(requests('/brain/abort').length, 1, 'only the confirmed double-Esc may abort');

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

  console.log('PASS test:cli-tmux — real 96x24 TUI, double-Esc, tool layout, single Build, and Ctrl+C stop verified.');
} catch (error) {
  failed = true;
  const pane = capture();
  const log = entries().slice(-80);
  process.stderr.write(`FAIL test:cli-tmux — ${error.stack ?? error}\n`);
  if (pane) process.stderr.write(`\n--- tmux capture ---\n${pane}\n`);
  if (log.length) process.stderr.write(`\n--- mock request tail ---\n${log.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
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
