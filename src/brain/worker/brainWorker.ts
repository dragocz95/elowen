import { defineTool } from '@earendil-works/pi-coding-agent';
import type { AgentSession, ModelRuntime, ResourceLoader, createAgentSession } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { BrainStore } from '../../store/brainStore.js';
import type { TaskStoreContract, TaskUsageContract } from '../../store/taskStoreContract.js';
import type { EventBus } from '../../api/sse.js';
import type { BrainRuntimeConfig } from '../providers.js';
import { buildBrainRegistry, resolveBrainModelRoute } from '../providers.js';
import { newCostMeter, runWithMeter, type CostMeter } from '../openrouterMeter.js';
import { projectUserTurn } from '../persistence.js';
import { taskSessionId } from '../sessionId.js';
import { BrainSessionFactory, resolveAutoCompactPct } from '../session/factory.js';
import type { BrainResourceLoaderOptions } from '../session/factory.js';
import { DEFAULT_AUTO_COMPACT_PCT } from '../session/liveBrain.js';
import { abortSessionWork } from '../session/abortSessionWork.js';
import { composeSessionTools } from '../session/capabilities.js';
import { supportsOpenAIHostedToolSearch } from '../session/openAiHostedToolSearch.js';
import { supportsAnthropicHostedToolSearch } from '../session/anthropicHostedToolSearch.js';
import { PluginHookBus } from '../../plugins/hookBus.js';
import { runWithPolicy } from '../../plugins/policyContext.js';
import type { PluginRegistryProvider } from '../../plugins/pluginsProvider.js';
import { callElowenApi } from '../../shared/apiClient.js';
import { renderPromptFor } from '../../prompts/index.js';
import { tddDirective } from '../../prompts/tdd.js';
import type { PromptService } from '../../prompts/promptService.js';
import type { TokenUsage } from '../../integrations/usage/types.js';
import { execRefSpec } from '../../shared/execs.js';
import { logger } from '../../shared/logger.js';
import { userInstructionsBlock } from '../../prompts/userInstructions.js';

const log = logger('brain-worker');

/** How long a worker may sit with no PI events before the watchdog reaps it (a wedged upstream). */
const DEFAULT_IDLE_MS = 10 * 60_000;
const WATCHDOG_TICK_MS = 60_000;

export interface BrainWorkerDeps {
  store: BrainStore;
  /** The task domain, resolved LIVE (its owning plugin can be disabled or reloaded under a running
   *  worker). Undefined ⇒ no task tracking on this instance: a launch must refuse, not pretend. */
  tasks: () => TaskStoreContract | undefined;
  bus: EventBus;
  taskUsage?: () => TaskUsageContract | undefined;
  /** Where a tool result's image bytes are externalized when a worker turn is persisted — a task worker
   *  reads screenshots too, and its rows must not carry base64 either. */
  chatImagesDir?: string;
  /** Live provider config resolver (null → nothing configured, launch fails clearly). */
  config: () => BrainRuntimeConfig | null;
  runtime: ModelRuntime;
  prompts?: PromptService;
  /** Daemon REST base + token the close tool calls (same reach-back the CLI workers use). */
  url: string;
  token: string;
  /** The daemon-wide shared plugin registry — the SAME provider the chat brain uses, so a plugin
   *  toggle invalidates both at once (a worker launched afterwards composes from the fresh registry). */
  plugins?: PluginRegistryProvider;
  /** The task owner's auto-compact settings — a worker runs on THEIR account, so it compacts at their
   *  threshold (global percentage plus any per-model override) instead of a fixed default. */
  userSettings?: (userId: number) => { autoCompactAt?: number; autoCompactAtByModel?: Record<string, number> };
  /** Raw global instructions for the task owner. Wrapped and escaped at worker spawn like owner chat. */
  userInstructions?: (userId: number) => string | undefined;
  /** Tool names the task owner must not reach (their admin-set deny-list plus the tools of any
   *  grant-gated plugin they hold no grant for). A worker runs unattended ON that account, so it gets
   *  the same answer chat does — the same seam, so the two cannot drift into different rules. */
  deniedTools?: (userId: number) => string[];
  now?: () => number;
  idleMs?: number;
  createSession?: typeof createAgentSession;
  fetchImpl?: typeof fetch;
  /** Injected for tests; production builds the disk-free DefaultResourceLoader below. */
  resourceLoaderFactory?: (o: BrainResourceLoaderOptions) => ResourceLoader | undefined;
}

export interface BrainWorkerLaunchInput {
  projectId: number;
  projectPath: string;
  taskId: string;
  agentName: string;
  spec: { program: string; model: string };
  taskTitle?: string;
  taskDescription?: string;
  resumeNote?: string;
  ownerId?: number | null;
  /** TDD mission mode: when on, the Test-Driven-Development directive is appended to the rendered
   *  worker-brain system prompt (outside the template, so a saved override can't drop it). Resolved
   *  centrally by the spawn layer. */
  tddMode?: boolean;
}

interface LiveWorker {
  session: AgentSession;
  sessionName: string;
  sessionId: string;
  taskId: string;
  projectId: number;
  /** The task's checkout — the bound workDir every run of this worker starts in. */
  cwd: string;
  provider: string;
  model: string;
  lastEventAt: number;
  nudged: boolean;
  closed: boolean;
  /** Accumulates the provider-reported cost of this worker's OpenRouter completions (see openrouterMeter). */
  meter: CostMeter;
}

/** Parse the exec's model part: `provider/model` when the provider id is configured, else treat the
 *  whole string as a model on the default provider (resolveBrainModel handles both). */
function selectionFor(cfg: BrainRuntimeConfig, spec: string): { provider?: string; model: string } {
  const slash = spec.indexOf('/');
  if (slash > 0) {
    const provider = spec.slice(0, slash);
    if (cfg.providers.some((p) => p.id === provider)) return { provider, model: spec.slice(slash + 1) };
  }
  return { model: spec };
}

/** Sum a live PI session's per-message usage into the normalized task-usage shape. Cost here is only
 *  pi-ai's price-sheet figure (0 for OpenRouter, whose real cost the meter recovers separately); the
 *  caller reconciles source in `recordUsage`. */
function sessionUsage(session: AgentSession): TokenUsage {
  const u: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, reasoning: 0, costUsd: null, currency: null, costSource: 'unavailable' };
  for (const m of session.messages as { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number; totalTokens?: number; cost?: { total?: number } } }[]) {
    u.input += m.usage?.input ?? 0;
    u.output += m.usage?.output ?? 0;
    u.cacheRead += m.usage?.cacheRead ?? 0;
    u.cacheWrite += m.usage?.cacheWrite ?? 0;
    u.reasoning += m.usage?.reasoning ?? 0;
    u.total += m.usage?.totalTokens ?? 0;
    const cost = m.usage?.cost?.total ?? 0;
    if (cost > 0) u.costUsd = (u.costUsd ?? 0) + cost;
  }
  return u;
}

/**
 * Runs `elowen:` tasks on the embedded brain: an in-process PI session scoped to the task's checkout
 * (Policy-guarded plugin tools + one baked-in close tool) instead of a tmux-spawned CLI. Task states
 * flow exactly as with CLI workers — the scheduler set in_progress before calling launch, and the
 * REST close route (driven by the ElowenCloseTask tool) runs the same ReviewService pipeline.
 */
export class BrainWorkerService {
  private live = new Map<string, LiveWorker>();
  /** In-flight launches per session name. The liveness guard in launchExclusive and the `live.set()` that
   *  follows it are separated by awaits (plugin registry, session factory), so two concurrent launches for
   *  one name would both pass the guard and leave the first session running with nothing tracking it. */
  private launching = new Map<string, Promise<{ session: string }>>();
  private watchdog: ReturnType<typeof setInterval> | undefined;
  /** Shared session assembly — the same factory the chat brain uses. */
  private factory: BrainSessionFactory;

  constructor(private d: BrainWorkerDeps) {
    this.factory = new BrainSessionFactory({ store: d.store, chatImagesDir: d.chatImagesDir, createSession: d.createSession, resourceLoaderFactory: d.resourceLoaderFactory });
  }

  /** tmux-style session names (`elowen-<agentName>`) for the stuck detector's composite lister. */
  liveSessionNames(): string[] { return [...this.live.keys()]; }
  isLive(sessionName: string): boolean { return this.live.has(sessionName); }

  private now(): number { return this.d.now?.() ?? Date.now(); }

  /** Launch a worker for a task, serialized per session name so the liveness guard below can't be
   *  observed by two callers at once. */
  async launch(input: BrainWorkerLaunchInput): Promise<{ session: string }> {
    const sessionName = `elowen-${input.agentName}`;
    const queued = (this.launching.get(sessionName) ?? Promise.resolve())
      .catch(() => { /* a previous launch's failure is its own caller's to handle */ })
      .then(() => this.launchExclusive(sessionName, input));
    this.launching.set(sessionName, queued);
    return queued.finally(() => { if (this.launching.get(sessionName) === queued) this.launching.delete(sessionName); });
  }

  private async launchExclusive(sessionName: string, input: BrainWorkerLaunchInput): Promise<{ session: string }> {
    // No task domain, no embedded worker: the run's whole lifecycle (read the task, revert it when the
    // agent stalls, snapshot its usage) is task rows. Refuse loudly rather than start something nothing
    // can settle — the caller (the agents plugin's spawn) reverts the task on a failed launch.
    if (!this.d.tasks()) throw new Error('elowen exec engine: task tracking is unavailable (its plugin is disabled)');
    // Idempotent ONLY for the same task. A different task under an already-live agent name gets no worker
    // of its own, so reporting success would leave it in_progress behind a session that belongs to another
    // task — which the stuck detector reads as alive, forever. The tmux path already fails here (`tmux
    // new-session` rejects a duplicate name) and every caller reverts the task on a failed launch.
    const existing = this.live.get(sessionName);
    if (existing) {
      if (existing.taskId === input.taskId) return { session: sessionName };
      throw new Error(`agent name ${input.agentName} is already running task ${existing.taskId}`);
    }
    const cfg = this.d.config();
    if (!cfg) throw new Error('elowen exec engine: no brain provider configured');

    const registry = buildBrainRegistry(cfg, this.d.runtime);
    const route = resolveBrainModelRoute(registry, cfg, selectionFor(cfg, input.spec.model));
    const { model } = route;
    const providerType = cfg.providers.find((provider) => provider.id === route.providerId)?.type;
    const hostedToolSearch = supportsOpenAIHostedToolSearch(model, providerType) ? 'openai'
      : supportsAnthropicHostedToolSearch(model, providerType) ? 'anthropic'
        : undefined;
    const sessionId = taskSessionId(input.taskId);
    const resumed = !!this.d.store.getSession(sessionId);
    // Same resolution the chat spawner runs: the owner's per-model override for THIS model wins over
    // their global percentage, which in turn wins over the built-in default.
    const ownerSettings = input.ownerId ? this.d.userSettings?.(input.ownerId) : undefined;
    const autoCompactAtPct = resolveAutoCompactPct(
      ownerSettings?.autoCompactAtByModel, route.providerId, model.id, ownerSettings?.autoCompactAt ?? DEFAULT_AUTO_COMPACT_PCT,
    );

    const cwd = input.projectPath;
    const plugins = await this.d.plugins?.get();
    // Run plugin tools through the shared composer so the "a task worker never gets the owner's Elowen*
    // control-plane tools" invariant is actually enforced here (not just true by construction) — the
    // worker's own close tool is added separately below.
    // Same `tools.call.after` fan-out as chat sessions (awaited by the tool gate, fail-open), so e.g.
    // the formatters plugin also runs — and finishes before the result returns — on files a task
    // worker writes.
    const toolHookBus = plugins && plugins.hooks.length > 0
      ? new PluginHookBus({ hooks: plugins.hooks, hookOwners: plugins.hookOwners, capabilities: plugins.pluginCapabilities, logger: log })
      : undefined;
    // Applied by NAME rather than as a policy: this factory takes no ToolPolicy, and a tool the owner
    // may not reach must not merely fail at execute time — its schema would still sit in their prompt.
    // An ownerless task keeps the full set: there is no account whose grants could withhold anything.
    const denied = new Set(input.ownerId ? this.d.deniedTools?.(input.ownerId) ?? [] : []);
    const pluginTools = composeSessionTools({
      kind: 'task-worker', pluginTools: (plugins?.tools ?? []).filter((t) => !denied.has(t.name)),
      onToolResult: toolHookBus ? (e) => toolHookBus.emit('tools.call.after', e) : undefined,
      // Task workers take the same veto gate. Wiring only the chat path would leave every guard a user
      // installs silently unenforced for exactly the sessions that run unattended.
      onToolCall: toolHookBus
        ? async (e) => (await toolHookBus.emitBlocking('tools.call.before', e)).deny
        : undefined,
    });
    const skills = plugins?.skillsFor(null) ?? [];
    const rawUserInstructions = input.ownerId != null ? this.d.userInstructions?.(input.ownerId) : undefined;
    const append = [
      ...(plugins?.promptFragments ?? []),
      rawUserInstructions ? userInstructionsBlock(rawUserInstructions) : '',
    ].filter((s) => s.length > 0);

    // The one control-plane capability a worker gets: closing ITS OWN task (id baked in) through the
    // REST route, so ReviewService/mission advancement fire exactly as for a CLI worker's `elowen close`.
    const closeTool = defineTool({
      name: 'ElowenCloseTask', label: 'Close task',
      description: 'Close YOUR task when the work is finished. Call exactly once, at the end.',
      parameters: Type.Object({
        summary: Type.String({ description: 'What you did and the result' }),
        outcome: Type.Union([Type.Literal('ok'), Type.Literal('fail')], { description: "'ok' when done, 'fail' when you could not complete it" }),
      }),
      execute: async (_id: string, p: { summary: string; outcome: 'ok' | 'fail' }) => {
        const r = await callElowenApi('PATCH', `/tasks/${input.taskId}`, { status: 'closed', result_summary: p.summary, outcome: p.outcome }, { url: this.d.url, token: this.d.token, fetchImpl: this.d.fetchImpl });
        if (r.ok) {
          // Match the task too: once this worker is gone the name can belong to a later task's worker,
          // which a late close call would otherwise mark closed and bill for.
          const w = this.live.get(sessionName);
          if (w?.taskId === input.taskId) { w.closed = true; this.recordUsage(w); }
        }
        return { content: [{ type: 'text' as const, text: r.ok ? 'Task closed.' : `Elowen API error HTTP ${r.status}: ${r.text}` }], details: {} };
      },
    });

    // System prompt: the (user-overridable) worker-brain template with the task brief baked in.
    const vars = {
      agentName: input.agentName,
      taskId: input.taskId,
      titlePart: input.taskTitle ? `: ${input.taskTitle}` : '',
      detailsPart: input.taskDescription?.trim() ? `\n\nDetails:\n${input.taskDescription.trim()}` : '',
      resumePart: input.resumeNote?.trim() ? `\n\nNew input for this run — address it:\n${input.resumeNote.trim()}` : '',
    };
    // Inject the TDD directive AFTER the template renders, not through a `{{tddDirective}}` placeholder:
    // a user's saved wholesale override (edited before TDD mode existed) carries no such placeholder, so
    // riding on it would silently drop the directive. Appending here makes the placeholder unnecessary —
    // TDD mode reaches the worker regardless of the override. Off state appends '' (no-op).
    const systemPrompt = renderPromptFor(this.d.prompts, 'worker-brain', vars, input.ownerId) + tddDirective(input.tddMode ?? false);
    // The shared assembly (store row + rehydrate + resource loader + PI session + persistence
    // subscription) — identical to the chat brain's, so the two can never drift.
    const { session } = await this.factory.create({
      // providerId travels with the model: omitting it makes touchSession clear a previously stored
      // entry id, leaving a model with no provider behind on every task-session respawn.
      sessionId, ownerUserId: input.ownerId ?? 0, runtime: this.d.runtime, model, providerId: route.providerId,
      compactionFallbackModel: route.compactionFallback, cwd,
      systemPrompt, appendSystemPrompt: append, skills,
      tools: [closeTool, ...pluginTools], hostedToolSearch,
      // Task workers run long and unattended — keep their context bounded with PI-native compaction (the
      // factory persists each compaction into the store, so a rehydrated/resumed task keeps the savings)
      // at the owner's own threshold. An ownerless task has nobody to read a setting from → the default.
      autoCompact: true, autoCompactAtPct,
      title: `${input.taskId}${input.taskTitle ? `: ${input.taskTitle}` : ''}`,
      onSpawned: toolHookBus ? (e) => toolHookBus.emit('brain.session.afterSpawn', e) : undefined,
    });

    const worker: LiveWorker = {
      session, sessionName, sessionId, taskId: input.taskId, projectId: input.projectId, cwd,
      provider: route.providerId, model: model.id,
      lastEventAt: this.now(), nudged: false, closed: false, meter: newCostMeter(),
    };
    this.live.set(sessionName, worker);
    session.subscribe(() => { worker.lastEventAt = this.now(); }); // liveness for the idle watchdog

    // The worker's file/terminal tools are confined to the task's checkout for the whole run.
    const policy = { allowedProjectIds: new Set([input.projectId]), allowedPaths: () => [cwd] };
    const kickoff = resumed
      ? 'You were interrupted and relaunched on the same task. Re-check the current state (git status, build/tests), fold in any new input from the brief, finish the work and call ElowenCloseTask.'
      : 'Start working on the task now.';
    projectUserTurn(this.d.store, sessionId, kickoff);
    // Fire-and-forget: launch() returns like a tmux spawn; the run settles through the close tool.
    // runWithMeter wraps the whole run so every OpenRouter completion's reported cost folds into worker.meter.
    // workDir binds the run's tool default-cwd to the task's checkout; re-passed on every run so any
    // directory the agent moved to mid-run resets back at the next one.
    // sessionId is what plugin tools key their per-conversation state on (ctx.currentSessionId): the
    // read-before-modify guard, and the ownership of background processes. Omitting it did not merely
    // hide the id — it silently DISABLED both, and left every worker's background processes sharing one
    // anonymous scope where they could read each other's output.
    void runWithMeter(worker.meter, () => runWithPolicy(policy, () => session.prompt(kickoff), { workDir: cwd, sessionId }))
      .then(() => this.onAgentEnd(worker, policy))
      .catch((e: unknown) => {
        log.error(`brain worker ${sessionName} failed: ${String(e)}`);
        this.teardown(worker, 'error');
      });

    log.info(`launched brain worker ${sessionName} (elowen:${input.spec.model}) for task ${input.taskId}`);
    return { session: sessionName };
  }

  /** The prompt settled. If the agent closed its task we're done; otherwise nudge once, then hand the
   *  task back to the scheduler (revert-to-open + resume note — the stuck-detector semantics). */
  private async onAgentEnd(worker: LiveWorker, policy: { allowedProjectIds: Set<number>; allowedPaths: () => string[] }): Promise<void> {
    if (worker.closed || !this.live.has(worker.sessionName)) { this.dispose(worker); return; }
    const task = this.d.tasks()?.get(worker.taskId);
    if (!task || task.status !== 'in_progress') { this.dispose(worker); return; }
    if (!worker.nudged) {
      worker.nudged = true;
      const nudge = 'You ended your turn without closing the task. If the work is complete, call ElowenCloseTask now with a summary; otherwise finish the remaining work first, then close.';
      projectUserTurn(this.d.store, worker.sessionId, nudge);
      try {
        await runWithMeter(worker.meter, () => runWithPolicy(policy, () => worker.session.prompt(nudge), { workDir: worker.cwd, sessionId: worker.sessionId }));
        return this.onAgentEnd(worker, policy);
      } catch (e) {
        log.error(`brain worker ${worker.sessionName} nudge failed: ${String(e)}`);
      }
    }
    this.teardown(worker, 'unclosed');
  }

  /** Abort a live worker (kill control / task cancelled). The task row is left to the caller. */
  async abort(sessionName: string): Promise<void> {
    const w = this.live.get(sessionName);
    if (!w) return;
    this.live.delete(sessionName);
    this.recordUsage(w);
    try { await abortSessionWork(w.session); } catch { /* already settled */ }
    w.session.dispose();
    log.info(`aborted brain worker ${sessionName}`);
  }

  /** Idle watchdog: a worker with no PI events for idleMs is wedged — reap it and re-open the task. */
  startWatchdog(): () => void {
    const idleMs = this.d.idleMs ?? DEFAULT_IDLE_MS;
    this.watchdog = setInterval(() => {
      for (const w of [...this.live.values()]) {
        if (this.now() - w.lastEventAt > idleMs) {
          log.info(`brain worker ${w.sessionName} idle > ${idleMs}ms — reaping`);
          this.teardown(w, 'idle');
        }
      }
    }, WATCHDOG_TICK_MS);
    this.watchdog.unref?.();
    return () => { if (this.watchdog) clearInterval(this.watchdog); };
  }

  /** Sweep the watchdog once (tests). */
  sweepIdle(): void {
    const idleMs = this.d.idleMs ?? DEFAULT_IDLE_MS;
    for (const w of [...this.live.values()]) {
      if (this.now() - w.lastEventAt > idleMs) this.teardown(w, 'idle');
    }
  }

  /** Common failure teardown: record usage, dispose the session, and (when the task is still
   *  in_progress) revert it to open with a resume note so the scheduler relaunches — the same
   *  semantics the tmux stuck detector applies to a dead CLI agent. */
  private teardown(worker: LiveWorker, reason: 'unclosed' | 'idle' | 'error'): void {
    if (!this.live.has(worker.sessionName)) return;
    this.dispose(worker);
    const tasks = this.d.tasks();
    const task = tasks?.get(worker.taskId);
    if (!tasks || !task || task.status !== 'in_progress' || worker.closed) return;
    tasks.setResumeNote(worker.taskId, 'Your previous run stalled and was relaunched — re-check the current state (git status, build/tests) and carry the task to completion.');
    tasks.setStatus(worker.taskId, 'open');
    this.d.bus.publish({ type: 'task', taskId: worker.taskId, status: 'open' });
    log.info(`brain worker ${worker.sessionName} torn down (${reason}) — task ${worker.taskId} reverted to open`);
  }

  private dispose(worker: LiveWorker): void {
    if (this.live.delete(worker.sessionName)) {
      this.recordUsage(worker);
      try { worker.session.dispose(); } catch { /* already gone */ }
    }
  }

  private recordUsage(worker: LiveWorker): void {
    const taskUsage = this.d.taskUsage?.();
    if (!taskUsage) return;
    try {
      const usage = sessionUsage(worker.session);
      const meter = worker.meter;
      if (meter.reported) {
        // The provider (OpenRouter) told us the real billed cost — that's the truth, not the price sheet.
        usage.costUsd = meter.costUsd;
        usage.currency = meter.currency ?? 'USD';
        usage.costSource = 'provider_reported';
        usage.rawUsageMetadata = meter.raw ?? null;
      } else if (usage.costUsd != null && usage.costUsd > 0) {
        // No provider figure, but pi-ai's price sheet gave a non-zero estimate — label it as such.
        usage.costSource = 'calculated';
        usage.currency = usage.currency ?? 'USD';
      } else {
        usage.costSource = 'unavailable';
      }
      if (usage.total > 0) {
        const exec = execRefSpec({ program: 'elowen', provider: worker.provider, model: worker.model });
        taskUsage.record(worker.taskId, worker.projectId, exec, usage);
      }
    } catch { /* usage is best-effort */ }
  }
}
