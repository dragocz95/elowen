import { createAgentSession, DefaultResourceLoader, defineTool, formatSkillsForPrompt } from '@earendil-works/pi-coding-agent';
import type { AgentSession, AgentSessionEvent, AuthStorage, ResourceLoader } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { BrainStore } from '../../store/brainStore.js';
import type { TaskStore } from '../../store/taskStore.js';
import type { TaskUsageStore } from '../../store/taskUsageStore.js';
import type { EventBus } from '../../api/sse.js';
import type { BrainRuntimeConfig } from '../providers.js';
import { buildBrainRegistry, resolveBrainModel } from '../providers.js';
import { projectEvent, projectUserTurn, rehydrate } from '../persistence.js';
import { taskSessionId } from '../sessionId.js';
import { runWithPolicy } from '../../plugins/policyContext.js';
import type { PluginRegistryProvider } from '../../plugins/pluginsProvider.js';
import { callOrcaApi } from '../../shared/apiClient.js';
import { renderPromptFor } from '../../prompts/index.js';
import type { PromptService } from '../../prompts/promptService.js';
import type { TokenUsage } from '../../integrations/usage/types.js';
import { logger } from '../../shared/logger.js';

const log = logger('brain-worker');

/** How long a worker may sit with no PI events before the watchdog reaps it (a wedged upstream). */
const DEFAULT_IDLE_MS = 10 * 60_000;
const WATCHDOG_TICK_MS = 60_000;

export interface BrainWorkerDeps {
  store: BrainStore;
  tasks: TaskStore;
  bus: EventBus;
  taskUsage?: TaskUsageStore;
  /** Live provider config resolver (null → nothing configured, launch fails clearly). */
  config: () => BrainRuntimeConfig | null;
  authStorage?: AuthStorage;
  prompts?: PromptService;
  /** Daemon REST base + token the close tool calls (same reach-back the CLI workers use). */
  url: string;
  token: string;
  /** The daemon-wide shared plugin registry — the SAME provider the chat brain uses, so a plugin
   *  toggle invalidates both at once (a worker launched afterwards composes from the fresh registry). */
  plugins?: PluginRegistryProvider;
  now?: () => number;
  idleMs?: number;
  createSession?: typeof createAgentSession;
  fetchImpl?: typeof fetch;
  /** Injected for tests; production builds the disk-free DefaultResourceLoader below. */
  resourceLoaderFactory?: (o: { cwd: string; systemPrompt: string; appendSystemPrompt?: string[] }) => ResourceLoader | undefined;
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
}

interface LiveWorker {
  session: AgentSession;
  sessionName: string;
  sessionId: string;
  taskId: string;
  projectId: number;
  model: string;
  lastEventAt: number;
  nudged: boolean;
  closed: boolean;
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

/** Sum a live PI session's per-message usage into the normalized task-usage shape. */
function sessionUsage(session: AgentSession): TokenUsage {
  const u: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, costUsd: null };
  for (const m of session.messages as { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; cost?: { total?: number } } }[]) {
    u.input += m.usage?.input ?? 0;
    u.output += m.usage?.output ?? 0;
    u.cacheRead += m.usage?.cacheRead ?? 0;
    u.cacheWrite += m.usage?.cacheWrite ?? 0;
    u.total += m.usage?.totalTokens ?? 0;
    const cost = m.usage?.cost?.total ?? 0;
    if (cost > 0) u.costUsd = (u.costUsd ?? 0) + cost;
  }
  return u;
}

/**
 * Runs `orca:` tasks on the embedded brain: an in-process PI session scoped to the task's checkout
 * (Policy-guarded plugin tools + one baked-in close tool) instead of a tmux-spawned CLI. Task states
 * flow exactly as with CLI workers — the scheduler set in_progress before calling launch, and the
 * REST close route (driven by the orca_close_task tool) runs the same ReviewService pipeline.
 */
export class BrainWorkerService {
  private live = new Map<string, LiveWorker>();
  private watchdog: ReturnType<typeof setInterval> | undefined;

  constructor(private d: BrainWorkerDeps) {}

  /** tmux-style session names (`orca-<agentName>`) for the stuck detector's composite lister. */
  liveSessionNames(): string[] { return [...this.live.keys()]; }
  isLive(sessionName: string): boolean { return this.live.has(sessionName); }

  private now(): number { return this.d.now?.() ?? Date.now(); }

  async launch(input: BrainWorkerLaunchInput): Promise<{ session: string }> {
    const cfg = this.d.config();
    if (!cfg) throw new Error('orca exec engine: no brain provider configured');
    const sessionName = `orca-${input.agentName}`;
    if (this.live.has(sessionName)) return { session: sessionName }; // idempotent re-launch

    const registry = buildBrainRegistry(cfg, this.d.authStorage);
    const model = resolveBrainModel(registry, cfg, selectionFor(cfg, input.spec.model));
    const sessionId = taskSessionId(input.taskId);
    const resumed = !!this.d.store.getSession(sessionId);
    if (!resumed) this.d.store.createSession({ id: sessionId, userId: input.ownerId ?? 0, model: model.id });
    else this.d.store.touchSession(sessionId, model.id);
    if (!this.d.store.getSession(sessionId)?.title) this.d.store.setTitle(sessionId, `${input.taskId}${input.taskTitle ? `: ${input.taskTitle}` : ''}`.slice(0, 60));

    const cwd = input.projectPath;
    const sessionManager = rehydrate(this.d.store, sessionId, cwd);
    const plugins = await this.d.plugins?.get();
    const pluginTools = plugins?.tools ?? [];
    const skills = plugins?.skills ?? [];
    const append = [skills.length ? formatSkillsForPrompt(skills) : '', ...(plugins?.promptFragments ?? [])].filter((s) => s.length > 0);

    // The one control-plane capability a worker gets: closing ITS OWN task (id baked in) through the
    // REST route, so ReviewService/mission advancement fire exactly as for a CLI worker's `orca close`.
    const closeTool = defineTool({
      name: 'orca_close_task', label: 'Close task',
      description: 'Close YOUR task when the work is finished. Call exactly once, at the end.',
      parameters: Type.Object({
        summary: Type.String({ description: 'What you did and the result' }),
        outcome: Type.Union([Type.Literal('ok'), Type.Literal('fail')], { description: "'ok' when done, 'fail' when you could not complete it" }),
      }),
      execute: async (_id: string, p: { summary: string; outcome: 'ok' | 'fail' }) => {
        const r = await callOrcaApi('PATCH', `/tasks/${input.taskId}`, { status: 'closed', result_summary: p.summary, outcome: p.outcome }, { url: this.d.url, token: this.d.token, fetchImpl: this.d.fetchImpl });
        if (r.ok) {
          const w = this.live.get(sessionName);
          if (w) { w.closed = true; this.recordUsage(w); }
        }
        return { content: [{ type: 'text' as const, text: r.ok ? 'Task closed.' : `Orca API error HTTP ${r.status}: ${r.text}` }], details: {} };
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
    const systemPrompt = renderPromptFor(this.d.prompts, 'worker-brain', vars, input.ownerId);
    const resourceLoader = this.d.resourceLoaderFactory
      ? this.d.resourceLoaderFactory({ cwd, systemPrompt, appendSystemPrompt: append })
      : new DefaultResourceLoader({
          cwd, agentDir: cwd, systemPrompt, appendSystemPrompt: append,
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        });
    if (resourceLoader) await resourceLoader.reload();

    const allTools = [closeTool, ...pluginTools];
    const create = this.d.createSession ?? createAgentSession;
    const { session } = await create({
      cwd, sessionManager, modelRegistry: registry, model, resourceLoader,
      customTools: allTools, tools: allTools.map((t) => t.name), noTools: 'builtin',
    });

    const worker: LiveWorker = {
      session, sessionName, sessionId, taskId: input.taskId, projectId: input.projectId,
      model: model.id, lastEventAt: this.now(), nudged: false, closed: false,
    };
    this.live.set(sessionName, worker);
    session.subscribe((e: AgentSessionEvent) => {
      worker.lastEventAt = this.now();
      projectEvent(this.d.store, sessionId, e);
    });

    // The worker's file/terminal tools are confined to the task's checkout for the whole run.
    const policy = { allowedProjectIds: new Set([input.projectId]), allowedPaths: () => [cwd] };
    const kickoff = resumed
      ? 'You were interrupted and relaunched on the same task. Re-check the current state (git status, build/tests), fold in any new input from the brief, finish the work and call orca_close_task.'
      : 'Start working on the task now.';
    projectUserTurn(this.d.store, sessionId, kickoff);
    // Fire-and-forget: launch() returns like a tmux spawn; the run settles through the close tool.
    void runWithPolicy(policy, () => session.prompt(kickoff))
      .then(() => this.onAgentEnd(worker, policy))
      .catch((e: unknown) => {
        log.error(`brain worker ${sessionName} failed: ${String(e)}`);
        this.teardown(worker, 'error');
      });

    log.info(`launched brain worker ${sessionName} (orca:${input.spec.model}) for task ${input.taskId}`);
    return { session: sessionName };
  }

  /** The prompt settled. If the agent closed its task we're done; otherwise nudge once, then hand the
   *  task back to the scheduler (revert-to-open + resume note — the stuck-detector semantics). */
  private async onAgentEnd(worker: LiveWorker, policy: { allowedProjectIds: Set<number>; allowedPaths: () => string[] }): Promise<void> {
    if (worker.closed || !this.live.has(worker.sessionName)) { this.dispose(worker); return; }
    const task = this.d.tasks.get(worker.taskId);
    if (!task || task.status !== 'in_progress') { this.dispose(worker); return; }
    if (!worker.nudged) {
      worker.nudged = true;
      const nudge = 'You ended your turn without closing the task. If the work is complete, call orca_close_task now with a summary; otherwise finish the remaining work first, then close.';
      projectUserTurn(this.d.store, worker.sessionId, nudge);
      try {
        await runWithPolicy(policy, () => worker.session.prompt(nudge));
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
    try { await w.session.abort(); } catch { /* already settled */ }
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
    const task = this.d.tasks.get(worker.taskId);
    if (!task || task.status !== 'in_progress' || worker.closed) return;
    this.d.tasks.setResumeNote(worker.taskId, 'Your previous run stalled and was relaunched — re-check the current state (git status, build/tests) and carry the task to completion.');
    this.d.tasks.setStatus(worker.taskId, 'open');
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
    if (!this.d.taskUsage) return;
    try {
      const usage = sessionUsage(worker.session);
      if (usage.total > 0) this.d.taskUsage.record(worker.taskId, worker.projectId, `orca:${worker.model}`, usage);
    } catch { /* usage is best-effort */ }
  }
}
