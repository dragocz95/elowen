import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir, dbPath, logDir, runFile } from '../shared/paths.js';

interface Svc { pid: number; port: number }
export interface RunState { daemon: Svc; web: Svc; version: string; startedAt: string }
export interface SvcStatus { running: boolean; pid: number | null; port: number; healthy: boolean }

export const DAEMON_PORT = 4400;
const WEB_PORT = 4500;

/** Where the CLI reaches the daemon when `ELOWEN_URL` says nothing. Every verb that talks to the API
 *  over HTTP — the api passthrough, the chat launcher, the menu, `ensureDaemon`'s probe — starts from
 *  this one, so a changed host is one edit. `DAEMON_PORT` is all the installer shares: it composes its
 *  own `127.0.0.1` URL because it needs the number for the units and the proxy too. */
export const DEFAULT_DAEMON_URL = `http://localhost:${DAEMON_PORT}`;

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

/** Which tracked service a pid claims to be — its entry script is the birth-identity marker. */
export type ServiceMark = 'daemon' | 'web';
const ENTRY_MARK: Record<ServiceMark, string> = { daemon: 'daemon/index.js', web: 'web-dist/server.js' };

/** Services whose argv is not stable get an environment identity too: Next.js overwrites the process
 *  title (and with it the in-memory argv that /proc/<pid>/cmdline mirrors) with `next-server (v16.x)`
 *  a moment after the web boots, so the entry mark vanishes from its cmdline. The env is a separate
 *  region that the title rewrite does not touch, so it still answers who the process is.
 *
 *  ELOWEN_SERVICE is the marker meant for this, pinned by the launcher and by the unit template. The
 *  value below is the LEGACY fallback: every install predating that marker hands the web
 *  ELOWEN_DAEMON_URL and nothing else sets it, and `elowen update` never rewrites an installed unit —
 *  so without it every existing deployment would silently keep failing this check. It is trusted only
 *  when ELOWEN_SERVICE is absent entirely (see isTrackedService).
 *
 *  Linux only: reading another process's env needs procfs, and no portable `ps` carries it. On macOS
 *  the web therefore stays unidentifiable — `status` reports it stopped and `stop` leaves it running,
 *  the very bug this fixes. Failing closed there is the safe direction (a foreign pid never gets a
 *  SIGTERM), but it is an open gap, not a decision. */
const ENV_MARK: Partial<Record<ServiceMark, string>> = { web: 'ELOWEN_DAEMON_URL' };

/** A pid liveness+identity predicate; injectable so tests need not mint real daemon processes. */
export type IsTracked = (pid: number, mark: ServiceMark) => boolean;

/** Whether a tracked pid is STILL our service, not an unrelated pid that reused the number after a
 *  reboot/crash. A bare `isAlive` check is not enough: run.json survives a reboot, the OS recycles pids,
 *  and `stop` would then SIGTERM an innocent process while `start` would adopt it as "already running"
 *  and never spawn. We birth-validate by matching the process's own argv against the service's entry
 *  script — or, for a service whose argv is not stable (see ENV_MARK), the environment markers every
 *  launch path pins on it; a dead pid, or one carrying neither, is "not ours". */
export function isTrackedService(pid: number, mark: ServiceMark, platform: NodeJS.Platform = process.platform): boolean {
  if (!isAlive(pid)) return false;
  const argv = processArgv(pid, platform);
  if (argv !== null && argv.includes(ENTRY_MARK[mark])) return true;
  const envMark = ENV_MARK[mark];
  if (envMark === undefined) return false; // the daemon's argv is stable — no env fallback
  const environ = processEnviron(pid, platform);
  if (environ === null) return false;
  // Every path that starts a service pins ELOWEN_SERVICE — this launcher, the systemd unit, and
  // ensureDaemon's auto-spawn in index.ts — so its value is authoritative over anything the operator's
  // shell exported. The legacy marker is trusted only in its absence, because an exported
  // ELOWEN_DAEMON_URL spreads into every spawn and would otherwise make a daemon read as the web,
  // handing it a SIGTERM from `down`. Any new spawn path has to pin it too, or it reopens that hole.
  // (The pin cannot help a process that is not ours: environments are inherited, so a child of the web
  // still carries both markers. It has to be in run.json to matter, which bounds it to one signal.)
  if (environ.some((e) => e === `ELOWEN_SERVICE=${mark}`)) return true;
  return !environ.some((e) => e.startsWith('ELOWEN_SERVICE=')) && environ.some((e) => e.startsWith(`${envMark}=`));
}

/** The command line of `pid`, or null when it cannot be read. procfs is the cheap path; off Linux there
 *  is no /proc and `ps` answers the same question — liveness alone used to stand in for identity there,
 *  which let `stop` SIGTERM whatever process had inherited a recycled pid (and `elowen setup` now takes
 *  that path unattended). `platform` is a parameter so the non-procfs branch is testable on Linux. */
function processArgv(pid: number, platform: NodeJS.Platform): string | null {
  if (platform === 'linux') {
    try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' '); } // NUL-separated argv
    catch { return null; } // /proc unreadable or the pid vanished mid-check
  }
  try { return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }); }
  catch { return null; } // ps failed or the pid is gone → cannot confirm it is ours
}

/** The environment of `pid` as KEY=VALUE entries, or null when it cannot be read. procfs exposes the
 *  env as NUL-separated bytes, readable — like cmdline — only for our own processes. Off Linux there
 *  is no /proc and no portable `ps` output carries the env, so the env identity stays Linux-only and
 *  the non-procfs branch keeps the argv check. */
function processEnviron(pid: number, platform: NodeJS.Platform): string[] | null {
  if (platform !== 'linux') return null;
  try { return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0'); }
  catch { return null; } // /proc unreadable or the pid vanished mid-check
}

/** GET `url` and report whether it answered 2xx within `timeoutMs` — the single readiness probe shared by
 *  every CLI health check (this launcher's own start/stop/status, `ensureDaemon`'s auto-spawn in
 *  index.ts, and the installer's post-provision wait). A response is required to be `ok`: an unhealthy
 *  500 must not read as "up" the way a bare non-throwing fetch would, and the bounded per-request timeout
 *  keeps a half-open local connection from blocking an ordinary command instead of just failing it. */
export async function urlHealthy(url: string, fetchFn: typeof fetch = fetch, timeoutMs = 3000): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return (await fetchFn(url, { signal: ctrl.signal })).ok; }
  catch { return false; }
  finally { clearTimeout(timer); }
}

const portUrl = (port: number, path: string): string => `http://127.0.0.1:${port}${path}`;

async function portHealthy(fetchFn: typeof fetch, port: number, path: string): Promise<boolean> {
  return urlHealthy(portUrl(port, path), fetchFn);
}

/** Options for `waitHealthy`. */
export interface ReadinessOpts {
  /** Wall-clock budget for the WHOLE wait, probes included. */
  budgetMs: number;
  /** Pause between polling rounds (clamped to what is left of the budget). */
  pollMs?: number;
  fetchFn?: typeof fetch;
}

/** Poll `urls` until every one answers 2xx or the budget runs out; returns each url's final health.
 *  The single readiness wait shared by `start`, `elowen setup`, `ensureDaemon` and the installer.
 *
 *  `budgetMs` is a real deadline and each probe may spend only what is LEFT of it. Attempts × interval is
 *  NOT a duration: every probe carries its own timeout, so a "5s" wait of 50×100ms could run for minutes
 *  against a port that accepts connections and then stalls — exactly the wedged-service case these waits
 *  exist for. Urls are probed in order and a later one only once every earlier one is healthy (the web
 *  proxies the daemon, so polling it before the daemon answers is wasted budget). */
export async function waitHealthy(urls: string[], opts: ReadinessOpts): Promise<boolean[]> {
  const { budgetMs, pollMs = 100, fetchFn = fetch } = opts;
  const deadline = Date.now() + budgetMs;
  const left = (): number => deadline - Date.now();
  const probes = urls.map((url) => ({ url, healthy: false }));
  do {
    for (const probe of probes) {
      if (probe.healthy) continue;
      probe.healthy = await urlHealthy(probe.url, fetchFn, Math.max(left(), 1));
      if (!probe.healthy) break; // gate the rest behind it
    }
    if (probes.every((p) => p.healthy)) break;
    await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(left(), 0))));
  } while (left() > 0);
  return probes.map((p) => p.healthy);
}

/** Status of both services: a service is `running` when its tracked pid is alive, and `healthy` when
 *  its port also answers (a recycled pid or a wedged process is running-but-unhealthy). */
export async function status(env: NodeJS.ProcessEnv, fetchFn: typeof fetch = fetch, isTracked: IsTracked = isTrackedService): Promise<{ daemon: SvcStatus; web: SvcStatus }> {
  const state = readState(env);
  const of = async (svc: Svc | undefined, path: string, mark: ServiceMark): Promise<SvcStatus> => {
    if (!svc) return { running: false, pid: null, port: 0, healthy: false };
    const running = isTracked(svc.pid, mark);
    const healthy = running && await portHealthy(fetchFn, svc.port, path);
    return { running, pid: svc.pid, port: svc.port, healthy };
  };
  return { daemon: await of(state?.daemon, '/health', 'daemon'), web: await of(state?.web, '/', 'web') };
}

export interface StopDeps {
  kill?: (pid: number, signal?: NodeJS.Signals | number) => void;
  fetch?: typeof fetch;
  isTracked?: IsTracked;
  /** ms between liveness/port polls and how many attempts before giving up on a signalled service. */
  pollMs?: number;
  attempts?: number;
  /** Kill outright (SIGKILL) instead of asking the daemon to drain its running turns first. For a wedged
   *  daemon, or when the caller genuinely cannot wait — it abandons whatever work was in flight. */
  force?: boolean;
}

/** Stop both tracked services and forget them — but only once they are actually GONE: SIGTERM is not a
 *  promise, and reporting success while a process is still shutting down (or its port still answers) is
 *  how `down` used to lie and a following `up` collided with it. Waits, bounded, for each signalled
 *  service's pid to die AND its port to stop answering before clearing run.json; on timeout the state is
 *  left in place (so the next `down`/`status` still sees it) and an error is thrown instead of a silent
 *  false success. A recycled/unrelated pid is never signalled or waited on. */
export async function stop(env: NodeJS.ProcessEnv, deps: StopDeps = {}): Promise<void> {
  const kill = deps.kill ?? ((pid: number, signal?: NodeJS.Signals | number) => process.kill(pid, signal));
  const fetchFn = deps.fetch ?? fetch;
  const isTracked = deps.isTracked ?? isTrackedService;
  const pollMs = deps.pollMs ?? 500;
  // The daemon drains running turns before it exits (see installGracefulShutdown), so the default budget
  // has to outlast that drain — at 5s this reported a failure while the daemon was still finishing a turn
  // exactly as asked. `--force` skips the drain entirely, so it only needs long enough to confirm a kill.
  const attempts = deps.attempts ?? (deps.force ? 10 : 1360); // ~5s forced, ~11min draining
  // SIGKILL cannot be caught, so a forced stop never reaches the drain. That is the point: it is the
  // escape hatch for a wedged daemon, and it abandons whatever was running.
  const signal: NodeJS.Signals = deps.force ? 'SIGKILL' : 'SIGTERM';
  const state = readState(env);
  if (!state) return;

  let pending: { mark: ServiceMark; svc: Svc; path: string }[] = [];
  for (const [svc, mark, path] of [[state.daemon, 'daemon', '/health'], [state.web, 'web', '/']] as const) {
    if (!isTracked(svc.pid, mark)) continue; // not our service — never signalled, never waited on
    try { kill(svc.pid, signal); } catch { /* raced to exit — still worth confirming below */ }
    pending.push({ mark, svc, path });
  }

  // IDENTITY, not bare liveness — the same predicate that decided to signal it, for the same reason one
  // line up. `isAlive` is `kill(pid, 0)`, which SUCCEEDS on a zombie: a process that has exited but whose
  // parent has not reaped it still owns its pid. That is the normal state of a detached daemon inside a
  // container whose PID 1 is an ordinary script rather than an init, so `down` waited out its whole budget
  // and then reported a daemon that had in fact died instantly. A zombie's /proc/<pid>/cmdline is empty,
  // so the identity check reads it as "not ours" — correctly, since it is no longer running anything.
  const stillUp = async (t: { mark: ServiceMark; svc: Svc; path: string }): Promise<boolean> =>
    isTracked(t.svc.pid, t.mark) || await portHealthy(fetchFn, t.svc.port, t.path);

  for (let i = 0; i < attempts && pending.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, pollMs));
    const next: typeof pending = [];
    for (const t of pending) if (await stillUp(t)) next.push(t);
    pending = next;
  }
  if (pending.length) {
    throw new Error(`elowen down: ${pending.map((t) => t.mark).join(' and ')} did not stop within ${Math.round((attempts * pollMs) / 1000)}s (pid still alive or the port still answers) — state left in place, retry \`elowen down\``);
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
  /** Pid liveness+identity check; injectable for tests (defaults to the procfs birth-validation). */
  isTracked?: IsTracked;
  /** ms between lock-acquisition retries and how many attempts before giving up when a concurrent
   *  start() already holds the lock. Injectable for tests. */
  lockPollMs?: number;
  lockAttempts?: number;
}

const here = dirname(fileURLToPath(import.meta.url)); // dist/cli at runtime
const daemonEntry = () => join(here, '..', 'daemon', 'index.js');    // dist/daemon/index.js
const webServer = () => join(here, '..', '..', 'web-dist', 'server.js'); // <pkg>/web-dist/server.js (Next standalone)

/** Serialises concurrent `start()` calls (e.g. the menu's "up" racing the hourly auto-update's fallback
 *  restart) so two invocations never both see "nothing tracked" for the same port and both decide to
 *  spawn. A stale lock — its recorded pid is gone — is reclaimed rather than left to jam every future
 *  `elowen up` after a hard crash between acquiring it and releasing it. */
async function acquireStartLock(env: NodeJS.ProcessEnv, pollMs: number, attempts: number): Promise<() => void> {
  mkdirSync(dataDir(env), { recursive: true });
  const lockPath = join(dataDir(env), 'start.lock');
  for (let i = 0; i < attempts; i++) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      return () => { try { rmSync(lockPath, { force: true }); } catch { /* already gone */ } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let holder = NaN;
      try { holder = Number(readFileSync(lockPath, 'utf8').trim()); } catch { /* vanished mid-check — retry immediately below */ }
      if (!Number.isInteger(holder) || !isAlive(holder)) { try { rmSync(lockPath, { force: true }); } catch { /* raced with the holder's own release */ } continue; }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  throw new Error('another `elowen up` is already in progress — try again in a moment');
}

/** Start daemon + web as detached background processes and record their pids. Idempotent-ish: a tracked,
 *  still-alive pid is adopted rather than re-spawned. Locked against concurrent start() calls, and both
 *  services must answer healthy before this reports success. */
export async function start(env: NodeJS.ProcessEnv, deps: StartDeps): Promise<RunState> {
  const release = await acquireStartLock(env, deps.lockPollMs ?? 100, deps.lockAttempts ?? 50);
  try { return await startLocked(env, deps); }
  finally { release(); }
}

async function startLocked(env: NodeJS.ProcessEnv, deps: StartDeps): Promise<RunState> {
  const spawn = deps.spawn ?? nodeSpawn;
  const fetchFn = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date().toISOString());
  const pollMs = deps.pollMs ?? 200;
  const attempts = deps.attempts ?? 100; // pollMs × attempts is the TOTAL readiness deadline
  // Ports are overridable (ELOWEN_PORT / ELOWEN_WEB_PORT) so a second instance — or a smoke test — can run
  // alongside an existing one. Defaults are the conventional 4400/4500.
  const daemonPort = Number((env.ELOWEN_PORT) ?? DAEMON_PORT);
  const webPort = Number((env.ELOWEN_WEB_PORT) ?? WEB_PORT);
  const childEnv = { ...env, ELOWEN_DB: dbPath(env), ELOWEN_LOG_DIR: logDir(env), ELOWEN_AUTOSTART: '0' };

  const launch = (entry: string, extra: NodeJS.ProcessEnv) => {
    const child = spawn(process.execPath, [entry], { detached: true, stdio: 'ignore', env: { ...childEnv, ...extra } });
    child.unref();
    if (!child.pid) throw new Error(`failed to spawn ${entry}`);
    return child.pid;
  };

  const isTracked = deps.isTracked ?? isTrackedService;
  const existing = readState(env);
  // Adopt a tracked pid only when it is confirmably STILL our service; a stale run.json (e.g. after a
  // reboot that recycled the pid) must not adopt a stranger. But it must not blindly spawn either: with
  // nothing tracked, a port that ALREADY answers healthy is some other live process (a systemd-managed
  // instance, or a start() that raced past this one's lock) — colliding with it is worse than refusing.
  const resolvePid = async (entry: string, port: number, healthPath: string, mark: ServiceMark, extra: NodeJS.ProcessEnv): Promise<number> => {
    const tracked = mark === 'daemon' ? existing?.daemon : existing?.web;
    if (tracked && isTracked(tracked.pid, mark)) return tracked.pid;
    if (await portHealthy(fetchFn, port, healthPath)) {
      throw new Error(`:${port} already answers healthily but isn't a tracked elowen ${mark} — refusing to spawn a second one (stop the other process, or remove ${runFile(env)} if it is stale)`);
    }
    return launch(entry, extra);
  };
  // ELOWEN_SERVICE pins the service identity in the child's environment: the web's argv stops being
  // readable once Next overwrites its title (see ENV_MARK), so isTrackedService reads the marker from
  // /proc/<pid>/environ instead — and the daemon's explicit `daemon` value keeps an exported
  // ELOWEN_DAEMON_URL from ever making it read as the web.
  const daemonPid = await resolvePid(daemonEntry(), daemonPort, '/health', 'daemon', { ELOWEN_PORT: String(daemonPort), ELOWEN_SERVICE: 'daemon' });
  const webPid = await resolvePid(webServer(), webPort, '/', 'web', { PORT: String(webPort), HOSTNAME: '127.0.0.1', ELOWEN_DAEMON_URL: `http://127.0.0.1:${daemonPort}`, ELOWEN_SERVICE: 'web' });

  // Wait for BOTH services to answer — a live daemon with a dead web must not report `elowen up` as a
  // success. The web proxies the daemon, so it's polled second within the same shared budget.
  const budgetMs = attempts * pollMs;
  const [daemonHealthy = false, webHealthy = false] = await waitHealthy(
    [portUrl(daemonPort, '/health'), portUrl(webPort, '/')], { budgetMs, pollMs, fetchFn },
  );

  // Record state even on failure so `elowen down`/`status` can see and clean up the spawned pids.
  const state: RunState = { daemon: { pid: daemonPid, port: daemonPort }, web: { pid: webPid, port: webPort }, version: deps.version, startedAt: now() };
  writeState(env, state);
  // But never report success when a service never answered: a wedged or crash-looping daemon (or a web
  // that failed to boot behind a healthy daemon) would otherwise be written as "elowen is up". Surface it
  // so the operator knows to check the logs.
  const budget = Math.round(budgetMs / 1000);
  if (!daemonHealthy) throw new Error(`elowen daemon did not become healthy on :${daemonPort} after ${budget}s — check the logs in ${logDir(env)}`);
  if (!webHealthy) throw new Error(`elowen web did not become healthy on :${webPort} after ${budget}s — check the logs in ${logDir(env)}`);
  return state;
}
