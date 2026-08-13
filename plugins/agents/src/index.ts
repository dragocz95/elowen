/** agents — the tmux-agent + missions subsystem as a plugin (plugin-platform F2).
 *
 *  The entry composes buildAgentsRuntime (runtime.ts) from the ctx seams and registers the host
 *  lifecycle: boot reconciles, the deriver service, the interval sweeps (original core periods) and
 *  the 'missions' control the daemon routes/services/advisor drive. Runtime reach comes exclusively
 *  through the PluginContext (ctx.host.*, ctx.db(), ctx.publishEvent(), …); imports from the daemon's
 *  src/ are TYPE-ONLY and erase at compile time, so the built plugin has no runtime dependency on the
 *  daemon's module graph.
 *
 *  Construction is LAZY on purpose: register() only registers, and the first accessor/tick/reconcile
 *  builds the runtime. A sub-agent runner loads this plugin too (same enabled list) but never starts
 *  plugin services and never calls the control, so it never assembles a second mission engine or
 *  attaches the push/usage bus subscribers beside the daemon's.
 */
import type { MissionsDomainControl, PluginContext } from '../../../src/plugins/api.js';
import type { ElowenEvent } from '../../../src/api/sse.js';
import { AGENTS_MIGRATIONS } from './store/migrations.js';
import { agentsEventRow } from './events/rows.js';
import { buildAgentsRuntime, AGENTS_INTERVAL_MS, type AgentsRuntime } from './runtime.js';
import { registerMissionsApi } from './api/missions.js';
import { registerSessionsApi } from './api/sessions.js';
import { registerAsksApi } from './api/asks.js';
import { registerApproveGateApi } from './api/approveGate.js';
import { registerNotesApi } from './api/notes.js';
import { registerSkillsApi } from './api/skills.js';
import { registerAdvisorApi } from './api/advisor.js';
import { stripPrefix } from './lib/text.js';
import { AGENTS_PROMPTS, AGENTS_PROMPTS_DIR } from './promptCatalog.js';
import { registerAgentsTools } from './tools.js';
import { AGENTS_MCP_TOOLS } from './mcpTools.js';
import { agentsPluginConfig } from './config.js';
import { logger, setBaseLogger } from './lib/logger.js';
import { detectClis } from './lib/cliDetection.js';
import { MISSIONS_WITHOUT_TASKS, TaskDomainUnavailableError, gateRoutesOnTaskDomain } from './lib/taskDomain.js';

export function register(ctx: PluginContext): void {
  // Logging first: every subsystem module logs through lib/logger's scoped facade, which delegates to
  // the plugin-scoped host logger — so the lines reach the daemon log AND the admin per-plugin
  // log/health ring (`[plugin:agents] [deriver] …`). See lib/logger.ts for why this replaced a copy.
  setBaseLogger(ctx.logger);

  // Schema first: grandfathered tables (see store/migrations.ts). In the daemon this applies pending
  // steps exactly once; in the sub-agent runner ctx.db().migrate() is a logged no-op by design.
  ctx.db().migrate(AGENTS_MIGRATIONS);

  // The subsystem's prompt templates (worker*, agent-guide*, pilot, overseer, code-review, decision-*).
  // Bare names — a user's pre-extraction `user_prompts` override still wins over these files.
  ctx.registerPrompts({ dir: AGENTS_PROMPTS_DIR, entries: AGENTS_PROMPTS });

  // The runtime's own lines (sweeps, resume capture, …) under their own scope tag.
  const log = logger('runtime');

  // This subsystem is BUILT ON the task domain (§missions are epics with phases), which a sibling plugin
  // owns. Resolved per call, never cached: a plugin reload can hand the domain to another owner or take
  // it away, and a captured answer would keep a dead generation alive.
  const tasksAvailable = (): boolean => ctx.host.stores().tasksAvailable();
  // Sweeps tick every 30-90s. Without the domain they must be quiet no-ops, not a warning per tick and
  // certainly not a throw per tick — so the reason is stated ONCE per loaded generation (a reload builds
  // a new closure and says it again, which is exactly when it is news).
  let idleWarned = false;
  const idleWithoutTasks = (): boolean => {
    if (tasksAvailable()) return false;
    if (!idleWarned) {
      idleWarned = true;
      log.warn(`${MISSIONS_WITHOUT_TASKS} — the mission engine, scheduler, deriver and sweeps stay idle`);
    }
    return true;
  };

  let runtime: AgentsRuntime | null = null;
  const rt = (): AgentsRuntime => {
    // Fail closed BEFORE construction: the runtime's stores include the task store, so building it
    // without an owner would throw somewhere inside a service instead of at this seam.
    if (!tasksAvailable()) throw new TaskDomainUnavailableError();
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
          // Host usersRead rows adapted to the is_admin shape the push dispatcher/engine read; the
          // per-user exec allow-list feeds planFlow's pilot/overseer override validation.
          users: {
            list: () => stores.usersRead.list().map((u) => ({ id: u.id, is_admin: u.isAdmin })),
            allowedExecs: (id) => stores.usersRead.allowedExecs(id),
          },
        },
        prompts: ctx.host.prompts(),
        config: ctx.host.config(),
        // The plugin's own config slice (plugins.config.agents), resolved per read with the live
        // autopilot values as fallback — a key the slice lacks behaves exactly as pre-extraction.
        pluginConfig: () => agentsPluginConfig(ctx.config, ctx.host.config()),
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
        homeProjectId: stores.homeProject().id,
        // Wired by bootstrap AFTER load (like brainWorker/push) — resolve per use, absent in the runner.
        advisorHost: () => { try { return ctx.host.advisor(); } catch { return undefined; } },
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
    start: () => { if (!idleWithoutTasks()) stopDeriver = rt().deriver.start(); },
    stop: () => { stopDeriver?.(); stopDeriver = null; },
  });

  // Boot reconciles (idempotent; re-run on plugin reload): zombie in_progress tasks whose session died
  // with the daemon, and re-parking/orphan-killing the per-mission overseers. Both reconcile TASK state,
  // so without the domain there is nothing to reconcile — skip rather than fail the boot sequence.
  ctx.registerBootReconcile(() => { if (!idleWithoutTasks()) rt().reconcileZombies(); });
  ctx.registerBootReconcile(() => { if (!idleWithoutTasks()) rt().reconcileOverseers(); });

  // The interval sweeps, with the original bootstrap periods (AGENTS_INTERVAL_MS — the same map the
  // runtime builds its definitions from, so the two cannot drift). Each tick resolves its fn by name
  // off the live runtime, keeping registration construction-free.
  for (const [name, ms] of Object.entries(AGENTS_INTERVAL_MS)) {
    ctx.registerInterval(name, () => { if (!idleWithoutTasks()) rt().intervals.find((i) => i.name === name)?.fn(); }, ms);
  }

  // Tenancy for the subsystem's own events — the SOLE source since the core copies were deleted:
  // with the plugin disabled, signal/plan events resolve null and record admin-only.
  // `signal` needs only the task store (an agent session is its `agent:<name>` label), so it must not
  // force runtime construction; `plan` jobs live in the runtime's PlanJobStore — no runtime, no jobs.
  ctx.registerEventProjectResolver((e: ElowenEvent) => {
    if (e.type === 'signal') {
      // No task domain, no way to attribute a session to a project: null records the event admin-only,
      // which is the fail-closed answer. (A throw here is caught and treated as null too, but then the
      // reason is a stack trace in the log rather than a decision.)
      if (!tasksAvailable()) return null;
      const name = stripPrefix(e.session, 'elowen-');
      const matches = ctx.host.stores().tasks.list().filter((t) => t.labels.includes(`agent:${name}`));
      return matches[matches.length - 1]?.project_id ?? null;
    }
    if (e.type === 'plan') return runtime?.planJobs.get(e.jobId)?.projectId ?? null;
    return null;
  });

  // Persistence for the subsystem's own events (mission/review/decision/message/signal) — the pure
  // mapping lives in events/rows.ts; with the plugin disabled these events are not persisted
  // (matching the rest of the degradation).
  ctx.registerEventRowResolver(agentsEventRow);

  // First-run readiness: the 'missions' row of GET /system/readiness (extracted with the subsystem —
  // with the plugin disabled the row disappears, which is the honest onboarding answer). The
  // planner/overseer need either the OpenAI-compatible relay or a configured pilot CLI.
  ctx.registerReadinessCheck(() => {
    const cfg = ctx.host.config();
    // A credential cannot make missions ready while the domain they are made of is switched off — the
    // onboarding row must say what is actually missing, not offer to configure a relay that changes
    // nothing.
    if (!tasksAvailable()) {
      return {
        id: 'missions', label: 'Missions', ok: false, detail: 'task tracking is disabled',
        hint: 'Missions are built on tasks. Enable the plugin that provides task tracking first.',
      };
    }
    const relay = cfg.autopilotRelay();
    const pilotExec = agentsPluginConfig(ctx.config, cfg).pilotExec;
    const ok = relay != null || pilotExec.length > 0;
    return {
      id: 'missions', label: 'Missions', ok,
      detail: relay ? 'relay configured' : (pilotExec || 'not set'),
      ...(ok ? {} : { hint: 'Missions need an OpenAI-compatible key or an installed agent CLI.' }),
    };
  });

  // The grandfathered '/missions' + '/sessions' + '/notes' API surfaces (root-mounted; declared in
  // the manifest, so a disabled plugin answers the explicit 503 instead of a bare 404).
  //
  // Every one of them drives the runtime, so they are registered through the task-domain gate: with the
  // domain unowned they answer 503 with the reason instead of a 500 from a construction that cannot
  // succeed. `/system/skills` is deliberately NOT gated — it reads skill files and owes nothing to tasks.
  const gated = gateRoutesOnTaskDomain(ctx, tasksAvailable);
  registerMissionsApi(gated, rt);
  registerSessionsApi(gated, rt);
  registerAsksApi(gated, rt);
  registerApproveGateApi(gated, rt);
  registerNotesApi(gated, rt);
  registerAdvisorApi(gated, rt);
  registerSkillsApi(ctx);

  // The subsystem's brain tools (owner-chat gated at execute time; gone while the plugin is disabled).
  registerAgentsTools(ctx, rt);

  // The agents tools of the daemon's OWN /mcp server (missions/sessions/notes — every route they
  // proxy is a plugin root mount above). Pure REST-proxy declarations: registering them never builds
  // the runtime, and with the plugin disabled they vanish from tools/list.
  for (const tool of AGENTS_MCP_TOOLS) ctx.registerMcpTool(tool);

  // The control surface the daemon routes/services/advisor drive (deps getters resolve it live from
  // the loaded registry). Keyed by the DOMAIN it implements, never by this plugin's name: consumers ask
  // for `missions` and stay correct if the implementing plugin is renamed or replaced. Accessor methods
  // so the registry's function-shape narrowing applies and so the first call is what builds the runtime.
  ctx.registerControl('missions', {
    engine: () => rt().engine,
    spawn: () => rt().spawn,
    planFlow: () => rt().planFlow,
    planJobs: () => rt().planJobs,
    decisionQueue: () => rt().decisionQueue,
    missionGit: () => rt().missionGit,
    agents: () => rt().agents,
    gitLock: () => rt().gitLock,
    missions: () => rt().missions,
    liveTaskUsage: () => rt().liveTaskUsage,
    // The post-done review gate the core close path awaits (gate → verdict → commit/release). A direct
    // method, not an accessor: the call IS the operation, and core must await its gating writes.
    onTaskClosed: (id, existing, opts) => rt().review.onTaskClosed(id, existing, opts),
    // Core still drives login autostart and user-deletion teardown; absent collaborators (runner,
    // minimal tests) degrade to no-ops so a login can never fail on the advisor.
    advisor: () => ({
      ensureOnLogin: async (userId: number) => { await rt().advisor()?.ensureOnLogin(userId); },
      stop: async (userId: number) => { await rt().advisor()?.stop(userId); },
    }),
    // Static — probing the agent CLIs' presence must not construct the runtime.
    detectClis: () => detectClis,
    // Declared dependency: while no plugin owns the `tasks` domain this control does not resolve at all,
    // so core sees exactly what it sees when this plugin is disabled — mission reads degrade, mission
    // routes answer 503, the login advisor hook is skipped — instead of every accessor throwing into a
    // caller that was never taught a second failure mode.
  } satisfies MissionsDomainControl, { requires: 'tasks' });

  ctx.logger.info('agents plugin loaded (runtime lazy; engine/scheduler/deriver via host services)');
}
