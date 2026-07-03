import { createAgentSession, DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import type { AgentSession, AgentSessionEvent, ResourceLoader, ToolDefinition, ModelRegistry } from '@earendil-works/pi-coding-agent';
import type { Model, Api } from '@earendil-works/pi-ai';
import type { BrainStore } from '../../store/brainStore.js';
import { projectEvent, rehydrate } from '../persistence.js';

/** Everything one PI brain session needs, composed by the caller: the chat brain renders the Orca
 *  persona and gates orca_* tools by session kind; the task worker bakes in its close tool and the
 *  worker-brain prompt. The factory only assembles. */
export interface SessionSpec {
  sessionId: string;
  /** The Orca user the store row belongs to (0 for ownerless task sessions). */
  ownerUserId: number;
  registry: ModelRegistry;
  model: Model<Api>;
  cwd: string;
  systemPrompt: string;
  /** Chunks appended after the system prompt (plugin skills block, fragments, role prompts). */
  appendSystemPrompt: string[];
  tools: ToolDefinition[];
  /** Reasoning effort for extended-thinking models (empty/undefined = the model default). */
  thinkingLevel?: string;
  /** Session title to set when the stored row has none yet (task sessions name themselves). */
  title?: string;
}

export interface SessionFactoryDeps {
  store: BrainStore;
  /** Injected for tests; defaults to PI's createAgentSession. */
  createSession?: typeof createAgentSession;
  /** Injected for tests; builds the resource loader that carries the system prompt. A test passes
   *  `() => undefined` so no disk-touching loader is constructed. */
  resourceLoaderFactory?: (o: { cwd: string; systemPrompt: string; appendSystemPrompt?: string[] }) => ResourceLoader | undefined;
}

/** Default resource loader: carries the composed system prompt, appends the extra chunks after it,
 *  and disables all disk discovery — the brain is a lean, in-process agent. */
function defaultResourceLoaderFactory(o: { cwd: string; systemPrompt: string; appendSystemPrompt?: string[] }): ResourceLoader {
  return new DefaultResourceLoader({
    cwd: o.cwd, agentDir: o.cwd, systemPrompt: o.systemPrompt, appendSystemPrompt: o.appendSystemPrompt,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
}

/** The shared session assembly behind both the chat brain (`spawnLive`) and the orca-exec task
 *  workers: store row → history rehydration → resource loader → PI session → persistence
 *  subscription. One implementation, so the reload gotcha below can never drift out of sync. */
export class BrainSessionFactory {
  constructor(private d: SessionFactoryDeps) {}

  async create(spec: SessionSpec): Promise<{ session: AgentSession }> {
    // Ensure the store row (sole source of truth) exists before rehydration.
    if (!this.d.store.getSession(spec.sessionId)) {
      this.d.store.createSession({ id: spec.sessionId, userId: spec.ownerUserId, model: spec.model.id });
    } else {
      this.d.store.touchSession(spec.sessionId, spec.model.id);
    }
    if (spec.title && !this.d.store.getSession(spec.sessionId)?.title) {
      this.d.store.setTitle(spec.sessionId, spec.title.slice(0, 60));
    }

    const sessionManager = rehydrate(this.d.store, spec.sessionId, spec.cwd);
    const resourceLoader = (this.d.resourceLoaderFactory ?? defaultResourceLoaderFactory)({
      cwd: spec.cwd, systemPrompt: spec.systemPrompt, appendSystemPrompt: spec.appendSystemPrompt,
    });
    // A resource loader passed to createAgentSession is NOT auto-reloaded (only one it builds itself
    // is), so its system prompt stays empty unless we reload it here. Without this the brain falls
    // back to pi's default "coding assistant" persona and misidentifies itself.
    if (resourceLoader) await resourceLoader.reload();

    const create = this.d.createSession ?? createAgentSession;
    // Reasoning effort for extended-thinking models — PI clamps an unsupported level to the model's
    // range, so passing it for a non-thinking model is harmless. Empty → leave the model default.
    const thinkingLevel = (['minimal', 'low', 'medium', 'high', 'xhigh'] as const).find((l) => l === spec.thinkingLevel);
    const { session } = await create({
      cwd: spec.cwd,
      sessionManager,
      modelRegistry: spec.registry,
      model: spec.model,
      resourceLoader,
      customTools: spec.tools,
      tools: spec.tools.map((t) => t.name),
      noTools: 'builtin',
      ...(thinkingLevel ? { thinkingLevel } : {}),
    });

    // Persist settled turns (agent_end). Callers layer their own subscriptions on top (BrainEvent
    // fanout in the chat brain, liveness timestamps in the worker).
    session.subscribe((e: AgentSessionEvent) => projectEvent(this.d.store, spec.sessionId, e));
    return { session };
  }
}
