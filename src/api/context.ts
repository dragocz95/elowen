import { logger } from '../shared/logger.js';
import { MemoryService } from '../brain/memoryService.js';
import { brainConfigFromElowen } from '../brain/config.js';
import { listBrainModels } from '../brain/models.js';
import { builtinToolMetas } from '../brain/tools/index.js';
import { discoverPlugins } from '../plugins/loader.js';
import { elowenExec } from '../shared/execs.js';
import { grantablePluginNames } from '../shared/pluginAccess.js';
import { toEmbeddingConfig } from '../store/configStore.js';
import type { Context, Hono } from 'hono';
import type { User, TokenScope } from '../store/userStore.js';
import type { ServerDeps } from './deps.js';
import { MicrosoftSsoService } from '../auth/msSso.js';
import { MemoryMaintenanceService } from '../brain/memoryMaintenanceService.js';
import { createLoginRateLimiter, type LoginRateLimiter } from './loginRateLimit.js';

/** The per-request Hono variables the auth middleware sets — the single source for `c.get('user')` etc.
 */
type ElowenVariables = { user: User; token: string; tokenScope: TokenScope };

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
export type AccessCtx = { get: { (k: 'user'): User | undefined; (k: 'tokenScope'): TokenScope | undefined } };

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
  /** Vector retrieval + anti-duplication over the memory store, for the retrieval-debugging route. Built
   *  only when the memory store AND the embedder are both wired (else /memory/retrieve degrades to 400).
   *  CRUD/audit routes talk to the user-scoped store directly and don't need this. */
  memoryService?: MemoryService;
  /** Owner-scoped background reindexing and recategorization. One instance per HTTP server keeps locks and
   * progress shared across every request without persisting stale running state across restarts. */
  memoryMaintenance?: MemoryMaintenanceService;
}

/** Present an already-resolved account as the structural context {@link createAccessHelpers}' predicates
 *  read. For the callers that hold a user but no Hono request — the plugin WebSocket dispatcher resolves
 *  its account from a ticket, outside any request the middleware ever saw. `tokenScope` answers 'user'
 *  because that is the only scope that exists; there is no other kind of credential to represent. */
export function accessContextFor(user: User | undefined): AccessCtx {
  return { get: ((k: 'user' | 'tokenScope') => (k === 'user' ? user : 'user')) as AccessCtx['get'] };
}

/** The tenancy predicates on their own, without the per-server services {@link createRouteContext} also
 *  builds. Extracted so a caller that must answer "is this an admin / what may they see" OUTSIDE a Hono
 *  request reuses the exact rules rather than restating them: the plugin WebSocket dispatcher
 *  authenticates by ticket, minutes after the request that minted it is gone, and it hands the resolved
 *  answer to the plugin as the connection's `auth` block. Constructing a second RouteContext for that
 *  would also mean a second MemoryMaintenanceService, whose locks are meant to be one per HTTP server.
 *
 *  The predicates read a structural context (`{ get('user') }`), so a caller outside Hono passes a plain
 *  object carrying the resolved user. */
export function createAccessHelpers(d: ServerDeps): Pick<RouteContext, 'canAccessProject' | 'notAdmin' | 'notAdminUnlessSetup' | 'accessibleProjects'> {
  // A non-admin user may only see/operate projects assigned to them; the admin (and open mode)
  // sees everything.
  const canAccessProject = (c: AccessCtx, id: number): boolean => {
    if (!d.userProjects || !d.users) return true; // open mode / single-user → no gating
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
  // Computed once for list endpoints so they don't run a per-row access query.
  const accessibleProjects = (c: AccessCtx): Set<number> | null => {
    if (!d.userProjects || !d.users) return null;
    const u = c.get('user');
    if (!u || d.userProjects.isAdmin(u.id)) return null;
    return new Set(d.userProjects.forUser(u.id));
  };

  return { canAccessProject, notAdmin, notAdminUnlessSetup, accessibleProjects };
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
  }) : null);
  // One source of truth for the tenancy rules; the WebSocket dispatcher reads the same helpers.
  const { canAccessProject, notAdmin, notAdminUnlessSetup, accessibleProjects } = createAccessHelpers(d);

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
        // Shared pools for the web-side browsing surface; the resolver only ever answers pools the
        // caller belongs to (see MemoryCategoryStore.listShared).
        sharedCategoriesOf: (userId) => d.memoryCategoryStore?.listSharedIds(userId) ?? [],
      })
    : undefined;
  const memoryMaintenance = d.memoryStore
    ? new MemoryMaintenanceService({
        memories: d.memoryStore,
        embeddings: d.embeddings,
        embeddingConfig: () => toEmbeddingConfig(d.config.embeddingConfig()),
        categorizer: d.memoryCategorizer,
        logger: log,
      })
    : undefined;

  return {
    d, log, loginRateLimiter, microsoftSso,
    canAccessProject, notAdmin, notAdminUnlessSetup, accessibleProjects,
    memoryService, memoryMaintenance,
  };
}
