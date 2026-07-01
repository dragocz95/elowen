import { createAgentSession, DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import type { AgentSession, AgentSessionEvent, ResourceLoader } from '@earendil-works/pi-coding-agent';
import type { BrainStore } from '../store/brainStore.js';
import type { BrainProviderConfig } from './providers.js';
import { buildBrainRegistry, resolveBrainModel } from './providers.js';
import { buildOrcaTools } from './tools/index.js';
import { projectEvent, projectUserTurn, rehydrate } from './persistence.js';

/** What a channel (web/terminal, later Discord) receives from the brain. Stable regardless of the
 *  underlying PI event shape — the mapping lives in one place (`toBrainEvent`). */
export type BrainEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string }
  | { type: 'idle' }
  | { type: 'error'; message: string };

/** A stored turn shaped for display (the `GET /brain/messages` payload consumed by channels). */
export interface BrainMessageView { role: string; text: string }

export interface BrainDeps {
  store: BrainStore;
  users: {
    ensureAdvisorToken(userId: number): string;
    get(userId: number): { name?: string; username?: string } | null | undefined;
  };
  config: BrainProviderConfig;
  /** Renders the brain's system prompt from the editable `advisor` template (per-user override aware). */
  prompts: { render(name: string, vars: Record<string, string>, userId?: number): string };
  /** Daemon REST base the brain's tools call (ORCA_URL). */
  url: string;
  /** Working dir for the in-memory session (not a repo checkout). Default: process.cwd(). */
  cwd?: string;
  /** Injected for tests; defaults to PI's createAgentSession. */
  createSession?: typeof createAgentSession;
  /** Injected for tests; builds the resource loader that carries the Orca system prompt. A test passes
   *  `() => undefined` so no disk-touching loader is constructed. */
  resourceLoaderFactory?: (o: { cwd: string; systemPrompt: string }) => ResourceLoader | undefined;
}

/** Default resource loader: carries the Orca persona as the session's system prompt and disables all
 *  disk discovery (extensions/skills/themes/context files) — the brain is a lean, in-process agent. */
function defaultResourceLoaderFactory(o: { cwd: string; systemPrompt: string }): ResourceLoader {
  return new DefaultResourceLoader({
    cwd: o.cwd, agentDir: o.cwd, systemPrompt: o.systemPrompt,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
}

interface LiveBrain { session: AgentSession; sessionId: string; model: string; listeners: Set<(e: BrainEvent) => void> }

/** Translate a PI session event into the stable BrainEvent contract. Defensive: unknown event types
 *  are dropped. Streaming shapes are refined by the Task 8 smoke; the contract never changes. */
function toBrainEvent(e: AgentSessionEvent): BrainEvent | null {
  if (e.type === 'agent_end') return { type: 'idle' };
  const anyE = e as { type: string; toolName?: string; delta?: string; assistantMessageEvent?: { type?: string; delta?: string } };
  if (anyE.type === 'message_update') {
    const delta = anyE.assistantMessageEvent?.type === 'text_delta' ? anyE.assistantMessageEvent.delta : undefined;
    return delta ? { type: 'text', delta } : null;
  }
  if (typeof anyE.toolName === 'string') return { type: 'tool', name: anyE.toolName };
  return null;
}

/** Per-user embedded brain lifecycle. Mirrors AdvisorService's shape so daemon wiring is familiar,
 *  but holds an in-process PI AgentSession instead of spawning an external CLI. One conversation per
 *  user for step #1 (session id `brain-<userId>`); multi-conversation is a later sub-project. */
export class BrainService {
  private live = new Map<number, LiveBrain>();
  constructor(private d: BrainDeps) {}

  private sessionIdFor(userId: number): string { return `brain-${userId}`; }

  status(userId: number): { running: boolean; sessionId: string | null; model: string } {
    const b = this.live.get(userId);
    return { running: !!b, sessionId: b?.sessionId ?? null, model: b?.model ?? '' };
  }

  async start(userId: number, opts?: { which?: 'openai' | 'anthropic' }): Promise<{ sessionId: string }> {
    const existing = this.live.get(userId);
    if (existing) return { sessionId: existing.sessionId }; // idempotent
    const sessionId = this.sessionIdFor(userId);
    const which = opts?.which ?? this.d.config.default;

    // Ensure the store row (sole source of truth) exists before rehydration.
    const registry = buildBrainRegistry(this.d.config);
    const model = resolveBrainModel(registry, this.d.config, which);
    if (!this.d.store.getSession(sessionId)) {
      this.d.store.createSession({ id: sessionId, userId, model: model.id });
    } else {
      this.d.store.touchSession(sessionId, model.id);
    }

    const cwd = this.d.cwd ?? process.cwd();
    const sessionManager = rehydrate(this.d.store, sessionId, cwd);
    const token = this.d.users.ensureAdvisorToken(userId);
    const tools = buildOrcaTools({ url: this.d.url, token });

    // Orca identity: the editable `advisor` prompt (per-user override aware) becomes the system prompt,
    // so the brain knows it is Orca — not the underlying model's default persona.
    const u = this.d.users.get(userId);
    const userName = u?.name || u?.username || 'Filip';
    const persona = this.d.prompts.render('advisor', { userName }, userId);
    const resourceLoader = (this.d.resourceLoaderFactory ?? defaultResourceLoaderFactory)({ cwd, systemPrompt: persona });
    // A resource loader passed to createAgentSession is NOT auto-reloaded (only one it builds itself is),
    // so its system prompt stays empty unless we reload it here. Without this the brain falls back to
    // pi's default "coding assistant" persona and misidentifies itself.
    if (resourceLoader) await resourceLoader.reload();

    const create = this.d.createSession ?? createAgentSession;
    const { session } = await create({
      cwd,
      sessionManager,
      modelRegistry: registry,
      model,
      resourceLoader,
      customTools: tools,
      tools: tools.map((t) => t.name),
      noTools: 'builtin',
    });

    const listeners = new Set<(e: BrainEvent) => void>();
    session.subscribe((e: AgentSessionEvent) => {
      projectEvent(this.d.store, sessionId, e); // persist settled turns (agent_end)
      const be = toBrainEvent(e);
      if (be) for (const l of listeners) l(be);
    });

    this.live.set(userId, { session, sessionId, model: model.id, listeners });
    return { sessionId };
  }

  subscribe(userId: number, listener: (e: BrainEvent) => void): () => void {
    const b = this.live.get(userId);
    if (!b) throw new Error('brain not started for user');
    b.listeners.add(listener);
    return () => b.listeners.delete(listener);
  }

  async send(userId: number, text: string): Promise<void> {
    const b = this.live.get(userId);
    if (!b) throw new Error('brain not started for user');
    projectUserTurn(this.d.store, b.sessionId, text);
    await b.session.prompt(text);
  }

  stop(userId: number): void {
    const b = this.live.get(userId);
    if (!b) return;
    b.session.dispose();
    this.live.delete(userId);
  }

  /** The user's stored conversation, shaped for display (channels render this on connect). Reads the
   *  sole store; no live session required, so it works before/independently of `start`. */
  history(userId: number): BrainMessageView[] {
    return this.d.store.getMessages(this.sessionIdFor(userId)).map((row) => {
      let text = '';
      try { text = extractText(JSON.parse(row.content)); } catch { /* malformed row → empty text */ }
      return { role: row.role, text };
    });
  }
}

/** Pull display text out of a stored message's content JSON. Content is either a plain string or an
 *  array of parts ({type:'text', text}); anything else yields an empty string. */
function extractText(msg: unknown): string {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : '')).join('');
  }
  return '';
}
