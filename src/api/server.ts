import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { hermesStatus, installHermesPlugin } from '../integrations/hermesInstall.js';
import { detectClis } from '../integrations/cliDetection.js';
import { readTaskUsage } from '../integrations/usage/index.js';
import { listProjectFiles, readProjectFile, writeProjectFile, readProjectBytes, createProjectFile, createProjectDir, deleteProjectEntry, renameProjectEntry, copyProjectEntry, projectFileAtHead, projectFileDiff, projectCommitDiff, projectCommitFiles, projectCommitFileDiff, projectCommitLog, projectChangedFiles, projectWorkingDiff, projectReviewDiff, isProjectImage } from '../integrations/projectFiles.js';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import type { TaskStore } from '../store/taskStore.js';
import type { Readiness } from '../store/readiness.js';
import type { MissionStore } from '../store/missionStore.js';
import type { AgentStore } from '../store/agentStore.js';
import type { MissionEngine } from '../overseer/missionEngine.js';
import type { SpawnService } from '../spawn/spawn.js';
import type { TmuxDriver } from '../tmux/types.js';
import type { EventBus } from './sse.js';
import type { AgentSpec } from '../spawn/commandBuilder.js';
import { resolveExecutor } from '../overseer/routing.js';
import { decompose, parsePhases, modelsBlock, VALID_TYPES as VALID_PHASE_TYPES, type Phase } from '../overseer/planner.js';
import { classifySession } from '../overseer/sessionInfo.js';
import { isDestructive } from '../overseer/decision.js';
import { buildReviewContext } from '../overseer/reviewContext.js';
import { PlanJobStore, type PlanJob } from '../overseer/planJob.js';
import { DecisionQueue } from '../overseer/decisionQueue.js';
import type { Task } from '../store/types.js';
import { RelayClient } from '../inference/client.js';
import type { InferenceClient, RelayConfig } from '../inference/types.js';
import { uniqueName } from '../daemon/uniqueName.js';
import type { Clock } from '../shared/clock.js';
import type { ConfigStore } from '../store/configStore.js';
import { assembleMissionDetail } from '../store/missionDetail.js';
import type { UserStore, User, TokenScope } from '../store/userStore.js';
import { authMiddleware } from './auth.js';
import { handleMcpRequest } from '../mcp/server.js';
import type { EventStore } from '../store/eventStore.js';
import type { ProjectStore } from '../store/projectStore.js';
import type { UserProjectStore } from '../store/userProjectStore.js';
import type { GitReader } from '../git/gitReader.js';
import { logger } from '../shared/logger.js';
import { shortId } from '../shared/id.js';

/** How many times an L3 mission auto-re-spawns a phase that the post-done review rejected before it
 *  gives up and escalates to a human. Mirrors the stuck detector's `maxRelaunch` (2) so the two
 *  bounded-retry loops behave consistently. */
const REVIEW_FIX_BUDGET = 2;

export interface ServerDeps {
  tasks: TaskStore; readiness: Readiness; missions: MissionStore;
  engine: MissionEngine; spawn: SpawnService; tmux: TmuxDriver; bus: EventBus;
  project: { id: number; path: string };
  fallback: AgentSpec;
  clock: Clock;
  config: ConfigStore;
  users?: UserStore;
  events?: EventStore;
  projects?: ProjectStore;
  userProjects?: UserProjectStore;
  /** Agent registry — records each spawned agent's project at spawn. Used to tag live sessions with
   *  their project (the daemon's single source of truth for session→repo). */
  agents?: AgentStore;
  git?: GitReader;
  /** Directory where uploaded user avatars are stored/served. Absent → avatar upload disabled. */
  avatarsDir?: string;
  /** HMAC secret for short-lived signed avatar URLs (so an <img> src never carries the long-lived
   *  session token). Per-daemon-process; absent → signed avatar links unavailable (bearer only). */
  avatarSecret?: string;
  /** Factory for the planning LLM client; defaults to RelayClient. Overridable in tests. */
  makeInference?: (cfg: RelayConfig) => InferenceClient;
  /** Async planning job registry (relay or agent backend resolves into it). Defaulted when absent. */
  planJobs?: PlanJobStore;
  /** Per-mission decision queue consumed by the parked overseer agent (long-poll). Defaulted when absent. */
  decisionQueue?: DecisionQueue;
  /** Spawn the Pilot agent for an agent-mode plan job (Task 9). Absent → relay-only planning. */
  pilot?: (job: PlanJob, projectPath: string) => Promise<void>;
  /** Per-user advisor lifecycle. Absent → advisor feature disabled (routes degrade gracefully). */
  advisor?: import('../advisor/service.js').AdvisorService;
}

/** This package's version, read once from its package.json (two dirs up from dist/api/server.js, and
 *  likewise from src/api/server.ts in dev/tests). Surfaced on /health so the web UI can show it. */
const ORCA_VERSION = (() => {
  try { return (JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0'; }
  catch { return '0.0.0'; }
})();

/** Port the daemon listens on — the MCP route reaches back into this same daemon's REST API at it. */
const ORCA_PORT = Number(process.env.ORCA_PORT ?? 4400);

export function createServer(d: ServerDeps): Hono<{ Variables: { user: User; token: string; tokenScope: TokenScope } }> {
  const log = logger('api');
  // Core reasoning stores are optional in deps for back-compat with existing call sites/tests; the
  // daemon (bootstrap) injects shared instances. Default here so every route has a working store.
  const planJobs = d.planJobs ?? new PlanJobStore();
  const decisionQueue = d.decisionQueue ?? new DecisionQueue();
  const app = new Hono<{ Variables: { user: User; token: string; tokenScope: TokenScope } }>();
  app.use('*', cors());
  // Single source of truth for malformed-body handling: most POST/PATCH routes call `c.req.json()`
  // without a per-route catch, and Hono throws a SyntaxError on invalid JSON. Convert that to a clean
  // 400 instead of leaking a default 500 with no useful body.
  app.onError((err, c) => {
    if (err instanceof SyntaxError) return c.json({ error: 'invalid JSON body' }, 400);
    log.error('unhandled route error', err);
    return c.json({ error: 'internal error' }, 500);
  });
  app.get('/health', c => c.json({ ok: true, version: ORCA_VERSION }));
  // Public: lets the web decide whether to show onboarding (no users yet) or the login form.
  app.get('/setup', c => c.json({ needsSetup: d.users ? d.users.count() === 0 : false }));

  if (d.users) {
    const users = d.users;
    app.use('*', authMiddleware(users, () => d.config.get().security.tokenTtlDays));

    // Capability gate for the agent service token. A spawned worker/overseer/pilot runs with
    // --dangerously-skip-permissions, so a prompt-injected agent must NOT reach the admin surface
    // (users, /config, project register/delete). Allow ONLY the verbs its CLI actually drives:
    //   • close its task        → PATCH /tasks/:id
    //   • submit a plan         → POST  /plan/:jobId/submit  (+ GET /plan/:jobId)
    //   • overseer poll/decide  → GET /missions/:id/overseer/next, POST /missions/:id/overseer/decide
    //   • read-only listings    → GET /tasks, /tasks/ready, /sessions   (orca ls|ready|sessions)
    // Project ownership of the affected row is still enforced downstream (canAccessProject etc.),
    // so the agent can't cross tenancy even within the allow-list.
    const agentAllowed = (method: string, path: string): boolean => {
      if (method === 'GET') {
        if (path === '/tasks' || path === '/tasks/ready' || path === '/sessions') return true;
        if (/^\/plan\/[^/]+$/.test(path)) return true;
        if (/^\/missions\/[^/]+\/overseer\/next$/.test(path)) return true;
      }
      if (method === 'PATCH' && /^\/tasks\/[^/]+$/.test(path)) return true;
      if (method === 'POST') {
        if (/^\/plan\/[^/]+\/submit$/.test(path)) return true;
        if (/^\/missions\/[^/]+\/overseer\/decide$/.test(path)) return true;
      }
      return false;
    };
    app.use('*', async (c, next) => {
      if (c.get('tokenScope') !== 'agent') return next();
      if (!agentAllowed(c.req.method, c.req.path)) return c.json({ error: 'forbidden' }, 403);
      return next();
    });

    // Gate the project-scoped surface: a non-admin must be assigned to the daemon's project to
    // touch its tasks/missions/sessions. Admin passes (canAccess checks is_admin). Without a
    // userProjects store this is a no-op (single-user mode keeps full access).
    if (d.userProjects) {
      const up = d.userProjects;
      // Every route family that exposes the daemon's project data — including the activity log and
      // the live SSE event stream, which carry task/mission ids + statuses. Boundary-matched so
      // '/tasksfoo' can't sneak past '/tasks'.
      const GATED = ['/tasks', '/missions', '/sessions', '/activity', '/events'];
      app.use('*', async (c, next) => {
        const p = c.req.path;
        if (!GATED.some((g) => p === g || p.startsWith(g + '/'))) return next();
        // An advisor session is per-user, not project-scoped: its access is governed by ownership in
        // the route's own sessionAccessible check, so the project gate must not pre-empt it (the user
        // need not be assigned to the daemon's project to reach their own advisor).
        const sess = p.match(/^\/sessions\/([^/]+)/);
        if (sess?.[1] && classifySession(decodeURIComponent(sess[1])).role === 'advisor') return next();
        if (users.count() === 0) return next(); // setup mode — no users to gate yet
        const u = c.get('user');
        if (u && up.canAccess(u.id, d.project.id)) return next();
        return c.json({ error: 'forbidden' }, 403);
      });
    }

    // Brute-force guard for the only unauthenticated, credential-checking endpoint: a fixed window per
    // client IP. Prefer x-real-ip (set by our nginx) over the client-spoofable x-forwarded-for. In-memory
    // per-process is enough for the single-daemon deployment; entries self-expire and are swept when the
    // map grows large so distinct-IP traffic can't leak memory.
    const LOGIN_MAX = 10, LOGIN_WINDOW_MS = 5 * 60_000;
    const loginHits = new Map<string, { count: number; resetAt: number }>();
    const loginLimited = (ip: string, now: number): boolean => {
      if (loginHits.size > 5000) for (const [k, v] of loginHits) if (now >= v.resetAt) loginHits.delete(k);
      const h = loginHits.get(ip);
      if (!h || now >= h.resetAt) { loginHits.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS }); return false; }
      h.count++;
      return h.count > LOGIN_MAX;
    };
    app.post('/auth/login', async (c) => {
      const ip = c.req.header('x-real-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
      if (loginLimited(ip, d.clock.now())) return c.json({ error: 'too many login attempts, try again later' }, 429);
      // Tolerate a missing/invalid JSON body: `c.req.json()` throws on empty input, which would surface
      // as an unhandled 500. A malformed login is a client error → 400, not a server fault.
      const body = await c.req.json().catch(() => null) as { username?: unknown; password?: unknown } | null;
      if (typeof body?.username !== 'string' || typeof body?.password !== 'string') {
        return c.json({ error: 'username and password required' }, 400);
      }
      const user = users.verify(body.username, body.password);
      if (!user) return c.json({ error: 'invalid credentials' }, 401);
      loginHits.delete(ip); // a valid login clears the counter so an earlier typo streak can't lock the user out
      const token = users.issueToken(user.id);
      void d.advisor?.ensureOnLogin(user.id); // fire-and-forget: bring the user's advisor back up; never block login
      return c.json({ token, user });
    });
    app.post('/auth/logout', (c) => { const t = c.get('token'); if (t) users.revokeToken(t); return c.json({ ok: true }); });
    app.get('/auth/me', (c) => c.json({ user: c.get('user') }));
    // Self-service profile: name / email / preferred default executor. A user edits only their own.
    app.patch('/auth/me', async (c) => {
      const u = c.get('user');
      const b = await c.req.json() as { name?: string; email?: string; default_exec?: string };
      if (typeof b.default_exec === 'string' && b.default_exec) {
        // The preferred default must be one the user is actually allowed to run.
        const globalOk = d.config.get().allowedExecs.includes(b.default_exec);
        const personalOk = u.allowed_execs.length === 0 || u.allowed_execs.includes(b.default_exec);
        if (!globalOk || !personalOk) return c.json({ error: 'exec not allowed' }, 400);
      }
      return c.json(users.setProfile(u.id, { name: b.name, email: b.email, default_exec: b.default_exec }));
    });
    // Self-service password change: verify the current password, then swap in the new one. A wrong
    // current password is rejected (401) so it can't be used to set a password without knowing it.
    app.post('/auth/me/password', async (c) => {
      const u = c.get('user');
      const b = await c.req.json().catch(() => null) as { currentPassword?: unknown; newPassword?: unknown } | null;
      if (typeof b?.currentPassword !== 'string' || typeof b?.newPassword !== 'string') {
        return c.json({ error: 'currentPassword and newPassword required' }, 400);
      }
      if (b.newPassword.length < 8) return c.json({ error: 'new password too short (min 8)' }, 400);
      if (!users.changePassword(u.id, b.currentPassword, b.newPassword)) {
        return c.json({ error: 'current password is incorrect' }, 401);
      }
      return c.json({ ok: true });
    });
    // Avatar upload (multipart). Validated by type + size; stored as <userId>.<ext> under avatarsDir.
    const AVATAR_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
    const AVATAR_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
    app.post('/auth/me/avatar', async (c) => {
      if (!d.avatarsDir) return c.json({ error: 'avatars unavailable' }, 400);
      const u = c.get('user');
      const form = await c.req.formData();
      const file = form.get('avatar');
      if (!(file instanceof File)) return c.json({ error: 'avatar file required' }, 400);
      const ext = AVATAR_EXT[file.type];
      if (!ext) return c.json({ error: 'unsupported image type' }, 415);
      if (file.size > 2 * 1024 * 1024) return c.json({ error: 'image too large (max 2MB)' }, 413);
      mkdirSync(d.avatarsDir, { recursive: true });
      // Drop any prior avatar of a different extension so a user never keeps two files.
      for (const e of Object.values(AVATAR_EXT)) { if (e !== ext) { const f = join(d.avatarsDir, `${u.id}.${e}`); if (existsSync(f)) { try { unlinkSync(f); } catch { /* best-effort */ } } } }
      const filename = `${u.id}.${ext}`;
      writeFileSync(join(d.avatarsDir, filename), Buffer.from(await file.arrayBuffer()));
      return c.json(users.setAvatar(u.id, filename));
    });
    // Short-lived signed URL for a user's avatar. An <img> can't set an Authorization header, so the
    // old approach put the long-lived session token in the query string (leaked into logs/referrer/
    // history — finding W2). Instead, an AUTHENTICATED caller mints a signed link here; the link
    // carries only an HMAC over (id, exp) that expires in minutes, so a leaked URL is near-worthless.
    const AVATAR_URL_TTL_MS = 5 * 60 * 1000;
    const signAvatar = (id: number, exp: number): string =>
      createHmac('sha256', d.avatarSecret!).update(`${id}.${exp}`).digest('hex');
    const avatarSigValid = (id: number, exp: number, sig: string): boolean => {
      if (!d.avatarSecret || !Number.isFinite(exp) || exp < Date.now()) return false;
      const expected = Buffer.from(signAvatar(id, exp), 'hex');
      const got = Buffer.from(sig, 'hex');
      return expected.length === got.length && timingSafeEqual(expected, got);
    };
    app.get('/users/:id/avatar/url', (c) => {
      if (!d.avatarsDir || !d.avatarSecret) return c.json({ error: 'avatars unavailable' }, 400);
      const id = Number(c.req.param('id'));
      const target = users.get(id);
      if (!target || !target.avatar) return c.json({ error: 'not found' }, 404);
      const exp = Date.now() + AVATAR_URL_TTL_MS;
      return c.json({ url: `/users/${id}/avatar?exp=${exp}&sig=${signAvatar(id, exp)}` });
    });
    // Serve a user's avatar bytes. Reachable as an <img> src via a short-lived `exp`+`sig` signature
    // (minted above); the bearer path still works for direct API use.
    app.get('/users/:id/avatar', (c) => {
      if (!d.avatarsDir) return c.json({ error: 'not found' }, 404);
      const id = Number(c.req.param('id'));
      const exp = Number(c.req.query('exp'));
      const sig = c.req.query('sig');
      // Allow either a valid signature (the <img> path) or the authenticated session (bearer/token,
      // which the auth middleware already validated for any non-signed request that reached here).
      if (sig != null) { if (!avatarSigValid(id, exp, sig)) return c.json({ error: 'forbidden' }, 403); }
      const target = users.get(id);
      if (!target || !target.avatar) return c.json({ error: 'not found' }, 404);
      const path = join(d.avatarsDir, target.avatar);
      if (!existsSync(path)) return c.json({ error: 'not found' }, 404);
      const ext = target.avatar.split('.').pop() ?? '';
      const body = new Uint8Array(readFileSync(path)).buffer;
      return c.body(body, 200, { 'content-type': AVATAR_MIME[ext] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    });
    app.get('/users', (c) => c.json(users.list()));
    app.post('/users', async (c) => {
      const { username, password } = await c.req.json();
      // Allow creation during setup (no users yet), otherwise admin only
      if (users.count() > 0) {
        const actor = c.get('user');
        if (!actor || !users.isAdmin(actor.id)) return c.json({ error: 'forbidden' }, 403);
      }
      try { return c.json(users.create(username, password), 201); }
      catch { return c.json({ error: 'username taken' }, 409); }
    });
    app.delete('/users/:id', (c) => {
      if (users.count() <= 1) return c.json({ error: 'cannot delete the last user' }, 400);
      // Never delete the admin: it would lock out assignment management and (on restart) silently
      // re-elect another user as admin. The flag must be transferred deliberately first.
      if (users.isAdmin(Number(c.req.param('id')))) return c.json({ error: 'cannot delete the admin' }, 400);
      users.delete(Number(c.req.param('id')));
      return c.json({ ok: true });
    });

    // Admin edits another user's permissions: role (is_admin) and per-user model allow-list.
    app.patch('/users/:id', async (c) => {
      const actor = c.get('user');
      if (!actor || !users.isAdmin(actor.id)) return c.json({ error: 'forbidden' }, 403);
      const id = Number(c.req.param('id'));
      const target = users.get(id);
      if (!target) return c.json({ error: 'user not found' }, 404);
      const b = await c.req.json() as { is_admin?: boolean; allowed_execs?: string[] };
      if (typeof b.is_admin === 'boolean') {
        // Refuse to demote the last admin — it would lock out role/assignment management.
        if (!b.is_admin && target.is_admin && users.adminCount() <= 1) return c.json({ error: 'cannot demote the last admin' }, 400);
        users.setAdmin(id, b.is_admin);
      }
      if (Array.isArray(b.allowed_execs)) {
        // Can't grant beyond what the daemon globally allows; keep only known execs (dedup).
        const globalAllowed = new Set(d.config.get().allowedExecs);
        users.setAllowedExecs(id, [...new Set(b.allowed_execs.filter((e) => typeof e === 'string' && globalAllowed.has(e)))]);
      }
      return c.json(users.get(id));
    });

    // User ↔ project assignments. Only the bootstrap admin may view/manage them.
    if (d.userProjects) {
      const up = d.userProjects;
      const adminOnly = (c: { get: (k: 'user') => User }) => up.isAdmin(c.get('user').id);
      app.get('/users/:id/projects', (c) => {
        if (!adminOnly(c)) return c.json({ error: 'forbidden' }, 403);
        return c.json(up.forUser(Number(c.req.param('id'))));
      });
      app.post('/users/:id/projects', async (c) => {
        if (!adminOnly(c)) return c.json({ error: 'forbidden' }, 403);
        const { projectId } = await c.req.json() as { projectId?: number };
        if (projectId == null) return c.json({ error: 'projectId required' }, 400);
        up.assign(Number(c.req.param('id')), Number(projectId));
        return c.json({ ok: true });
      });
      app.delete('/users/:id/projects/:pid', (c) => {
        if (!adminOnly(c)) return c.json({ error: 'forbidden' }, 403);
        up.unassign(Number(c.req.param('id')), Number(c.req.param('pid')));
        return c.json({ ok: true });
      });
    }
  }

  // Minimal structural view of the request context the access predicates read (the real Hono context
  // satisfies it). Overloaded `get` so a caller can read both the user and the token scope.
  type AccessCtx = { get: { (k: 'user'): User | undefined; (k: 'tokenScope'): TokenScope | undefined } };

  // The projects an AGENT-scoped token may touch. The shared service token is owned by the admin user,
  // so without this it would inherit admin's cross-project bypass and a prompt-injected agent could
  // read/close tasks in tenants it isn't working in (finding S51). Bind it to the daemon's live work:
  //   • workers   → projects with an in_progress `agent:`-labelled task
  //   • overseers → projects of every active mission's epic (the overseer polls even between phases)
  // A pilot only ever submits to the plan job it was handed (project checked on that job's route), so
  // it needs no extra entry here.
  const agentProjects = (): Set<number> => {
    const ids = new Set<number>();
    for (const t of d.tasks.list({ status: 'in_progress' })) {
      if (t.labels.some((l) => l.startsWith('agent:'))) ids.add(t.project_id);
    }
    for (const m of d.missions.active()) {
      const epic = d.tasks.get(m.epic_id);
      if (epic) ids.add(epic.project_id);
    }
    // The final-phase agent closes the epic itself right after closing its own leaf — by then its task
    // is no longer in_progress and the mission has disengaged, so neither set above covers it and the
    // epic-close would 403. A still-open epic that hosted agent work keeps its project reachable to that
    // agent until the epic is actually closed (then it drops out again). No permanent widening.
    for (const t of d.tasks.list()) {
      if (!t.parent_id || !t.labels.some((l) => l.startsWith('agent:'))) continue;
      const epic = d.tasks.get(t.parent_id);
      if (epic && epic.status !== 'closed' && epic.status !== 'cancelled') ids.add(epic.project_id);
    }
    return ids;
  };

  // A non-admin user may only see/operate projects assigned to them; the admin (and open mode)
  // sees everything. An agent-scoped token is confined to its live working set, never admin-bypass.
  // Returns true when access is permitted.
  const canAccessProject = (c: AccessCtx, id: number): boolean => {
    if (!d.userProjects || !d.users) return true; // open mode / single-user → no gating
    if (c.get('tokenScope') === 'agent') return agentProjects().has(id);
    const u = c.get('user');
    return !!u && d.userProjects.canAccess(u.id, id);
  };

  // Admin gate for daemon-wide, project-agnostic routes (integrations, etc.). Open/single-user mode
  // (no userProjects store) passes; otherwise only the admin clears it.
  const notAdmin = (c: { get: (k: 'user') => User | undefined }): boolean => {
    if (!d.userProjects || !d.users) return false;
    const u = c.get('user');
    return !u || !d.userProjects.isAdmin(u.id);
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

  // A mission belongs to its epic's project — gate by that project's access. Open/single-user mode
  // has no tenancy boundary, so it always passes (even if the epic row is absent).
  const missionAccessible = (c: AccessCtx, epicId: string): boolean => {
    if (!d.userProjects || !d.users) return true;
    const epic = d.tasks.get(epicId);
    return !!epic && canAccessProject(c, epic.project_id);
  };

  // Resolve a live session name (`orca-<agentName>` / `orca-overseer-<missionId>` / `orca-pilot-…`)
  // to the task it runs, mirroring the daemon's agent:<name> label convention (bootstrap.taskForSession).
  // Agent names recur across missions, so the MOST RECENT match wins (list is created_at ASC).
  const taskForSession = (session: string): Task | null => {
    const info = classifySession(session);
    if (info.role === 'overseer') {
      const mission = d.missions.get(info.missionId ?? '');
      return mission ? d.tasks.get(mission.epic_id) : null;
    }
    const matches = d.tasks.list().filter((t) => t.labels.includes(`agent:${info.agent}`));
    return matches[matches.length - 1] ?? null;
  };

  // Ownership guard for the session-control routes (kill / keys / resize / pane / stream). The caller
  // must be able to access the project the session's task belongs to; admin / open-mode pass via
  // canAccessProject. An unresolvable session (no matching task) is refused — a caller can't operate
  // a session it can't be shown to own. Returns null when access is allowed, else a 403 response.
  const sessionAccessible = (c: AccessCtx, name: string): boolean => {
    if (!d.userProjects || !d.users) return true; // open / single-user mode — no tenancy boundary
    const u = c.get('user');
    // An advisor session belongs to exactly one user: only its owner (or an admin) may reach it, and
    // never via an agent-scoped token. It has no task row, so the project check below can't apply.
    const info = classifySession(name);
    if (info.role === 'advisor') {
      if (c.get('tokenScope') === 'agent') return false;
      return !!u && (u.id === info.userId || d.userProjects.isAdmin(u.id));
    }
    // Admin sees every session — but NOT via an agent-scoped token (it's owned by the admin user yet
    // must stay confined to its working set; fall through to the project check below).
    if (c.get('tokenScope') !== 'agent' && u && d.userProjects.isAdmin(u.id)) return true;
    const task = taskForSession(name);
    return !!task && canAccessProject(c, task.project_id);
  };

  // Per-user model allow-list: a non-admin whose allowed_execs is non-empty may only use those
  // execs. Open mode (no auth), admins, or an empty list → unrestricted. The global
  // config.allowedExecs check still applies independently and is the outer bound.
  const execAllowedForUser = (c: { get: (k: 'user') => User | undefined }, exec: string): boolean => {
    if (!d.users) return true;
    const u = c.get('user');
    if (!u || u.is_admin) return true;
    return u.allowed_execs.length === 0 || u.allowed_execs.includes(exec);
  };

  // Filesystem path of a project. The daemon's home project is always known; others resolve via the
  // ProjectStore (falling back to the home path when the store is absent — e.g. legacy single-project).
  const pathFor = (projectId: number): string =>
    projectId === d.project.id ? d.project.path : (d.projects?.get(projectId)?.path ?? d.project.path);

  // Resolve the target project for a create/plan request. Defaults to the daemon's home project;
  // any other project_id must exist and be accessible to the caller.
  const resolveTarget = (c: AccessCtx, projectId?: number):
    | { project: { id: number; path: string } }
    | { error: string; status: 403 | 404 } => {
    const pid = projectId ?? d.project.id;
    if (pid === d.project.id) return { project: d.project };
    const p = d.projects?.get(pid);
    if (!p) return { error: 'project not found', status: 404 };
    if (!canAccessProject(c, p.id)) return { error: 'forbidden', status: 403 };
    return { project: { id: p.id, path: p.path } };
  };

  // Persist a plan job's phases as an epic + chained child tasks. Creates the epic when the job has
  // no epicId yet; otherwise appends after the epic's current tail (leaves = phases nothing depends
  // on). For a fresh epic there are no descendants, so the first new phase simply starts the chain.
  // Single source of truth for both initial planning and replan (DRY with the old inline blocks).
  function persistPlan(job: PlanJob): { epic: Task; phases: Task[] } {
    const path = pathFor(job.projectId);
    const allowedExecs = d.config.get().allowedExecs;
    const newId = () => shortId(basename(path));
    const epicId = job.epicId ?? newId();
    let epic = d.tasks.get(epicId);
    if (!epic) {
      epic = d.tasks.create({ id: epicId, project_id: job.projectId, title: job.goal, type: 'epic', description: job.goal });
      d.bus.publish({ type: 'task', taskId: epic.id, status: epic.status });
    }
    const existing = d.tasks.descendants(epic.id);
    const dependedOn = new Set(d.tasks.depsAmong(existing.map((t) => t.id)).map((e) => e.depends_on_id));
    const leaves = existing.map((t) => t.id).filter((id) => !dependedOn.has(id));
    const overallGoal = epic.description?.trim() || epic.title;
    const created: Task[] = [];
    let prevId: string | null = null;
    for (const ph of job.phases) {
      const childDesc = ph.details ? `${ph.details}\n\nOverall goal: ${overallGoal}` : `Overall goal: ${overallGoal}`;
      const child = d.tasks.create({ id: newId(), project_id: job.projectId, title: ph.title, type: ph.type, parent_id: epic.id, labels: ph.agent ? [`agent:${ph.agent}`] : [], description: childDesc });
      if (prevId) d.tasks.addDep(child.id, prevId); // chain within the new batch
      else for (const leaf of leaves) d.tasks.addDep(child.id, leaf); // first new phase waits on the tail
      // exec: auto mode takes the planner's per-phase pick, manual mode the job-level choice. Either
      // way it must be allow-listed — a halucinated/disabled exec is dropped so the child runs with
      // the configured default (resolveExecutor fallback), never a bogus model.
      const pickedExec = job.autoModel ? ph.exec : job.exec;
      if (pickedExec && allowedExecs.includes(pickedExec)) d.tasks.setExec(child.id, pickedExec);
      d.bus.publish({ type: 'task', taskId: child.id, status: child.status });
      created.push(child);
      prevId = child.id;
    }
    return { epic, phases: created };
  }

  // Finalize an async plan job: a dryRun job records phases without persisting; otherwise persist the
  // epic+children, optionally engage a mission, tick an already-active mission so it picks up the new
  // ready phase, and announce the result over SSE. Shared by the relay path and the agent submit path.
  // Reap a settled plan job's Pilot tmux session. The Pilot has submitted (or the job failed), so its
  // pane is done; leaving it alive lets a finished planner linger and later collide with a fresh plan
  // job's session name. No-op for relay jobs (no session) and safe if the session is already gone.
  const reapPilotSession = (job: PlanJob): void => {
    if (job.sessionName) void d.tmux.kill(job.sessionName).catch(() => { /* already gone — fine */ });
  };

  async function finalizePlanJob(jobId: string, phases: Phase[]): Promise<void> {
    const job = planJobs.get(jobId);
    if (!job) return;
    if (job.dryRun) {
      planJobs.setPhases(jobId, phases);
      d.bus.publish({ type: 'plan', jobId, status: 'done', phases });
      reapPilotSession(job);
      return;
    }
    job.phases = phases;
    const { epic, phases: created } = persistPlan(job);
    job.epicId = epic.id;
    planJobs.setPhases(jobId, phases);
    if (job.engage) {
      await d.engine.engage({ epicId: epic.id, autonomy: job.engage.autonomy, maxSessions: job.engage.maxSessions });
    } else {
      const missionId = `m-${epic.id}`;
      if (d.engine?.isActive(missionId)) await d.engine.tick(missionId); // replan into a live mission
    }
    d.bus.publish({ type: 'plan', jobId, status: 'done', epicId: epic.id, phases: created.map((t) => ({ title: t.title, type: t.type })) });
    reapPilotSession(job);
  }

  app.get('/projects', (c) => {
    const all = d.projects ? d.projects.list() : [];
    if (!d.userProjects || !d.users) return c.json(all);
    const u = c.get('user');
    if (u && d.userProjects.isAdmin(u.id)) return c.json(all);
    const allowed = u ? new Set(d.userProjects.forUser(u.id)) : new Set<number>();
    return c.json(all.filter((p) => allowed.has(p.id)));
  });
  app.post('/projects', async (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    // Only the admin may register projects (when multi-user auth is on).
    if (d.userProjects && d.users) { const u = c.get('user'); if (!u || !d.userProjects.isAdmin(u.id)) return c.json({ error: 'forbidden' }, 403); }
    const { slug, path, notes } = await c.req.json();
    try { return c.json(d.projects.create({ slug, path, notes }), 201); }
    catch { return c.json({ error: 'slug taken' }, 409); }
  });
  // Edit a project's path / Pilot notes (slug stays immutable). Admin-only, like registration.
  app.patch('/projects/:id', async (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    if (d.userProjects && d.users) { const u = c.get('user'); if (!u || !d.userProjects.isAdmin(u.id)) return c.json({ error: 'forbidden' }, 403); }
    const id = Number(c.req.param('id'));
    const cur = d.projects.get(id);
    if (!cur) return c.json({ error: 'project not found' }, 404);
    const b = await c.req.json() as { path?: string; notes?: string; icon?: string };
    const patch: { path?: string; notes?: string; icon?: string } = {};
    if (typeof b.path === 'string' && b.path.trim()) patch.path = b.path.trim();
    if (typeof b.notes === 'string') patch.notes = b.notes;
    // Icon is a project-relative image path. '' clears it; anything else must resolve to a real image
    // file inside the project root (guards against path traversal / pointing at a non-image).
    if (typeof b.icon === 'string') {
      if (b.icon !== '' && !isProjectImage(cur.path, b.icon)) return c.json({ error: 'invalid icon path' }, 400);
      patch.icon = b.icon;
    }
    return c.json(d.projects.update(id, patch));
  });
  // Remove a project from orca entirely: cascades to its tasks, missions, agents and access grants
  // (ProjectStore.remove), but never touches the files on disk. Admin-only; the daemon's home project
  // can't be removed (it's where the daemon itself lives).
  app.delete('/projects/:id', (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    if (d.userProjects && d.users) { const u = c.get('user'); if (!u || !d.userProjects.isAdmin(u.id)) return c.json({ error: 'forbidden' }, 403); }
    const id = Number(c.req.param('id'));
    if (id === d.project.id) return c.json({ error: 'cannot remove the home project' }, 400);
    if (!d.projects.get(id)) return c.json({ error: 'project not found' }, 404);
    d.projects.remove(id);
    return c.json({ ok: true });
  });
  app.get('/projects/:id/git', async (c) => {
    if (!d.projects || !d.git) return c.json({ error: 'projects unavailable' }, 400);
    const p = d.projects.get(Number(c.req.param('id')));
    if (!p) return c.json({ error: 'project not found' }, 404);
    if (!canAccessProject(c, p.id)) return c.json({ error: 'forbidden' }, 403);
    return c.json(await d.git.read(p.path));
  });

  // --- Project file editor: tree, read, write, per-file diff. Paths are validated to stay inside
  // the project root (see projectFiles.safe); access is gated to the project's assigned users. ---
  const projectOf = (c: { req: { param: (k: string) => string } }) => d.projects?.get(Number(c.req.param('id'))) ?? null;
  app.get('/projects/:id/files', (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    const p = projectOf(c); if (!p) return c.json({ error: 'project not found' }, 404);
    if (!canAccessProject(c, p.id)) return c.json({ error: 'forbidden' }, 403);
    return c.json(listProjectFiles(p.path));
  });
  app.get('/projects/:id/file', (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    const p = projectOf(c); if (!p) return c.json({ error: 'project not found' }, 404);
    if (!canAccessProject(c, p.id)) return c.json({ error: 'forbidden' }, 403);
    const path = c.req.query('path'); if (!path) return c.json({ error: 'path required' }, 400);
    try { return c.json(readProjectFile(p.path, path)); }
    catch { return c.json({ error: 'invalid path' }, 400); }
  });
  app.put('/projects/:id/file', async (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    const p = projectOf(c); if (!p) return c.json({ error: 'project not found' }, 404);
    if (!canAccessProject(c, p.id)) return c.json({ error: 'forbidden' }, 403);
    const b = await c.req.json() as { path?: string; content?: string };
    if (!b.path || typeof b.content !== 'string') return c.json({ error: 'path and content required' }, 400);
    try { writeProjectFile(p.path, b.path, b.content); return c.json({ ok: true }); }
    catch { return c.json({ error: 'invalid path' }, 400); }
  });
  // Raw file bytes for binary previews (images). Content-type from extension; unknown → octet-stream.
  app.get('/projects/:id/raw', (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    const p = projectOf(c); if (!p) return c.json({ error: 'project not found' }, 404);
    if (!canAccessProject(c, p.id)) return c.json({ error: 'forbidden' }, 403);
    const path = c.req.query('path'); if (!path) return c.json({ error: 'path required' }, 400);
    try {
      const bytes = readProjectBytes(p.path, path);
      if (!bytes) return c.json({ error: 'not previewable' }, 415);
      const ext = path.split('.').pop()?.toLowerCase() ?? '';
      const mime: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp', avif: 'image/avif' };
      const body = new Uint8Array(bytes).buffer; // fresh ArrayBuffer (not the Buffer's shared pool)
      return c.body(body, 200, { 'content-type': mime[ext] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    } catch { return c.json({ error: 'invalid path' }, 400); }
  });
  // File-manager operations (create / mkdir / rename / copy / delete). Each validates the path(s)
  // stay inside the project root and is gated to the project's assigned users.
  app.post('/projects/:id/new-file', async (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    const p = projectOf(c); if (!p) return c.json({ error: 'project not found' }, 404);
    if (!canAccessProject(c, p.id)) return c.json({ error: 'forbidden' }, 403);
    const b = await c.req.json() as { path?: string };
    if (!b.path) return c.json({ error: 'path required' }, 400);
    try { createProjectFile(p.path, b.path); return c.json({ ok: true }); }
    catch (e) { return c.json({ error: e instanceof Error ? e.message : 'invalid path' }, 400); }
  });
  app.post('/projects/:id/dir', async (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    const p = projectOf(c); if (!p) return c.json({ error: 'project not found' }, 404);
    if (!canAccessProject(c, p.id)) return c.json({ error: 'forbidden' }, 403);
    const b = await c.req.json() as { path?: string };
    if (!b.path) return c.json({ error: 'path required' }, 400);
    try { createProjectDir(p.path, b.path); return c.json({ ok: true }); }
    catch (e) { return c.json({ error: e instanceof Error ? e.message : 'invalid path' }, 400); }
  });
  app.post('/projects/:id/rename', async (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    const p = projectOf(c); if (!p) return c.json({ error: 'project not found' }, 404);
    if (!canAccessProject(c, p.id)) return c.json({ error: 'forbidden' }, 403);
    const b = await c.req.json() as { from?: string; to?: string };
    if (!b.from || !b.to) return c.json({ error: 'from and to required' }, 400);
    try { renameProjectEntry(p.path, b.from, b.to); return c.json({ ok: true }); }
    catch (e) { return c.json({ error: e instanceof Error ? e.message : 'invalid path' }, 400); }
  });
  app.post('/projects/:id/copy', async (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    const p = projectOf(c); if (!p) return c.json({ error: 'project not found' }, 404);
    if (!canAccessProject(c, p.id)) return c.json({ error: 'forbidden' }, 403);
    const b = await c.req.json() as { from?: string; to?: string };
    if (!b.from || !b.to) return c.json({ error: 'from and to required' }, 400);
    try { copyProjectEntry(p.path, b.from, b.to); return c.json({ ok: true }); }
    catch (e) { return c.json({ error: e instanceof Error ? e.message : 'invalid path' }, 400); }
  });
  app.delete('/projects/:id/entry', (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    const p = projectOf(c); if (!p) return c.json({ error: 'project not found' }, 404);
    if (!canAccessProject(c, p.id)) return c.json({ error: 'forbidden' }, 403);
    const path = c.req.query('path'); if (!path) return c.json({ error: 'path required' }, 400);
    try { deleteProjectEntry(p.path, path); return c.json({ ok: true }); }
    catch (e) { return c.json({ error: e instanceof Error ? e.message : 'invalid path' }, 400); }
  });
  app.get('/projects/:id/diff', async (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    const p = projectOf(c); if (!p) return c.json({ error: 'project not found' }, 404);
    if (!canAccessProject(c, p.id)) return c.json({ error: 'forbidden' }, 403);
    const path = c.req.query('path'); if (!path) return c.json({ error: 'path required' }, 400);
    try { return c.json({ diff: await projectFileDiff(p.path, path) }); }
    catch { return c.json({ error: 'invalid path' }, 400); }
  });
  app.get('/projects/:id/head', async (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    const p = projectOf(c); if (!p) return c.json({ error: 'project not found' }, 404);
    if (!canAccessProject(c, p.id)) return c.json({ error: 'forbidden' }, 403);
    const path = c.req.query('path'); if (!path) return c.json({ error: 'path required' }, 400);
    try { return c.json({ content: await projectFileAtHead(p.path, path) }); }
    catch { return c.json({ error: 'invalid path' }, 400); }
  });
  app.get('/projects/:id/commit/:hash', async (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    const p = projectOf(c); if (!p) return c.json({ error: 'project not found' }, 404);
    if (!canAccessProject(c, p.id)) return c.json({ error: 'forbidden' }, 403);
    const hash = c.req.param('hash');
    const [diff, files] = await Promise.all([projectCommitDiff(p.path, hash), projectCommitFiles(p.path, hash)]);
    return c.json({ diff, files });
  });
  app.get('/projects/:id/commit/:hash/diff', async (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    const p = projectOf(c); if (!p) return c.json({ error: 'project not found' }, 404);
    if (!canAccessProject(c, p.id)) return c.json({ error: 'forbidden' }, 403);
    const path = c.req.query('path'); if (!path) return c.json({ error: 'path required' }, 400);
    try { return c.json({ diff: await projectCommitFileDiff(p.path, c.req.param('hash'), path) }); }
    catch { return c.json({ error: 'invalid path' }, 400); }
  });
  app.get('/projects/:id/commits', async (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    const p = projectOf(c); if (!p) return c.json({ error: 'project not found' }, 404);
    if (!canAccessProject(c, p.id)) return c.json({ error: 'forbidden' }, 403);
    const limit = Number(c.req.query('limit')) || 30;
    return c.json({ commits: await projectCommitLog(p.path, limit) });
  });
  app.get('/projects/:id/changed', async (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    const p = projectOf(c); if (!p) return c.json({ error: 'project not found' }, 404);
    if (!canAccessProject(c, p.id)) return c.json({ error: 'forbidden' }, 403);
    return c.json({ changed: await projectChangedFiles(p.path) });
  });
  app.get('/projects/:id/changes', async (c) => {
    if (!d.projects) return c.json({ error: 'projects unavailable' }, 400);
    const p = projectOf(c); if (!p) return c.json({ error: 'project not found' }, 404);
    if (!canAccessProject(c, p.id)) return c.json({ error: 'forbidden' }, 403);
    return c.json({ diff: await projectWorkingDiff(p.path) });
  });

  app.get('/activity', (c) => {
    if (!d.events) return c.json([]);
    const limit = Number(c.req.query('limit')) || undefined;
    const type = c.req.query('type') || undefined;
    return c.json(d.events.list({ limit, type }));
  });

  app.get('/tasks', c => {
    const allowed = accessibleProjects(c);
    const all = d.tasks.list();
    const scoped = allowed ? all.filter((t) => allowed.has(t.project_id)) : all;
    // Optional `?project_id=N` narrows the list to one project. Applied AFTER the access gate so a
    // non-admin can't cross tenancy. An unknown/foreign id simply yields [] (no 404 — benevolent).
    const pidRaw = c.req.query('project_id');
    if (pidRaw !== undefined && pidRaw !== '') {
      const pid = Number(pidRaw);
      if (Number.isFinite(pid)) return c.json(scoped.filter((t) => t.project_id === pid));
    }
    return c.json(scoped);
  });
  /** Release the dependents a phase's review gate was holding: clear this phase's `gatedby:<id>` hold
   *  and re-open each dependent that no OTHER review still gates (a DAG dependent can be held by several
   *  predecessors at once). Re-check 'blocked' so a human's manual change is never overridden. Single
   *  source of truth for both an agent-approved verdict and a human approval, so they behave
   *  identically. Returns the ids actually re-opened. */
  function releaseGatedDependents(phaseId: string): string[] {
    const reopened: string[] = [];
    for (const e of d.tasks.allDeps()) {
      if (e.depends_on_id !== phaseId) continue;
      const dep = d.tasks.get(e.task_id);
      if (!dep || !dep.labels.includes(`gatedby:${phaseId}`)) continue;
      d.tasks.removeLabel(dep.id, `gatedby:${phaseId}`);
      const stillGated = d.tasks.get(dep.id)!.labels.some((l) => l.startsWith('gatedby:'));
      if (!stillGated && dep.status === 'blocked') {
        d.tasks.setStatus(dep.id, 'open');
        d.bus.publish({ type: 'task', taskId: dep.id, status: 'open' });
        reopened.push(dep.id);
      }
    }
    return reopened;
  }

  app.post('/tasks', async c => {
    const b = await c.req.json() as { title: string; type?: string; priority?: string; id?: string; description?: string; scheduled_at?: string | null; autostart?: number; deps?: string[]; project_id?: number };
    const target = resolveTarget(c, b.project_id);
    if ('error' in target) return c.json({ error: target.error }, target.status);
    const id = b.id ?? shortId(basename(target.project.path));
    const created = d.tasks.create({ id, project_id: target.project.id, title: b.title, type: b.type, priority: b.priority, description: b.description, scheduled_at: b.scheduled_at, autostart: b.autostart });
    if (Array.isArray(b.deps)) d.tasks.setDeps(created.id, b.deps);
    d.bus.publish({ type: 'task', taskId: created.id, status: created.status });
    return c.json(created, 201);
  });
  app.get('/tasks/ready', c => c.json(d.readiness.ready(d.project.id)));
  app.get('/tasks/deps', c => c.json(d.tasks.allDeps()));
  // Token/cost usage for a task's agent run, read from the executor CLI's local session storage
  // (opencode / claude / codex) — portable, no relay. Null usage → no matching session found.
  app.get('/tasks/:id/usage', c => {
    const task = d.tasks.get(c.req.param('id'));
    if (!task) return c.json({ error: 'not found' }, 404);
    if (!canAccessProject(c, task.project_id)) return c.json({ error: 'forbidden' }, 403);
    // Pass the task's own project siblings so usage can disambiguate concurrent agents by start-order
    // rank, and read sessions from that project's path (not the daemon home, under multi-project).
    return c.json(readTaskUsage(task, d.tasks.list({ project_id: task.project_id }), pathFor(task.project_id), d.fallback));
  });
  app.patch('/tasks/:id', async c => {
    const b = await c.req.json();
    const id = c.req.param('id');
    const existing = d.tasks.get(id);
    if (!existing) return c.json({ error: 'task not found' }, 404);
    if (!canAccessProject(c, existing.project_id)) return c.json({ error: 'forbidden' }, 403);
    if (b.status) {
      if (b.status === 'closed') d.tasks.close(id, { summary: b.result_summary, outcome: b.outcome });
      else d.tasks.setStatus(id, b.status);
      d.bus.publish({ type: 'task', taskId: id, status: b.status });
      // Post-done review (opt-in): when a mission phase closes, let the parked overseer judge the
      // outcome before the next phase may run. This is a HARD sequential gate — the phase's direct
      // dependents are blocked synchronously at close (so the engine tick can't spawn them mid-review),
      // and only an approving verdict releases them. A reject/destructive verdict leaves them blocked,
      // so a bad result halts the mission for a human instead of rolling on. Default off, and only
      // active with an agent overseer configured.
      const cfg = d.config.get();
      if (b.status === 'closed' && existing.parent_id && cfg.autopilot.reviewOnDone && cfg.autopilot.overseerExec) {
        const mission = d.missions.active().find((m) => m.epic_id === existing.parent_id);
        if (mission) {
          // Close the gate now: block every open direct dependent so no tick spawns it while the review
          // is pending. Track exactly which ones we gated — the verdict releases only these, never a
          // dependent left blocked by a different cause (e.g. an earlier review on another dep).
          const gated: string[] = [];
          for (const e of d.tasks.allDeps()) {
            if (e.depends_on_id !== id) continue;
            const dep = d.tasks.get(e.task_id);
            if (!dep) continue;
            // Gate a direct dependent when it is still 'open', OR when this very phase's earlier review
            // already gated it (an L3 self-heal re-close: the dependent is 'blocked' from the first round,
            // not 'open', so a status check alone would miss it and the mission would strand). The
            // `gatedby:<id>` marker records which review holds it, so the verdict releases only its own gate.
            const gatedByThis = dep.labels.includes(`gatedby:${id}`);
            if (dep.status === 'open' || gatedByThis) {
              if (dep.status !== 'blocked') { d.tasks.setStatus(dep.id, 'blocked'); d.bus.publish({ type: 'task', taskId: dep.id, status: 'blocked' }); }
              if (!gatedByThis) d.tasks.addLabel(dep.id, `gatedby:${id}`);
              gated.push(dep.id);
            }
          }
          // Nothing was gated → nothing downstream to hold back, so there is nothing to review. This is
          // the terminal/leaf phase: closing it also completes the mission, which drains the queue with a
          // synthetic 'mission disengaged' verdict. Reviewing it here would let that synthetic reject
          // resurrect a just-finished phase into an orphaned, mission-less 'open' state. Skip it.
          if (gated.length > 0) {
            const localDestructive = isDestructive(`${existing.title} ${b.result_summary ?? ''}`);
            // Hand the overseer the REAL evidence — the working-tree changes — not just the agent's
            // self-reported summary, so the review judges the diff instead of rubber-stamping. Workers
            // don't commit, so `git diff HEAD` is the phase's actual change set (cumulative across a
            // sequential mission, which the overseer reads against the phase's stated scope).
            const reviewPath = d.projects?.get(existing.project_id)?.path ?? d.project.path;
            const { changedFiles, diff } = await projectReviewDiff(reviewPath);
            const reviewCtx = buildReviewContext({ title: existing.title, outcome: b.outcome ?? '', summary: b.result_summary ?? '', changedFiles, diff });
            void decisionQueue.enqueue(mission.id, 'review', reviewCtx, localDestructive)
              .then((verdict) => {
                // The mission may have torn down while the review was pending (manual disengage, shutdown):
                // the drain settles the queue with a synthetic reject. Never apply a verdict to a dead
                // mission — releasing or self-healing it would only orphan tasks under a mission that's gone.
                const live = d.missions.get(mission.id);
                if (!live || (live.state !== 'active' && live.state !== 'stalled')) return;
                const approved = verdict.approve && !verdict.destructive;
                // Surface the verdict to the UI/timeline — otherwise the rationale dies in the overseer
                // pane and the user only sees an unexplained 'blocked'/'stalled'.
                d.bus.publish({ type: 'review', missionId: mission.id, taskId: id, approve: approved, rationale: verdict.rationale });
                if (approved) {
                  // Gate opens: release the gated dependents and tick so the next phase spawns promptly
                  // rather than waiting up to the 90s interval.
                  releaseGatedDependents(id);
                  void d.engine.tick(mission.id).catch((e) => log.error('post-review tick failed', e));
                  return;
                }
                // Rejected/destructive. L3 (full autonomy) self-heals: re-open the phase with the review
                // feedback so the agent fixes it, up to REVIEW_FIX_BUDGET times before escalating. L1/L2
                // (human-in-the-loop) leave it — the dependents stay gated for a human to resolve.
                const fresh = d.tasks.get(id);
                if (fresh && mission.autonomy === 'L3' && d.tasks.bumpReviewFix(id) <= REVIEW_FIX_BUDGET) {
                  const feedback = `\n\n[Review rejected — previous attempt was not accepted]: ${verdict.rationale}\nFix the issue and close the task again.`;
                  d.tasks.update(id, { description: (fresh.description ?? '') + feedback });
                  d.tasks.setStatus(id, 'open'); // re-open so the engine tick re-spawns it (its deps are already satisfied)
                  d.bus.publish({ type: 'task', taskId: id, status: 'open' });
                  void d.engine.tick(mission.id).catch((e) => log.error('post-review self-heal tick failed', e));
                }
                // else: escalated — leave the phase closed and the dependents blocked for a human.
              })
              // Fire-and-forget review must never crash the daemon — the verdict apply (or the enqueue
              // itself) can throw, so swallow-and-log instead of leaving an unhandled rejection.
              .catch((e) => log.error('review verdict apply failed', e));
          }
        }
      }
    }
    if (typeof b.exec === 'string') { d.tasks.setExec(id, b.exec); }
    if (typeof b.title === 'string' || typeof b.type === 'string' || typeof b.priority === 'string' || typeof b.description === 'string' || b.scheduled_at !== undefined || b.autostart !== undefined) {
      d.tasks.update(id, { title: b.title, type: b.type, priority: b.priority, description: b.description, scheduled_at: b.scheduled_at, autostart: b.autostart });
    }
    if (Array.isArray(b.deps)) d.tasks.setDeps(id, b.deps);
    return c.json(d.tasks.get(id));
  });
  // Human approval of an escalated phase: accept its result and release the review gate it holds,
  // re-opening only the dependents no OTHER predecessor still gates (mirrors the agent-approved
  // verdict). The escalations inbox calls this instead of blindly opening every blocked dependent.
  app.post('/tasks/:id/approve-gate', c => {
    const id = c.req.param('id');
    const existing = d.tasks.get(id);
    if (!existing) return c.json({ error: 'task not found' }, 404);
    if (!canAccessProject(c, existing.project_id)) return c.json({ error: 'forbidden' }, 403);
    const released = releaseGatedDependents(id);
    return c.json({ released });
  });

  app.get('/tasks/:id/deps', c => c.json(d.tasks.depsFor(c.req.param('id'))));
  app.delete('/tasks/:id', async c => {
    const id = c.req.param('id');
    const existing = d.tasks.get(id);
    if (!existing) return c.json({ error: 'task not found' }, 404);
    if (!canAccessProject(c, existing.project_id)) return c.json({ error: 'forbidden' }, 403);
    // `?subtree=1` removes a whole mission: disengage it (stops its agents), then delete the epic,
    // every child task, their dependency edges and the mission row — not just the single task.
    if (c.req.query('subtree')) {
      const mission = d.missions.live().find((m) => m.epic_id === id);
      if (mission) await d.engine.disengage(mission.id).catch(() => { /* best-effort */ });
      const removed = d.tasks.deleteEpic(id);
      d.bus.publish({ type: 'task', taskId: id, status: 'cancelled' });
      d.events?.deleteForTarget(id);
      return c.json({ ok: true, tasks: removed.tasks });
    }
    d.tasks.delete(id);
    d.bus.publish({ type: 'task', taskId: id, status: 'cancelled' }); // live SSE so open UIs drop the row
    d.events?.deleteForTarget(id); // purge its history — a removed task leaves no dead feed
    return c.json({ ok: true });
  });
  // Admin maintenance: wipe ALL operational data — tasks (+deps), missions, the activity feed — and
  // stop every live agent session. Projects, users and config are kept. Irreversible; admin-only.
  app.post('/admin/cleanup', async c => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    // Stop missions cleanly first (kills their agents + drains overseers), then sweep any remaining
    // orca- sessions (manual launches / zombies) so no agent keeps running against deleted tasks.
    for (const m of d.missions.live()) await d.engine.disengage(m.id).catch(() => { /* best-effort */ });
    for (const s of (await d.tmux.list()).filter((s) => s.startsWith('orca-'))) {
      await d.tmux.kill(s).catch(() => { /* already gone */ });
    }
    const removed = d.tasks.deleteAll();
    const events = d.events?.deleteAll() ?? 0;
    return c.json({ ok: true, tasks: removed.tasks, missions: removed.missions, events });
  });
  app.post('/tasks/plan', async c => {
    const b = await c.req.json() as { goal?: string; exec?: string; autoModel?: boolean; autonomy?: string; maxSessions?: number; engage?: boolean; phases?: { title?: string; type?: string }[]; dryRun?: boolean; prompt?: string; project_id?: number };
    const goal = (b.goal ?? '').trim();
    if (!goal) return c.json({ error: 'goal required' }, 400);
    if (b.exec && !d.config.get().allowedExecs.includes(b.exec)) return c.json({ error: 'exec not allowed' }, 400);
    if (b.exec && !execAllowedForUser(c, b.exec)) return c.json({ error: 'exec not allowed for user' }, 403);
    const target = resolveTarget(c, b.project_id);
    if ('error' in target) return c.json({ error: target.error }, target.status);

    // Manual mode: explicit phases → synchronous create (no LLM, no key). Keeps the 201 contract.
    if (Array.isArray(b.phases) && b.phases.length > 0) {
      const phases: Phase[] = b.phases.map((p) => ({ title: (p.title ?? '').trim(), type: VALID_PHASE_TYPES.has(p.type ?? '') ? p.type! : 'task' })).filter((p) => p.title);
      if (phases.length === 0) return c.json({ error: 'phases required' }, 400);
      if (b.dryRun === true) return c.json({ phases }); // playground preview, nothing persisted
      const job = planJobs.create({ goal, projectId: target.project.id, epicId: null, dryRun: false, exec: b.exec });
      job.phases = phases;
      const { epic, phases: created } = persistPlan(job);
      job.epicId = epic.id;
      planJobs.setPhases(job.id, phases);
      let mission;
      if (b.engage === true) mission = await d.engine.engage({ epicId: epic.id, autonomy: b.autonomy ?? 'L3', maxSessions: b.maxSessions ?? 1 });
      return c.json({ epic, phases: created.map((t) => d.tasks.get(t.id)), mission }, 201);
    }

    // Autopilot mode: always async via a plan job — one path for the relay and the agent backends.
    const cfg = d.config.get();
    const job = planJobs.create({
      goal, projectId: target.project.id, epicId: null, dryRun: b.dryRun === true,
      // Auto mode lets the planner pick a model per phase, so no uniform exec rides along.
      exec: b.autoModel ? undefined : b.exec, autoModel: b.autoModel === true,
      engage: b.engage === true ? { autonomy: b.autonomy ?? 'L3', maxSessions: b.maxSessions ?? 1 } : undefined,
    });
    d.bus.publish({ type: 'plan', jobId: job.id, status: 'planning' });
    if (cfg.autopilot.pilotExec && d.pilot) {
      // Agent backend: spawn the Pilot in the repo; it submits via `orca plan submit`.
      void d.pilot(job, target.project.path).catch((e) => { planJobs.fail(job.id, String(e)); d.bus.publish({ type: 'plan', jobId: job.id, status: 'failed', error: String(e) }); reapPilotSession(job); });
      return c.json({ jobId: job.id }, 202);
    }
    // Relay backend: decompose inline and resolve the job before responding.
    const key = d.config.apiKey();
    if (!key) return c.json({ error: 'autopilot_key_missing' }, 400);
    const inf = (d.makeInference ?? ((rc) => new RelayClient(rc)))({ baseUrl: cfg.autopilot.apiUrl, apiKey: key, model: cfg.autopilot.model });
    let phases: Phase[];
    try {
      const notes = d.projects?.get(target.project.id)?.notes;
      const models = job.autoModel ? modelsBlock(cfg.allowedExecs, cfg.modelNotes) : undefined;
      phases = await decompose(inf, goal, b.prompt ?? cfg.autopilot.prompt, { notes }, models);
    } catch {
      planJobs.fail(job.id, 'plan_parse_failed');
      d.bus.publish({ type: 'plan', jobId: job.id, status: 'failed', error: 'plan_parse_failed' });
      return c.json({ jobId: job.id, error: 'plan_parse_failed' }, 502);
    }
    await finalizePlanJob(job.id, phases);
    return c.json({ jobId: job.id, epicId: planJobs.get(job.id)?.epicId ?? null }, 202);
  });

  app.get('/plan/:jobId', (c) => {
    const job = planJobs.get(c.req.param('jobId'));
    if (!job) return c.json({ error: 'not found' }, 404);
    // The Pilot (agent scope) is handed exactly this job's unguessable id and may have no in_progress
    // task yet (it runs during initial planning), so the working-set check doesn't apply — the job id
    // is the capability. Interactive users still go through the project access gate.
    if (c.get('tokenScope') !== 'agent' && !canAccessProject(c, job.projectId)) return c.json({ error: 'forbidden' }, 403);
    return c.json(job);
  });

  app.post('/plan/:jobId/submit', async (c) => {
    const job = planJobs.get(c.req.param('jobId'));
    if (!job) return c.json({ error: 'not found' }, 404);
    if (c.get('tokenScope') !== 'agent' && !canAccessProject(c, job.projectId)) return c.json({ error: 'forbidden' }, 403);
    const body = await c.req.json().catch(() => ({})) as { phases?: unknown };
    let phases: Phase[];
    try { phases = parsePhases(JSON.stringify(body.phases ?? [])); } // reuse the relay validator (DRY)
    catch { return c.json({ error: 'invalid phases' }, 400); }
    await finalizePlanJob(job.id, phases);
    return c.json(planJobs.get(job.id));
  });


  // Insert phases into an existing epic — a manual list of phases, or `goal` to replan
  // (decompose a residual goal). New phases run AFTER the epic's current chain; an active
  // mission picks up the freshly-ready phase on the next tick (triggered immediately here).
  app.post('/tasks/:epicId/phases', async c => {
    const epicId = c.req.param('epicId');
    const epic = d.tasks.get(epicId);
    if (!epic || epic.type !== 'epic') return c.json({ error: 'epic not found' }, 404);
    if (!canAccessProject(c, epic.project_id)) return c.json({ error: 'forbidden' }, 403);
    const b = await c.req.json() as { phases?: { title?: string; type?: string }[]; goal?: string; prompt?: string; exec?: string };
    if (b.exec && !d.config.get().allowedExecs.includes(b.exec)) return c.json({ error: 'exec not allowed' }, 400);
    if (b.exec && !execAllowedForUser(c, b.exec)) return c.json({ error: 'exec not allowed for user' }, 403);

    // Manual insert: explicit phases, no LLM, no key. persistPlan appends after the epic's tail.
    if (Array.isArray(b.phases) && b.phases.length > 0) {
      const phases: Phase[] = b.phases.map((p) => ({ title: (p.title ?? '').trim(), type: VALID_PHASE_TYPES.has(p.type ?? '') ? p.type! : 'task' })).filter((p) => p.title);
      if (phases.length === 0) return c.json({ error: 'phases required' }, 400);
      const job = planJobs.create({ goal: epic.description?.trim() || epic.title, projectId: epic.project_id, epicId, dryRun: false, exec: b.exec });
      job.phases = phases;
      const { phases: created } = persistPlan(job);
      const missionId = `m-${epicId}`;
      if (d.engine?.isActive(missionId)) await d.engine.tick(missionId); // pick up the new ready phase
      return c.json({ epic, phases: created.map((t) => d.tasks.get(t.id)) }, 201);
    }
    if (!(b.goal ?? '').trim()) return c.json({ error: 'phases or goal required' }, 400);

    // Replan: decompose the residual goal — async via a plan job scoped to this epic (so an agent
    // Pilot can do it; finalizePlanJob appends + ticks an active mission). One path, relay or agent.
    const cfg = d.config.get();
    const job = planJobs.create({ goal: b.goal!.trim(), projectId: epic.project_id, epicId, dryRun: false, exec: b.exec });
    d.bus.publish({ type: 'plan', jobId: job.id, status: 'planning' });
    if (cfg.autopilot.pilotExec && d.pilot) {
      void d.pilot(job, pathFor(epic.project_id)).catch((e) => { planJobs.fail(job.id, String(e)); d.bus.publish({ type: 'plan', jobId: job.id, status: 'failed', error: String(e) }); });
      return c.json({ jobId: job.id, epicId }, 202);
    }
    const key = d.config.apiKey();
    if (!key) return c.json({ error: 'autopilot_key_missing' }, 400);
    const inf = (d.makeInference ?? ((rc) => new RelayClient(rc)))({ baseUrl: cfg.autopilot.apiUrl, apiKey: key, model: cfg.autopilot.model });
    let phases: Phase[];
    try { phases = await decompose(inf, b.goal!.trim(), b.prompt ?? cfg.autopilot.prompt, { notes: d.projects?.get(epic.project_id)?.notes }); }
    catch {
      planJobs.fail(job.id, 'plan_parse_failed');
      d.bus.publish({ type: 'plan', jobId: job.id, status: 'failed', error: 'plan_parse_failed' });
      return c.json({ jobId: job.id, error: 'plan_parse_failed' }, 502);
    }
    await finalizePlanJob(job.id, phases);
    return c.json({ jobId: job.id, epicId }, 202);
  });

  // Hermes integration — install the bundled orca plugin into a same-host Hermes instance.
  const hermesRoot = process.env.HERMES_HOME || join(homedir(), '.hermes');
  // Resolve the Hermes home. An `home` override is constrained to live under the configured root so a
  // crafted path can't read/write arbitrary filesystem locations (path-traversal / fs enumeration).
  // Returns null for a rejected override; callers turn that into a 400.
  const hermesHome = (override?: string): string | null => {
    const o = override?.trim();
    if (!o) return hermesRoot;
    const abs = join(o);
    if (abs !== hermesRoot && !abs.startsWith(hermesRoot + '/')) return null;
    return abs;
  };
  app.get('/integrations/hermes/status', c => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const home = hermesHome(c.req.query('home'));
    if (!home) return c.json({ error: 'home must be under the Hermes root' }, 400);
    return c.json(hermesStatus(home));
  });
  app.post('/integrations/hermes/install', async c => {
    // Admin-only: this writes a plugin + credentials into a host path. Without the gate any
    // authenticated user could point Hermes at an attacker URL/token.
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const b = await c.req.json().catch(() => ({})) as { home?: string; url?: string; token?: string; timeout?: number };
    const url = (b.url ?? '').trim();
    const token = (b.token ?? '').trim();
    if (!url || !token) return c.json({ error: 'url and token required' }, 400);
    const home = hermesHome(b.home);
    if (!home) return c.json({ error: 'home must be under the Hermes root' }, 400);
    const pluginSrc = join(d.project.path, 'hermes-plugin', 'orca');
    try {
      const result = installHermesPlugin({ home, pluginSrc, url, token, timeout: b.timeout });
      return c.json({ ...result, status: hermesStatus(home) }, 201);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.get('/integrations/cli-status', c => {
    const cfg = d.config.get();
    const ctx = {
      configPersisted: d.config.hasSettings(),
      hasApiKey: cfg.autopilot.apiKeySet,
      hasCustomSetup: cfg.customModels.length > 0 || cfg.hiddenPresets.length > 0,
    };
    return c.json(detectClis(ctx));
  });

  app.get('/sessions', async c => c.json((await d.tmux.list()).filter((s) => s.startsWith('orca-')).map((s) => {
    const info = classifySession(s);
    // Tag each session with its project from the agent store (every role upserts there at spawn), so
    // clients can show the repo for workers, pilots and overseers alike — the name alone can't.
    return { ...info, projectId: d.agents?.projectFor(s.slice('orca-'.length)) ?? undefined };
  })));
  app.post('/sessions', async (c) => {
    const { taskId, exec } = await c.req.json() as { taskId: string; exec?: string };
    if (exec && !d.config.get().allowedExecs.includes(exec)) return c.json({ error: 'exec not allowed' }, 400);
    if (exec && !execAllowedForUser(c, exec)) return c.json({ error: 'exec not allowed for user' }, 403);
    const spec = resolveExecutor(exec ? [`exec:${exec}`] : [], d.fallback);
    const task = d.tasks.get(taskId);
    if (!task) return c.json({ error: 'task not found' }, 404); // don't spawn a phantom agent for a missing task
    // Launch in the task's own project (multi-project), gated to the caller's access.
    const projectId = task.project_id;
    if (!canAccessProject(c, projectId)) return c.json({ error: 'forbidden' }, 403);
    if (exec) d.tasks.setExec(taskId, exec); // remember which model ran it — drives the model icon
    const agentName = uniqueName();
    d.tasks.setAgent(taskId, agentName);     // link task → orca-<agentName> session for run controls
    d.tasks.markStarted(taskId, d.clock.now()); // precise spawn time → correct usage attribution under concurrency
    d.tasks.setStatus(taskId, 'in_progress');
    let session: string;
    try {
      ({ session } = await d.spawn.launch({ projectId, projectPath: pathFor(projectId), taskId, agentName, spec, taskTitle: task.title, taskDescription: task.description, epicId: task.parent_id ?? undefined }));
    } catch (e) {
      // The task was already flipped to in_progress above; a spawn failure (bad cwd, missing tmux,
      // name collision) would otherwise leave it stuck with no live session until the stuck detector
      // reverts it 120s later. Revert immediately so the mission/scheduler can re-pick it.
      d.tasks.setStatus(taskId, 'open');
      d.bus.publish({ type: 'task', taskId, status: 'open' });
      return c.json({ error: `spawn failed: ${(e as Error).message}` }, 500);
    }
    d.bus.publish({ type: 'task', taskId, status: 'in_progress' });
    return c.json({ session }, 201);
  });
  app.delete('/sessions/:name', async c => {
    if (!sessionAccessible(c, c.req.param('name'))) return c.json({ error: 'forbidden' }, 403);
    await d.tmux.kill(c.req.param('name')); return c.json({ ok: true });
  });
  app.post('/sessions/:name/keys', async c => {
    if (!sessionAccessible(c, c.req.param('name'))) return c.json({ error: 'forbidden' }, 403);
    const { keys } = await c.req.json().catch(() => ({})) as { keys?: unknown };
    // Validate before handing to `tmux send-keys`: it must be a non-empty list of plain key tokens.
    // Reject anything starting with '-' so a crafted entry can't smuggle a tmux flag (e.g. `-t
    // <other-session>`) and redirect keystrokes into a session the caller shouldn't reach.
    if (!Array.isArray(keys) || keys.length === 0 || !keys.every((k) => typeof k === 'string' && k.length > 0 && !k.startsWith('-'))) {
      return c.json({ error: 'keys must be a non-empty array of non-flag strings' }, 400);
    }
    await d.tmux.sendKeys(c.req.param('name'), keys as string[]);
    return c.json({ ok: true });
  });
  app.post('/sessions/:name/input', async c => {
    // Raw interactive input: the xterm `onData` bytes (printable chars, control codes, ESC sequences)
    // are forwarded verbatim to the pane via `send-keys -l`, so the advisor terminal behaves like a
    // real one. `-l` + `--` (in the driver) make a leading '-' safe, so no flag-token validation here.
    if (!sessionAccessible(c, c.req.param('name'))) return c.json({ error: 'forbidden' }, 403);
    const { data } = await c.req.json().catch(() => ({})) as { data?: unknown };
    if (typeof data !== 'string' || data.length === 0) return c.json({ error: 'data must be a non-empty string' }, 400);
    await d.tmux.sendRaw(c.req.param('name'), data);
    return c.json({ ok: true });
  });
  app.post('/sessions/:name/resize', async c => {
    if (!sessionAccessible(c, c.req.param('name'))) return c.json({ error: 'forbidden' }, 403);
    const { cols, rows } = await c.req.json() as { cols?: number; rows?: number };
    if (typeof cols !== 'number' || typeof rows !== 'number') return c.json({ error: 'cols and rows required' }, 400);
    await d.tmux.resize(c.req.param('name'), cols, rows);
    return c.json({ ok: true });
  });
  app.get('/sessions/:name/pane', async c => {
    const name = c.req.param('name');
    if (!sessionAccessible(c, name)) return c.json({ error: 'forbidden' }, 403);
    const pane = c.req.query('ansi') ? await d.tmux.capturePaneAnsi(name, 60) : await d.tmux.capturePane(name, 60);
    return c.json({ pane });
  });

  app.get('/sessions/:name/stream', (c) => {
    const name = c.req.param('name');
    if (!sessionAccessible(c, name)) return c.json({ error: 'forbidden' }, 403);
    return streamSSE(c, async (stream) => {
      let done = false;          // flips once: on abort, on too many errors, or on normal exit
      const frame = async () => {
        const pane = await d.tmux.capturePaneAnsi(name, 200);
        await stream.writeSSE({ data: JSON.stringify({ pane }), event: 'pane' });
      };
      await frame(); // first frame synchronously so clients render immediately
      let errs = 0;
      // capturePaneAnsi returns '' for a vanished session, so a throw here means the write failed
      // (closed client). After a short run of consecutive failures, stop pushing empty frames forever.
      const clear = d.clock.setInterval(() => {
        frame().then(() => { errs = 0; }).catch(() => { if (++errs >= 5) done = true; });
      }, 1000);
      // Single teardown: the abort listener flips `done`; the loop exits and `clear()` runs exactly
      // once (the previous code called stop() on both abort and loop-exit — a redundant double-clear).
      c.req.raw.signal.addEventListener('abort', () => { done = true; });
      while (!done && !c.req.raw.signal.aborted) await stream.sleep(1000);
      clear();
    });
  });

  // Per-user advisor lifecycle. Full-scope (non-agent) callers only — a spawned agent must not be able
  // to start/stop a human's advisor. Each acts on the caller's own session (`orca-advisor-<userId>`).
  app.get('/advisor/status', async c => {
    if (!d.advisor) return c.json({ running: false, exec: '', session: null });
    if (c.get('tokenScope') === 'agent') return c.json({ error: 'forbidden' }, 403);
    return c.json(await d.advisor.status(c.get('user').id));
  });
  app.post('/advisor/start', async c => {
    if (!d.advisor) return c.json({ error: 'advisor unavailable' }, 503);
    if (c.get('tokenScope') === 'agent') return c.json({ error: 'forbidden' }, 403);
    const { exec } = await c.req.json().catch(() => ({})) as { exec?: unknown };
    if (typeof exec !== 'string' || !exec) return c.json({ error: 'exec required' }, 400);
    try { return c.json(await d.advisor.start(c.get('user').id, exec), 201); }
    catch (e) { return c.json({ error: (e as Error).message }, 403); } // exec not allowed for the user
  });
  app.post('/advisor/stop', async c => {
    if (!d.advisor) return c.json({ ok: true });
    if (c.get('tokenScope') === 'agent') return c.json({ error: 'forbidden' }, 403);
    await d.advisor.stop(c.get('user').id);
    return c.json({ ok: true });
  });

  // MCP endpoint: the advisor agent connects here to control Orca with native tools. Each request is
  // handled statelessly with the toolset bound to the caller's token, and every tool delegates to the
  // same `callOrcaApi` core as the `orca api` CLI verb — so a new REST endpoint needs zero edits here.
  app.all('/mcp', async c => {
    const token = c.get('token');
    return handleMcpRequest(c.req.raw, { url: `http://localhost:${ORCA_PORT}`, token });
  });

  app.get('/missions', c => {
    const allowed = accessibleProjects(c);
    const live = d.missions.live();
    return c.json(allowed ? live.filter((m) => { const epic = d.tasks.get(m.epic_id); return epic && allowed.has(epic.project_id); }) : live);
  });
  app.get('/missions/:id', (c) => {
    const mission = d.missions.get(c.req.param('id'));
    if (!mission) return c.json({ error: 'mission not found' }, 404);
    if (!missionAccessible(c, mission.epic_id)) return c.json({ error: 'forbidden' }, 403);
    const detail = assembleMissionDetail({ missions: d.missions, tasks: d.tasks }, c.req.param('id'));
    return detail ? c.json(detail) : c.json({ error: 'mission not found' }, 404);
  });
  app.post('/missions', async c => {
    const b = await c.req.json().catch(() => ({})) as { epicId?: string; autonomy?: string; maxSessions?: number };
    // Validate the epic up front: an absent/unknown epicId would otherwise create a zombie mission
    // (id `m-undefined`, no epic to tick) that reports `active` over SSE but never progresses.
    if (!b.epicId) return c.json({ error: 'epicId required' }, 400);
    if (!d.tasks.get(b.epicId)) return c.json({ error: 'epic not found' }, 404);
    if (!missionAccessible(c, b.epicId)) return c.json({ error: 'forbidden' }, 403);
    // Default the engage params (mirrors /tasks/plan) so a partial body can't reach the engine with
    // undefined autonomy/maxSessions.
    return c.json(await d.engine.engage({
      epicId: b.epicId,
      autonomy: b.autonomy ?? 'L3',
      maxSessions: typeof b.maxSessions === 'number' ? b.maxSessions : 1,
    }), 201);
  });
  app.patch('/missions/:id', async (c) => {
    const id = c.req.param('id');
    const mission = d.missions.get(id);
    if (!mission) return c.json({ error: 'mission not found' }, 404);
    if (!missionAccessible(c, mission.epic_id)) return c.json({ error: 'forbidden' }, 403);
    const { action } = await c.req.json();
    if (action === 'pause') {
      await d.engine.pause(id); // kills running agents + reverts their tasks, then marks paused
    } else if (action === 'resume') {
      await d.engine.resume(id); // flips active, re-parks the overseer, then ticks
    }
    return c.json(d.missions.get(id));
  });
  app.delete('/missions/:id', async c => {
    const mission = d.missions.get(c.req.param('id'));
    if (!mission) return c.json({ error: 'mission not found' }, 404);
    if (!missionAccessible(c, mission.epic_id)) return c.json({ error: 'forbidden' }, 403);
    await d.engine.disengage(c.req.param('id'));
    return c.json({ ok: true });
  });

  // Overseer long-poll: the parked per-mission overseer agent polls `next` (blocks until a decision
  // is needed or a heartbeat) and answers via `decide`. Decisions are keyed by mission id in the
  // path; both sit behind the bearer middleware. No model output is parsed — the agent posts a
  // structured verdict, and the local destructive heuristic stays authoritative (applied at enqueue).
  // Gate the overseer routes by the mission's OWN project (not the daemon home project the GATED
  // middleware checks) so a cross-project user can't read/answer another tenant's decisions. A
  // non-existent mission id has nothing to leak, so it falls through (harmless heartbeat / no-op).
  const overseerForbidden = (c: AccessCtx, missionId: string): boolean => {
    const mission = d.missions.get(missionId);
    return !!mission && !missionAccessible(c, mission.epic_id);
  };
  app.get('/missions/:id/overseer/next', async (c) => {
    const id = c.req.param('id');
    if (overseerForbidden(c, id)) return c.json({ error: 'forbidden' }, 403);
    const raw = Number(c.req.query('timeoutMs'));
    const timeoutMs = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 30_000) : undefined;
    const req = await decisionQueue.next(id, timeoutMs);
    return c.json(req ?? {});
  });
  app.post('/missions/:id/overseer/decide', async (c) => {
    const id = c.req.param('id');
    if (overseerForbidden(c, id)) return c.json({ error: 'forbidden' }, 403);
    const b = await c.req.json().catch(() => ({})) as { id?: string; approve?: boolean; confidence?: number; rationale?: string; choice?: string };
    if (!b.id) return c.json({ error: 'id required' }, 400);
    const ok = decisionQueue.resolve(id, b.id, {
      approve: b.approve === true,
      confidence: typeof b.confidence === 'number' ? Math.max(0, Math.min(1, b.confidence)) : 0,
      destructive: false, // never trusted from the agent — the enqueue-time heuristic is authoritative
      rationale: typeof b.rationale === 'string' ? b.rationale : '',
      // For a 'question' decision: the picked option id. Absent ⇒ the deriver escalates to a human.
      ...(typeof b.choice === 'string' ? { choice: b.choice } : {}),
    });
    return ok ? c.json({ ok: true }) : c.json({ error: 'no such decision' }, 404);
  });

  app.get('/config', (c) => c.json(d.config.get()));
  app.put('/config', async (c) => {
    // Editing the daemon config is admin-only (the Administration surface); reads stay open so the
    // app can populate model pickers etc. During setup (no users yet) it's open so onboarding can
    // save providers/the API key before the first admin exists.
    if (d.users && d.users.count() > 0) { const u = c.get('user'); if (!u || !d.users.isAdmin(u.id)) return c.json({ error: 'forbidden' }, 403); }
    const patch = await c.req.json();
    return c.json(d.config.update(patch));
  });

  app.get('/events', c => streamSSE(c, async stream => {
    const off = d.bus.subscribe(e => void stream.writeSSE({ data: JSON.stringify(e), event: e.type }));
    c.req.raw.signal.addEventListener('abort', off);
    // Flush an immediate comment: a streamed response sends no HTTP headers until the first body byte,
    // so through the web BFF proxy the live channel would never connect on a quiet system. Comments
    // (lines starting with ':') are ignored by EventSource. The periodic ping doubles as a keep-alive
    // that stops reverse proxies from idle-closing the stream.
    await stream.write(': connected\n\n');
    while (!c.req.raw.signal.aborted) {
      await stream.sleep(30000);
      if (c.req.raw.signal.aborted) break;
      await stream.write(': ping\n\n');
    }
  }));

  return app;
}
