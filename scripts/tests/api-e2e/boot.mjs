// Minimal real-daemon boot for the API contract E2E suite — a PLAIN daemon with NO bootstrap user.
//
// The brain E2E harness (`../brain-e2e/spawn-daemon.mjs`, reused elsewhere in this suite) ALWAYS injects
// `ELOWEN_BOOTSTRAP_USER/PASS`, so by the time it returns a token the daemon already has one user and is
// permanently past the fresh-install "setup mode" (`users.count() === 0`). The auth-guard matrix has to
// observe that 0-user state and the transition into re-engaged auth, which spawnRealDaemon cannot produce.
// So this helper boots the SAME built `dist/daemon/index.js` on a throwaway loopback port + temp DB/config
// with NO bootstrap credentials and NO provider config — leaving the daemon in setup mode until the test
// itself creates the first admin via `POST /users`.
//
// SAFETY mirrors spawn-daemon.mjs: never uses 4400/4500 (auto-selects a free ephemeral port), redirects
// HOME + every ELOWEN_*/agent-CLI env var into the temp dir so nothing touches prod DB/config/services,
// and never runs `elowen up`. Robust teardown kills the child and removes the temp dir.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// The built daemon this harness boots. `ELOWEN_E2E_DIST` overrides the location so the suite can be run
// against a SCRATCH build (`tsc --outDir <dir>`) without rewriting the `dist/` a deployed instance runs
// from — the default stays the ordinary `dist/`, so nothing changes for CI or a plain local run.
const distRoot = process.env.ELOWEN_E2E_DIST || join(repoRoot, 'dist');
const daemonEntry = join(distRoot, 'daemon', 'index.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A free loopback port (bind :0, read it back). Guarantees we never collide with prod's 4400/4500. */
function freePort() {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => (port ? resolvePort(port) : reject(new Error('failed to allocate a free port'))));
    });
  });
}

/** Poll `GET /health` until the daemon answers `{ ok: true }` or the hard deadline elapses. */
async function waitForHealth(baseUrl, deadlineMs) {
  const until = Date.now() + deadlineMs;
  let lastErr = 'no attempt';
  while (Date.now() < until) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) {
        const body = await res.json();
        if (body && body.ok) return;
      }
      lastErr = `status ${res.status}`;
    } catch (e) { lastErr = e instanceof Error ? e.message : String(e); }
    await sleep(100);
  }
  throw new Error(`daemon did not become healthy within ${deadlineMs}ms (last: ${lastErr})`);
}

/** Write a FIXTURE plugin into the daemon's writable plugin dir, the way the marketplace lays an
 *  installed plugin down: `<dirname(dbPath)>/plugins/<name>/` (brainCore.ts derives that path from the
 *  DB location, so a plugin put there before the first boot is discovered by the boot scan).
 *
 *  Same reasoning as `tests/helpers/fixturePlugin.ts`, which does this for the in-process suites: when
 *  the subject is a DAEMON mechanism reached through a plugin seam, the plugin has to be a fixture. A
 *  product plugin would tie the assertion to whatever that plugin currently does — and after the
 *  extraction the product plugin that used to own this seam is not in this package at all. The source
 *  lives here as a string for the same reason it does there: it must be a real folder on disk, and
 *  generating it keeps the plugin and the assertion that reads it in one file.
 *
 *  @param {string} dataDir  The daemon's data dir (the DB sits directly inside it).
 *  @param {{name: string, manifest?: object, register: string}} spec
 */
function writeFixturePlugin(dataDir, spec) {
  const dir = join(dataDir, 'plugins', spec.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'elowen-plugin.json'), JSON.stringify({
    name: spec.name, version: '1.0.0', apiVersion: '1',
    description: `api-e2e fixture plugin ${spec.name}`, entry: 'index.mjs',
    ...(spec.manifest ?? {}),
  }, null, 2));
  writeFileSync(join(dir, 'index.mjs'), `export function register(ctx){\n${spec.register}\n}\n`);
}

/**
 * Boot a plain daemon in fresh-install setup mode (0 users). No bootstrap, no provider config.
 *
 * @param {object} [opts]
 * @param {number} [opts.healthTimeoutMs] Hard deadline for boot readiness (default 30000).
 * @param {{name: string, manifest?: object, register: string}[]} [opts.plugins] Fixture plugins to lay
 *   down in the writable plugin dir BEFORE the first boot. Written, not enabled — the test enables them
 *   through the real PATCH /plugins/:name route, so the daemon takes the same path a user's toggle does.
 * @returns {Promise<{ baseUrl: string, port: number, dataDir: string, stop: ()=>Promise<void> }>}
 */
export async function bootPlainDaemon(opts = {}) {
  const healthTimeoutMs = opts.healthTimeoutMs ?? 30_000;
  const dataDir = mkdtempSync(join(tmpdir(), 'elowen-api-e2e-'));
  const dbPath = join(dataDir, 'elowen.db');
  for (const spec of opts.plugins ?? []) writeFixturePlugin(dataDir, spec);
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  // Filtered copy of the parent env: drop every ELOWEN_* prod var + agent-CLI config override, then set
  // our own throwaway values and a redirected HOME so the boot-time skill self-install can't touch prod.
  const childEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('ELOWEN_')) continue;
    if (k === 'CLAUDE_CONFIG_DIR' || k === 'CODEX_HOME' || k === 'XDG_CONFIG_HOME' || k === 'XDG_DATA_HOME') continue;
    childEnv[k] = v;
  }
  Object.assign(childEnv, {
    HOME: dataDir,
    ELOWEN_DB: dbPath,
    ELOWEN_PORT: String(port),
    ELOWEN_HOST: '127.0.0.1',
    ELOWEN_PROJECT: 'e2e',
    ELOWEN_PROJECT_PATH: dataDir,
    ELOWEN_LOG_DIR: join(dataDir, 'logs'),
    // Deliberately NO ELOWEN_BOOTSTRAP_USER/PASS and NO ELOWEN_ALLOW_OPEN: the daemon boots with zero
    // users (setup mode) and re-engages Bearer auth the moment the test creates the first admin.
  });

  const child = spawn(process.execPath, [daemonEntry], { cwd: dataDir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(d.toString()));
  child.stderr.on('data', (d) => logs.push(d.toString()));
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  const cleanupDataDir = () => {
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  };
  const cleanupOnExit = () => {
    if (exited === null) child.kill('SIGKILL');
    cleanupDataDir();
  };
  process.once('exit', cleanupOnExit);

  const stop = async () => {
    try {
      if (exited === null) {
        child.kill('SIGTERM');
        for (let i = 0; i < 30 && exited === null; i += 1) await sleep(100);
        if (exited === null) {
          child.kill('SIGKILL');
          for (let i = 0; i < 30 && exited === null; i += 1) await sleep(100);
          if (exited === null) throw new Error(`daemon child ${child.pid ?? 'unknown'} did not exit after SIGKILL`);
        }
      }
    } finally {
      process.off('exit', cleanupOnExit);
      cleanupDataDir();
    }
  };

  try {
    await waitForHealth(baseUrl, healthTimeoutMs);
    return { baseUrl, port, dataDir, stop };
  } catch (e) {
    const tail = logs.join('').split('\n').slice(-40).join('\n');
    await stop();
    const detail = exited ? ` (daemon exited code=${exited.code} signal=${exited.signal})` : '';
    throw new Error(`bootPlainDaemon failed${detail}: ${e instanceof Error ? e.message : String(e)}\n--- daemon log tail ---\n${tail}`);
  }
}
