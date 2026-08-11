import { eventProjectId, type EventProjectDeps } from '../api/eventProject.js';
import { createServer } from '../api/server.js';
import { ELOWEN_VERSION } from '../api/version.js';
import { createSkillService } from '../api/services/skillService.js';
import { createTicketStore } from '../terminal/ticketStore.js';
import { RealTmuxDriver } from '../tmux/driver.js';
import { SystemClock } from '../shared/clock.js';
import { ensureVapidKeys } from '../push/vapid.js';
import { PushSender } from '../push/pushSender.js';
import { buildTurnDone } from '../push/messages.js';
import type { TmuxDriver } from '../tmux/types.js';
import { lifecycleNotice } from './lifecycleNotices.js';
import { logger, setLogSink } from '../shared/logger.js';
import { PluginLogBuffer } from '../shared/logBuffer.js';
import { AdvisorService } from '../advisor/service.js';
import { writeMcpConfig } from '../advisor/mcpConfig.js';
import type { BrainService } from '../brain/brainService.js';
import { BrainTerminalService } from '../brain/terminalService.js';
import { processRegistry } from '../brain/processRegistry.js';
import { isSubagentSession } from '../brain/sessionId.js';
import type { MemoryStore } from '../store/memoryStore.js';
import { USAGE_HISTORY_DAYS } from '../store/memoryStore.js';
import { isEvictable, vitality, type MemoryRetentionConfig } from '../brain/memoryVitality.js';
import { sweepChatImages } from '../brain/chatImages.js';
import { discoverPlugins } from '../plugins/loader.js';
import { MarketplaceService } from '../plugins/marketplace.js';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { systemctl } from '../cli/systemd.js';
import { BrainWorkerService } from '../brain/worker/brainWorker.js';
import { buildBrainCore } from './brainCore.js';
import { SubagentRunnerPool } from '../subagent/pool.js';
import { resolvePoolMax } from '../subagent/sizing.js';
import type { RuntimeConfig } from '../shared/wireContract.js';
import type { PluginRegistryProvider } from '../plugins/pluginsProvider.js';
import type { PluginRegistry } from '../plugins/registry.js';
import { WORKFLOW_ADD_NODES_RPC, type HostRpcHandler } from '../subagent/hostRpc.js';

const log = logger('daemon');

/** Daemon endpoint for reverse workflow expansion, split out so the post-await liveness fence is testable. */
export function createWorkflowHostRpc(resolvePlugins: () => Promise<PluginRegistry | undefined>): HostRpcHandler {
  return async (caller, request) => {
    if (request.method !== WORKFLOW_ADD_NODES_RPC) throw new Error(`unsupported host RPC: ${request.method}`);
    const workflow = (await resolvePlugins())?.control('workflow');
    if (!workflow) throw new Error('the workflow engine is unavailable in the daemon');
    // Registry loading is asynchronous. A result/error/abort can retire the runner turn while it waits;
    // recheck immediately before the synchronous mutation so expired authority cannot add late nodes.
    if (!caller.isActive()) throw new Error('the host RPC caller turn is no longer active');
    return workflow.addNodesFromSession({
      callerSessionId: caller.sessionId,
      callerAccess: caller.access,
      ...(caller.model ? { callerModel: caller.model } : {}),
      workflowId: request.workflowId,
      nodes: request.nodes,
    });
  };
}

const MEMORY_EVICTION_BATCH_SIZE = 1_000;

export interface MemoryEvictionSweepDeps {
  memories: Pick<MemoryStore, 'listActiveForEviction' | 'softDelete'>;
  users: { list(): Iterable<{ id: number }> };
  retention: () => MemoryRetentionConfig;
  now: () => number;
}

/** Soft-delete low-vitality active memories while retaining an auditable, restorable trail. */
export function runMemoryEvictionSweep(deps: MemoryEvictionSweepDeps): number {
  const retention = deps.retention();
  if (!retention.enabled) return 0;

  const now = deps.now();
  let removed = 0;
  for (const user of deps.users.list()) {
    for (const memory of deps.memories.listActiveForEviction(user.id, MEMORY_EVICTION_BATCH_SIZE)) {
      if (!isEvictable(memory, retention, now)) continue;
      const score = vitality(memory, retention, now);
      const reason = `auto-evict: vitality ${score.toFixed(2)} < ${retention.vitalityFloor}`;
      if (deps.memories.softDelete(user.id, memory.id, 'daemon', reason)) removed += 1;
    }
  }
  return removed;
}

// Bounded ring of recent log lines, installed as the logger's single sink so it captures every
// emitted line (including plugin output prefixed `[plugin:<name>]` and `plugin skipped: <name>`).
// Feeds the admin per-plugin logs + health views. Best-effort: a full ring just evicts its oldest.
const pluginLogs = new PluginLogBuffer();
setLogSink(pluginLogs);

/** A boot announced less than this ago suppresses the next one, so a crash-looping daemon reports the
 *  first restart and then goes quiet instead of flooding the channel. Deliberately longer than systemd's
 *  RestartSec and far shorter than any plausible gap between two real deploys. */
const BOOT_ANNOUNCE_DEBOUNCE_MS = 60_000;

/** How long a shutdown waits for running work to finish before exiting anyway.
 *
 *  Ten minutes, because the work being waited for is a MODEL TURN: an agent thinking, or a sub-agent
 *  researching, routinely runs for minutes, and the first version's 60s cut one off and lost its result.
 *  A budget shorter than the work it is protecting is not a graceful shutdown, just a delayed kill.
 *
 *  MUST stay below the unit's TimeoutStopSec (set to 11 minutes in systemdUnits.ts), because when that
 *  expires systemd sends SIGKILL — the exact outcome this drain exists to prevent. The two numbers are a
 *  pair: raising this one without raising the unit's just moves the kill earlier. `elowen down` waits
 *  longer still, so it observes the exit rather than timing out on it, and `--force` is the way out for
 *  anyone who cannot wait. */
const SHUTDOWN_DRAIN_MS = 600_000;
const SHUTDOWN_POLL_MS = 500;

/** Once the platforms are back up, announce that the daemon is running — for EVERY boot, not just a
 *  user-triggered `/restart`. A deploy, a crash and a host reboot all bring the daemon back without anyone
 *  being told, and the unattended restart is precisely the one worth hearing about.
 *
 *  The wording distinguishes the two, because they answer different questions: after `/restart` the
 *  operator is waiting for a confirmation, while an unexpected boot needs to say WHICH build came up.
 *
 *  The `/restart` marker holds the request timestamp and is honoured only while RECENT — a stale marker
 *  (a failed restart whose cleanup never ran) must not make a later boot claim to be that restart. It is
 *  always cleared, so it can only ever be read once.
 *
 *  A user-triggered restart bypasses the crash-loop debounce: it was explicitly asked for, so it is
 *  confirmed however soon it follows another boot. Best-effort throughout — an announcement failure must
 *  never affect startup. Silent without a state dir (the `:memory:` test daemon), which also keeps the
 *  test suite from posting to real channels. */
/** Drain and exit on SIGTERM/SIGINT instead of dying where we stand.
 *
 *  The daemon had NO signal handler, so a deploy's `systemctl restart` killed it at whatever instruction
 *  it happened to be executing: a turn mid-stream, a sub-agent mid-task, both simply gone. This waits for
 *  the work to finish first, and says so on the platforms — the stop is the half nobody was told about,
 *  since only the following boot ever announced itself.
 *
 *  A SECOND signal exits immediately. Someone sending it twice is telling us they are not waiting, and
 *  that is also the escape hatch if the drain itself ever wedges. `elowen down --force` skips straight to
 *  SIGKILL and never reaches this code at all.
 *
 *  Handlers registered once, at boot. Exit code 0 throughout: a drained shutdown is a clean one, and
 *  `Restart=on-failure` must not read a deliberate stop as a crash to bounce back from. */
export function installGracefulShutdown(
  brain: BrainService | undefined,
  log: { info: (m: string) => void; error: (m: string, e?: unknown) => void },
  opts?: { drainMs?: number; pollMs?: number; exit?: (code: number) => never; notify?: boolean },
): void {
  const drainMs = opts?.drainMs ?? SHUTDOWN_DRAIN_MS;
  const pollMs = opts?.pollMs ?? SHUTDOWN_POLL_MS;
  const exit = opts?.exit ?? ((code: number) => process.exit(code));
  let draining = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (draining) {
      log.info(`${signal} again — exiting now, without waiting for the remaining work`);
      exit(0);
      return;
    }
    draining = true;
    // Stop admitting new turns at once, so fresh input arriving through the drain window cannot keep
    // busy() above zero for the whole budget. Existing turns, delegation and result delivery are
    // unaffected — they reach the brain through seams other than the two gated send() entries.
    brain?.beginDrain();
    void (async () => {
      const at = brain?.busy() ?? { turns: 0, children: 0, undelivered: 0 };
      const busy = at.turns > 0 || at.children > 0 || at.undelivered > 0;
      log.info(`${signal} — draining (${at.turns} turn(s), ${at.children} sub-agent(s), ${at.undelivered} undelivered result(s))`);
      if (opts?.notify !== false) {
        // Only worth a message when something is actually being waited for; an idle restart already
        // announces itself on the way back up, and saying it twice is noise.
        const { text, notice } = busy
          ? lifecycleNotice('stopping', at.turns, at.children, at.undelivered)
          : lifecycleNotice('stoppingIdle');
        await brain?.notify(text, undefined, notice).catch(() => { /* best-effort: never block the exit on a chat API */ });
      }
      const deadline = Date.now() + drainMs;
      for (;;) {
        const now = brain?.busy() ?? { turns: 0, children: 0, undelivered: 0 };
        if (now.turns === 0 && now.children === 0 && now.undelivered === 0) break;
        if (Date.now() >= deadline) {
          log.error(`drain budget expired with ${now.turns} turn(s), ${now.children} sub-agent(s) and ${now.undelivered} undelivered result(s) — exiting anyway`);
          break;
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
      log.info('drained — exiting');
      exit(0);
    })();
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
}

export async function announceBoot(
  brain: BrainService | undefined,
  restartMarker: string | undefined,
  bootMarker: string | undefined,
  version: string,
): Promise<void> {
  if (!bootMarker) return;
  let requested = false;
  if (restartMarker && existsSync(restartMarker)) {
    try { requested = Date.now() - Number(readFileSync(restartMarker, 'utf8')) < 5 * 60_000; } catch { /* unreadable → treat as stale */ }
    try { unlinkSync(restartMarker); } catch { /* already gone */ }
  }
  if (!requested) {
    try {
      const last = Number(readFileSync(bootMarker, 'utf8'));
      if (Number.isFinite(last) && Date.now() - last < BOOT_ANNOUNCE_DEBOUNCE_MS) return;
    } catch { /* no previous announcement — this is the first */ }
  }
  try { writeFileSync(bootMarker, String(Date.now())); } catch { /* the guard is a nicety, not required */ }
  const { text, notice } = requested ? lifecycleNotice('backOnline') : lifecycleNotice('backOnlineVersion', version);
  await brain?.notify(text, undefined, notice).catch(() => { /* best-effort */ });
}

export interface BuildOpts {
  dbPath: string;
  project: { id: number; slug: string; path: string };
  relay: { baseUrl: string; apiKey: string; model: string } | null;
  tmux?: TmuxDriver;
  bootstrap?: { username: string; password: string } | null;
  allowOpen?: boolean;
  /** Override the plugin scan roots (bundled + user dir). Tests run from TS sources, where the default
   *  bundled-dir resolution (relative to the compiled dist layout) finds no plugins — a bootstrap test
   *  that needs the real bundled plugins passes the repo's plugins/ dir here. */
  pluginDirs?: string[];
}

export async function buildApp(opts: BuildOpts) {
  const tmux = opts.tmux ?? new RealTmuxDriver();
  // The sub-agent runner POOL. Constructed here — never inside buildBrainCore — because it is the one
  // thing a runner must NOT have: a process built without it always executes a nested delegation itself,
  // so a runner can never fork a runner. Nothing is forked until a delegated turn is dispatched AND the
  // operator's switch is on (Settings → runtime.subagentRunnerEnabled, off by default); it then grows
  // lazily up to a cap it measures off this machine. The in-memory test database has no file for a second
  // process to attach to, so it never gets one.
  //
  // The pool size knob is read through a late-bound getter: the config store is built by buildBrainCore
  // below, and the knob is only ever consulted on a delegated turn, long after that has returned.
  let runtimeConfigForPool: (() => RuntimeConfig) | undefined;
  // Same late binding, same reason: the plugin registry is built by buildBrainCore below, and this is only
  // ever read when a runner is being forked — long after that returned.
  let pluginsForPool: PluginRegistryProvider | undefined;
  const subagentRunner = opts.dbPath !== ':memory:'
    ? new SubagentRunnerPool({
      dbPath: opts.dbPath,
      project: opts.project,
      // What the daemon's OWN registry bridges right now. The mcp plugin is the single source: it holds
      // the tool definitions it registered from, so a runner registers from the same data through the same
      // code. Absent control (plugin disabled, or a registry that will not load) ⇒ no snapshot ⇒ the
      // runner connects at boot, exactly as before.
      mcpBridgeSnapshot: async () => (await pluginsForPool?.get())?.control('mcp')?.bridgeSnapshot(),
      // Reverse calls terminate in the daemon plugin instance that owns the in-memory DAG. The host has
      // already replaced all child-supplied identity with the session derived from its active turn table.
      hostRpc: createWorkflowHostRpc(async () => pluginsForPool?.get()),
      // Explicit: a delegated turn's cwd ends in `process.cwd()`, so a child forked with a different
      // one would change what the model is told about where it is running.
      cwd: process.cwd(),
      poolMax: () => resolvePoolMax(runtimeConfigForPool?.().subagentRunnerPoolMax, process.env.ELOWEN_SUBAGENT_POOL_MAX),
      // The same predicate the dispatcher routes on, so /health reports what delegated turns ACTUALLY do
      // rather than what the machine would allow them to do.
      enabled: () => runtimeConfigForPool?.().subagentRunnerEnabled === true,
    })
    : undefined;
  // Stores, plugin registry and brain services — the part of the daemon that is NOT the daemon: it holds
  // no server, no platform gateway, no scheduler and no loop, so a second process can build the identical
  // brain by calling the same factory instead of re-deriving the wiring.
  const {
    tasks, readiness, config, users, homeProject, projects, userProjects,
    pushSubscriptions, userPrompts, userSettings, prompts, taskUsage, git,
    cli, cliArgv, elowenCli, bus, events,
    avatarsDir, chatImagesDir, pluginDirs, userPluginDir, pluginDataRoot,
    brainRuntime, brainCreds, brainOauth, brainConfig, embeddings,
    brainStore, memoryStore, memoryCategoryStore, embedQueue, memoryCategorizer,
    pluginProvider, hookAudit, brain, themes, brand, loadedPlugins, setPluginHostBrainWorker, setPluginHostPush, setPluginHostTerminals,
  } = await buildBrainCore({
    dbPath: opts.dbPath,
    project: opts.project,
    tmux,
    bootstrap: opts.bootstrap,
    ...(opts.pluginDirs ? { pluginDirs: opts.pluginDirs } : {}),
    ...(subagentRunner ? { subagentRunner } : {}),
    // An owner turn finished with the device it was sent from off screen → push it to the user's phone.
    // No subscription registered ⇒ sendToUsers is a no-op, so this needs no separate enable flag. Web push
    // is a daemon transport, so the hook is passed IN: the sender is built below out of the core's own
    // stores (hence resolved on use, not on wiring) and a process without that transport just omits it.
    notifyTurnComplete: (userId, title, preview) => { void pushSender.sendToUsers([userId], buildTurnDone({ title, preview, productName: brand().productName })); },
  });
  // Close the late binding opened above the pool: from here the knob resolves against the live store,
  // so raising or zeroing it takes effect on the next delegated turn with no restart.
  runtimeConfigForPool = () => config.get().runtime;
  pluginsForPool = pluginProvider;
  ensureVapidKeys(config); // generate the web-push VAPID keypair on first boot (idempotent thereafter)
  // The tmux-agent/mission subsystem (spawn, mission engine, scheduler, deriver, overseers, PR git,
  // push dispatch, usage recorder, all its sweeps and boot reconciles) lives in the `agents` PLUGIN
  // now. The daemon reaches it through the typed 'agents' control, resolved LIVE from the loaded
  // registry on every access: undefined until the plugin loads, swapped by a plugin reload, absent
  // for good when the operator disables the plugin (routes answer 503, the CLI/web degrade).
  const agentsControl = () => loadedPlugins()?.control('agents');

  // The missions/notes TABLES belong to the agents plugin now (part 2 of the extraction deleted the
  // core store classes). Core routes/tenancy read them through these live facades: each call resolves
  // the control fresh (a plugin reload swaps the store instance), and with the plugin disabled reads
  // degrade to empty — every mission WRITE already flows through the engine and answers 503 without it.
  const missions: import('../plugins/api.js').AgentsMissions = {
    get: (id) => agentsControl()?.missions().get(id) ?? null,
    active: () => agentsControl()?.missions().active() ?? [],
    live: () => agentsControl()?.missions().live() ?? [],
    activeForEpic: (epicId) => agentsControl()?.missions().activeForEpic(epicId) ?? null,
  };

  // Phone push TRANSPORT stays core: the sender owns the device subscriptions + VAPID keys. The agents
  // plugin's dispatcher resolves recipients and hands over ids + payload through ctx.host.push().
  // Contact is read per send, so changing it in Settings reaches the next notification without a restart.
  const pushSender = new PushSender(pushSubscriptions, () => config.webPushKeys(), undefined,
    () => ({ configured: config.get().webPushContact, instanceUrl: elowenCli.url }));
  // …and the plugin host's late binding, so ctx.host.push() resolves (the agents plugin's dispatcher).
  setPluginHostPush(pushSender);

  // Persist every bus event into the activity log, stamping its owning project (resolved for ALL event
  // types, not just task/review) so the timeline can be scoped per-tenant. The event store is
  // core-owned; it keeps recording plugin-published events through the shared bus unchanged.
  // `signal`/`plan` tenancy (session→task via the agent:<name> label, plan job → its runtime record)
  // deliberately has NO core lookup here: the agents plugin's registered event resolver is the sole
  // source — with the plugin disabled those events resolve null and the rows record admin-only,
  // matching the rest of the disabled-plugin degradation.
  const eventDeps: EventProjectDeps = {
    taskProject: (id) => tasks.get(id)?.project_id ?? null,
    // Live registry read (not a snapshot): a plugin reload swaps the resolver set with it.
    pluginResolvers: () => (loadedPlugins()?.eventProjectResolvers ?? []).map((r) => r.fn),
  };
  bus.subscribe((e) => { try { events.record(e, eventProjectId(e, eventDeps)); } catch (err) { log.error('event record failed', err); } });
  // Setup mode: with no users yet the daemon is open so the onboarding page can run before login;
  // auth (in authMiddleware) re-engages automatically once the first admin is created.
  if (users.count() === 0) {
    log.warn('SETUP MODE — no users yet; the API is open until the first admin is created via onboarding');
  }
  // Per-process secret for short-lived signed avatar URLs (finding W2) — keeps the long-lived session
  // token out of <img> src query strings. Rotates on restart; links live ~5 min, so that's harmless.
  const avatarSecret = randomBytes(32).toString('hex');
  // Per-user advisor: a persistent assistant session controlling Elowen on the user's behalf. Its cwd
  // is a neutral per-user dir (alongside the DB, NOT a project checkout) so the per-program MCP config
  // never pollutes a repo. Disabled for the in-memory DB (tests build their own AdvisorService).
  const mcpUrl = `${elowenCli.url}/mcp`; // the daemon hosts the MCP server on its own /mcp route
  const advisor = opts.dbPath === ':memory:' ? undefined : new AdvisorService({
    // The launcher lives in the agents plugin — resolved per start(), so a disabled plugin yields a
    // clear "agents plugin is disabled" error while the embedded-brain advisor keeps working.
    spawn: () => agentsControl()?.spawn(), tmux, users, config, fallback: { program: 'claude-code', model: 'sonnet' },
    projectId: homeProject.id, url: elowenCli.url, mcpUrl,
    advisorDir: (id) => { const p = join(dirname(opts.dbPath), 'advisor', String(id)); mkdirSync(p, { recursive: true }); return p; },
    prepareMcp: (program, cwd, token) => writeMcpConfig(program, cwd, token, mcpUrl),
    prompts,
    advisorStyle: (id) => userSettings.cliSettings(id).advisorStyle,
    brand,
  });
  // Admin-only interactive `elowen chat` terminals bound to existing brain conversations. Its cwd is a
  // neutral per-admin scratch dir alongside the DB (never a project checkout), mirroring the advisor dir.
  // Constructed after `brain` (it needs store+users+url); the delete-conversation teardown is attached back
  // onto the brain via a late setter to avoid a constructor cycle (mirrors spawn.attachBrainWorker).
  const brainTerminal = opts.dbPath === ':memory:' ? undefined : new BrainTerminalService({
    tmux, users, store: brainStore, url: elowenCli.url, cliArgv,
    terminalDir: (id) => { const p = join(dirname(opts.dbPath), 'terminal', String(id)); mkdirSync(p, { recursive: true }); return p; },
  });
  if (brain && brainTerminal) brain.attachTerminalTeardown((userId, sessionId) => brainTerminal.stopForSession(userId, sessionId));
  // A delegated child running in the sub-agent runner can delegate FURTHER, inside that same process. The
  // abort tree, `/stop` and the shutdown gate are authoritative here, so those nested edges are mirrored
  // into this registry — and retracted wholesale if the runner dies.
  if (brain && subagentRunner) {
    subagentRunner.attachChildEdgeSink((parentSessionId, childSessionId, running) =>
      brain.mirrorRemoteChildEdge(parentSessionId, childSessionId, running));
  }
  // Wake the operator's conversation when a background command they started finishes ON ITS OWN (a killed
  // one is dropped before its close fires, so it never wakes). Delivered as an INTERNAL turn — no 'you'
  // bubble, and it runs after any in-flight turn — so a completed build/command nudges the agent instead of
  // the operator having to poke it manually. Best-effort: a wake failure is swallowed.
  // Keep the owner's live process panels (CLI + web) in step out of turn: every spawn/exit/kill pushes
  // the fresh snapshot to the owner's client streams, so a killed/finished process leaves the panel
  // without the client polling (single source of truth — no local delete on the click path).
  processRegistry.setChangeListener((sessionId) => {
    if (sessionId) brain?.broadcastProcesses(sessionId, processRegistry.listForSession(sessionId));
  });
  processRegistry.setExitListener((info, userId, sessionId) => {
    if (!brain || userId == null) return;
    // An active delegated child owns its background-process continuation inside the subagent plugin: its
    // collect loop waits for session idle and runs the same child again to collect output before
    // completing the parent result. That loop is the SOLE owner of subagent exit continuation — a second
    // daemon wake here would race and duplicate it. (Real delegate session ids are `brain-ch-subagent-*`.)
    if (sessionId != null && isSubagentSession(sessionId)) return;
    const status = info.exitCode === 0 ? 'finished successfully' : `exited (code ${info.exitCode})`;
    const text = `⚙️ Background command \`${info.command}\` ${status}. If it matters, read its output with `
      + `ProcessOutput("${info.id}") and continue; otherwise just carry on.`;
    // `systemNudge`: no 'you' bubble, dropped if the target session is already streaming, and it never
    // drives the goal loop (so a wake can't spend a goal-budget turn or mis-judge an active goal). Bound to
    // the session the command was started in — not whatever conversation is currently active.
    void brain.send({
      userId,
      text,
      mode: 'build',
      internal: { kind: 'systemNudge' },
      session: sessionId ?? undefined,
    })
      .catch(() => { /* best-effort wake */ });
  });
  // The elowen exec engine: tasks with an `elowen:` exec run on an embedded PI session instead of a
  // spawned CLI. Shares the brain's providers/auth/plugins; closes tasks through the same REST route.
  const brainWorkers = new BrainWorkerService({
    store: brainStore, tasks, bus, taskUsage, chatImagesDir,
    config: brainConfig, runtime: brainRuntime, prompts,
    url: elowenCli.url, token: elowenCli.token,
    plugins: pluginProvider, // the SAME shared registry — a plugin toggle reaches workers too
    userSettings: (userId) => userSettings.cliSettings(userId), // the task owner's auto-compact threshold
  });
  // The plugin host's late binding, so ctx.host.brainWorker() resolves from now on — the agents
  // plugin's spawn attaches through this accessor (its stuck detector and startup reconcile also read
  // the live embedded-worker sessions through it).
  setPluginHostBrainWorker(brainWorkers);
  // Single-use ticket store for the terminal WebSocket stream — shared between the authenticated
  // `POST /sessions/:name/ws-ticket` route and the daemon's `/ws/terminal` upgrade handler.
  const tickets = createTicketStore();
  // Terminal/session controls for the agents plugin's '/sessions' surface: teardown that must run
  // through the owning service (advisor autostart flag, chat-terminal token revocation), the embedded
  // brain-worker session controls, and the SAME ticket store /ws/terminal redeems.
  setPluginHostTerminals({
    advisorStop: async (userId) => { await advisor?.stop(userId); },
    chatTerminalStop: async (userId, session) => { await brainTerminal?.stop(userId, session); },
    brainWorkerLive: (session) => brainWorkers.isLive(session),
    brainWorkerAbort: async (session) => { await brainWorkers.abort(session); },
    ticketIssue: (session, userId) => tickets.issue({ session, userId }),
  });
  // The plugin marketplace: install/update/remove plugins from the curated GitHub registry into the
  // writable user plugin dir (pluginDirs[1]), applied live via the brain's plugin hot-reload. The registry
  // repo is a shallow-clone cache next to the DB; ELOWEN_PLUGIN_REGISTRY overrides the repo URL (tests).
  // The host node_modules that installed plugins symlink so their SDK imports resolve. Derived from a real
  // dependency's resolved path (robust to the dist layout) — the SAME modules the daemon itself loads, so a
  // plugin always sees the matching SDK version.
  const hostNodeModules = (() => {
    try {
      const p = createRequire(import.meta.url).resolve('typebox');
      const marker = `${sep}node_modules${sep}`;
      const i = p.lastIndexOf(marker);
      return i >= 0 ? p.slice(0, i + marker.length - 1) : undefined;
    } catch { return undefined; }
  })();
  const marketplace = new MarketplaceService({
    registryUrl: (process.env.ELOWEN_PLUGIN_REGISTRY) || undefined,
    cacheDir: join(dirname(opts.dbPath), 'marketplace'),
    userPluginsDir: userPluginDir,
    hostNodeModules,
    pluginDataRoot,
    discovered: () => discoverPlugins(pluginDirs),
    getEnabled: () => config.get().plugins.enabled,
    setEnabled: (names) => { config.update({ plugins: { enabled: names } }); },
    reload: () => brain?.reloadPlugins() ?? Promise.resolve(),
  });
  marketplace.sweep(); // clear crash debris (.staging-*/.old-*) left by an interrupted install
  // The admin-only `/restart` slash command: announce it on the platforms (Discord main channel), drop a
  // marker so the NEXT boot announces "back online", then hand off to systemd. Runs in prod only (a
  // :memory: test DB has no config dir + no units). `setTimeout` lets the HTTP response flush before the
  // process is torn down. systemctl() self-elevates via sudo when not root (www-data has passwordless).
  const restartMarker = opts.dbPath !== ':memory:' ? join(dirname(opts.dbPath), '.restart-marker') : undefined;
  // Timestamp of the last boot announcement — the crash-loop debounce in announceBoot. Same state dir,
  // and likewise absent under the in-memory test DB so the suite never announces.
  const bootMarker = opts.dbPath !== ':memory:' ? join(dirname(opts.dbPath), '.boot-announce') : undefined;
  const restartDaemon = restartMarker
    ? async (byUserId: number): Promise<void> => {
        log.info(`/restart requested by user ${byUserId}`);
        const restartingNotice = lifecycleNotice('restarting');
        await brain?.notify(restartingNotice.text, undefined, restartingNotice.notice).catch(() => { /* best-effort */ });
        // Drop the marker (timestamped) so the NEXT boot echoes "back online" — but ONLY for a restart that
        // actually takes. systemctl() resolves an exit code (never throws); on failure the daemon keeps
        // running, so we must undo the marker + tell the operator, or a future unrelated boot would falsely
        // announce recovery.
        try { writeFileSync(restartMarker, String(Date.now())); } catch { /* marker is a nicety, not required */ }
        setTimeout(() => {
          void systemctl('restart', 'elowen-daemon').then((r) => {
            if (r.code !== 0) {
              log.error(`/restart failed (systemctl exit ${r.code}): ${r.stdout.trim()}`);
              try { unlinkSync(restartMarker); } catch { /* nothing to undo */ }
              const failed = lifecycleNotice('restartFailed');
              void brain?.notify(failed.text, undefined, failed.notice).catch(() => { /* best-effort */ });
            }
            // On success this process is torn down before the promise settles — nothing more to do.
          });
        }, 800);
      }
    : undefined;
  // Late-bind the restart handler onto the brain so a platform `/restart` slash (Discord) reaches the
  // same systemd path the web/CLI command uses. Built here (needs the units + marker), wired now.
  if (brain && restartDaemon) brain.restartHandler = restartDaemon;

  // The agents-subsystem deps resolve LIVE off the loaded registry's control (getters, not values):
  // the plugin loads after this server is built and a plugin reload swaps the whole runtime, so a
  // captured instance would strand the routes on a dead generation. Absent control ⇒ undefined ⇒ the
  // routes answer 503 ("agents plugin is disabled").
  const app = createServer({
    tasks, readiness, missions, tmux, bus, events,
    get notes() { return agentsControl()?.notes(); },
    get engine() { return agentsControl()?.engine(); },
    get missionGit() { return agentsControl()?.missionGit(); },
    get gitLock() { return agentsControl()?.gitLock(); },
    get planJobs() { return agentsControl()?.planJobs(); },
    get decisionQueue() { return agentsControl()?.decisionQueue(); },
    get pilot() { return agentsControl()?.pilot(); },
    project: homeProject, fallback: { program: 'claude-code', model: 'sonnet' }, cli, clock: new SystemClock(), config, users, projects, userProjects, pushSubscriptions, userPrompts, userSettings, pluginDirs, pluginDataRoot, brainOauth, brainAuth: brainCreds, prompts, taskUsage, git, avatarsDir, avatarSecret, chatImagesDir, advisor, brain, brainTerminal, restartDaemon, brainWorkers, brainStore, memoryStore, memoryCategoryStore, memoryCategorizer, embeddings, plugins: pluginProvider, marketplace, pluginLogs, hookAudit, themes, ...(subagentRunner ? { subagentPool: () => subagentRunner.stats() } : {}),
  });

  const startLoops = () => {
    const clock = new SystemClock();
    // The agents plugin owns the subsystem's own boot reconciles (zombie tasks, overseer re-park) and
    // sweeps — they run through the plugin runner's registerBootReconcile/registerInterval hooks.
    // Restart zombies on the brain side: goals still marked 'active' whose in-memory continuation timers
    // died with the process. Pause them so nothing falsely claims to be running (the user /goal resumes).
    try { brain?.reconcileGoalsOnBoot(); } catch (e) { log.error('reconcileGoalsOnBoot failed', e); }
    // Same on the delegation side: sub-agent runs and workflow DAGs still marked 'running' whose in-memory
    // children died with the process. Synchronous and BEFORE startPlatforms, so no channel turn — and no
    // client connecting the moment the port opens — can observe (or act on) a phantom running delegation.
    try { brain?.reconcileDelegationsOnBoot(); } catch (e) { log.error('reconcileDelegationsOnBoot failed', e); }
    // One-shot: reap chat terminals + tokens orphaned while the daemon was down (tmux died / conversation
    // deleted), and kill stray `elowen-chat-*` panes with no binding. Periodic sweep is scheduled below.
    void brainTerminal?.sweep().catch((e) => log.error('brain terminal sweep failed', e));
    // Bring up plugin platform channels (Discord bot, …). Fail-open per adapter. Once they are connected,
    // announce that the daemon is up — every boot, with the wording depending on whether an operator
    // `/restart` asked for it.
    void brain?.startPlatforms(log)
      .then(() => announceBoot(brain, restartMarker, bootMarker, ELOWEN_VERSION))
      // Boot phase 2 of delegation recovery: respawn the interrupted sub-agents claimed above, now that the
      // platforms are up so their turns can actually run. After announceBoot, with its own catch, so a
      // recovery failure neither blocks the boot announcement nor is misreported as a startPlatforms error.
      .then(() => brain?.runDelegationRecovery().catch((e) => log.error('delegation recovery failed', e)))
      .catch((e) => log.error('startPlatforms failed', e));
    // Registered only once the platforms are coming up, so a stop can actually announce itself. Skipped
    // under the in-memory test DB, where installing process-wide signal handlers would leak across tests.
    if (opts.dbPath !== ':memory:') installGracefulShutdown(brain, log);
    // Self-heal the agent-workflow skill: (re)install the bundled `elowen-workflow` SKILL.md into every
    // present provider on boot. Best-effort — installAll catches its own per-provider errors and never
    // throws, so this can't block or crash startup. Covers `elowen install` (first boot) and `elowen update`
    // (restart) with one code path, always as the spawning user. Skipped under the in-memory test DB.
    if (opts.dbPath !== ':memory:') {
      const done = createSkillService().installAll().filter((r) => r.installed).map((r) => r.provider);
      if (done.length) log.info(`installed elowen-workflow skill for: ${done.join(', ')}`);
    }
    // Purge expired auth tokens hourly so the table can't grow unbounded over a long-running daemon.
    const purgeTokens = () => users?.purgeExpiredTokens(config.get().security.tokenTtlDays);
    purgeTokens();
    const stopTokenPurge = clock.setInterval(purgeTokens, 3_600_000);
    // Same for the activity timeline: every bus event is persisted (events.record), so without a
    // retention sweep the `events` table grows without bound. Drop rows past the operator's retention
    // window (Elowen AI → Runtime) hourly; read live so a change applies on the next sweep.
    const purgeEvents = () => {
      try { events.purgeOlderThan(config.get().runtime.limits.eventRetentionDays); }
      catch (e) { log.error('event purge failed', e); }
    };
    purgeEvents();
    const stopEventPurge = clock.setInterval(purgeEvents, 3_600_000);
    // Optional session retention (admin, off by default): hourly, delete each user's own idle
    // conversations older than the configured age. Skips running/active/has-running-child sessions,
    // conversations a pending cron wake-up is bound to, and the non-user channel/task shells (enforced
    // in BrainService + the store query). No-op while disabled. Async: the purge consults the plugin
    // registry (the cronjob wake-up seam), so the sweep awaits each user in turn.
    const purgeStaleSessions = async () => {
      const retention = config.get().sessionRetention;
      if (!retention.enabled || !brain || !users) return;
      try {
        let removed = 0;
        for (const user of users.list()) removed += await brain.purgeStaleSessionsForUser(user.id, retention.days);
        if (removed > 0) log.info(`session retention: removed ${removed} conversation(s) older than ${retention.days} days`);
      } catch (e) { log.error('session retention sweep failed', e); }
    };
    void purgeStaleSessions();
    const stopSessionPurge = clock.setInterval(() => void purgeStaleSessions(), 3_600_000);
    // Retention is a daily, bounded soft-delete sweep. Deleted memories remain in the trash and keep
    // their audit trail, so an operator can restore a false positive.
    const sweepMemoryRetention = () => {
      try {
        const removed = runMemoryEvictionSweep({
          memories: memoryStore,
          users: { list: () => users.list() },
          retention: () => config.get().runtime.memoryRetention,
          now: () => clock.now(),
        });
        if (removed > 0) log.info(`memory retention: soft-deleted ${removed} memory item(s)`);
      } catch (e) { log.error('memory retention sweep failed', e); }
      // Recall events are the one memory table that grows with traffic (hundreds of rows a day), so it
      // is pruned by age. Its own try: an eviction failure must not leave the log growing unbounded.
      try {
        const dropped = memoryStore.purgeUsageEventsOlderThan(USAGE_HISTORY_DAYS);
        if (dropped > 0) log.info(`memory retention: dropped ${dropped} recall event(s) older than ${USAGE_HISTORY_DAYS} days`);
      } catch (e) { log.error('memory usage-event purge failed', e); }
    };
    sweepMemoryRetention();
    const stopMemoryRetentionSweep = clock.setInterval(sweepMemoryRetention, 86_400_000);
    // Chat attachments outlive their turn on purpose, but not their message: a turn discarded before it
    // produced output, or a deleted conversation, leaves files nothing points at. Reclaim them daily,
    // keeping anything written in the last hour — a turn writes its files before committing the row that
    // references them, so a sweep landing in between must not delete a live attachment.
    // A message queued mid-turn is the exception the grace period cannot cover: its files are written at
    // admission but its row only at delivery, so a turn running longer than an hour would leave them
    // looking abandoned. Ask the live sessions what is still in flight and treat that as referenced too.
    const sweepChatAttachments = () => {
      if (!chatImagesDir) return;
      try {
        const referenced = brainStore.referencedChatImages();
        for (const file of brain?.pendingChatImageFiles() ?? []) referenced.add(file);
        const removed = sweepChatImages(chatImagesDir, referenced, 3_600_000, clock.now());
        if (removed > 0) log.info(`chat images: removed ${removed} unreferenced attachment(s)`);
      } catch (e) { log.error('chat image sweep failed', e); }
    };
    sweepChatAttachments();
    const stopChatImageSweep = clock.setInterval(sweepChatAttachments, 86_400_000);
    // Sweep expired terminal-WS tickets so a burst of unredeemed tickets can't grow the map unbounded.
    const stopTicketSweep = clock.setInterval(() => tickets.sweep(clock.now()), 60_000);
    // Reconcile chat terminals against live tmux: reap orphaned tokens/bindings and stray `elowen-chat-*`
    // panes. Backstops the proactive teardown (self-exit `/quit`, delete-conversation) so nothing leaks.
    const stopTerminalSweep = clock.setInterval(() => {
      void brainTerminal?.sweep().catch((e) => log.error('brain terminal sweep failed', e));
    }, 60_000);
    // Reap live PI sessions nobody watches and nothing runs in. A client's binding expires on its own
    // TTL, but the RUNTIME was owned by no one: a browser tab closed over a running agent (which no
    // longer stops it) would otherwise leak its session until the daemon restarted. The countdown starts
    // only once a session is both unwatched and idle, so a long unattended run is never cut short.
    const stopIdleSessionReap = clock.setInterval(() => {
      void brain?.reapIdleLiveSessions().catch((e) => log.error('idle live-session reap failed', e));
    }, 60_000);
    const stopBrainWorkerWatchdog = brainWorkers.startWatchdog();
    // Memory embed queue: fill in missing/stale memory vectors in the background. No-ops until an
    // embedding provider/model is configured; one bad memory never aborts a drain (caught + logged).
    const stopEmbedQueue = clock.setInterval(() => {
      void embedQueue.drain().catch((e) => log.error('embed queue drain failed', e));
    }, 30_000);
    return () => { stopTokenPurge(); stopEventPurge(); stopSessionPurge(); stopMemoryRetentionSweep(); stopChatImageSweep(); stopTicketSweep(); stopTerminalSweep(); stopIdleSessionReap(); stopBrainWorkerWatchdog(); stopEmbedQueue(); };
  };
  return { app, startLoops, tickets, tmux };
}
