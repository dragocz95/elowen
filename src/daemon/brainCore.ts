import { openDb } from '../store/db.js';
import type { Db } from '../store/db.js';
import { makePluginDb } from '../store/pluginDb.js';
import { TaskRefs } from '../store/taskRefs.js';
import type { PluginBrainWorker, PluginHostAdvisor, PluginHostPush, PluginHostTerminals, TasksDomainControl } from '../plugins/api.js';
import { RelayClient } from '../inference/client.js';
import { EventBus } from '../api/sse.js';
import { ConfigStore } from '../store/configStore.js';
import { ThemeStore, activeThemeName } from '../store/themeStore.js';
import { resolveBrand, type ResolvedBrand } from '../shared/brand.js';
import { UserStore } from '../store/userStore.js';
import { EventStore } from '../store/eventStore.js';
import { ProjectStore } from '../store/projectStore.js';
import { UserProjectStore } from '../store/userProjectStore.js';
import { PushSubscriptionStore } from '../store/pushSubscriptionStore.js';
import { UserPromptStore } from '../store/userPromptStore.js';
import { UserSettingStore } from '../store/userSettingStore.js';
import { PromptService } from '../prompts/promptService.js';
import { setPluginPromptCatalog } from '../prompts/catalog.js';
import { setPluginPromptSources, rawTemplate } from '../prompts/index.js';
import { projectHead, projectRangeDiff, projectRangeLog, projectRangeFileDiff, projectCommitFileDiff, safeProjectPath } from '../integrations/projectFiles.js';
import { RealGitReader } from '../git/gitReader.js';
import type { TmuxDriver } from '../tmux/types.js';
import { logger } from '../shared/logger.js';
import { HookAuditBuffer } from '../shared/hookAudit.js';
import { BrainService } from '../brain/brainService.js';
import { BrainOAuthManager } from '../brain/oauth.js';
import { ModelRuntime, readStoredCredential } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { FileCredentialStore } from '../brain/credentialStore.js';
import { bearerFromAuth, type BrainCredentialAccess } from '../brain/providerUsage.js';
import { BrainStore } from '../store/brainStore.js';
import { MemoryStore } from '../store/memoryStore.js';
import { MemoryCategoryStore } from '../store/memoryCategoryStore.js';
import { MemoryCategorizer } from '../brain/memoryCategorizer.js';
import type { InferenceClient } from '../inference/types.js';
import { EmbeddingService } from '../embeddings/embeddingService.js';
import { EmbeddingQueue } from '../embeddings/embedQueue.js';
import { MemoryService } from '../brain/memoryService.js';
import { toEmbeddingConfig } from '../store/configStore.js';
import { brainConfigFromElowen } from '../brain/config.js';
import { loadAgentRegistry, agentCatalog, type AgentDef } from '../brain/agents/agentRegistry.js';
import { makeAgentCatalog } from '../brain/agents/catalogService.js';
import { listBrainModels } from '../brain/models.js';
import { setToolOutputCaps, setToolOutputPolicy, shapeBrainMessages } from '../brain/messageView.js';
import { taskSessionId } from '../brain/sessionId.js';
import { setSpillMaxResultBytes, setToolResultGroupBudget } from '../brain/session/toolResultClearing.js';
import { setSpillNamespaceResolver } from '../shared/paths.js';
import { setCompactionFailureLimit } from '../brain/session/compactionCircuitBreaker.js';
import { makeToolOutputPolicy } from '../brain/toolOutput.js';
import { BUILTIN_TOOL_OUTPUT_SHOWN } from '../brain/tools/index.js';
import type { DelegatedChildBridge } from '../plugins/api.js';
import type { DelegatedTurnRunner } from '../brain/delegatedTurn.js';
import type { Policy } from '../plugins/policy.js';
import type { McpBridgeSnapshot } from '../plugins/mcpSnapshot.js';
import { discoverPlugins, loadPlugins } from '../plugins/loader.js';
import type { PluginRegistry } from '../plugins/registry.js';
import { PluginRegistryProvider } from '../plugins/pluginsProvider.js';
import { predictsRunnerDispatch } from '../subagent/dispatch.js';
import { setWorkflowLivenessProbe, workflowEngineProbeFrom } from '../brain/service/statusService.js';
import { resolvePolicy } from '../plugins/policy.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { isExecAllowedForUser, isModelVisibleForUser, elowenExec } from '../shared/execs.js';
import { WORKFLOW_ADD_NODES_RPC, type WorkflowExpansionRpc } from '../subagent/hostRpc.js';

const log = logger('daemon');

/** Compact, human-readable one-liner for a bus event — the daemon's activity trail in the log file. */
function describeEvent(e: { type: string } & Record<string, unknown>): string {
  switch (e.type) {
    case 'task': return `task ${e.taskId} → ${e.status}`;
    case 'mission': return `mission ${e.missionId} → ${e.state}`;
    case 'plan': return `plan ${e.jobId} → ${e.status}${e.epicId ? ` (epic ${e.epicId})` : ''}${e.error ? ` — ${e.error}` : ''}`;
    case 'signal': return `signal ${e.session} → ${(e.signal as { type?: string })?.type ?? '?'}`;
    default: return e.type;
  }
}

/** The plugin-facing bridge to the brain's DIRECT sub-agent delegation, keyed on the parent session
 *  the registry reads off the live turn so a plugin can only ever reach its OWN children. Lifted out
 *  of the core factory purely so the wiring test can exercise the real bridge instead of a hand-rolled
 *  replica: a swapped (parent, child) pair typechecks (both strings) and would silently let a turn reach
 *  another turn's children, so the argument order has to be pinned by a test on the real code. */
export function createDelegatedChildren(
  brainStore: BrainStore,
  brain: BrainService | undefined,
): DelegatedChildBridge {
  return {
    runs: (parentSessionId, limit) => brainStore.listDelegatedChildren(parentSessionId, limit),
    read: (parentSessionId, childSessionId) => {
      if (!brain) throw new Error('the brain is not available on this deployment');
      return brain.readSubagent(parentSessionId, childSessionId);
    },
    continue: (parentSessionId, childSessionId, text, access, onEvent, model) => brain
      ? brain.continueSubagent(parentSessionId, childSessionId, text, access, onEvent, model)
      : Promise.reject(new Error('the brain is not available on this deployment')),
    stop: (parentSessionId, childSessionId) => brain
      ? brain.stopSubagent(parentSessionId, childSessionId)
      : Promise.reject(new Error('the brain is not available on this deployment')),
  };
}

export interface BrainCoreOpts {
  dbPath: string;
  project: { id: number; slug: string; path: string };
  /** The tmux driver the spawn service drives. Supplied by the caller (never chosen here) so a process
   *  that has no business launching panes can hand in whatever it wants to be reachable through spawn. */
  tmux: TmuxDriver;
  /** Seed the first admin when the user table is empty. DAEMON-ONLY: a process attaching to a database
   *  the daemon already prepared must not create accounts, so it simply omits this. */
  bootstrap?: { username: string; password: string } | null;
  /** An owner turn finished with the device it was sent from off screen → push it to the user's phone.
   *  DAEMON-ONLY: web push is a transport the daemon owns (it holds the subscriptions and the VAPID
   *  keys), so a process without that transport omits the hook and its turns notify nobody. */
  notifyTurnComplete?: (userId: number, title: string, preview: string) => void;
  /** Create the schema and run migrations (default true). The sub-agent runner passes false: it is forked
   *  only AFTER the daemon's own openDb returned, so the shape is already final and it has no business
   *  taking the write lock to prove that. */
  migrate?: boolean;
  /** The forked sub-agent runner — DAEMON-ONLY (see BrainDeps.subagentRunner). A runner omits it, which
   *  is what keeps a nested delegation inside the same process instead of forking a runner from a runner. */
  subagentRunner?: DelegatedTurnRunner;
  /** The daemon's bridged MCP tool definitions, captured at the instant this process was forked —
   *  RUNNER-ONLY, and the mirror image of `subagentRunner` above. With it the `mcp` plugin declares the
   *  identical bridged tool set without connecting anything, and connects a server only when one of its
   *  tools is actually called. The daemon passes nothing and connects at boot exactly as before. */
  mcpBridgeSnapshot?: McpBridgeSnapshot;
  /** Runner-only reverse channel into the daemon's workflow engine. Omitted anywhere that cannot prove
   *  support, which keeps remote WorkflowAddNodes denied instead of exposing a dead tool. */
  workflowExpansionRpc?: WorkflowExpansionRpc;
  /** Alternate plugin scan roots for an embedded/test core. Production omits this and uses the packaged
   *  bundled directory plus the instance plugin directory. */
  pluginDirs?: string[];
}

/** Construct the store + plugin registry + brain services that ANY Elowen process needs, with no HTTP
 *  server, no platform gateways, no scheduler and no background loop attached.
 *
 *  This is deliberately the single construction path: the daemon's `buildApp` calls it and wires its own
 *  daemon-only layers (API, autopilot, platforms, sweeps) on top of what comes back. The point is that a
 *  second process can obtain a byte-identical brain — same prompts, same tools, same limits — by calling
 *  the same function, instead of re-deriving the wiring and drifting from it.
 *
 *  In particular the process-local module state below (LSP toggle, tool-output caps, spill thresholds,
 *  compaction circuit breaker, tool-output visibility policy) is applied HERE rather than by the caller.
 *  Those setters have silent defaults: a process that forgets one produces different transcripts with no
 *  error at all, which is the exact failure this factory exists to make impossible. */
export async function buildBrainCore(opts: BrainCoreOpts) {
  // Annotated (not inferred) so declaration emit names the `Db` alias — the composite build for the
  // agents plugin (tsconfig.plugins.json) needs this factory's return type to be declaration-emittable.
  const db: Db = openDb(opts.dbPath, opts.migrate === false ? { migrate: false } : {});
  db.prepare('INSERT OR IGNORE INTO projects (id,slug,path) VALUES (?,?,?)').run(opts.project.id, opts.project.slug, opts.project.path);
  const tmux = opts.tmux;
  // The task ROWS are owned by whichever plugin registers the `tasks` domain control (see tasksSeam
  // below). What stays here is the tenancy boundary's own read view of them — it must answer before any
  // plugin is loaded, and must never be served by a plugin whose callers it gates.
  const taskRefs = new TaskRefs(db);
  const config = new ConfigStore(db);
  // One-shot upgrade: auto-enable the extracted `agents` plugin for pre-existing installs (it replaces
  // previously-core behaviour — see migrateAgentsEnabled). Daemon-only, like schema migrations: the
  // sub-agent runner attaches to a database the daemon already prepared and must not write settings.
  if (opts.migrate !== false) config.migrateAgentsEnabled();
  // One-shot copy of the plugin-exclusive autopilot keys into plugins.config.agents (lossless —
  // autopilot.* keeps its values for rollback). Same daemon-only discipline as above.
  if (opts.migrate !== false) config.migrateAgentsPluginConfig();
  // Config wave 2 (batch 3a): the remaining agents-only keys (pilot/overseer execs, reviewOnDone,
  // tddMode, prEnabled, ghToken) follow the same one-shot lossless copy.
  if (opts.migrate !== false) config.migrateAgentsPluginConfigWave2();
  // One-shot copy of the core `lspEnabled` toggle into plugins.config.lsp + auto-enable of the
  // extracted `lsp` plugin for pre-existing installs (lossless — lspEnabled keeps its value for
  // rollback). The plugin's own service seeds its manager from that slice at start.
  if (opts.migrate !== false) config.migrateLspPlugin();
  // The project editor was previously core, so existing installs retain it once; later operator
  // disables remain authoritative through the persisted marker.
  if (opts.migrate !== false) config.migrateEditorPlugin();
  // Task tracking was core until this wave; keep it on for installs that already had it (the marker
  // makes it one-shot, so a deliberate disable is never undone).
  if (opts.migrate !== false) config.migrateWorkPlugin();
  const users = new UserStore(db);
  if (opts.bootstrap != null) {
    if (users.count() === 0) {
      users.create(opts.bootstrap.username, opts.bootstrap.password);
    }
  } else if (users.count() === 0) {
    log.warn('no users exist and no ELOWEN_BOOTSTRAP_USER/PASS set — login will be impossible until a user is seeded');
  }
  const projects = new ProjectStore(db);
  const allProjects = projects.list();
  const homeProject = allProjects.find((p) => p.path === opts.project.path)
    ?? allProjects.find((p) => p.slug.toLowerCase() === opts.project.slug.toLowerCase())
    ?? projects.get(opts.project.id)
    ?? opts.project;
  if (homeProject.id !== opts.project.id || homeProject.path !== opts.project.path) {
    log.info(`home project resolved to ${homeProject.slug}#${homeProject.id} at ${homeProject.path}`);
  }
  const userProjects = new UserProjectStore(db);
  const pushSubscriptions = new PushSubscriptionStore(db);
  const userPrompts = new UserPromptStore(db);
  const userSettings = new UserSettingStore(db);
  const prompts = new PromptService(userPrompts);
  const git = new RealGitReader();
  // Give spawned agents a way to close their task: the elowen CLI path + daemon URL + a service token.
  // The token is AGENT-SCOPED (not the admin's full token): a prompt-injected agent can only drive
  // its own worker/overseer/pilot verbs (close task, plan submit, overseer poll/decide, read-only
  // listings) — never manage users, PUT /config, or register/delete projects (finding S51). Reused
  // across restarts (see ensureAgentToken) so a restart doesn't 401 in-flight agents. Owned by the
  // lowest-id user purely to satisfy the FK; the scope, not the owner, is what bounds it.
  const cliPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'index.js');
  // How spawned agents invoke the elowen CLI. In a global install the `elowen` command is on PATH, so set
  // ELOWEN_CLI=elowen (the systemd unit does); a source checkout leaves it unset and falls back to running
  // this daemon's own CLI by absolute path via node. Single source — threaded to spawn/pilot/overseer.
  const cli = (process.env.ELOWEN_CLI) ?? `node ${cliPath}`;
  // The SAME invocation as argv tokens (not a split of the shell string), for the direct tmux launch of an
  // admin's chat terminal (BrainTerminalService → tmux `-- <argv>`). Prod's ELOWEN_CLI=elowen → ['elowen'];
  // a checkout → ['node', <cliPath>]. (Space-bearing checkout paths would mis-tokenize; ours has none.)
  const cliArgv = (process.env.ELOWEN_CLI) ? process.env.ELOWEN_CLI.split(' ') : ['node', cliPath];
  // Reuse the existing agent token across restarts so a daemon restart doesn't 401 in-flight agents
  // mid-task (they hold the token they were spawned with); only mints fresh when none is valid.
  const serviceUserId = users.count() > 0 ? users.list()[0]?.id ?? null : null;
  const serviceToken = serviceUserId !== null ? users.ensureAgentToken(serviceUserId) : '';
  // Per-task agent credential: a worker is spawned with a token bound to the task it was spawned for,
  // so the API can refuse it on any other task — one shared token cannot tell two workers apart inside
  // the same project. Only ids that are REAL task rows bind; the overseer (`overseer-<mission>`), the
  // pilot (a plan job id) and the advisor have no task row and keep the unbound service token.
  const tokenForTask = (taskId: string): string | undefined =>
    serviceUserId !== null && taskRefs.get(taskId) ? users.ensureAgentTokenForTask(serviceUserId, taskId) : undefined;
  // A credential that acts as ONE REAL USER, for a plugin that took over a core surface which always ran
  // with the user's own rights (the Elowen* control-plane tools). Deliberately the SAME mint the core
  // path uses (`ensureAdvisorToken`, DB scope 'advisor', reused within its TTL), so moving that surface
  // into a plugin changes neither the tenancy it acts under nor the token rows the database accumulates.
  // Only a REAL user binds — an unknown id gets nothing rather than a token attributed to a ghost row.
  const tokenForUser = (userId: number): string | undefined =>
    users.get(userId) ? users.ensureAdvisorToken(userId) : undefined;
  const elowenCli = { cli, url: `http://localhost:${(process.env.ELOWEN_PORT) ?? 4400}`, token: serviceToken, tokenForTask };
  // NOTE: the SpawnService (and the AgentStore it records into) is owned by the agents plugin now —
  // the daemon reaches it through the 'missions' control; nothing here launches agent sessions.
  const bus = new EventBus();
  // The activity-log recorder resolves plugin-owned event shapes (mission/review/decision/message/
  // signal → the agents plugin) through the LIVE registry — a reload swaps the resolver set, and with
  // the owning plugin disabled those events are simply not persisted.
  const events = new EventStore(db, () => (loadedPluginRegistry?.eventRowResolvers ?? []).map((r) => r.fn));
  // Activity trail: mirror every bus event into the log file as a readable one-liner, so the log on
  // its own tells the story of a run (spawns, advances, plans) without cross-referencing the DB.
  bus.subscribe((e) => log.info(describeEvent(e)));
  const avatarsDir = opts.dbPath === ':memory:' ? undefined : join(dirname(opts.dbPath), 'avatars');
  // A chat turn's image attachments, kept beside the database like avatars. They are read back through an
  // authenticated route, so no signed link is needed — the web proxy supplies the bearer from the cookie.
  const chatImagesDir = opts.dbPath === ':memory:' ? undefined : join(dirname(opts.dbPath), 'chat-images');
  // Plugin scan roots: the bundled dist/plugins dir + the instance data-dir plugins/. Shared by the
  // brain's lazy loader and the admin /plugins listing so both always see the same set.
  const userPluginDir = join(dirname(opts.dbPath), 'plugins');
  const pluginDirs = opts.pluginDirs ?? [join(dirname(fileURLToPath(import.meta.url)), '..', 'plugins'), userPluginDir];
  const pluginDataRoot = join(dirname(opts.dbPath), 'plugins-data');
  // White-label theme packages next to the DB (sibling of agents/, plans/). Absent for an in-memory
  // database, like the other file-backed dirs. The brand resolver below and the public theme API both
  // read through the SAME store instance, so the served payload and the persona always agree.
  const themes = opts.dbPath === ':memory:' ? undefined : new ThemeStore(join(dirname(opts.dbPath), 'themes'));
  const brand = (): ResolvedBrand => {
    const name = activeThemeName();
    const theme = name ? themes?.get(name) ?? null : null;
    return resolveBrand(config.get(), theme?.manifest.brand ?? null, name);
  };
  // Typed sub-agents: built-in explore/plan ship in dist/prompts/agents (same `../` resolution as the
  // bundled plugins dir); user `.md` types live next to the DB in <config>/agents. Loaded lazily and
  // rebuilt on every plugin reload (invalidated in the pluginProvider factory below) so a new user agent
  // file applies after a reload, exactly like a skill.
  const agentsBuiltinDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts', 'agents');
  const agentsUserDir = opts.dbPath === ':memory:' ? undefined : join(dirname(opts.dbPath), 'agents');
  let agentRegistry: Map<string, AgentDef> | null = null;
  const getAgentRegistry = (): Map<string, AgentDef> =>
    (agentRegistry ??= loadAgentRegistry({ builtinDir: agentsBuiltinDir, userDir: agentsUserDir, logger: log }));
  // The brain's credential store: OAuth tokens (Anthropic/Copilot/OpenAI accounts) persist here and
  // pi refreshes them in place. Lives next to the brain's cwd, never inside a repo checkout.
  // 0700: this directory holds auth.json (OAuth secrets), and the directory is the outer permission
  // wall — the credential store hardens an existing dir itself, but a fresh one must not be born open.
  const brainDir = (() => { const p = join(dirname(opts.dbPath), 'brain'); mkdirSync(p, { recursive: true, mode: 0o700 }); return p; })();
  // Platform channels (Discord, …) and delegated children alike resolve their project scope through THIS
  // one resolver. Named (rather than inlined into the brain deps below) because the sub-agent runner has
  // to re-derive a delegated child's Policy from the same expression the daemon used — two copies of it
  // would be two ways for a child to end up scoped differently in the two processes.
  const policyForProjects = (ids: number[]): Policy => ({
    allowedProjectIds: new Set(ids),
    allowedPaths: () => ids.map((id) => projects.get(id)?.path).filter((p): p is string => !!p),
  });
  // The brain's model runtime: a file-backed credential store (OAuth tokens persist + pi refreshes them
  // in place) plus the built-in model catalog. Elowen's OWN store rather than pi's default AuthStorage:
  // this same auth.json is shared by the daemon and every forked sub-agent runner, and AuthStorage serves
  // a construction-time snapshot — a runner (or the daemon) would keep using a token a re-login in
  // another process already replaced, and a revoked-but-wallclock-valid token never even enters the
  // refresh path (see credentialStore.ts). A `:memory:` test DB gets an ephemeral in-memory store.
  const brainAuthPath = opts.dbPath === ':memory:' ? undefined : join(brainDir, 'auth.json');
  const brainRuntime = await ModelRuntime.create({
    credentials: brainAuthPath ? new FileCredentialStore(brainAuthPath) : new InMemoryCredentialStore(),
  });
  // Synchronous credential existence/read (config + usage pollers) reads auth.json directly; token
  // resolution (with refresh) goes through the runtime. Both no-op safely for an in-memory `:memory:` store.
  const brainCreds: BrainCredentialAccess = {
    get: (provider) => (brainAuthPath ? readStoredCredential(provider, brainAuthPath) : undefined),
    getApiKey: async (provider) => bearerFromAuth((await brainRuntime.getAuth(provider))?.auth),
  };
  const brainOauth = new BrainOAuthManager(brainRuntime, brainCreds);
  // Live provider resolver: adding a provider / connecting an account in Settings applies to the next
  // brain start without a daemon restart.
  const brainConfig = () => brainConfigFromElowen(config, brainCreds);
  // Central provider credential resolver exposed to plugins (voice STT/TTS, image gen) so they reuse the
  // operator's configured provider key instead of duplicating a secret. Reads live config each call.
  const resolveProvider = (id: string) => {
    const p = config.brainProviders().find((x) => x.id === id);
    return p ? { id: p.id, label: p.label, type: p.type, baseUrl: p.baseUrl, apiKey: p.apiKey } : null;
  };
  // Text→vector embedder for Elowen memory (consumed by Phase-4 retrieval); reuses the operator's brain
  // provider credentials via the same resolver plugins get. Pure network service, no DB access.
  const embeddings = new EmbeddingService({ resolveProvider });
  // The usage views may hide a task worker's spend ONLY while the other half of /usage/* reports it —
  // that half is the task domain owner's snapshot aggregate (`tasksDomain()?.usage()`, exactly what the
  // route reads). Resolved live per query, so toggling the owning plugin applies with no restart, and
  // the boot window (registry not loaded yet) reads as unowned, which keeps spend VISIBLE rather than
  // hiding money nobody else is reporting.
  const brainStore = new BrainStore(db, () => !!tasksDomain()?.usage());
  // Session id → immutable spill namespace, for pathGuard's spill-dir allowance and the
  // toolResultClearing default dir. Wired HERE because this is the single construction path every
  // process shares (daemon and forked sub-agent runner alike) — an unwired process would fall back to
  // id-keyed directories and stop seeing spills of conversations that were ever re-keyed.
  setSpillNamespaceResolver((sessionId) => brainStore.spillNamespace(sessionId));
  const memoryStore = new MemoryStore(db);
  const memoryCategoryStore = new MemoryCategoryStore(db);
  // ONE embedding-config mapper shared by the retrieval service AND the background embed queue, so both
  // read the same live config each call (a Settings change applies without a restart). Empty
  // providerId/model → the service degrades to keyword search and the queue no-ops.
  // Tool-output preview caps (Elowen AI → Limits) feed the shared messageView renderer; read live.
  setToolOutputCaps(() => ({ lines: config.get().brain.limits.toolOutputMaxLines, chars: config.get().brain.limits.toolOutputMaxChars }));
  // Size trigger for inline tool results (Elowen AI → Limits): a single result above this is spilled to
  // disk and the model gets a placeholder instead. Read live so a Settings change applies without a restart.
  setSpillMaxResultBytes(() => config.get().brain.limits.toolResultInlineBytes);
  // Aggregate trigger for one wire-level tool-result message (Elowen AI → Limits): a turn's parallel
  // results reach the provider as a single block, and its largest members are spilled until the block
  // fits. Read live, like the two above.
  setToolResultGroupBudget(() => config.get().brain.limits.toolResultGroupBudgetBytes);
  // Consecutive failed automatic compactions after which a conversation stops attempting them (Elowen AI
  // → Limits). Read live, so raising the limit lets a stopped conversation try again without a restart.
  setCompactionFailureLimit(() => config.get().brain.limits.compactionFailureLimit);
  // Tool-output VISIBILITY policy (single source, mirrors the icon pipeline): output is hidden by
  // default; the built-in show defaults plus every enabled plugin's manifest `showOutput` are merged and
  // injected into the shared messageView renderer so the live (events.ts) and history (shapeBrainMessages)
  // paths show the same tools' output. `pluginOutputShowPatterns` is refreshed on each plugin (re)load
  // below, so a newly enabled plugin's policy applies without a daemon restart — read live per render,
  // like the caps above.
  let pluginOutputShowPatterns: readonly string[] = [];
  setToolOutputPolicy(makeToolOutputPolicy(() => [...BUILTIN_TOOL_OUTPUT_SHOWN, ...pluginOutputShowPatterns]));
  // The most recently loaded plugin registry, for the SYNC consumers below (the workflow liveness probe).
  // The provider's own memo is a Promise, which a synchronous status read cannot await; refreshed by the
  // same `.then` that refreshes the output-show snapshot, so it can never lag behind a reload.
  let loadedPluginRegistry: PluginRegistry | undefined;
  // The task domain's CURRENT owner, or undefined when no loaded plugin claims it. Resolved through the
  // live registry on every call — a plugin reload swaps the owner, so a captured control would keep a
  // dead generation alive. Core never names the owning plugin: it asks for the domain.
  const tasksDomain = (): TasksDomainControl | undefined => loadedPluginRegistry?.control('tasks');
  const tasksSeam = (): TasksDomainControl => {
    const domain = tasksDomain();
    // Fail closed and LOUD: a seam that answered an unowned domain with an empty store would let a caller
    // which never asked `tasksAvailable()` report "no tasks" as fact.
    if (!domain) throw new Error('the tasks domain is unavailable — no loaded plugin owns it');
    return domain;
  };
  // Late binding for ctx.host.brainWorker(): the BrainWorkerService is constructed in bootstrap AFTER
  // this factory returns (it needs the brain store + bus), mirroring SpawnService.attachBrainWorker.
  let hostBrainWorker: PluginBrainWorker | undefined;
  // Same late binding for the push transport: the PushSender is a bootstrap construct (it needs the
  // subscriptions store + web-push keys wired there).
  let hostPush: PluginHostPush | undefined;
  let hostTerminals: PluginHostTerminals | undefined;
  let hostAdvisor: PluginHostAdvisor | undefined;
  // Status reads verify a `running` workflow row against the ENGINE (the subagent plugin's `workflow`
  // control) instead of trusting the row + origin-session liveness — see statusService.workflowRuns.
  setWorkflowLivenessProbe(workflowEngineProbeFrom(() => loadedPluginRegistry));
  const embeddingConfig = () => toEmbeddingConfig(config.embeddingConfig());
  // Vector retrieval + anti-duplication over the memory store (owner chat only — the caller gates it).
  const memoryService = new MemoryService({
    store: memoryStore, categories: memoryCategoryStore, embeddings, embeddingConfig,
    // Per-turn recall size is operator-tuned (Elowen AI → Limits); read live so a change applies without a restart.
    recallDefaults: () => ({ count: config.get().brain.limits.memoryRecallCount, chars: config.get().brain.limits.memoryRecallChars }),
    // Relevance floor below which a memory counts as unrelated to the query (Elowen AI → Runtime), carried
    // in per mille of cosine similarity. Read live, like the recall size above.
    semanticFloorPerMille: () => config.get().runtime.limits.memorySemanticFloorPerMille,
    // How much of the score is NOT the query — semantic similarity takes whatever these two leave. Same
    // live read as the floor above.
    scoreWeightsPerMille: () => ({
      importance: config.get().runtime.limits.memoryImportanceWeightPerMille,
      vitality: config.get().runtime.limits.memoryVitalityWeightPerMille,
    }),
    // The two cosine thresholds deciding when two memories are the same fact: on write (update instead
    // of add) and on recall (skip the redundant one).
    dedupePerMille: () => ({
      duplicate: config.get().runtime.limits.memoryDuplicatePerMille,
      paraphrase: config.get().runtime.limits.memoryParaphrasePerMille,
    }),
    retention: () => config.get().runtime.memoryRetention,
    // A recall moves usage and vitality with no user action behind it, so the open memory view would sit
    // on stale numbers until it remounted (queries are SSE-driven, refetchOnWindowFocus is off).
    onRecalled: (userId) => bus.publish({ type: 'memory', userId }),
  });
  // Background embedder: fills in missing/stale memory vectors so writes never block on the provider.
  // Driven off a startLoops tick below; no-ops until an embedding provider/model is configured.
  const embedQueue = new EmbeddingQueue({
    memoryStore, embeddings, users: { list: () => users.list() }, embeddingConfig, logger: log,
  });
  // The workspace-level MEMORY model (Settings → Memory). ONE cheap model drives BOTH post-turn
  // auto-save (the curator distilling durable facts) AND category classification — it resolves the
  // referenced brain provider's endpoint+key at call time (no second secret stored), mirroring how
  // embeddings reuse the brain key. Null when unconfigured/keyless → both no-op (memory still works via
  // the explicit Memory* tools). NOTE: deliberately NOT the autopilot model — memory is its own concern.
  const memoryModelInference = (): InferenceClient | null => {
    const block = config.get().categorization;
    if (!block.providerId || !block.model) return null;
    const provider = resolveProvider(block.providerId);
    if (!provider || !provider.apiKey) return null;
    return new RelayClient({ baseUrl: block.baseUrl || provider.baseUrl, apiKey: provider.apiKey, model: block.model });
  };
  const memoryCategorizer = new MemoryCategorizer({
    categories: memoryCategoryStore, memories: memoryStore, inference: memoryModelInference, logger: log,
  });
  // ONE shared plugin registry for the whole daemon (brain chat + elowen-exec workers + platforms):
  // loading is lazy (plugins load on first use, not at boot), and a plugin toggle invalidates every consumer at once —
  // a per-service memo would leave the workers on a stale registry until a daemon restart.
  const pluginProvider = new PluginRegistryProvider(() => {
    // Never load against a half-built package: an in-place `npm run build` wipes dist/plugins for the
    // whole tsc run before copying the plugin sources back, and a reload landing inside that window
    // would see ONLY the user plugin dir — every session spawned then loses the bundled tools (files,
    // terminal, …) and a stale same-name user copy silently wins the dedupe. An empty bundled dir is
    // impossible in a healthy install, so treat it as mid-build: fail this load and let the provider
    // keep serving the last good registry until a later get() finds the dir populated again.
    if (discoverPlugins([pluginDirs[0]!]).length === 0) {
      return Promise.reject(new Error('bundled plugins directory is empty — package build in progress?'));
    }
    const enabled = config.get().plugins.enabled;
    const pluginConfig = Object.fromEntries(enabled.map((n) => [n, config.pluginConfig(n)]));
    // A plugin reload also refreshes the typed sub-agents: drop the memo so a newly added user `.md`
    // agent is picked up on the same toggle/restart that reloads plugins (mirrors skills).
    agentRegistry = null;
    return loadPlugins({
      dirs: pluginDirs, enabled, config: pluginConfig, dataRoot: pluginDataRoot,
      // The typed sub-agent catalog, read synchronously by the subagent plugin at register time to compose
      // its Delegate tool description.
      subagentTypes: () => agentCatalog(getAgentRegistry()),
      // The operator's ceiling on the context a delegating plugin may attach to a child (Settings →
      // Elowen AI → Limits). Read live, so raising it applies to the next delegation without a restart.
      delegateContextChars: () => config.get().brain.limits.delegateContextChars,
      // Sub-agent transcripts already outlive their delegation in SQLite; this is what lets the agent
      // that spawned them find them again and pick one back up. Both halves are keyed on the parent
      // session the registry reads off the live turn, so a plugin can only ever reach its OWN children.
      delegatedChildren: createDelegatedChildren(brainStore, brain),
      // ONE answer to "what time is it for this operator", read from the single place they configure it
      // (Settings → Plugins → runtime-context → Timezone) and shared with every plugin that reasons about
      // wall-clock time. Without it, cron would silently schedule in whatever zone the SERVER happens to
      // run in — so "daily 07:30" would fire at 07:30 UTC for a user living in Prague. Read live, and
      // deliberately independent of whether runtime-context itself is enabled: the field is the setting.
      timezone: () => {
        const configured = config.pluginConfig('runtime-context').timezone;
        return typeof configured === 'string' && configured.trim() ? configured.trim() : '';
      },
      notify: (t, channelId) => brain?.notify(t, channelId) ?? Promise.resolve(),
      // A plugin that writes a skill to disk (skills plugin's CreateSkill) asks for a live apply; the brain
      // coalesces it and reloads once the current turn settles, so the new skill reaches the next message.
      requestReload: () => brain?.requestPluginReload(),
      // Interactive transports (Discord) hand a parked AskUserQuestion's answer straight back in-process.
      answerQuestion: (id, answers) => brain?.answerQuestion(id, answers) ?? false,
      // The Discord /model picker is an operator-shared channel setting, so it offers the platform
      // owner's CURATED list: their personal allow-list narrows the picker even though, as admin, they
      // could run anything (display filter, not the enforcement gate). Empty personal list = all global.
      listModels: () => {
        const c = brainConfig();
        if (!c) return Promise.resolve([]);
        const owner = users.list().find((u) => u.is_admin);
        const globalExecs = config.get().allowedExecs;
        return listBrainModels(c).then((models) =>
          models.filter((m) => isModelVisibleForUser(owner, globalExecs, elowenExec(m.provider, m.model))));
      },
      resolveProvider,
      // The SHARED embedder + live Settings→Memory config mapper, exposed to plugins as ctx.embeddings
      // (gated by a `reads:['embeddings']` capability). Same instance the memory retrieval + embed queue
      // use, so a semantic-index plugin reuses the operator's ONE embedding model — no second provider.
      embeddings,
      embeddingConfig,
      // Present only in a sub-agent runner (see BrainCoreOpts). Captured once, at fork time, and reused
      // across this process's plugin reloads: it describes the tool SET, which a reload does not change.
      ...(opts.mcpBridgeSnapshot ? { mcpBridgeSnapshot: opts.mcpBridgeSnapshot } : {}),
      // THE dispatch prediction, shared verbatim with SubagentDispatch.mode() so the two cannot drift:
      // only the daemon holds a runner, the toggle is read live, and a pool sized to zero routes
      // in-process. A runner process has no `subagentRunner` by construction (no nested forking), so
      // there this is structurally false and workflow self-expansion stays open.
      delegatedTurnsOutOfProcess: () => predictsRunnerDispatch(
        opts.subagentRunner, config.get().runtime.subagentRunnerEnabled === true),
      // An old/unwired runner is not "probably capable": the workflow engine withholds both briefing and
      // tool unless the exact reverse verb is advertised by the dispatcher it will use.
      delegatedWorkflowExpansionAvailable: () =>
        opts.subagentRunner?.supportsHostRpc?.(WORKFLOW_ADD_NODES_RPC) === true,
      // Present only in the runner process. Its plugin instance has no local DAG, so WorkflowAddNodes uses
      // this client to reach the daemon instance that owns the workflow.
      ...(opts.workflowExpansionRpc ? { workflowExpansionRpc: opts.workflowExpansionRpc } : {}),
      // ctx.db(): shared main DB, capability-gated. Migrations run only in the daemon — the runner
      // opened this DB {migrate:false} and must never race the daemon as a second migrator.
      pluginDb: (plugin) => makePluginDb(db, plugin, { canMigrate: opts.migrate !== false }),
      // ctx.publishEvent(): the daemon's ONE bus (SSE + activity log). Capability-gated in the registry.
      publishEvent: (e) => bus.publish(e),
      // ctx.deleteEventsForTarget(): the feed's purge verb, for a plugin deleting the row its activity
      // history describes. Same store the recorder writes to, same capability gate as publishing.
      deleteEvents: (target) => events.deleteForTarget(target),
      // ctx.host.*: the core-owned machinery an extracted subsystem (agents) builds on. The brain
      // worker resolves LIVE — bootstrap constructs it after this load (setPluginHostBrainWorker).
      host: {
        tmux,
        brainWorker: () => hostBrainWorker,
        elowenCli: { cli, cliArgv, url: elowenCli.url, token: elowenCli.token, tokenForTask, tokenForUser },
        stores: {
          // The task domain resolves LIVE through its control on every read (see tasksSeam): the owner is
          // whichever plugin registered `tasks`, and a getter — rather than the instance — is what keeps a
          // held `stores()` object correct across a plugin reload that swapped that owner.
          get tasks() { return tasksSeam().store(); },
          get readiness() { return tasksSeam().readiness(); },
          get taskUsage() { return tasksSeam().usage(); },
          tasksAvailable: () => tasksDomain() !== undefined,
          projects,
          // Live row read: `homeProject` may be the narrow bootstrap fallback {id,slug,path}, but the
          // row always exists (inserted at open), so the store yields the full Project shape.
          homeProject: () => projects.get(homeProject.id) ?? { id: homeProject.id, slug: homeProject.slug, path: homeProject.path, notes: '', icon: '', pr_enabled: null },
          usersRead: {
            list: () => users.list().map((u) => ({ id: u.id, username: u.username, isAdmin: u.is_admin })),
            isAdmin: (id) => users.isAdmin(id),
            allowedExecs: (id) => users.list().find((u) => u.id === id)?.allowed_execs ?? null,
          },
          ...(events ? { eventsRead: { list: (opts: { target?: string; type?: string }) => events.list(opts) } } : {}),
          // The task transcript, shaped HERE: the `brain-task-<id>` session name and the message view are
          // both core conventions shared with chat, so the plugin serving the route asks for a task's
          // conversation and never for a session id it would have to spell itself.
          taskConversation: (taskId: string) => shapeBrainMessages(
            brainStore.getMessages(taskSessionId(taskId)), brainStore.getSubagentRuns(taskSessionId(taskId))),
        },
        prompts: {
          render: (name, vars, userId) => prompts.render(name, vars ?? {}, userId),
          rawTemplate,
          userOverride: (userId, name) => userPrompts.get(userId, name),
        },
        config: {
          get: () => {
            const c = config.get();
            return { autopilot: c.autopilot, allowedExecs: c.allowedExecs, customModels: c.customModels, hiddenPresets: c.hiddenPresets, modelNotes: c.modelNotes, defaults: c.defaults, providers: c.providers, brain: c.brain };
          },
          autopilotRelay: () => config.autopilotRelay(),
          hasSettings: () => config.hasSettings(),
          legacyGhToken: () => config.legacyGhToken(),
        },
        relayClient: (cfg) => new RelayClient(cfg),
        git: { projectHead, projectRangeDiff, projectRangeLog, projectRangeFileDiff, projectCommitFileDiff },
        push: () => hostPush,
        terminals: () => hostTerminals,
        advisor: () => hostAdvisor,
        // The typed sub-agent catalog editor (the subagent plugin's '/plugins/agents/*' surface).
        // Tool names resolve through the provider so a save validates against the LIVE merged
        // registry — including the reload this very load is part of (get() memoizes per generation).
        agentCatalog: makeAgentCatalog({
          builtinDir: agentsBuiltinDir,
          ...(agentsUserDir ? { userDir: agentsUserDir } : {}),
          pluginToolNames: async (): Promise<string[]> => (await pluginProvider.get()).tools.map((t) => t.name),
        }),
        projectFiles: { safe: safeProjectPath },
      },
      subscribeEvents: (fn) => bus.subscribe(fn),
      logger: log,
    }).then((registry) => {
      // Snapshot the merged plugin output-show patterns so the (sync) messageView policy above reads the
      // current set — refreshed on every reload (a plugin toggle invalidates this provider), so a newly
      // enabled plugin's `showOutput` applies without a daemon restart.
      pluginOutputShowPatterns = [...registry.toolShowOutput];
      // Same snapshot discipline for plugin prompt templates: the (sync) prompt renderer + catalog read
      // module state, refreshed whole on every (re)load so a plugin toggle swaps templates live.
      setPluginPromptCatalog(registry.promptEntries.map((p) => p.entry));
      setPluginPromptSources(new Map([...registry.promptSources].map(([n, s]) => [n, s.file])));
      loadedPluginRegistry = registry;
      return registry;
    });
  });
  // Bounded ring of recent mutating-hook execution records. The brain's owner-chat hook runner is the
  // sole writer (via the audit sink below); the admin plugins API reads it (per-plugin hook-audit view).
  const hookAudit = new HookAuditBuffer();
  // Per-user embedded brain (the new advisor engine): an in-process PI agent session. Wired only when
  // a provider is configured (reuses the relay endpoint) and not for the in-memory test DB. Coexists
  // with the spawn-CLI advisor — routes degrade to 503 when left unwired.
  const brain: BrainService | undefined = opts.dbPath !== ':memory:'
    ? new BrainService({
        store: brainStore, users, config: brainConfig, prompts, url: elowenCli.url,
        runtime: brainRuntime,
        cwd: brainDir,
        projectPath: () => homeProject.path,
        projects,
        chatImagesDir,
        // The registry swap can happen long after the toggle was saved (it waits for running work), so the
        // web learns from this event instead of polling or needing a manual page reload.
        onPluginsReloaded: () => bus.publish({ type: 'plugins' }),
        // An owner turn finished with the device it was sent from off screen → push it to the user's phone.
        // No subscription registered ⇒ sendToUsers is a no-op, so this needs no separate enable flag.
        notifyTurnComplete: opts.notifyTurnComplete,
        plugins: pluginProvider,
        hookAudit,
        policy: (userId) => resolvePolicy({ userProjects, projects }, userId),
        userSettings: (userId) => userSettings.cliSettings(userId),
        projectModelPreference: (userId, projectRoot) => userSettings.projectModelPreference(userId, projectRoot),
        setProjectModelPreference: (userId, projectRoot, selection) => { userSettings.setProjectModelPreference(userId, projectRoot, selection); },
        // Granular tool permissions (allow/ask/deny rules + the persisted YOLO default) and the
        // "Always allow" persistence behind the owner-chat approval prompt.
        permissions: (userId) => userSettings.permissionSettings(userId),
        saveAlwaysAllow: (userId, scope, pattern) => { userSettings.addPermissionAllowRule(userId, scope, pattern); },
        // One global personality body per user (user_settings key 'personalityBody'), identical on every
        // platform. Empty → undefined so nothing is appended and the system-prompt prefix stays byte-stable.
        activePersonality: (userId) => { const body = userSettings.cliSettings(userId).personalityBody.trim(); return body ? body : undefined; },
        brand,
        maxSteps: () => config.get().brain.maxSteps,
        brainLimits: () => config.get().brain.limits,
        runtimeConfig: () => config.get().runtime,
        resolvePlatformUser: (platform, platformUserId) => {
          if (!platformUserId) return null;
          // Discord ids are bare snowflakes; WhatsApp userIds are JIDs (e.g. "420778433908@s.whatsapp.net"
          // or a "<id>@lid") — strip to digits so it matches the stored phone number. Telegram userIds are
          // bare numeric ids (the plugin reports String(from.id)), stored/matched as-is.
          let key: 'discordUserId' | 'whatsappNumber' | 'telegramUserId';
          let value: string;
          if (platform === 'discord') { key = 'discordUserId'; value = platformUserId; }
          else if (platform === 'whatsapp') { key = 'whatsappNumber'; value = platformUserId.replace(/[@:].*$/, '').replace(/[^\d]/g, ''); }
          else if (platform === 'telegram') { key = 'telegramUserId'; value = platformUserId.replace(/[^\d]/g, ''); }
          else return null;
          if (!value) return null;
          const id = userSettings.userIdBySetting(key, value);
          const u = id != null ? users.get(id) : undefined;
          return u ? { id: u.id, name: u.name || u.username, username: u.username, admin: !!u.is_admin } : null;
        },
        // Same allow-list semantics as the task/session routes: admins unrestricted, everyone else
        // bounded by the global list AND their personal whitelist (empty personal = global only).
        execAllowed: (userId, exec) => isExecAllowedForUser(users.get(userId), config.get().allowedExecs, exec),
        // Platform channels (Discord, …): role mappings resolve to project-scoped policies; the admin's
        // token anchors the channel sessions.
        policyForProjects,
        platformOwner: () => users.ownerId(),
        // Present only in the daemon: a runner builds its core without one and therefore always runs a
        // nested delegation itself.
        ...(opts.subagentRunner ? { subagentRunner: opts.subagentRunner } : {}),
        // The typed sub-agent registry, resolved host-side when a delegate call names a subagent_type.
        agents: () => getAgentRegistry(),
        // Private long-term memory: the owner-chat memory tools + per-turn retrieval injection + the
        // post-turn curator. All owner-gated inside BrainService (channels/workers never reach them).
        memoryStore, memoryService, inference: memoryModelInference,
        // Budget for recall that runs mid-turn. Read through the config on every search, so changing it
        // in Settings reaches a conversation that is already running.
        liveRecallBudget: () => ({
          passes: config.get().brain.limits.memoryLiveRecallPasses,
          count: config.get().brain.limits.memoryLiveRecallCount,
          bytes: config.get().brain.limits.memoryLiveRecallBytes,
        }),
        // Auto-categorize newly-added durable memories (fire-and-forget from the curator) + the owner's
        // memory_category_* tools (create/delete/recategorize).
        memoryCategorizer, memoryCategoryStore,
        // Cap on curator writes per exchange (Elowen AI → Runtime), read live like the budgets above.
        memoryCuratorMaxOps: () => config.get().runtime.limits.memoryCuratorMaxOps,
      })
    : undefined;
  return {
    db, taskRefs, config, users, homeProject, projects, userProjects,
    pushSubscriptions, userPrompts, userSettings, prompts, git,
    // The task domain's CURRENT owner, for the daemon layers that legitimately drive task rows (the
    // embedded worker, the instance-cleanup route). Resolved per call — never captured — and undefined
    // while no loaded plugin owns it, which is what those layers must degrade on.
    tasksDomain,
    cli, cliArgv, elowenCli, bus, events,
    avatarsDir, chatImagesDir, pluginDirs, userPluginDir, pluginDataRoot, getAgentRegistry,
    brainDir, brainRuntime, brainCreds, brainOauth, brainConfig, resolveProvider,
    embeddings, embeddingConfig, brainStore, memoryStore, memoryCategoryStore,
    memoryService, embedQueue, memoryModelInference, memoryCategorizer,
    pluginProvider, hookAudit, brain, themes, brand,
    // Sync view of the last loaded registry (undefined before the first load) — for wiring that must
    // read plugin contributions without awaiting the provider (e.g. event tenancy resolvers).
    loadedPlugins: () => loadedPluginRegistry,
    // Bootstrap hands the constructed BrainWorkerService here so ctx.host.brainWorker() resolves.
    setPluginHostBrainWorker: (worker: PluginBrainWorker) => { hostBrainWorker = worker; },
    setPluginHostPush: (sender: PluginHostPush) => { hostPush = sender; },
    setPluginHostTerminals: (terminals: PluginHostTerminals) => { hostTerminals = terminals; },
    setPluginHostAdvisor: (advisor: PluginHostAdvisor) => { hostAdvisor = advisor; },
  };
}
