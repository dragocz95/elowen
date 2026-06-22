import { spawn as nodeSpawn } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir, dbPath, logDir, runFile } from './paths.js';

interface Svc { pid: number; port: number }
export interface RunState { daemon: Svc; web: Svc; version: string; startedAt: string }
export interface SvcStatus { running: boolean; pid: number | null; port: number; healthy: boolean }

const DAEMON_PORT = 4400;
const WEB_PORT = 4500;

/** Read the tracked run state, or null when absent/corrupt. A corrupt file (partial write, manual
 *  edit) must not throw — the caller treats null as "nothing running" and can re-start cleanly. */
export function readState(env: NodeJS.ProcessEnv): RunState | null {
  try { return JSON.parse(readFileSync(runFile(env), 'utf8')) as RunState; }
  catch { return null; }
}

export function writeState(env: NodeJS.ProcessEnv, state: RunState): void {
  mkdirSync(dataDir(env), { recursive: true });
  writeFileSync(runFile(env), JSON.stringify(state, null, 2), 'utf8');
}

export function clearState(env: NodeJS.ProcessEnv): void {
  rmSync(runFile(env), { force: true });
}

/** Liveness via signal 0: it delivers nothing but still does the permission/existence check. ESRCH
 *  means gone; EPERM means alive but owned by another user (still "alive" for our purposes). */
export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function portHealthy(fetchFn: typeof fetch, port: number, path: string): Promise<boolean> {
  try { const r = await fetchFn(`http://127.0.0.1:${port}${path}`); return r.ok; }
  catch { return false; }
}

/** Status of both services: a service is `running` when its tracked pid is alive, and `healthy` when
 *  its port also answers (a recycled pid or a wedged process is running-but-unhealthy). */
export async function status(env: NodeJS.ProcessEnv, fetchFn: typeof fetch = fetch): Promise<{ daemon: SvcStatus; web: SvcStatus }> {
  const state = readState(env);
  const of = async (svc: Svc | undefined, path: string): Promise<SvcStatus> => {
    if (!svc) return { running: false, pid: null, port: 0, healthy: false };
    const running = isAlive(svc.pid);
    const healthy = running && await portHealthy(fetchFn, svc.port, path);
    return { running, pid: svc.pid, port: svc.port, healthy };
  };
  return { daemon: await of(state?.daemon, '/health'), web: await of(state?.web, '/') };
}

/** Stop both tracked services and forget them. Tolerates already-dead pids (kill throws → ignored).
 *  Default kill is SIGTERM via process.kill; injectable for tests. */
export async function stop(env: NodeJS.ProcessEnv, kill: (pid: number, signal?: NodeJS.Signals | number) => void = (p, s) => process.kill(p, s)): Promise<void> {
  const state = readState(env);
  if (!state) return;
  for (const svc of [state.daemon, state.web]) {
    try { kill(svc.pid, 'SIGTERM'); } catch { /* already gone — fine */ }
  }
  clearState(env);
}

export interface StartDeps {
  spawn?: typeof nodeSpawn;
  fetch?: typeof fetch;
  version: string;
  now?: () => string;
  /** ms between health polls and how many attempts before giving up. */
  pollMs?: number;
  attempts?: number;
}

const here = dirname(fileURLToPath(import.meta.url)); // dist/cli at runtime
const daemonEntry = () => join(here, '..', 'daemon', 'index.js');    // dist/daemon/index.js
const webServer = () => join(here, '..', '..', 'web-dist', 'server.js'); // <pkg>/web-dist/server.js (Next standalone)

/** Start daemon + web as detached background processes and record their pids. Idempotent-ish: if both
 *  ports are already healthy it just refreshes the run file rather than double-spawning. */
export async function start(env: NodeJS.ProcessEnv, deps: StartDeps): Promise<RunState> {
  const spawn = deps.spawn ?? nodeSpawn;
  const fetchFn = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date().toISOString());
  const pollMs = deps.pollMs ?? 200;
  const attempts = deps.attempts ?? 100;
  // Ports are overridable (ORCA_PORT / ORCA_WEB_PORT) so a second instance — or a smoke test — can run
  // alongside an existing one. Defaults are the conventional 4400/4500.
  const daemonPort = Number(env.ORCA_PORT ?? DAEMON_PORT);
  const webPort = Number(env.ORCA_WEB_PORT ?? WEB_PORT);
  const childEnv = { ...env, ORCA_DB: dbPath(env), ORCA_LOG_DIR: logDir(env), ORCA_AUTOSTART: '0' };

  const launch = (entry: string, extra: NodeJS.ProcessEnv) => {
    const child = spawn(process.execPath, [entry], { detached: true, stdio: 'ignore', env: { ...childEnv, ...extra } });
    child.unref();
    if (!child.pid) throw new Error(`failed to spawn ${entry}`);
    return child.pid;
  };

  const existing = readState(env);
  const daemonPid = existing && isAlive(existing.daemon.pid) ? existing.daemon.pid : launch(daemonEntry(), { ORCA_PORT: String(daemonPort) });
  const webPid = existing && isAlive(existing.web.pid) ? existing.web.pid
    : launch(webServer(), { PORT: String(webPort), HOSTNAME: '127.0.0.1', ORCA_DAEMON_URL: `http://127.0.0.1:${daemonPort}` });

  // Wait for the daemon to answer; the web proxies it, so it comes up second.
  let healthy = false;
  for (let i = 0; i < attempts; i++) {
    if (await portHealthy(fetchFn, daemonPort, '/health')) { healthy = true; break; }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  // Record state even on failure so `orca down`/`status` can see and clean up the spawned pids.
  const state: RunState = { daemon: { pid: daemonPid, port: daemonPort }, web: { pid: webPid, port: webPort }, version: deps.version, startedAt: now() };
  writeState(env, state);
  // But never report success when the daemon never answered: a wedged or crash-looping daemon would
  // otherwise be written as "orca is up". Surface it so the operator knows to check the logs.
  if (!healthy) throw new Error(`orca daemon did not become healthy on :${daemonPort} after ${Math.round((attempts * pollMs) / 1000)}s — check the logs in ${logDir(env)}`);
  return state;
}
