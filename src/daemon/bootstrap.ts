import { installEventRecording } from './eventRecording.js';
import { createServer } from '../api/server.js';
import { ELOWEN_VERSION } from '../api/version.js';
import { createTicketStore } from '../terminal/ticketStore.js';
import { RealTmuxDriver } from '../tmux/driver.js';
import { SystemClock } from '../shared/clock.js';
import { ensureVapidKeys } from '../push/vapid.js';
import { PushSender } from '../push/pushSender.js';
import { buildTurnDone } from '../push/messages.js';
import type { TmuxDriver } from '../tmux/types.js';
import { logger, setLogSink } from '../shared/logger.js';
import { PluginLogBuffer } from '../shared/logBuffer.js';
import { BrainTerminalService } from '../brain/terminalService.js';
import { processRegistry } from '../brain/processRegistry.js';
import { isSubagentSession } from '../brain/sessionId.js';
import { discoverPlugins } from '../plugins/loader.js';
import { MarketplaceService } from '../plugins/marketplace.js';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { buildBrainCore } from './brainCore.js';
import { SubagentRunnerPool } from '../subagent/pool.js';
import { resolvePoolMax } from '../subagent/sizing.js';
import type { RuntimeConfig } from '../shared/wireContract.js';
import type { PluginRegistryProvider } from '../plugins/pluginsProvider.js';
import type { PluginRegistry } from '../plugins/registry.js';
import { WORKFLOW_ADD_NODES_RPC, type HostRpcHandler } from '../subagent/hostRpc.js';
import { createRestartDaemon, type ShutdownControl } from './shutdown.js';
import { createMaintenanceLoops } from './maintenance.js';

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

export { runMemoryEvictionSweep } from './maintenance.js';
export type { MemoryEvictionSweepDeps } from './maintenance.js';

// Bounded ring of recent log lines, installed as the logger's single sink so it captures every
// emitted line (including plugin output prefixed `[plugin:<name>]` and `plugin skipped: <name>`).
// Feeds the admin per-plugin logs + health views. Best-effort: a full ring just evicts its oldest.
const pluginLogs = new PluginLogBuffer();
setLogSink(pluginLogs);

export { announceBoot, installGracefulShutdown, RESTART_EXIT_CODE } from './shutdown.js';
export type { ShutdownControl } from './shutdown.js';

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
    config, users, homeProject, projects, userProjects,
    pushSubscriptions, userPrompts, userSettings, prompts, git,
    cliArgv, elowenCli, bus, events,
    avatarsDir, chatImagesDir, pluginDirs, userPluginDir, pluginDataRoot,
    brainCreds, brainOauth, embeddings,
    brainStore, usageOrigins, memoryStore, memoryCategoryStore, userPluginConfig, pluginSecrets, embedQueue, memoryCategorizer,
    pluginProvider, hookAudit, brain, themes, brand, setPluginHostPush,
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
  // Phone push transport stays core: the sender owns device subscriptions and VAPID keys.
  // Contact is read per send, so changing it in Settings reaches the next notification without a restart.
  const pushSender = new PushSender(pushSubscriptions, () => config.webPushKeys(), undefined,
    () => ({ configured: config.get().webPushContact, instanceUrl: elowenCli.url }));
  // Bind the generic plugin push seam to the core transport.
  setPluginHostPush(pushSender);

  installEventRecording({ bus, events, log });
  // Setup mode: with no users yet the daemon is open so the onboarding page can run before login;
  // auth (in authMiddleware) re-engages automatically once the first admin is created.
  if (users.count() === 0) {
    log.warn('SETUP MODE — no users yet; the API is open until the first admin is created via onboarding');
  }
  // Per-process secret for short-lived signed avatar URLs (finding W2) — keeps the long-lived session
  // token out of <img> src query strings. Rotates on restart; links live ~5 min, so that's harmless.
  const avatarSecret = randomBytes(32).toString('hex');
  // Admin-only interactive `elowen chat` terminals bound to existing brain conversations. Its cwd is a
  // neutral per-admin scratch dir alongside the DB (never a project checkout), mirroring the advisor dir.
  // Constructed after `brain` (it needs store+users+url); the delete-conversation teardown is attached back
  // onto the brain via a late setter to avoid a constructor cycle.
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
  processRegistry.setChangeListener((sessionId, accountUserId) => {
    if (sessionId) brain?.broadcastProcesses(
      sessionId,
      accountUserId,
      processRegistry.listForSessionAccount(sessionId, accountUserId),
    );
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
  // Single-use ticket store for the terminal WebSocket stream — shared between the authenticated
  // `POST /sessions/:name/ws-ticket` route and the daemon's `/ws/terminal` upgrade handler.
  const tickets = createTicketStore();
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
    // Whether the registry was rebuilt NOW or parked until running work settles is reported as it is, not
    // as a failure: the marketplace keeps its rollback folder either way and only drops it once the plugin
    // is proven present in a rebuilt registry (`loadedNames`). Turning the deferral into an error here
    // rolled back every install triggered from a conversation, because the work being waited on was that
    // very turn.
    reload: async () => {
      if (!brain) { pluginProvider.invalidate(); return 'applied'; }
      return await brain.reloadPlugins() ? 'applied' : 'deferred';
    },
    loadedNames: async () => (await pluginProvider.get()).loadedNames,
  });
  // The deferred half of the contract above: once a reload really lands, the marketplace gets to prove or
  // undo the installs it parked. Late-bound for the same reason `restartHandler` is.
  if (brain) brain.afterPluginsApplied = () => marketplace.settleDeferredApplies();
  marketplace.sweep(); // clear crash debris (.staging-*/.old-*) left by an interrupted install
  // Restore any plugin that is enabled but no longer on disk — the case an upgrade creates when a
  // plugin moves out of the package into the registry. Start it now but do not await it from buildApp: a
  // slow registry must not hold up the HTTP daemon. The first plugin-runtime start below waits for it,
  // keeping adapters offline until every restore has completed its validating registry reload.
  const pluginReconcile = marketplace.reconcileEnabled().catch((e) => {
    log.warn(`plugin reconcile failed: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  });
  // The admin-only `/restart` slash command: announce it on the platforms (Discord main channel), drop a
  // marker so the NEXT boot announces "back online", then drain and exit for the supervisor to restart.
  // Runs in prod only (a :memory: test DB has no config dir + no units).
  // Late-bound: the handle exists only once startLoops installs the shutdown handler, which happens after
  // this closure is built but long before a user can invoke it.
  let shutdown: ShutdownControl | undefined;
  const restartMarker = opts.dbPath !== ':memory:' ? join(dirname(opts.dbPath), '.restart-marker') : undefined;
  // Timestamp of the last boot announcement — the crash-loop debounce in announceBoot. Same state dir,
  // and likewise absent under the in-memory test DB so the suite never announces.
  const bootMarker = opts.dbPath !== ':memory:' ? join(dirname(opts.dbPath), '.boot-announce') : undefined;
  const restartDaemon = createRestartDaemon(brain, restartMarker, () => shutdown, log);
  // Late-bind the restart handler onto the brain so a platform `/restart` slash (Discord) reaches the
  // same systemd path the web/CLI command uses. Built here (needs the units + marker), wired now.
  if (brain && restartDaemon) brain.restartHandler = restartDaemon;

  const app = createServer({
    bus, events,
    project: homeProject, clock: new SystemClock(), config, users, projects, userProjects,
    pushSubscriptions, userPrompts, userSettings, pluginDirs, pluginDataRoot, brainOauth,
    brainAuth: brainCreds, prompts, git, avatarsDir, avatarSecret, chatImagesDir, brain, brainTerminal,
    restartDaemon, brainStore, usageOrigins, memoryStore, memoryCategoryStore, userPluginConfig, pluginSecrets,
    memoryCategorizer, embeddings, plugins: pluginProvider, marketplace, pluginLogs, hookAudit, themes,
    ...(subagentRunner ? { subagentPool: () => subagentRunner.stats() } : {}),
  });

  const startLoops = createMaintenanceLoops({
    brain, brainTerminal, brainStore, chatImagesDir, config, embedQueue, events,
    memoryStore, users, usageOrigins, tickets, pluginReconcile, dbPath: opts.dbPath,
    restartMarker, bootMarker, version: ELOWEN_VERSION, log,
    onShutdownInstalled: (control) => { shutdown = control; },
  });
  return { app, startLoops, tickets, tmux };
}
