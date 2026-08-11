/** agents — the tmux-agent + missions subsystem as a plugin (plugin-platform F2).
 *
 *  The entry composes buildAgentsRuntime (runtime.ts) from the ctx seams and registers the host
 *  lifecycle: boot reconciles, the deriver service, the interval sweeps (original core periods) and
 *  the 'agents' control the daemon routes/services/advisor drive. Runtime reach comes exclusively
 *  through the PluginContext (ctx.host.*, ctx.db(), ctx.publishEvent(), …); imports from the daemon's
 *  src/ are TYPE-ONLY and erase at compile time, so the built plugin has no runtime dependency on the
 *  daemon's module graph.
 *
 *  Construction is LAZY on purpose: register() only registers, and the first accessor/tick/reconcile
 *  builds the runtime. A sub-agent runner loads this plugin too (same enabled list) but never starts
 *  plugin services and never calls the control, so it never assembles a second mission engine or
 *  attaches the push/usage bus subscribers beside the daemon's.
 */
import type { AgentsControl, PluginContext } from '../../../src/plugins/api.js';
import type { ElowenEvent } from '../../../src/api/sse.js';
import { AGENTS_MIGRATIONS } from './store/migrations.js';
import { buildAgentsRuntime, AGENTS_INTERVAL_MS, type AgentsRuntime } from './runtime.js';
import { stripPrefix } from './lib/text.js';
import type { Logger } from './lib/logger.js';

export function register(ctx: PluginContext): void {
  // Schema first: grandfathered tables (see store/migrations.ts). In the daemon this applies pending
  // steps exactly once; in the sub-agent runner ctx.db().migrate() is a logged no-op by design.
  ctx.db().migrate(AGENTS_MIGRATIONS);

  // The subsystem logs through the plugin-scoped host logger, so its lines land in the daemon log AND
  // the admin per-plugin log/health views (`[plugin:agents] …`). The host logger has no debug level or
  // structured extra, so debug drops and the extra is appended as text.
  const withExtra = (m: string, extra?: unknown) => (extra === undefined ? m : `${m} — ${String(extra)}`);
  const log: Logger = {
    debug: () => { /* the host plugin logger has no debug channel */ },
    info: (m, extra) => ctx.logger.info(withExtra(m, extra)),
    warn: (m, extra) => ctx.logger.warn(withExtra(m, extra)),
    error: (m, extra) => ctx.logger.error(withExtra(m, extra)),
  };

  let runtime: AgentsRuntime | null = null;
  const rt = (): AgentsRuntime => {
    if (!runtime) {
      const stores = ctx.host.stores();
      runtime = buildAgentsRuntime({
        tmux: ctx.host.tmux(),
        db: ctx.db(),
        stores: {
          tasks: stores.tasks,
          projects: stores.projects,
          readiness: stores.readiness,
          taskUsage: stores.taskUsage,
          // Host usersRead rows adapted to the is_admin shape the push dispatcher/engine read.
          users: { list: () => stores.usersRead.list().map((u) => ({ id: u.id, is_admin: u.isAdmin })) },
        },
        prompts: ctx.host.prompts(),
        config: ctx.host.config(),
        relayClient: (cfg) => ctx.host.relayClient(cfg),
        git: ctx.host.git(),
        elowenCli: ctx.host.elowenCli(),
        // Late-resolved embedded worker executor: bootstrap wires it AFTER the plugin loads
        // (setPluginHostBrainWorker), so resolve per launch and report "not yet wired" as undefined —
        // an `elowen:` exec launched before that fails exactly like the core's unattached spawn.
        brainWorker: () => { try { return ctx.host.brainWorker(); } catch { return undefined; } },
        publishEvent: (e) => ctx.publishEvent(e),
        subscribeEvents: (fn) => ctx.subscribeEvents(fn),
        // Push transport resolves per send: bootstrap wires setPluginHostPush after the plugin loads.
        push: { sendToUsers: (userIds, payload) => ctx.host.push().sendToUsers(userIds, payload) },
        homeProjectPath: stores.homeProject().path,
        log,
      });
    }
    return runtime;
  };

  // Teardown FIRST so PluginServiceRunner.stopAll (newest-first) runs it LAST — after the loops above
  // it have stopped. Disposes the bus subscribers (push dispatch + usage recorder; the registry also
  // detaches ctx.subscribeEvents handlers on reload, dispose is idempotent) and drops the instance so
  // a reloaded generation rebuilds a fresh runtime instead of resurrecting stale closures.
  ctx.registerService({
    name: 'runtime-teardown',
    start: () => { /* construction is lazy — nothing to start */ },
    stop: () => { runtime?.dispose(); runtime = null; },
  });

  // The deriver's own 5s loop (pane polling → signals). start() builds the runtime on a full daemon
  // start; a runner never starts services, so the loop (and the runtime) never exist there.
  let stopDeriver: (() => void) | null = null;
  ctx.registerService({
    name: 'deriver',
    start: () => { stopDeriver = rt().deriver.start(); },
    stop: () => { stopDeriver?.(); stopDeriver = null; },
  });

  // Boot reconciles (idempotent; re-run on plugin reload): zombie in_progress tasks whose session died
  // with the daemon, and re-parking/orphan-killing the per-mission overseers.
  ctx.registerBootReconcile(() => rt().reconcileZombies());
  ctx.registerBootReconcile(() => rt().reconcileOverseers());

  // The interval sweeps, with the original bootstrap periods (AGENTS_INTERVAL_MS — the same map the
  // runtime builds its definitions from, so the two cannot drift). Each tick resolves its fn by name
  // off the live runtime, keeping registration construction-free.
  for (const [name, ms] of Object.entries(AGENTS_INTERVAL_MS)) {
    ctx.registerInterval(name, () => { rt().intervals.find((i) => i.name === name)?.fn(); }, ms);
  }

  // Tenancy for the subsystem's own events. Coexists with the core resolvers while the bootstrap
  // wiring's taskForSession survives in core (plugin resolvers run only when core yields null);
  // becomes the sole source once the core copies are deleted (B2b part 2).
  // `signal` needs only the task store (an agent session is its `agent:<name>` label), so it must not
  // force runtime construction; `plan` jobs live in the runtime's PlanJobStore — no runtime, no jobs.
  ctx.registerEventProjectResolver((e: ElowenEvent) => {
    if (e.type === 'signal') {
      const name = stripPrefix(e.session, 'elowen-');
      const matches = ctx.host.stores().tasks.list().filter((t) => t.labels.includes(`agent:${name}`));
      return matches[matches.length - 1]?.project_id ?? null;
    }
    if (e.type === 'plan') return runtime?.planJobs.get(e.jobId)?.projectId ?? null;
    return null;
  });

  // The control surface the daemon routes/services/advisor drive (deps getters resolve it live from
  // the loaded registry). Accessor methods so the registry's function-shape narrowing applies and so
  // the first call is what builds the runtime.
  ctx.registerControl('agents', {
    engine: () => rt().engine,
    spawn: () => rt().spawn,
    pilot: () => rt().pilot,
    planJobs: () => rt().planJobs,
    decisionQueue: () => rt().decisionQueue,
    missionGit: () => rt().missionGit,
    agents: () => rt().agents,
    gitLock: () => rt().gitLock,
    missions: () => rt().missions,
    notes: () => rt().notes,
  } satisfies AgentsControl);

  ctx.logger.info('agents plugin loaded (runtime lazy; engine/scheduler/deriver via host services)');
}
