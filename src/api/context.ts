import { logger } from '../shared/logger.js';
import { MemoryService } from '../brain/memoryService.js';
import { brainConfigFromElowen } from '../brain/config.js';
import { listBrainModels } from '../brain/models.js';
import { builtinToolMetas } from '../brain/tools/index.js';
import { discoverPlugins } from '../plugins/loader.js';
import { elowenExec } from '../shared/execs.js';
import { grantablePluginNames } from '../shared/pluginAccess.js';
import { toEmbeddingConfig } from '../store/configStore.js';
import type { EventProjectDeps } from './eventProject.js';
import type { Context, Hono } from 'hono';
import type { User, TokenScope } from '../store/userStore.js';
import type { ServerDeps } from './deps.js';
import { MicrosoftSsoService } from '../auth/msSso.js';
import { createLoginRateLimiter, type LoginRateLimiter } from './loginRateLimit.js';

/** The per-request Hono variables the auth middleware sets — the single source for `c.get('user')` etc.
 *  `agentTask` is the task an agent token was minted for (null for every unbound token). */
type ElowenVariables = { user: User; token: string; tokenScope: TokenScope; agentTask: string | null };

/** The daemon's Hono app, typed with the per-request variables the auth middleware sets. Shared by
 *  `createServer` and every route-family registrar so they all agree on `c.get('user')` etc. */
export type ElowenApp = Hono<{ Variables: ElowenVariables }>;

/** A single request's context, typed with the same variables as {@link ElowenApp}. Handlers pulled out of
 *  an inline `app.get(path, c => …)` (e.g. behind a guard wrapper) annotate `c` with this to keep the
 *  typed `c.get('user')` they'd otherwise get from Hono's inference. Route path params are not carried
 *  here (Hono infers those only for inline handlers), so a wrapped `:id` handler reads `param('id')` with
 *  a non-null assertion — the route only matches when the segment is present. */
export type ElowenContext = Context<{ Variables: ElowenVariables }>;

/** Minimal structural view of the request context the access predicates read (the real Hono context
 *  satisfies it). Overloaded `get` so a caller can read both the user and the token scope. */
type AccessCtx = { get: { (k: 'user'): User | undefined; (k: 'tokenScope'): TokenScope | undefined } };

/** Narrower context shape for the admin/user-only predicates that read just the user. */
type UserCtx = { get: (k: 'user') => User | undefined };

/** Shared per-server state and helper predicates, built once from {@link ServerDeps} and threaded into
 *  every route module. It bundles the access helpers that used to be closures inside `createServer`, so
 *  the route families can live in their own files while still sharing one source of truth for tenancy
 *  gating. */
export interface RouteContext {
  d: ServerDeps;
  log: ReturnType<typeof logger>;
  loginRateLimiter: LoginRateLimiter;
  microsoftSso: MicrosoftSsoService | null;

  /** Projects an AGENT-scoped token may currently touch (its live working set). */
  agentProjects(): Set<number>;
  /** True when the caller may see/operate the given project (admin/open mode always pass). */
  canAccessProject(c: AccessCtx, id: number): boolean;
  /** True when the caller is NOT the admin on a gated daemon (open/single-user mode → false). Strict:
   *  closed even at 0 users (a project-agnostic daemon route is never open pre-setup). */
  notAdmin(c: UserCtx): boolean;
  /** Like {@link notAdmin} but OPEN during first-run onboarding (users store present, 0 users) so the
   *  initial admin can configure the daemon before existing — the gate for the config/plugins/memory
   *  routes that must be reachable pre-setup. Admin-only once any user exists. */
  notAdminUnlessSetup(c: UserCtx): boolean;
  /** Set of project ids the caller may see, or null for unrestricted (open mode / admin). */
  accessibleProjects(c: AccessCtx): Set<number> | null;
  /** Resolve any live event's owning project — the same logic the activity log stamps rows with. */
  eventDeps: EventProjectDeps;
  /** Vector retrieval + anti-duplication over the memory store, for the retrieval-debugging route. Built
   *  only when the memory store AND the embedder are both wired (else /memory/retrieve degrades to 400).
   *  CRUD/audit routes talk to the user-scoped store directly and don't need this. */
  memoryService?: MemoryService;
}

/** Build the shared {@link RouteContext} from the daemon's injected {@link ServerDeps}. Core reasoning
 *  stores are optional in deps for back-compat with existing call sites/tests; defaulted here so every
 *  route has a working store. The helper bodies are lifted verbatim from the old `createServer`
 *  closure, so tenancy/path semantics are unchanged. */
export function createRouteContext(d: ServerDeps): RouteContext {
  const log = logger('api');
  const loginRateLimiter = createLoginRateLimiter();
  const microsoftSso = d.microsoftSso ?? (d.users ? new MicrosoftSsoService({
    config: d.config,
    users: d.users,
    userSettings: d.userSettings,
    projects: d.projects,
    userProjects: d.userProjects,
    project: d.project,
    catalogs: {
      models: async () => {
        const cfg = brainConfigFromElowen(d.config, d.brainAuth);
        if (!cfg) return [];
        return (await listBrainModels(cfg)).map((model) => elowenExec(model.provider, model.model));
      },
      plugins: async () => {
        const removed = new Set(d.config.get().plugins.removed);
        return grantablePluginNames(discoverPlugins(d.pluginDirs ?? [])
          .map((plugin) => plugin.manifest)
          .filter((manifest) => !removed.has(manifest.name)));
      },
      tools: async () => {
        const registry = await d.plugins?.get();
        return [...builtinToolMetas().map((tool) => tool.name), ...(registry?.tools ?? []).map((tool) => tool.name)];
      },
    },
    clock: d.clock,
    bus: d.bus,
    advisor: () => d.advisor,
  }) : null);
  // The projects an AGENT-scoped token may touch. The shared service token is owned by the admin user,
  // so without this it would inherit admin's cross-project bypass and a prompt-injected agent could
  // read/close tasks in tenants it isn't working in (finding S51). Bind it to the daemon's live work:
  //   • workers   → projects with an in_progress `agent:`-labelled task
  //   • overseers → projects of every active mission's epic (the overseer polls even between phases)
  // A pilot only ever submits to the plan job it was handed (project checked on that job's route), so
  // it needs no extra entry here.
  // Reads the daemon's own tolerant REF view, not the task store: this is the boundary that decides
  // what an agent token may reach, so it must not be served by the plugin whose callers it gates, and it
  // must answer before any plugin has loaded. No task rows (or no table at all) ⇒ an empty set ⇒ the
  // token reaches nothing, which is the fail-closed direction.
  const agentProjects = (): Set<number> => {
    const ids = new Set<number>();
    // Single pass: one `list()` covers all three groups (in-progress agent tasks, active missions'
    // epics, still-open epics of agent-labelled children) via an in-memory id→task map, instead of a
    // `get()` per mission and per agent child — the query count no longer grows with historical tasks.
    const all = (d.taskRefs?.all() ?? []);
    const byId = new Map(all.map((t) => [t.id, t]));
    for (const t of all) {
      if (t.status === 'in_progress' && t.labels.some((l) => l.startsWith('agent:'))) ids.add(t.project_id);
    }
    for (const m of d.missions.active()) {
      const epic = byId.get(m.epic_id);
      if (epic) ids.add(epic.project_id);
    }
    // The final-phase agent closes the epic itself right after closing its own leaf — by then its task
    // is no longer in_progress and the mission has disengaged, so neither set above covers it and the
    // epic-close would 403. A still-open epic that hosted agent work keeps its project reachable to that
    // agent until the epic is actually closed (then it drops out again). No permanent widening.
    for (const t of all) {
      if (!t.parent_id || !t.labels.some((l) => l.startsWith('agent:'))) continue;
      const epic = byId.get(t.parent_id);
      if (epic && epic.status !== 'closed' && epic.status !== 'cancelled') ids.add(epic.project_id);
    }
    return ids;
  };

  // A non-admin user may only see/operate projects assigned to them; the admin (and open mode)
  // sees everything. An agent-scoped token is confined to its live working set, never admin-bypass.
  const canAccessProject = (c: AccessCtx, id: number): boolean => {
    if (!d.userProjects || !d.users) return true; // open mode / single-user → no gating
    if (c.get('tokenScope') === 'agent') return agentProjects().has(id);
    const u = c.get('user');
    return !!u && d.userProjects.canAccess(u.id, id);
  };

  // Is the CALLER an admin account? The two gates below differ only in when they stay OPEN, never in how
  // they answer this — they used to reach it through two different stores (`userProjects.isAdmin` vs
  // `users.isAdmin`), which is a drift waiting to happen rather than a distinction.
  const callerIsAdmin = (c: UserCtx): boolean => {
    const u = c.get('user');
    return !!u && !!d.users?.isAdmin(u.id);
  };

  // Admin gate for daemon-wide, project-agnostic routes (integrations, etc.). Open/single-user mode
  // (no userProjects store) passes; otherwise only an admin clears it.
  const notAdmin = (c: UserCtx): boolean => {
    if (!d.userProjects || !d.users) return false;
    return !callerIsAdmin(c);
  };

  // Setup-tolerant admin gate: identical to notAdmin once any user exists, but OPEN during first-run
  // onboarding (users store present, 0 users) so the config/plugins/memory routes can be configured
  // before the first admin is created. The ONE place this weaker rule lives.
  const notAdminUnlessSetup = (c: UserCtx): boolean => {
    if (!d.users || d.users.count() === 0) return false;
    return !callerIsAdmin(c);
  };

  // The set of project ids the caller may see, or null for unrestricted (open mode / admin).
  // Computed once for list endpoints so they don't run a per-row access query. An agent-scoped token
  // is confined to its live working set (never the admin-bypass null).
  const accessibleProjects = (c: AccessCtx): Set<number> | null => {
    if (!d.userProjects || !d.users) return null;
    if (c.get('tokenScope') === 'agent') return agentProjects();
    const u = c.get('user');
    if (!u || d.userProjects.isAdmin(u.id)) return null;
    return new Set(d.userProjects.forUser(u.id));
  };

  // Resolve any live event's owning project — the same single-source logic the activity log stamps
  // rows with — so the SSE stream can gate each event per subscriber instead of broadcasting globally.
  // `signal`/`plan` tenancy (session→task via the agent:<name> label, plan job → its runtime record)
  // has NO core lookup: the agents plugin's registered event resolver is the sole source — with the
  // plugin disabled those events resolve null and gate admin-only (fail closed).
  const eventDeps: EventProjectDeps = {
    taskProject: (id) => d.taskRefs?.get(id)?.project_id ?? null,
    pluginResolvers: d.eventProjectResolvers,
  };

  // The retrieval-debugging seam — built only when both the memory store and the embedder are wired, so
  // the /memory/retrieve route can rank the caller's memories. Reads the live embedding config each call
  // (a Settings change applies without a restart), mirroring the daemon's own MemoryService.
  const memoryService = d.memoryStore && d.embeddings
    ? new MemoryService({
        store: d.memoryStore,
        categories: d.memoryCategoryStore,
        embeddings: d.embeddings,
        embeddingConfig: () => toEmbeddingConfig(d.config.embeddingConfig()),
        retention: () => d.config.get().runtime.memoryRetention,
      })
    : undefined;

  return {
    d, log, loginRateLimiter, microsoftSso,
    agentProjects, canAccessProject, notAdmin, notAdminUnlessSetup, accessibleProjects,
    eventDeps, memoryService,
  };
}
