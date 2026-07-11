import { openDb } from '../store/db.js';
import { TaskStore } from '../store/taskStore.js';
import { Readiness } from '../store/readiness.js';
import { AgentStore } from '../store/agentStore.js';
import { MissionStore } from '../store/missionStore.js';
import { MissionPrStore } from '../store/missionPrStore.js';
import { SpawnService } from '../spawn/spawn.js';
import { MissionEngine } from '../overseer/missionEngine.js';
import { MissionGit } from '../overseer/missionGit.js';
import type { SummaryContext } from '../overseer/missionEngine.js';
import type { Task } from '../store/types.js';
import { Scheduler } from '../overseer/scheduler.js';
import { sweepFinishedSessions } from '../overseer/janitor.js';
import { sweepPrFeedback, type PrFeedbackDeps } from '../overseer/prFeedback.js';
import { sweepStuckTasks, deadAgentTasks } from '../overseer/stuckDetector.js';
import { decidePrompt, decideChoice, gateVerdict, minConfidenceFor, noOverseerFallback } from '../overseer/decision.js';
import { PlanJobStore } from '../overseer/planJob.js';
import { DecisionQueue, type DecisionResult } from '../overseer/decisionQueue.js';
import { sweepAgentLiveness, checkAction, WORKER_IDLE_MS, OVERSEER_IDLE_MS, DECISION_GRACE_MS, DECISION_HARD_MS, DECISION_SWEEP_MS, PROGRESS_REVIEW_MS } from '../overseer/livenessSweep.js';
import { PaneActivityTracker } from '../overseer/paneActivity.js';
import { detectAgentPrompt } from '../deriver/shellPatterns/index.js';
import { makePilot } from '../overseer/pilotAgent.js';
import { makeOverseer } from '../overseer/overseerAgent.js';
import { RelayClient } from '../inference/client.js';
import { Deriver } from '../deriver/deriver.js';
import { EventBus } from '../api/sse.js';
import { eventProjectId, type EventProjectDeps } from '../api/eventProject.js';
import { createServer } from '../api/server.js';
import { createSkillService } from '../api/services/skillService.js';
import { createTicketStore } from '../terminal/ticketStore.js';
import { RealTmuxDriver } from '../tmux/driver.js';
import { SystemClock } from '../shared/clock.js';
import { ConfigStore } from '../store/configStore.js';
import { ensureVapidKeys } from '../push/vapid.js';
import { PushSender } from '../push/pushSender.js';
import { PushDispatcher } from '../push/pushDispatcher.js';
import { UserStore } from '../store/userStore.js';
import { EventStore } from '../store/eventStore.js';
import { NoteStore } from '../store/noteStore.js';
import { KeyedMutex } from '../shared/keyedMutex.js';
import { ProjectStore } from '../store/projectStore.js';
import { UserProjectStore } from '../store/userProjectStore.js';
import { PushSubscriptionStore } from '../store/pushSubscriptionStore.js';
import { UserPromptStore } from '../store/userPromptStore.js';
import { UserSettingStore } from '../store/userSettingStore.js';
import { PromptService } from '../prompts/promptService.js';
import { resolveOwnerId } from '../prompts/owner.js';
import { TaskUsageStore } from '../store/taskUsageStore.js';
import { UsageRecorder } from '../integrations/usage/recorder.js';
import { captureResumeLabel } from '../integrations/usage/resumeCapture.js';
import { usagePath } from '../integrations/usage/usagePath.js';
import { RealGitReader } from '../git/gitReader.js';
import type { TmuxDriver } from '../tmux/types.js';
import { uniqueName } from './uniqueName.js';
import { logger, setLogSink } from '../shared/logger.js';
import { PluginLogBuffer } from '../shared/logBuffer.js';
import { HookAuditBuffer } from '../shared/hookAudit.js';
import { AdvisorService } from '../advisor/service.js';
import { writeMcpConfig } from '../advisor/mcpConfig.js';
import { BrainService } from '../brain/brainService.js';
import { processRegistry } from '../brain/processRegistry.js';
import { lspManager } from '../brain/tools/lspTools.js';
import { BrainOAuthManager } from '../brain/oauth.js';
import { AuthStorage } from '@earendil-works/pi-coding-agent';
import { BrainStore } from '../store/brainStore.js';
import { PersonalityStore } from '../store/personalityStore.js';
import { PersonalityService } from '../brain/personalityService.js';
import { MemoryStore } from '../store/memoryStore.js';
import { MemoryCategoryStore } from '../store/memoryCategoryStore.js';
import { MemoryCategorizer } from '../brain/memoryCategorizer.js';
import type { InferenceClient } from '../inference/types.js';
import { EmbeddingService } from '../embeddings/embeddingService.js';
import { EmbeddingQueue } from '../embeddings/embedQueue.js';
import { MemoryService } from '../brain/memoryService.js';
import { toEmbeddingConfig } from '../store/configStore.js';
import { brainConfigFromElowen } from '../brain/config.js';
import { listBrainModels } from '../brain/models.js';
import { setToolOutputCaps, setToolOutputPolicy } from '../brain/messageView.js';
import { makeToolOutputPolicy } from '../brain/toolOutput.js';
import { BUILTIN_TOOL_OUTPUT_SHOWN } from '../brain/tools/index.js';
import { discoverPlugins, loadPlugins } from '../plugins/loader.js';
import { MarketplaceService } from '../plugins/marketplace.js';
import { PluginRegistryProvider } from '../plugins/pluginsProvider.js';
import { resolvePolicy } from '../plugins/policy.js';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { systemctl } from '../cli/systemd.js';
import { isExecAllowedForUser, isModelVisibleForUser, elowenExec } from '../shared/execs.js';
import { BrainWorkerService } from '../brain/worker/brainWorker.js';

const log = logger('daemon');

// Bounded ring of recent log lines, installed as the logger's single sink so it captures every
// emitted line (including plugin output prefixed `[plugin:<name>]` and `plugin skipped: <name>`).
// Feeds the admin per-plugin logs + health views. Best-effort: a full ring just evicts its oldest.
const pluginLogs = new PluginLogBuffer();
setLogSink(pluginLogs);

/** Build the overseer-model prompt that turns a finished mission's phase results into a short,
 *  human-readable Czech summary shown on the epic in the dashboard. Kept terse so the relay returns
 *  prose, not JSON or a plan. */
function missionSummaryPrompt(ctx: SummaryContext): string {
  const phases = ctx.phases
    .map((p, i) => `${i + 1}. ${p.title} — ${p.summary?.trim() || p.outcome || 'dokončeno'}`)
    .join('\n');
  return [
    'Jsi dozorčí autopilota. Mise právě skončila. Napiš stručné shrnutí v češtině (2–4 věty),',
    'co se v misi reálně udělalo, formálním tónem (vykání). Bez nadpisů, bez odrážek, jen plynulá próza.',
    '',
    `Cíl mise: ${ctx.goal}`,
    '',
    'Dokončené fáze:',
    phases,
  ].join('\n');
}

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

export interface BuildOpts {
  dbPath: string;
  project: { id: number; slug: string; path: string };
  relay: { baseUrl: string; apiKey: string; model: string } | null;
  tmux?: TmuxDriver;
  bootstrap?: { username: string; password: string } | null;
  allowOpen?: boolean;
}

export function buildApp(opts: BuildOpts) {
  const db = openDb(opts.dbPath);
  db.prepare('INSERT OR IGNORE INTO projects (id,slug,path) VALUES (?,?,?)').run(opts.project.id, opts.project.slug, opts.project.path);
  const tmux = opts.tmux ?? new RealTmuxDriver();
  const tasks = new TaskStore(db); const agents = new AgentStore(db);
  const missions = new MissionStore(db); const readiness = new Readiness(db);
  const config = new ConfigStore(db);
  ensureVapidKeys(config); // generate the web-push VAPID keypair on first boot (idempotent thereafter)
  // Seed the daemon-wide LSP manager from the persisted toggle — before this, /lsp silently reset to
  // "on" at every daemon restart. Runtime flips (the /lsp command, PUT /config) keep both in sync.
  lspManager().setEnabled(config.get().lspEnabled);
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
  const taskUsage = new TaskUsageStore(db);
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
  // Reuse the existing agent token across restarts so a daemon restart doesn't 401 in-flight agents
  // mid-task (they hold the token they were spawned with); only mints fresh when none is valid.
  const serviceToken = users.count() > 0 ? users.ensureAgentToken(users.list()[0]!.id) : '';
  const elowenCli = { cli, url: `http://localhost:${(process.env.ELOWEN_PORT) ?? 4400}`, token: serviceToken };
  const spawn = new SpawnService({ tmux, agents, elowen: elowenCli, providers: (program) => config.get().providers[program], prompts, tddMode: () => config.get().autopilot.tddMode });
  const bus = new EventBus();
  const events = new EventStore(db);
  const notes = new NoteStore(db);
  // Activity trail: mirror every bus event into the log file as a readable one-liner, so the log on
  // its own tells the story of a run (spawns, advances, plans) without cross-referencing the DB.
  bus.subscribe((e) => log.info(describeEvent(e)));
  // The overseer relay client, rebuilt per-call so a key set/cleared at runtime takes effect.
  // Overseer decisions use their own model when set, else fall back to the planner model.
  // Returns null when no API key is configured (callers then keep their pre-relay behaviour).
  const overseerClient = () => {
    const cfg = config.get(); const relay = config.autopilotRelay();
    if (!relay) return null;
    return new RelayClient({ baseUrl: relay.baseUrl, apiKey: relay.apiKey, model: cfg.autopilot.overseerModel || cfg.autopilot.model });
  };
  // Shared reasoning stores: the async planning job registry and the per-mission decision queue.
  // The Pilot spawns a repo-aware planning agent for agent-mode plan jobs (relay path needs none);
  // the Overseer parks a per-mission agent that long-polls the decision queue.
  const planJobs = new PlanJobStore();
  const decisionQueue = new DecisionQueue();
  const pilot = makePilot({ spawn, config, projects, planJobs, tmux, nameAgent: uniqueName, cli, prompts });

  // PR-native git lifecycle (no-op unless Settings → PR workflow is enabled): each mission runs in an
  // isolated worktree on its own branch, commits per approved phase, and (later stages) opens a PR.
  const missionPrs = new MissionPrStore(db);
  const missionGit = new MissionGit({ prs: missionPrs, config, projects, tasks });

  // The overseer must be parked INSIDE the mission's worktree (via missionGit) so its read-only
  // `git diff` judges the agent's actual work, not the unchanged main checkout.
  const overseer = makeOverseer({ spawn, tmux, config, queue: decisionQueue, cli, missionGit, missions, prompts });

  // Phone push: a single bus subscriber maps lifecycle events (review escalation, needs_input, stall,
  // completion) to web-push notifications for the mission's owner + admins. No-op until a user
  // subscribes a device and (implicitly) VAPID keys exist — generated above on first boot.
  const pushSender = new PushSender(pushSubscriptions, () => config.webPushKeys());
  new PushDispatcher({ missions, tasks, users, sender: pushSender, missionGit }).subscribe(bus);
  // Snapshot each task's token/cost usage into task_usage as it settles, so the stats page reads
  // DB aggregates instead of re-scanning the CLIs' session stores. Resolve the same path the live
  // usage endpoint does (mission worktree under PR-native, else the project checkout). The same
  // path + fallback also drive resume-session capture (shared with the stuck detector below).
  const usagePathFor = (task: { project_id: number; parent_id: string | null }) =>
    usagePath(task, (pid) => projects.get(pid)?.path ?? homeProject.path, (id) => missionGit?.worktreeFor(id));
  const resumeFallback = { program: 'claude-code', model: 'sonnet' };
  new UsageRecorder({ usage: taskUsage, tasks, fallback: resumeFallback, pathFor: usagePathFor }).subscribe(bus);

  // One shared per-checkout git lock across the scheduler, mission engine and API server, so a phase's
  // commit+snapshot at close never interleaves with another agent's baseline read on the same checkout.
  const gitLock = new KeyedMutex();
  const engine = new MissionEngine({
    tasks, readiness, missions, users, spawn, tmux, bus, projects,
    fallback: { program: 'claude-code', model: 'sonnet' }, nameAgent: uniqueName, clock: new SystemClock(),
    overseer, missionGit, gitLock,
    // On natural completion, ask the overseer model to write the mission's "what happened" prose.
    // No relay key → return blank so the engine writes its own deterministic phase digest instead.
    summarize: async (ctx) => {
      const inf = overseerClient();
      if (!inf) return '';
      const { text } = await inf.decide(missionSummaryPrompt(ctx));
      return text;
    },
  });
  const scheduler = new Scheduler({ tasks, spawn, bus, missions, users, projects, fallback: { program: 'claude-code', model: 'sonnet' }, nameAgent: uniqueName, clock: new SystemClock(), gitLock, worktreeFor: (id) => missionGit?.worktreeFor(id) });
  // Deriver resolves a session's task via the agent registry / in-progress task (simplified: first in_progress child).
  // Resolve a session's task via its agent:<name> label. Agent names recur across missions,
  // so pick the MOST RECENT match (list is created_at ASC) — never an old same-named task,
  // which would make the janitor reap a live agent or skip a real zombie.
  const taskForSession = (session: string) => {
    const name = session.replace(/^elowen-/, '');
    const matches = tasks.list().filter((t) => t.labels.includes(`agent:${name}`));
    return matches[matches.length - 1] ?? null;
  };
  // Persist every bus event into the activity log, stamping its owning project (resolved for ALL event
  // types, not just task/review) so the timeline can be scoped per-tenant. Subscribed here — after
  // taskForSession exists — because resolving a signal event's project needs it.
  const eventDeps: EventProjectDeps = {
    taskProject: (id) => tasks.get(id)?.project_id ?? null,
    sessionProject: (s) => taskForSession(s)?.project_id ?? null,
    jobProject: (id) => planJobs.get(id)?.projectId ?? null,
  };
  bus.subscribe((e) => { try { events.record(e, eventProjectId(e, eventDeps)); } catch (err) { log.error('event record failed', err); } });
  // The active mission owning a session (via its task's parent epic), or null for a manual launch.
  const missionIdForSession = (session: string): string | null => {
    const t = taskForSession(session);
    if (!t?.parent_id) return null;
    return missions.activeForEpic(t.parent_id)?.id ?? null;
  };
  // Render an inline overseer decision prompt through the task owner's overrides (else file default),
  // so a user's edited decision-* prompts drive the auto-clear/choice verdicts for their own tasks.
  const decisionRenderer = (taskId: string) => (name: string, vars?: Record<string, string>) =>
    prompts.render(name, vars, resolveOwnerId({ tasks, missions, users }, { taskId }));
  const deriver = new Deriver({
    tmux, agents, tasks, sink: bus, clock: new SystemClock(),
    // Resolve strictly via the agent:<name> label. No global "first in-progress task" fallback:
    // the parked Overseer (elowen-overseer-<id>) and the Pilot have no task row, and the fallback would
    // mis-attribute their panes — even pressing accept-keys into the Overseer's TUI. Unresolved → skip.
    sessionTaskId: (session) => taskForSession(session)?.id ?? null,
    autonomyFor: (session) => {
      const t = taskForSession(session);
      if (!t?.parent_id) return null;
      return missions.activeForEpic(t.parent_id)?.autonomy ?? null;
    },
    missionFor: missionIdForSession,
    // Overseer decision for an auto-cleared prompt: the parked agent (queue) when overseerExec is set
    // and the prompt belongs to a mission, else the relay.
    decideApproval: async (input) => {
      // Per-autonomy confidence bar: L1 (Assist) is held stricter than L2/L3 so it auto-runs only
      // clearly-safe steps. One source of truth, applied on every gate path below.
      const minConfidence = minConfidenceFor(input.autonomy);
      // Persist what the autopilot decided against the task it ran for, so the detail pane can show the
      // agent↔autopilot conversation. Only the real overseer paths (queue/relay) record — the
      // no-overseer fallback has no verdict/rationale to show.
      const recordPrompt = (gated: { approve: boolean }, rationale: string, confidence: number) =>
        bus.publish({ type: 'decision', taskId: input.taskId, kind: 'prompt', question: input.question, outcome: gated.approve ? 'approved' : 'escalated', rationale, confidence });
      if (input.missionId && config.get().autopilot.overseerExec) {
        const v = await decisionQueue.enqueue(input.missionId, 'prompt', { question: input.question, context: input.context, options: input.options });
        const gated = gateVerdict(v, { minConfidence });
        recordPrompt(gated, v.rationale, v.confidence);
        return gated;
      }
      const inf = overseerClient();
      // No overseer wired at all: only L3 may wave a prompt through; L1/L2 escalate
      // instead of being blindly approved (that blanket-approve was the bug that collapsed L2 into L3).
      if (!inf) return noOverseerFallback(input.autonomy);
      const d = await decidePrompt(inf, input, decisionRenderer(input.taskId));
      const gated = gateVerdict(d, { minConfidence });
      recordPrompt(gated, d.rationale, d.confidence);
      return gated;
    },
    // The agent asked the user to pick an option. This routes through the SAME overseer that judges
    // prompts/reviews: the parked agent via the decision queue when one is configured, else the relay
    // inference as a fallback. A null choiceId escalates to a human: no overseer, an unknown/absent
    // option id, or below the autonomy confidence bar.
    decideQuestion: async (input) => {
      const minConfidence = minConfidenceFor(input.autonomy);
      // Gate a raw verdict (parked agent OR relay) into a final choiceId: the picked id must be a real
      // option and clear the autonomy confidence bar.
      const gate = (choice: string | undefined, confidence: number) => {
        const chosen = choice ? input.options.find((o) => o.id === choice) : undefined;
        if (!chosen || confidence < minConfidence) return { choiceId: null };
        return { choiceId: chosen.id };
      };
      // Persist the question verdict (chosen option or escalation) for the task's conversation feed.
      const recordChoice = (res: { choiceId: string | null }, rationale: string, confidence: number) =>
        bus.publish({ type: 'decision', taskId: input.taskId, kind: 'choice', question: input.question, outcome: res.choiceId ? 'chose' : 'escalated', rationale, confidence, optionLabel: res.choiceId ? input.options.find((o) => o.id === res.choiceId)?.label : undefined });
      if (input.missionId && config.get().autopilot.overseerExec) {
        const v = await decisionQueue.enqueue(input.missionId, 'question', { question: input.question, context: input.context, options: input.options });
        const res = gate(v.choice, v.confidence);
        recordChoice(res, v.rationale, v.confidence);
        return res;
      }
      const inf = overseerClient();
      if (!inf) return { choiceId: null };
      const v = await decideChoice(inf, input, decisionRenderer(input.taskId));
      const res = gate(v.choice === 'escalate' ? undefined : v.choice, v.confidence);
      recordChoice(res, v.rationale, v.confidence);
      return res;
    },
  });
  // Setup mode: with no users yet the daemon is open so the onboarding page can run before login;
  // auth (in authMiddleware) re-engages automatically once the first admin is created.
  if (users.count() === 0) {
    log.warn('SETUP MODE — no users yet; the API is open until the first admin is created via onboarding');
  }
  const avatarsDir = opts.dbPath === ':memory:' ? undefined : join(dirname(opts.dbPath), 'avatars');
  // Per-process secret for short-lived signed avatar URLs (finding W2) — keeps the long-lived session
  // token out of <img> src query strings. Rotates on restart; links live ~5 min, so that's harmless.
  const avatarSecret = randomBytes(32).toString('hex');
  // Per-user advisor: a persistent assistant session controlling Elowen on the user's behalf. Its cwd
  // is a neutral per-user dir (alongside the DB, NOT a project checkout) so the per-program MCP config
  // never pollutes a repo. Disabled for the in-memory DB (tests build their own AdvisorService).
  const mcpUrl = `${elowenCli.url}/mcp`; // the daemon hosts the MCP server on its own /mcp route
  const advisor = opts.dbPath === ':memory:' ? undefined : new AdvisorService({
    spawn, tmux, users, config, fallback: { program: 'claude-code', model: 'sonnet' },
    projectId: homeProject.id, url: elowenCli.url, mcpUrl,
    advisorDir: (id) => { const p = join(dirname(opts.dbPath), 'advisor', String(id)); mkdirSync(p, { recursive: true }); return p; },
    prepareMcp: (program, cwd, token) => writeMcpConfig(program, cwd, token, mcpUrl),
    prompts,
    advisorStyle: (id) => userSettings.cliSettings(id).advisorStyle,
  });
  // Per-user embedded brain (the new advisor engine): an in-process PI agent session. Wired only when
  // a provider is configured (reuses the relay endpoint) and not for the in-memory test DB. Coexists
  // with the spawn-CLI advisor — routes degrade to 503 when left unwired.
  // Plugin scan roots: the bundled dist/plugins dir + the instance data-dir plugins/. Shared by the
  // brain's lazy loader and the admin /plugins listing so both always see the same set.
  const userPluginDir = join(dirname(opts.dbPath), 'plugins');
  const pluginDirs = [join(dirname(fileURLToPath(import.meta.url)), '..', 'plugins'), userPluginDir];
  const pluginDataRoot = join(dirname(opts.dbPath), 'plugins-data');
  // The brain's credential store: OAuth tokens (Anthropic/Copilot/OpenAI accounts) persist here and
  // pi refreshes them in place. Lives next to the brain's cwd, never inside a repo checkout.
  const brainDir = (() => { const p = join(dirname(opts.dbPath), 'brain'); mkdirSync(p, { recursive: true }); return p; })();
  const brainAuth = opts.dbPath === ':memory:' ? AuthStorage.inMemory() : AuthStorage.create(join(brainDir, 'auth.json'));
  const brainOauth = new BrainOAuthManager(brainAuth);
  // Live provider resolver: adding a provider / connecting an account in Settings applies to the next
  // brain start without a daemon restart.
  const brainConfig = () => brainConfigFromElowen(config, brainAuth);
  // Central provider credential resolver exposed to plugins (voice STT/TTS, image gen) so they reuse the
  // operator's configured provider key instead of duplicating a secret. Reads live config each call.
  const resolveProvider = (id: string) => {
    const p = config.brainProviders().find((x) => x.id === id);
    return p ? { id: p.id, label: p.label, type: p.type, baseUrl: p.baseUrl, apiKey: p.apiKey } : null;
  };
  // Text→vector embedder for Elowen memory (consumed by Phase-4 retrieval); reuses the operator's brain
  // provider credentials via the same resolver plugins get. Pure network service, no DB access.
  const embeddings = new EmbeddingService({ resolveProvider });
  const brainStore = new BrainStore(db);
  const personalityStore = new PersonalityStore(db);
  // SINGLE SOURCE for the personality system-prompt chunk: the brain (activePersonality seam) and the
  // preview route both render through this ONE instance, so the chunk/persona can never drift. Reuses the
  // exact prompts/users/agentName seams the brain uses.
  const personalityService = new PersonalityService({
    store: personalityStore, prompts, users,
    userSettings: (userId) => userSettings.cliSettings(userId),
    agentName: () => config.get().brain.agentName,
  });
  const memoryStore = new MemoryStore(db);
  // ONE embedding-config mapper shared by the retrieval service AND the background embed queue, so both
  // read the same live config each call (a Settings change applies without a restart). Empty
  // providerId/model → the service degrades to keyword search and the queue no-ops.
  // Tool-output preview caps (Elowen AI → Limits) feed the shared messageView renderer; read live.
  setToolOutputCaps(() => ({ lines: config.get().brain.limits.toolOutputMaxLines, chars: config.get().brain.limits.toolOutputMaxChars }));
  // Tool-output VISIBILITY policy (single source, mirrors the icon pipeline): output is hidden by
  // default; the built-in show defaults plus every enabled plugin's manifest `showOutput` are merged and
  // injected into the shared messageView renderer so the live (events.ts) and history (shapeBrainMessages)
  // paths show the same tools' output. `pluginOutputShowPatterns` is refreshed on each plugin (re)load
  // below, so a newly enabled plugin's policy applies without a daemon restart — read live per render,
  // like the caps above.
  let pluginOutputShowPatterns: readonly string[] = [];
  setToolOutputPolicy(makeToolOutputPolicy(() => [...BUILTIN_TOOL_OUTPUT_SHOWN, ...pluginOutputShowPatterns]));
  const embeddingConfig = () => toEmbeddingConfig(config.embeddingConfig());
  // Vector retrieval + anti-duplication over the memory store (owner chat only — the caller gates it).
  const memoryService = new MemoryService({
    store: memoryStore, embeddings, embeddingConfig,
    // Per-turn recall size is operator-tuned (Elowen AI → Limits); read live so a change applies without a restart.
    recallDefaults: () => ({ count: config.get().brain.limits.memoryRecallCount, chars: config.get().brain.limits.memoryRecallChars }),
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
  // the explicit memory_* tools). NOTE: deliberately NOT the autopilot model — memory is its own concern.
  const memoryCategoryStore = new MemoryCategoryStore(db);
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
  // loading is lazy (buildApp is sync), and a plugin toggle invalidates every consumer at once —
  // a per-service memo would leave the workers on a stale registry until a daemon restart.
  const pluginProvider = new PluginRegistryProvider(() => {
    const enabled = config.get().plugins.enabled;
    const pluginConfig = Object.fromEntries(enabled.map((n) => [n, config.pluginConfig(n)]));
    return loadPlugins({
      dirs: pluginDirs, enabled, config: pluginConfig, dataRoot: pluginDataRoot,
      notify: (t, channelId) => brain?.notify(t, channelId) ?? Promise.resolve(),
      // Interactive transports (Discord) hand a parked ask_user_question's answer straight back in-process.
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
      logger: log,
    }).then((registry) => {
      // Snapshot the merged plugin output-show patterns so the (sync) messageView policy above reads the
      // current set — refreshed on every reload (a plugin toggle invalidates this provider), so a newly
      // enabled plugin's `showOutput` applies without a daemon restart.
      pluginOutputShowPatterns = [...registry.toolShowOutput];
      return registry;
    });
  });
  // Bounded ring of recent mutating-hook execution records. The brain's owner-chat hook runner is the
  // sole writer (via the audit sink below); the admin plugins API reads it (per-plugin hook-audit view).
  const hookAudit = new HookAuditBuffer();
  const brain: BrainService | undefined = opts.dbPath !== ':memory:'
    ? new BrainService({
        store: brainStore, users, config: brainConfig, prompts, url: elowenCli.url,
        authStorage: brainAuth,
        cwd: brainDir,
        projectPath: () => homeProject.path,
        plugins: pluginProvider,
        hookAudit,
        policy: (userId) => resolvePolicy({ userProjects, projects }, userId),
        userSettings: (userId) => userSettings.cliSettings(userId),
        // Granular tool permissions (allow/ask/deny rules + the persisted YOLO default) and the
        // "Always allow" persistence behind the owner-chat approval prompt.
        permissions: (userId) => userSettings.permissionSettings(userId),
        saveAlwaysAllow: (userId, scope, pattern) => { userSettings.addPermissionAllowRule(userId, scope, pattern); },
        activePersonality: (userId, platform) => personalityService.activeAppend(userId, platform),
        agentName: () => config.get().brain.agentName,
        maxSteps: () => config.get().brain.maxSteps,
        brainLimits: () => config.get().brain.limits,
        resolvePlatformUser: (platform, platformUserId) => {
          if (!platformUserId) return null;
          // Discord ids are bare snowflakes; WhatsApp userIds are JIDs (e.g. "420778433908@s.whatsapp.net"
          // or a "<id>@lid") — strip to digits so it matches the stored phone number.
          let key: 'discordUserId' | 'whatsappNumber';
          let value: string;
          if (platform === 'discord') { key = 'discordUserId'; value = platformUserId; }
          else if (platform === 'whatsapp') { key = 'whatsappNumber'; value = platformUserId.replace(/[@:].*$/, '').replace(/[^\d]/g, ''); }
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
        policyForProjects: (ids) => ({
          allowedProjectIds: new Set(ids),
          allowedPaths: () => ids.map((id) => projects.get(id)?.path).filter((p): p is string => !!p),
        }),
        platformOwner: () => users.list().find((u) => u.is_admin)?.id,
        // Private long-term memory: the owner-chat memory tools + per-turn retrieval injection + the
        // post-turn curator. All owner-gated inside BrainService (channels/workers never reach them).
        memoryStore, memoryService, inference: memoryModelInference,
        // Auto-categorize newly-added durable memories (fire-and-forget from the curator) + the owner's
        // memory_category_* tools (create/delete/recategorize).
        memoryCategorizer, memoryCategoryStore,
      })
    : undefined;
  // Wake the operator's conversation when a background command they started finishes ON ITS OWN (a killed
  // one is dropped before its close fires, so it never wakes). Delivered as an INTERNAL turn — no 'you'
  // bubble, and it runs after any in-flight turn — so a completed build/command nudges the agent instead of
  // the operator having to poke it manually. Best-effort: a wake failure is swallowed.
  // Keep the owner's live process panels (CLI + web) in step out of turn: every spawn/exit/kill pushes
  // the fresh snapshot to the owner's client streams, so a killed/finished process leaves the panel
  // without the client polling (single source of truth — no local delete on the click path).
  processRegistry.setChangeListener(() => brain?.broadcastProcesses(processRegistry.list()));
  processRegistry.setExitListener((info, userId, sessionId) => {
    if (!brain || userId == null) return;
    const status = info.exitCode === 0 ? 'finished successfully' : `exited (code ${info.exitCode})`;
    const text = `⚙️ Background command \`${info.command}\` ${status}. If it matters, read its output with `
      + `read_process_output("${info.id}") and continue; otherwise just carry on.`;
    // `systemNudge`: no 'you' bubble, dropped if the target session is already streaming, and it never
    // drives the goal loop (so a wake can't spend a goal-budget turn or mis-judge an active goal). Bound to
    // the session the command was started in — not whatever conversation is currently active.
    void brain.send({
      userId,
      text,
      mode: 'build',
      internal: { systemNudge: true },
      session: sessionId ?? undefined,
    })
      .catch(() => { /* best-effort wake */ });
  });
  // The elowen exec engine: tasks with an `elowen:` exec run on an embedded PI session instead of a
  // spawned CLI. Shares the brain's providers/auth/plugins; closes tasks through the same REST route.
  const brainWorkers = new BrainWorkerService({
    store: brainStore, tasks, bus, taskUsage,
    config: brainConfig, authStorage: brainAuth, prompts,
    url: elowenCli.url, token: elowenCli.token,
    plugins: pluginProvider, // the SAME shared registry — a plugin toggle reaches workers too
  });
  spawn.attachBrainWorker(brainWorkers);
  // Brain workers have no tmux pane — the stuck detector and startup reconcile must see their live
  // sessions or they would reap every running elowen task as dead.
  const liveSessions = { list: async () => [...(await tmux.list()), ...brainWorkers.liveSessionNames()] };
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
    reload: () => brain?.reloadPlugins() ?? Promise.resolve(),
  });
  marketplace.sweep(); // clear crash debris (.staging-*/.old-*) left by an interrupted install
  // The admin-only `/restart` slash command: announce it on the platforms (Discord main channel), drop a
  // marker so the NEXT boot announces "back online", then hand off to systemd. Runs in prod only (a
  // :memory: test DB has no config dir + no units). `setTimeout` lets the HTTP response flush before the
  // process is torn down. systemctl() self-elevates via sudo when not root (www-data has passwordless).
  const restartMarker = opts.dbPath !== ':memory:' ? join(dirname(opts.dbPath), '.restart-marker') : undefined;
  const restartDaemon = restartMarker
    ? async (byUserId: number): Promise<void> => {
        log.info(`/restart requested by user ${byUserId}`);
        await brain?.notify('🔄 **Restart** — Elowen is restarting, back in a moment…').catch(() => { /* best-effort */ });
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
              void brain?.notify('⚠️ **Restart failed** — the daemon could not restart itself. Check the service logs.').catch(() => { /* best-effort */ });
            }
            // On success this process is torn down before the promise settles — nothing more to do.
          });
        }, 800);
      }
    : undefined;
  // Late-bind the restart handler onto the brain so a platform `/restart` slash (Discord) reaches the
  // same systemd path the web/CLI command uses. Built here (needs the units + marker), wired now.
  if (brain && restartDaemon) brain.restartHandler = restartDaemon;

  const app = createServer({ tasks, readiness, missions, engine, missionGit, gitLock, spawn, tmux, bus, events, notes, agents, project: homeProject, fallback: { program: 'claude-code', model: 'sonnet' }, cli, clock: new SystemClock(), config, users, projects, userProjects, pushSubscriptions, userPrompts, userSettings, pluginDirs, pluginDataRoot, brainOauth, brainAuth, prompts, taskUsage, git, avatarsDir, avatarSecret, planJobs, decisionQueue, pilot, advisor, brain, restartDaemon, brainWorkers, brainStore, personalityStore, memoryStore, memoryCategoryStore, memoryCategorizer, embeddings, plugins: pluginProvider, marketplace, pluginLogs, hookAudit, tickets });

  // Root-cause recovery: after a daemon crash/restart, tasks left 'in_progress' whose tmux
  // session is gone are zombies — revert them to 'open' so they can be picked up again. No grace
  // or relaunch counter here: a restart isn't an agent death, so it shouldn't spend the budget.
  const reconcileZombies = async () => {
    const live = new Set((await liveSessions.list()).filter((s) => s.startsWith('elowen-')));
    for (const t of deadAgentTasks(live, tasks.list({ status: 'in_progress' }))) {
      tasks.setStatus(t.id, 'open');
      bus.publish({ type: 'task', taskId: t.id, status: 'open' });
    }
  };

  // After a restart the parked overseers are gone (their tmux sessions died with the daemon). When an
  // agent overseer is configured, re-park one per active mission and kill any orphan overseer session
  // whose mission is no longer active. Inert when overseerExec is empty (relay handles decisions).
  const reconcileOverseers = async () => {
    if (!config.get().autopilot.overseerExec) return;
    const live = new Set((await tmux.list()).filter((s) => s.startsWith('elowen-overseer-')));
    const activeIds = new Set(missions.active().map((m) => m.id));
    for (const s of live) {
      const id = s.replace('elowen-overseer-', '');
      if (!activeIds.has(id)) await tmux.kill(s).catch(() => { /* already gone */ });
    }
    for (const m of missions.active()) {
      if (live.has(`elowen-overseer-${m.id}`)) continue;
      const epic = tasks.get(m.epic_id);
      const proj = epic ? projects.get(epic.project_id) : null;
      if (proj) await overseer.start(m.id, proj.id, proj.path);
    }
  };

  const startLoops = () => {
    const clock = new SystemClock();
    // One-shot startup sweeps. Log on failure (e.g. tmux missing) so a silent rejection can't leave
    // zombies un-reverted — that would stall every mission until the next restart.
    void reconcileZombies().catch((e) => log.error('reconcileZombies failed', e));
    // Restart zombies on the brain side: goals still marked 'active' whose in-memory continuation timers
    // died with the process. Pause them so nothing falsely claims to be running (the user /goal resumes).
    try { brain?.reconcileGoalsOnBoot(); } catch (e) { log.error('reconcileGoalsOnBoot failed', e); }
    // Bring up plugin platform channels (Discord bot, …). Fail-open per adapter. If this boot follows an
    // operator `/restart`, announce "back online" once the platforms are connected, then clear the marker
    // (so ordinary restarts/deploys stay quiet — only a user-triggered restart is echoed).
    void brain?.startPlatforms(log).then(async () => {
      if (restartMarker && existsSync(restartMarker)) {
        // Only echo "back online" for a restart that's actually RECENT. A stale marker (e.g. a failed
        // restart whose cleanup didn't run, or a very old crash) must not make an ordinary later deploy
        // falsely announce recovery. The marker holds the request timestamp.
        let fresh = false;
        try { fresh = Date.now() - Number(readFileSync(restartMarker, 'utf8')) < 5 * 60_000; } catch { /* unreadable → treat as stale */ }
        if (fresh) await brain?.notify('✅ **Back online** — Elowen restarted and is ready.').catch(() => { /* best-effort */ });
        try { unlinkSync(restartMarker); } catch { /* already gone */ }
      }
    }).catch((e) => log.error('startPlatforms failed', e));
    void reconcileOverseers().catch((e) => log.error('reconcileOverseers failed', e)); // re-park overseers for active missions / kill orphans
    // Self-heal the agent-workflow skill: (re)install the bundled `elowen-workflow` SKILL.md into every
    // present provider on boot. Best-effort — installAll catches its own per-provider errors and never
    // throws, so this can't block or crash startup. Covers `elowen install` (first boot) and `elowen update`
    // (restart) with one code path, always as the spawning user. Skipped under the in-memory test DB.
    if (opts.dbPath !== ':memory:') {
      const done = createSkillService().installAll().filter((r) => r.installed).map((r) => r.provider);
      if (done.length) log.info(`installed elowen-workflow skill for: ${done.join(', ')}`);
    }
    const stopDeriver = deriver.start();
    const stopOverseer = clock.setInterval(() => { for (const m of missions.live()) void engine.tick(m.id); }, 90000);
    const stopScheduler = clock.setInterval(() => { void scheduler.tick(); }, 30000);
    // Janitor: reap finished agents' zombie tmux sessions. Log what it reaps so the trail shows when
    // a session was cleaned up (and that the janitor is alive).
    const stopJanitor = clock.setInterval(() => {
      void sweepFinishedSessions({ tmux, taskForSession })
        .then((reaped) => { if (reaped.length) log.info(`janitor reaped ${reaped.length} finished session(s): ${reaped.join(', ')}`); })
        .catch((e) => log.error('janitor sweep failed', e));
    }, 60000);
    // Stuck detector: an agent that died without `elowen close` leaves its task in_progress with a
    // dead session; revert it so the mission re-spawns (bounded), else escalate. 2-min grace
    // covers the spawn→session window; relaunch at most twice before escalating to a human.
    const stopStuck = clock.setInterval(() => {
      void sweepStuckTasks({ tmux: liveSessions, tasks, bus, now: clock.now(), graceMs: 120000, maxRelaunch: 2,
        // Stamp the dead agent's session for resume so the relaunch continues it (best-effort).
        onReap: (t) => { try { captureResumeLabel({ tasks, pathFor: usagePathFor, fallback: resumeFallback }, t); } catch (e) { log.warn(`resume capture failed for stuck task ${t.id}`, e); } } })
        .then(({ reverted, escalated }) => {
          if (reverted.length) log.warn(`stuck detector reverted ${reverted.length} dead-agent task(s) to open: ${reverted.join(', ')}`);
          if (escalated.length) log.error(`stuck detector escalated ${escalated.length} task(s) to blocked after max relaunches: ${escalated.join(', ')}`);
        })
        .catch((e) => log.error('stuck sweep failed', e));
    }, 60000);
    // Overseer watchdog: a parked overseer can die mid-mission (TUI crash, OOM) and would otherwise
    // leave the mission running unsupervised until the next daemon restart. reconcileOverseers is
    // idempotent — it re-parks a missing overseer for each active mission and kills orphans — so run
    // it periodically, not just on boot.
    const stopOverseerWatchdog = clock.setInterval(() => { void reconcileOverseers().catch((e) => log.error('overseer watchdog failed', e)); }, 60000);
    // Universal agent-liveness sweep. One signal — did the agent's tmux pane change since last look? —
    // decides everything, so it works the same for any CLI tool (no timer/keyword parsing). A live but
    // STATIC worker is woken via the overseer ('check'); a parked decision escalates only when its
    // overseer is genuinely unsupervised (session dead past grace, or its OWN pane static past the bar),
    // never just because it's thinking. `deadSince`/`inflightChecks`/`paneTracker` persist across sweeps.
    const decisionDeadSince = new Map<string, number>();
    const inflightChecks = new Set<string>();
    const progressLastAt = new Map<string, number>();
    const paneTracker = new PaneActivityTracker();
    const NUDGE_MAX = 2;
    // Escalate a wedged worker to a human — but never if its mission was torn down meanwhile (drain race).
    const escalateWorker = (taskId: string): void => {
      const task = tasks.get(taskId);
      if (!task || task.status === 'blocked') return;
      if (task.parent_id && !missions.activeForEpic(task.parent_id)) return; // mission gone → no-op
      tasks.setStatus(taskId, 'blocked');
      bus.publish({ type: 'task', taskId, status: 'blocked' });
    };
    // Restart a wedged worker: kill its session and revert the task so the scheduler respawns it, resuming
    // its session. Reuses the dead-agent stuck path (shared `stuck:<n>` budget bounds total churn).
    const restartWorker = async (task: Task): Promise<void> => {
      const name = task.labels.find((l) => l.startsWith('agent:'))?.slice('agent:'.length);
      if (name) {
        try { captureResumeLabel({ tasks, pathFor: usagePathFor, fallback: resumeFallback }, task); } catch (e) { log.warn(`resume capture failed for ${task.id}`, e); }
        await tmux.kill(`elowen-${name}`).catch(() => { /* already gone */ });
      }
      if (tasks.bumpStuck(task.id) > 2) {
        tasks.setStatus(task.id, 'blocked');
        bus.publish({ type: 'task', taskId: task.id, status: 'blocked' });
      } else {
        tasks.setResumeNote(task.id, 'Your previous run stalled and was relaunched — re-check the current state (git status, build/tests) and carry the task to completion.');
        tasks.setStatus(task.id, 'open');
        bus.publish({ type: 'task', taskId: task.id, status: 'open' });
      }
    };
    // Wake the overseer about a worker whose screen has gone static and act on its verdict. Mirrors the
    // askService 'message' path: enqueue per-mission, fall straight to a human when there's no overseer.
    const checkWorker = async (session: string, taskId: string, snapshot: string, idleMin: number, reason: 'idle' | 'progress'): Promise<void> => {
      const task = tasks.get(taskId);
      if (!task) return;
      const missionId = missionIdForSession(session);
      // No overseer to ask: a wedged worker escalates to a human; a routine progress glance just no-ops —
      // never block a healthy, working agent just because nobody happens to be watching.
      if (!missionId || !config.get().autopilot.overseerExec) { if (reason === 'idle') escalateWorker(taskId); return; }
      let verdict: DecisionResult;
      try { verdict = await decisionQueue.enqueue(missionId, 'check', { taskId, session, paneSnapshot: snapshot, idleMin, reason }); }
      catch (e) { log.error(`check enqueue failed for ${session}`, e); return; }
      const m = missions.get(missionId);
      const fresh = tasks.get(taskId) ?? task;
      const nudges = Number(fresh.labels.find((l) => l.startsWith('nudge:'))?.slice('nudge:'.length)) || 0;
      const action = checkAction(verdict, { reason, missionLive: !!m && (m.state === 'active' || m.state === 'stalled'), nudges, nudgeMax: NUDGE_MAX });
      switch (action.type) {
        case 'noop': return;
        case 'nudge':
          await tmux.sendRaw(session, action.text);
          await tmux.sendKeys(session, ['Enter']);
          tasks.bumpNudge(taskId);
          return;
        case 'steer':
          // Proactive course-correction to a working agent — delivered like a nudge but NOT counted against
          // the wedge nudge budget (it isn't a "this agent is stuck" poke).
          await tmux.sendRaw(session, action.text);
          await tmux.sendKeys(session, ['Enter']);
          return;
        case 'restart': await restartWorker(fresh); return;
        case 'escalate': escalateWorker(taskId); return;
      }
    };
    const stopDecisionSweep = clock.setInterval(() => {
      void sweepAgentLiveness({
        tmux, queue: decisionQueue, tracker: paneTracker, now: clock.now(),
        deadSince: decisionDeadSince, inflightChecks, lastProgressAt: progressLastAt,
        sessionTaskId: (s) => taskForSession(s)?.id ?? null,
        programFor: (s) => agents.programFor(s.replace(/^elowen-/, '')),
        hasPrompt: (content, program) => detectAgentPrompt(content, program) !== null,
        checkWorker,
        workerIdleMs: WORKER_IDLE_MS, overseerIdleMs: OVERSEER_IDLE_MS, graceMs: DECISION_GRACE_MS, hardMs: DECISION_HARD_MS,
        // Routine progress checks only make sense when there's an overseer to do them (0 disables).
        progressReviewMs: config.get().autopilot.overseerExec ? PROGRESS_REVIEW_MS : 0,
      })
        .then(({ escalated, checked }) => {
          if (escalated.length) log.warn(`liveness sweep escalated ${escalated.length} unanswered decision(s) to a human: ${escalated.join(', ')}`);
          if (checked.length) log.info(`liveness sweep woke the overseer about ${checked.length} idle worker(s): ${checked.join(', ')}`);
        })
        .catch((e) => log.error('liveness sweep failed', e));
    }, DECISION_SWEEP_MS);
    // Purge expired auth tokens hourly so the table can't grow unbounded over a long-running daemon.
    const purgeTokens = () => users?.purgeExpiredTokens(config.get().security.tokenTtlDays);
    purgeTokens();
    const stopTokenPurge = clock.setInterval(purgeTokens, 3_600_000);
    // Same for the activity timeline: every bus event is persisted (events.record), so without a
    // retention sweep the `events` table grows without bound. Drop rows past the 30-day window hourly.
    const purgeEvents = () => { try { events.purgeOlderThan(); } catch (e) { log.error('event purge failed', e); } };
    purgeEvents();
    const stopEventPurge = clock.setInterval(purgeEvents, 3_600_000);
    // Sweep expired terminal-WS tickets so a burst of unredeemed tickets can't grow the map unbounded.
    const stopTicketSweep = clock.setInterval(() => tickets.sweep(clock.now()), 60_000);
    // PR feedback loop (no-op unless PR mode + open PRs): poll each open PR for fresh actionable review
    // feedback and, within the fix budget, route it through the pilot (1..N fix phases on the mission's
    // exec) then re-engage the mission so an agent applies them. Relay-only (no agent pilot) degrades to
    // a single fix phase. The pilot plans in the mission's WORKTREE (not the main checkout) so it sees
    // the mission's committed changes — the code under review and the bug live on the branch, not in
    // the base checkout. The worker later applies the fix in that same worktree (missionEngine cwd).
    const replan: PrFeedbackDeps['replan'] = async ({ epicId, goal, exec }) => {
      const epic = tasks.get(epicId);
      const project = epic ? projects.get(epic.project_id) : null;
      const mission = missions.get(`m-${epicId}`);
      if (!epic || !project || !mission) return false;
      // PR-feedback CONTINUES a finished mission, so keep the existing review self-heal budgets rather
      // than resetting them on this re-engage. Flows through both the pilot and relay paths below.
      const engage = { autonomy: mission.autonomy, maxSessions: mission.max_sessions, preserveReviewBudget: true };
      if (config.get().autopilot.pilotExec) {
        const cwd = missionGit.worktreeFor(`m-${epicId}`) ?? project.path;
        // engage flag → finalizePlanJob re-engages the mission AFTER the pilot pins the phases, so a
        // completed mission doesn't disengage in the gap between engage and the phases existing.
        const job = planJobs.create({ goal, projectId: epic.project_id, epicId, dryRun: false, exec, engage, createdBy: epic.created_by ?? null });
        bus.publish({ type: 'plan', jobId: job.id, status: 'planning' });
        void pilot(job, cwd).catch((e) => { planJobs.fail(job.id, String(e)); bus.publish({ type: 'plan', jobId: job.id, status: 'failed', error: String(e) }); });
        return true;
      }
      // Relay-only fallback: append one fix phase synchronously, then engage (the phase already exists).
      const ok = await missionGit.appendFixPhase(epicId, goal, exec);
      if (ok) await engine.engage({ epicId, ...engage });
      return ok;
    };
    const stopPrFeedback = clock.setInterval(() => {
      void sweepPrFeedback({ prs: missionPrs, missions, missionGit, bus, replan })
        .then((ids) => { if (ids.length) log.info(`PR feedback re-engaged ${ids.length} mission(s): ${ids.join(', ')}`); })
        .catch((e) => log.error('PR feedback sweep failed', e));
    }, 60_000);
    const stopBrainWorkerWatchdog = brainWorkers.startWatchdog();
    // Memory embed queue: fill in missing/stale memory vectors in the background. No-ops until an
    // embedding provider/model is configured; one bad memory never aborts a drain (caught + logged).
    const stopEmbedQueue = clock.setInterval(() => {
      void embedQueue.drain().catch((e) => log.error('embed queue drain failed', e));
    }, 30_000);
    return () => { stopDeriver(); stopOverseer(); stopScheduler(); stopJanitor(); stopStuck(); stopOverseerWatchdog(); stopDecisionSweep(); stopTokenPurge(); stopEventPurge(); stopTicketSweep(); stopPrFeedback(); stopBrainWorkerWatchdog(); stopEmbedQueue(); };
  };
  return { app, startLoops, tickets, tmux };
}
