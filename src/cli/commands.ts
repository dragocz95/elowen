import { start as realStart, stop as realStop, status as realStatus, type RunState, type SvcStatus } from './launcher.js';
import { update as realUpdate, type UpdateResult } from './update.js';

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

/** Render a one-glance status block. A service is shown stopped, running-but-unhealthy, or healthy. */
export function formatStatus(s: { daemon: SvcStatus; web: SvcStatus }): string {
  const line = (name: string, svc: SvcStatus, url: string): string => {
    if (!svc.running) return `  ${name.padEnd(7)} ○ stopped`;
    const dot = svc.healthy ? '●' : '◐';
    const health = svc.healthy ? 'healthy' : 'starting…';
    return `  ${name.padEnd(7)} ${dot} running  :${svc.port}  ${health}  ${svc.healthy ? url : ''}`.trimEnd();
  };
  return [line('daemon', s.daemon, ''), line('web', s.web, 'http://localhost:4500')].join('\n');
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
      deps.log(formatStatus(await deps.status(env)));
      return true;
    }
    case 'update': {
      deps.log('Checking for updates…');
      const r = await deps.update(env, { current: deps.version });
      deps.log(r.updated ? `Updated ${r.from} → ${r.to}` : `Already up to date (${r.to})`);
      return true;
    }
    default:
      return false;
  }
}
