import { start as realStart, stop as realStop, status as realStatus, type RunState, type SvcStatus } from './launcher.js';
import { update as realUpdate, type UpdateResult } from './update.js';
import { callElowenApi } from '../shared/apiClient.js';
import { restartServices, type RestartTarget } from './systemd.js';
import { dbPath, shutdownDrainMarker } from '../shared/paths.js';
import { writeFileSync } from 'node:fs';

/** `elowen api <METHOD> <path> [jsonBody]` — generic authenticated REST passthrough. Reads
 *  ELOWEN_URL/ELOWEN_TOKEN from the env the daemon injects into every spawned agent, so an agent can
 *  drive ANY endpoint without a per-endpoint CLI command (and a new endpoint needs zero CLI edits).
 *  Injectable for tests; returns a process exit code. */
export async function runApiCommand(
  args: string[], env: NodeJS.ProcessEnv,
  deps: { call: typeof callElowenApi; out: (s: string) => void; err: (s: string) => void },
): Promise<number> {
  const [method, path, rawBody] = args;
  if (!method || !path) { deps.err('usage: elowen api <METHOD> <path> [jsonBody]'); return 2; }
  let body: unknown;
  if (rawBody !== undefined) {
    try { body = JSON.parse(rawBody); } catch { deps.err('api: body must be valid JSON'); return 2; }
  }
  const url = (env.ELOWEN_URL) ?? 'http://localhost:4400';
  const token = (env.ELOWEN_TOKEN) ?? '';
  const res = await deps.call(method, path, body, { url, token });
  deps.out(res.data !== undefined ? JSON.stringify(res.data, null, 2) : res.text);
  return res.ok ? 0 : 1;
}

/** Lifecycle command dependencies — injectable so dispatch is unit-testable without spawning. */
export interface LifecycleDeps {
  version: string;
  log: (s: string) => void;
  start: (env: NodeJS.ProcessEnv, deps: { version: string }) => Promise<RunState>;
  stop: (env: NodeJS.ProcessEnv, opts?: { force?: boolean }) => Promise<void>;
  status: (env: NodeJS.ProcessEnv) => Promise<{ daemon: SvcStatus; web: SvcStatus }>;
  update: (env: NodeJS.ProcessEnv, deps: { current: string }) => Promise<UpdateResult>;
  restart: (target: RestartTarget) => Promise<void>;
  /** Drop the one-shot marker the daemon's SIGTERM handler consumes to choose a step-boundary drain over
   *  the default pause (see daemon/shutdown.ts). Injectable so dispatch stays unit-testable. */
  requestDrain?: (env: NodeJS.ProcessEnv) => void;
}

export function defaultLifecycleDeps(version: string): LifecycleDeps {
  return {
    version,
    log: (s) => console.log(s),
    start: realStart,
    stop: realStop,
    status: realStatus,
    update: realUpdate,
    restart: async (target) => {
      const result = await restartServices(target);
      if (result.code !== 0) throw new Error(`restart failed (code ${result.code})`);
    },
    requestDrain: (env) => { writeFileSync(shutdownDrainMarker(dbPath(env)), String(Date.now())); },
  };
}

/** Render a one-glance status block. A service is shown stopped, running-but-unhealthy, or healthy.
 *  When `version` is given, a header line is prepended. */
export function formatStatus(s: { daemon: SvcStatus; web: SvcStatus }, version?: string): string {
  const line = (name: string, svc: SvcStatus, url: string): string => {
    if (!svc.running) return `  ${name.padEnd(7)} ○  stopped`;
    const dot = svc.healthy ? '●' : '◐';
    const health = svc.healthy ? 'healthy' : 'starting…';
    return `  ${name.padEnd(7)} ${dot}  running  :${svc.port}  ${health}${svc.healthy && url ? `  ${url}` : ''}`.trimEnd();
  };
  const body = [line('daemon', s.daemon, ''), line('web', s.web, `http://localhost:${s.web.port || 4500}`)];
  return (version ? [`  elowen v${version}`, '', ...body] : body).join('\n');
}

/** Dispatch the install-lifecycle commands. Returns true when handled, false for anything else (the
 *  caller then falls through to the daemon-backed API CLI). Lifecycle commands manage the daemon
 *  themselves, so they deliberately skip the auto-start that the API commands use. */
export async function runLifecycle(
  cmd: string | undefined, env: NodeJS.ProcessEnv, deps: LifecycleDeps,
  /** The remaining argv, for the flags a lifecycle verb accepts (`down --force`). */
  argv: readonly string[] = [],
): Promise<boolean> {
  switch (cmd) {
    case 'up': {
      deps.log('Starting elowen…');
      const s = await deps.start(env, { version: deps.version });
      deps.log(`elowen is up — daemon :${s.daemon.port}, web :${s.web.port}\nOpen http://localhost:${s.web.port}`);
      return true;
    }
    case 'down': {
      const force = argv.includes('--force') || argv.includes('-f');
      if (!force) deps.log('Stopping elowen — checkpointing running turns (--force to kill now)…');
      await deps.stop(env, { force });
      deps.log('elowen stopped');
      return true;
    }
    case 'status': {
      deps.log(formatStatus(await deps.status(env), deps.version));
      return true;
    }
    case 'update': {
      deps.log('Checking for updates…');
      const r = await deps.update(env, { current: deps.version });
      deps.log(r.updated ? `Updated ${r.from} → ${r.to}` : `Already up to date (${r.to})`);
      return true;
    }
    case 'restart': {
      // `--drain` asks the daemon to finish the current step of every running turn before exiting (up to
      // ten minutes) instead of the default pause-and-resume; it only means something for the daemon.
      const drain = argv.includes('--drain');
      const rest = [...argv].filter((arg) => arg !== '--drain');
      const target = rest[0];
      if (rest.length !== 1 || (target !== 'daemon' && target !== 'web' && target !== 'all')) {
        throw new Error('usage: elowen restart <daemon|web|all> [--drain]');
      }
      if (drain && target !== 'web') deps.requestDrain?.(env);
      await deps.restart(target);
      deps.log(`Restart queued: ${target}${drain && target !== 'web' ? ' (draining running work first)' : ''}`);
      return true;
    }
    default:
      return false;
  }
}
