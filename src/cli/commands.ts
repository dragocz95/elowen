import { start as realStart, stop as realStop, status as realStatus, type RunState, type SvcStatus } from './launcher.js';
import { update as realUpdate, type UpdateResult } from './update.js';
import { callOrcaApi } from '../shared/apiClient.js';

/** `orca api <METHOD> <path> [jsonBody]` — generic authenticated REST passthrough. Reads
 *  ORCA_URL/ORCA_TOKEN from the env the daemon injects into every spawned agent, so an agent can
 *  drive ANY endpoint without a per-endpoint CLI command (and a new endpoint needs zero CLI edits).
 *  Injectable for tests; returns a process exit code. */
export async function runApiCommand(
  args: string[], env: NodeJS.ProcessEnv,
  deps: { call: typeof callOrcaApi; out: (s: string) => void; err: (s: string) => void },
): Promise<number> {
  const [method, path, rawBody] = args;
  if (!method || !path) { deps.err('usage: orca api <METHOD> <path> [jsonBody]'); return 2; }
  let body: unknown;
  if (rawBody !== undefined) {
    try { body = JSON.parse(rawBody); } catch { deps.err('api: body must be valid JSON'); return 2; }
  }
  const url = env.ORCA_URL ?? 'http://localhost:4400';
  const token = env.ORCA_TOKEN ?? '';
  const res = await deps.call(method, path, body, { url, token });
  deps.out(res.data !== undefined ? JSON.stringify(res.data, null, 2) : res.text);
  return res.ok ? 0 : 1;
}

/** Lifecycle command dependencies — injectable so dispatch is unit-testable without spawning. */
export interface LifecycleDeps {
  version: string;
  log: (s: string) => void;
  start: (env: NodeJS.ProcessEnv, deps: { version: string }) => Promise<RunState>;
  stop: (env: NodeJS.ProcessEnv) => Promise<void>;
  status: (env: NodeJS.ProcessEnv) => Promise<{ daemon: SvcStatus; web: SvcStatus }>;
  update: (env: NodeJS.ProcessEnv, deps: { current: string }) => Promise<UpdateResult>;
}

export function defaultLifecycleDeps(version: string): LifecycleDeps {
  return {
    version,
    log: (s) => console.log(s),
    start: realStart,
    stop: realStop,
    status: realStatus,
    update: realUpdate,
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
  return (version ? [`  orcasynth v${version}`, '', ...body] : body).join('\n');
}

/** Dispatch the install-lifecycle commands. Returns true when handled, false for anything else (the
 *  caller then falls through to the daemon-backed API CLI). Lifecycle commands manage the daemon
 *  themselves, so they deliberately skip the auto-start that the API commands use. */
export async function runLifecycle(cmd: string | undefined, env: NodeJS.ProcessEnv, deps: LifecycleDeps): Promise<boolean> {
  switch (cmd) {
    case 'up': {
      deps.log('Starting orca…');
      const s = await deps.start(env, { version: deps.version });
      deps.log(`orca is up — daemon :${s.daemon.port}, web :${s.web.port}\nOpen http://localhost:${s.web.port}`);
      return true;
    }
    case 'down': {
      await deps.stop(env);
      deps.log('orca stopped');
      return true;
    }
    case 'status': {
      deps.log(formatStatus(await deps.status(env), deps.version));
      return true;
    }
    case 'update': {
      deps.log('Checking for updates…');
      const r = await deps.update(env, { current: deps.version });
      deps.log(r.updated
        ? (r.restartDeferred ? `Installed ${r.to} — restart deferred (a mission is running); it takes over on the next restart` : `Updated ${r.from} → ${r.to}`)
        : `Already up to date (${r.to})`);
      return true;
    }
    default:
      return false;
  }
}
