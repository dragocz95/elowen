// Reusable real-daemon harness for the brain E2E suites.
//
// Boots the ACTUAL built daemon (`dist/daemon/index.js`) as a child process on a throwaway loopback
// port, backed by a throwaway SQLite DB + config/data dir under `os.tmpdir()`. Everything the daemon
// writes (DB, brain auth, plugin data, logs, avatars, marketplace cache) lands under that one temp dir,
// and HOME is redirected there too so the boot-time skill self-install can never touch the real user's
// `~/.claude` / `~/.codex` / `~/.config`. A custom brain provider pointing at a scripted model server is
// injected AFTER boot over the authenticated `PUT /config` API (the daemon reads brain config live, so no
// restart is needed). Robust teardown kills the child and removes the temp dir.
//
// SAFETY: never uses ports 4400/4500 (auto-selects a free ephemeral port), never touches the prod DB
// (/var/www/.config/elowen/elowen.db), config dir or systemd services, and never runs `elowen up`.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// The built daemon this harness boots. `ELOWEN_E2E_DIST` overrides the location so the suite can be run
// against a SCRATCH build (`tsc --outDir <dir>`) without rewriting the `dist/` a deployed instance runs
// from — the default stays the ordinary `dist/`, so nothing changes for CI or a plain local run.
const distRoot = process.env.ELOWEN_E2E_DIST || join(repoRoot, 'dist');
const daemonEntry = join(distRoot, 'daemon', 'index.js');

/** Grab a free loopback TCP port by binding to port 0 and reading it back. Guarantees we never collide
 *  with prod's 4400/4500 (the OS hands out an ephemeral high port). */
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/**
 * Boot a real daemon, inject a custom brain provider, and return handles for driving it.
 *
 * @param {object} opts
 * @param {string} opts.providerBaseUrl  OpenAI-compatible base URL (must end in `/v1`) of the model server.
 * @param {string} [opts.providerId]     Config id for the injected provider (default 'e2e').
 * @param {string} [opts.model]          Model id the provider advertises (default 'mock-model').
 * @param {number} [opts.healthTimeoutMs] Hard deadline for boot readiness (default 30000).
 * @param {Record<string,string>} [opts.env] Extra environment for the daemon child, applied LAST. The
 *        filter below strips every inherited `ELOWEN_*` var on purpose, so a suite that needs one (the
 *        load harness needs its trace-output dir) has to pass it explicitly rather than rely on leakage.
 * @param {(dataDir: string, dbPath: string) => void} [opts.prepareDataDir] Optional synchronous fixture hook
 *        run after the isolated temp paths exist but before the daemon's first boot. It is for migration E2E
 *        fixtures only; it must write exclusively under `dataDir`.
 * @returns {Promise<{ baseUrl: string, token: string, dataDir: string, port: number, providerId: string, model: string, pid: ()=>number|undefined, stop: ()=>Promise<void>, restart: ()=>Promise<string> }>}
 */
export async function spawnRealDaemon(opts) {
  if (!opts?.providerBaseUrl) throw new Error('spawnRealDaemon requires providerBaseUrl');
  const providerId = opts.providerId ?? 'e2e';
  const model = opts.model ?? 'mock-model';
  const healthTimeoutMs = opts.healthTimeoutMs ?? 30_000;

  const dataDir = mkdtempSync(join(tmpdir(), 'elowen-brain-e2e-'));
  const dbPath = join(dataDir, 'elowen.db');
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const bootstrapUser = 'admin';
  const bootstrapPass = `e2e-${randomBytes(18).toString('base64url')}`;

  // Start from a filtered copy of the parent env: drop every ELOWEN_* prod var and every agent-CLI config
  // override so nothing points back at prod paths, then set our own throwaway values + a redirected HOME.
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
    ELOWEN_BOOTSTRAP_USER: bootstrapUser,
    ELOWEN_BOOTSTRAP_PASS: bootstrapPass,
  }, opts.env ?? {});

  let child = null;
  let logs = [];
  let exited = null;
  /** Timing of the most recent restart(): how long the SIGTERM took to turn into an exit, whether the
   *  harness had to SIGKILL, and how long the new process took to become healthy. A suite that changes the
   *  shutdown path needs these as evidence, not as a feeling. */
  let lastRestart = null;

  /** (Re)start the daemon child on the SAME port and data dir, capturing its output. */
  const launch = () => {
    logs = [];
    exited = null;
    child = spawn(process.execPath, [daemonEntry], { cwd: dataDir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => logs.push(d.toString()));
    child.stderr.on('data', (d) => logs.push(d.toString()));
    child.on('exit', (code, signal) => { exited = { code, signal }; });
  };

  /** Terminate the child and WAIT for the exit, so its port is free again. Leaves the data dir intact —
   *  that is what separates a restart from a teardown. */
  const kill = async () => {
    if (!child || exited !== null) return { stopMs: 0, forced: false, exit: exited };
    const startedAt = Date.now();
    child.kill('SIGTERM');
    for (let i = 0; i < 30 && exited === null; i += 1) await sleep(100);
    let forced = false;
    if (exited === null) {
      forced = true;
      child.kill('SIGKILL');
      for (let i = 0; i < 20 && exited === null; i += 1) await sleep(100);
    }
    return { stopMs: Date.now() - startedAt, forced, exit: exited };
  };

  /** Authenticate as the bootstrapped admin → bearer token. */
  const login = async () => {
    const res = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: bootstrapUser, password: bootstrapPass }),
    });
    if (!res.ok) throw new Error(`login failed: HTTP ${res.status} ${await res.text()}`);
    const { token } = await res.json();
    if (!token) throw new Error('login returned no token');
    return token;
  };

  // stop() only runs when the suite reaches its own teardown. A crash, an unhandled rejection or a
  // Ctrl-C skips it and strands the whole data dir — including the daemon log, which is why two aborted
  // runs could leave 30 GB each sitting in /tmp. This fires on the way out no matter how we leave.
  const cleanupDataDir = () => {
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  };
  process.once('exit', cleanupDataDir);

  const stop = async () => {
    try { await kill(); } finally {
      process.off('exit', cleanupDataDir);
      cleanupDataDir();
    }
  };

  /** Restart the daemon over the SAME data dir and port. Everything it held in memory (live sessions,
   *  caches, timers) is provably gone, while every persisted row survives — the only way a suite can
   *  show that behaviour after the restart came out of SQLite rather than out of RAM. Returns a FRESH
   *  bearer token; the caller must use it from then on. */
  const restart = async () => {
    const stop = await kill();
    const bootStartedAt = Date.now();
    launch();
    await waitForHealth(baseUrl, healthTimeoutMs);
    lastRestart = { ...stop, bootMs: Date.now() - bootStartedAt, bootAt: bootStartedAt };
    return login();
  };

  opts.prepareDataDir?.(dataDir, dbPath);
  launch();

  try {
    await waitForHealth(baseUrl, healthTimeoutMs);
    const token = await login();

    // Inject the custom brain provider pointing at the scripted model server. brainConfigFromElowen reads
    // this live on the next brain start, so no daemon restart is required.
    const cfgRes = await fetch(`${baseUrl}/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        brain: { providers: [{ id: providerId, label: 'E2E Model', type: 'openai', baseUrl: opts.providerBaseUrl, models: [model], apiKey: 'e2e-test-key' }] },
      }),
    });
    if (!cfgRes.ok) throw new Error(`config PUT failed: HTTP ${cfgRes.status} ${await cfgRes.text()}`);

    // Everything the daemon wrote so far. A harness that flips a runtime switch needs to prove the
    // daemon actually took that path instead of silently falling back to the old one.
    // `pid` is a getter, not a value: a restart replaces the child, and a caller sampling /proc must
    // follow the live process rather than keep polling a pid that has exited.
    return {
      baseUrl, token, dataDir, port, providerId, model, pid: () => child?.pid, stop, restart, logText: () => logs.join(''),
      lastRestart: () => lastRestart,
      // The daemon writes its log under ELOWEN_LOG_DIR, not to stdout — this is where a suite reads it.
      logDir: join(dataDir, 'logs'),
    };
  } catch (e) {
    const tail = logs.join('').split('\n').slice(-40).join('\n');
    await stop();
    const detail = exited ? ` (daemon exited code=${exited.code} signal=${exited.signal})` : '';
    throw new Error(`spawnRealDaemon failed${detail}: ${e instanceof Error ? e.message : String(e)}\n--- daemon log tail ---\n${tail}`);
  }
}
