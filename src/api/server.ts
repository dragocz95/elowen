import { basename, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { hermesStatus, installOrcaMcp } from '../integrations/hermesInstall.js';
import { detectClis } from '../integrations/cliDetection.js';
import { detectGithubAuth } from '../integrations/github/auth.js';
import { readTaskUsage } from '../integrations/usage/index.js';
import { usagePath } from '../integrations/usage/usagePath.js';
import { checkoutBusy } from '../overseer/checkout.js';
import { listProjectFiles, listDirs, readProjectFile, writeProjectFile, readProjectBytes, createProjectFile, createProjectDir, deleteProjectEntry, renameProjectEntry, copyProjectEntry, projectFileAtHead, projectFileDiff, projectCommitDiff, projectCommitFiles, projectCommitFileDiff, projectCommitLog, projectChangedFiles, projectWorkingDiff, projectReviewDiff, projectHead, projectRangeFileDiff, isProjectImage } from '../integrations/projectFiles.js';
import { snapshotTaskChanges } from '../overseer/taskSnapshot.js';
import { KeyedMutex } from '../shared/keyedMutex.js';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import type { TaskStore } from '../store/taskStore.js';
import type { Readiness } from '../store/readiness.js';
import type { MissionStore } from '../store/missionStore.js';
import type { AgentStore } from '../store/agentStore.js';
import type { MissionEngine } from '../overseer/missionEngine.js';
import type { MissionGit } from '../overseer/missionGit.js';
import type { SpawnService } from '../spawn/spawn.js';
import type { TmuxDriver } from '../tmux/types.js';
import type { EventBus } from './sse.js';
import type { AgentSpec } from '../spawn/commandBuilder.js';
import { resolveExecutor } from '../overseer/routing.js';
import { parseResumeLabel } from '../spawn/resume/index.js';
import { decompose, parsePhases, modelsBlock, parallelismBlock, VALID_TYPES as VALID_PHASE_TYPES, type Phase } from '../overseer/planner.js';
import { resolvePrEnabled } from '../overseer/prMode.js';
import { classifySession } from '../overseer/sessionInfo.js';
import { buildReviewContext } from '../overseer/reviewContext.js';
import { PlanJobStore, type PlanJob } from '../overseer/planJob.js';
import { DecisionQueue } from '../overseer/decisionQueue.js';
import type { Task } from '../store/types.js';
import { RelayClient } from '../inference/client.js';
import type { InferenceClient, RelayConfig } from '../inference/types.js';
import { uniqueName } from '../daemon/uniqueName.js';
import type { Clock } from '../shared/clock.js';
import type { ConfigStore } from '../store/configStore.js';
import { isNewer } from '../cli/version.js';
import { assembleMissionDetail } from '../store/missionDetail.js';
import type { UserStore, User, TokenScope } from '../store/userStore.js';
import { authMiddleware } from './auth.js';
import { handleMcpRequest } from '../mcp/server.js';
import { createTicketStore, type TicketStore } from '../terminal/ticketStore.js';
import type { EventStore } from '../store/eventStore.js';
import type { NoteStore } from '../store/noteStore.js';
import type { ProjectStore } from '../store/projectStore.js';
import type { UserProjectStore } from '../store/userProjectStore.js';
import type { PushSubscriptionStore, WebPushSubscription } from '../store/pushSubscriptionStore.js';
import type { TaskUsageStore } from '../store/taskUsageStore.js';
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
  /** PR-native git lifecycle. Absent (or PR mode off) → phases never commit, no worktree, no PR. */
  missionGit?: MissionGit;
  /** Shared per-checkout git serialization lock — the SAME instance the scheduler and mission engine
   *  use, so a phase's commit+snapshot at close can't interleave with the baseline read at another
   *  agent's spawn on the same checkout. Absent → a private lock (fine for isolated tests). */
  gitLock?: KeyedMutex;
  project: { id: number; path: string };
  fallback: AgentSpec;
  clock: Clock;
  config: ConfigStore;
  users?: UserStore;
  events?: EventStore;
  notes?: NoteStore;
  projects?: ProjectStore;
  userProjects?: UserProjectStore;
  /** Per-user web-push device subscriptions. Absent → push subscribe/unsubscribe routes degrade to no-ops. */
  pushSubscriptions?: PushSubscriptionStore;
  taskUsage?: TaskUsageStore;
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
  /** Single-use ticket store backing the terminal WebSocket stream. Shared with the daemon's
   *  `/ws/terminal` handler so a ticket minted here is redeemable there. Defaulted when absent. */
  tickets?: TicketStore;
  /** Latest published version lookup for the System panel. Injected in tests; defaults to a cached
   *  npm-registry fetch. */
  latestVersion?: () => Promise<string | null>;
  /** Start a manual in-place update (detached). Injected in tests; defaults to spawning `orca update`. */
  startUpdate?: () => void;
}

/** This package's version, read once from its package.json (two dirs up from dist/api/server.js, and
 *  likewise from src/api/server.ts in dev/tests). Surfaced on /health so the web UI can show it. */
const ORCA_VERSION = (() => {
  try { return (JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0'; }
  catch { return '0.0.0'; }
})();

/** Latest published orcasynth version from the npm registry, cached for 30 min so the System panel's
 *  polling never hammers npm. A failed fetch keeps any prior good value and returns null otherwise —
 *  the panel just won't show an "update available" badge rather than erroring. */
let latestCache: { ts: number; val: string | null } | null = null;
const LATEST_TTL_MS = 30 * 60 * 1000;
async function defaultLatestVersion(): Promise<string | null> {
  const now = Date.now();
  if (latestCache && now - latestCache.ts < LATEST_TTL_MS) return latestCache.val;
  try {
    const r = await fetch('https://registry.npmjs.org/orcasynth/latest');
    if (!r.ok) throw new Error(`registry ${r.status}`);
    const body = await r.json() as { version?: string };
    latestCache = { ts: now, val: body.version ?? latestCache?.val ?? null };
  } catch {
    latestCache = { ts: now, val: latestCache?.val ?? null }; // keep last good; null until first success
  }
  return latestCache.val;
}

/** Kick off a manual `orca update`, detached so it survives the very service restart it triggers
 *  (same mechanism as orca-update.service). The caller gates on missions first. */
function defaultStartUpdate(): void {
  spawn('orca', ['update'], { detached: true, stdio: 'ignore' }).unref();
}

/** Port the daemon listens on — the MCP route reaches back into this same daemon's REST API at it. */
const ORCA_PORT = Number(process.env.ORCA_PORT ?? 4400);

export function createServer(d: ServerDeps): Hono<{ Variables: { user: User; token: string; tokenScope: TokenScope } }> {
  const log = logger('api');
  // Core reasoning stores are optional in deps for back-compat with existing call sites/tests; the
  // daemon (bootstrap) injects shared instances. Default here so every route has a working store.
  const planJobs = d.planJobs ?? new PlanJobStore();
  const decisionQueue = d.decisionQueue ?? new DecisionQueue();
  const tickets = d.tickets ?? createTicketStore();
  const gitLock = d.gitLock ?? new KeyedMutex();
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
        if (path === '/notes') return true; // read a mission's handoff notes (orca note ls)
        if (/^\/plan\/[^/]+$/.test(path)) return true;
        if (/^\/missions\/[^/]+\/overseer\/next$/.test(path)) return true;
      }
      if (method === 'PATCH' && /^\/tasks\/[^/]+$/.test(path)) return true;
      if (method === 'POST') {
        if (path === '/notes') return true; // leave a handoff note for later phases (orca note add)
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
      const GATED = ['/tasks', '/missions', '/sessions', '/activity', '/events', '/usage'];
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

  // Filesystem path of a project. Store-first for EVERY id (the home project included), so this agrees
  // with the scheduler's baseline resolver and a re-homed project path resolves consistently across the
  // spawn baseline and the close-time snapshot. Falls back to the home path when the store is absent
  // (legacy single-project) or the id is unknown.
  const pathFor = (projectId: number): string =>
    d.projects?.get(projectId)?.path ?? d.project.path;

  // Where a task's agent actually ran — the cwd its CLI logged token usage under. For a PR-native
  // mission that's the isolated worktree, not the project checkout; otherwise the project path. A
  // phase's mission is `m-<epicId>`, and its epic is the task's parent. Falls back to the project path
  // when there's no worktree (PR mode off / mission torn down).
  const usagePathFor = (task: { project_id: number; parent_id: string | null }): string =>
    usagePath(task, pathFor, (id) => d.missionGit?.worktreeFor(id));

  // The checkout a mission's work lands in: the isolated PR worktree while it's live, else the shared
  // project checkout. `missionId` null (or worktree gone) ⇒ the project path. Single source for the
  // commit/snapshot/diff sites below, which must all agree on which tree to read.
  const checkoutPathFor = (missionId: string | null, projectId: number): string =>
    (missionId ? d.missionGit?.worktreeFor(missionId) : undefined) ?? pathFor(projectId);

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
      // A per-task PR override rides as a `pr:on`/`pr:off` epic label (missionGit reads it first, before
      // the project/global default). Only stamped on a fresh epic — a replan must never flip the mode.
      const prLabels = job.prEnabled === true ? ['pr:on'] : job.prEnabled === false ? ['pr:off'] : [];
      // Title = the short mission name when given (else the goal, so it's never blank); the full goal
      // always lands in the description. This is what lets the tasks UI show a tidy name + the full brief.
      epic = d.tasks.create({ id: epicId, project_id: job.projectId, title: job.name?.trim() || job.goal, type: 'epic', description: job.goal, labels: prLabels });
      d.bus.publish({ type: 'task', taskId: epic.id, status: epic.status });
    }
    const existing = d.tasks.descendants(epic.id);
    const dependedOn = new Set(d.tasks.depsAmong(existing.map((t) => t.id)).map((e) => e.depends_on_id));
    const leaves = existing.map((t) => t.id).filter((id) => !dependedOn.has(id));
    const overallGoal = epic.description?.trim() || epic.title;
    // Agent names double as tmux session names AND as the janitor/deriver's session↔task key, so the
    // "one agent name ↔ one task" invariant is load-bearing. The pilot (an LLM) can hand the same name
    // to several phases; honour each only while it's still free (across the epic's existing tasks and
    // this batch), else drop it so the engine assigns a fresh unique name via freeAgentName at spawn.
    const usedAgents = new Set(existing.flatMap((t) => t.labels.filter((l) => l.startsWith('agent:')).map((l) => l.slice('agent:'.length))));
    const created: Task[] = [];
    // No phase carries an id → we can't build a real DAG, so reproduce the legacy prev→next chain
    // (back-compat: old relay prompts and manual UI phases never emit ids). Any id present → DAG mode.
    const linear = job.phases.every((p) => !p.id);
    const idMap = new Map<string, string>(); // planner-local phase id → created DB task id
    // Pass 1: create every child task first, so a phase's dependsOn can reference a sibling defined
    // either earlier OR later in the array (a DAG, not just a backward chain). Deps wired in pass 2.
    for (const ph of job.phases) {
      // The web detail pane strips this appended overgoal back off (web/lib/agentUtils phaseDetails),
      // which anchors on the exact `\n\nOverall goal:` separator — keep that wording/join in sync.
      const childDesc = ph.details ? `${ph.details}\n\nOverall goal: ${overallGoal}` : `Overall goal: ${overallGoal}`;
      const agentLabels = ph.agent && !usedAgents.has(ph.agent) ? [`agent:${ph.agent}`] : [];
      if (agentLabels.length) usedAgents.add(ph.agent!);
      const child = d.tasks.create({ id: newId(), project_id: job.projectId, title: ph.title, type: ph.type, parent_id: epic.id, labels: agentLabels, description: childDesc });
      if (ph.id) idMap.set(ph.id, child.id);
      // exec: auto mode takes the planner's per-phase pick, manual mode the job-level choice. Either
      // way it must be allow-listed — a halucinated/disabled exec is dropped so the child runs with
      // the configured default (resolveExecutor fallback), never a bogus model.
      const pickedExec = job.autoModel ? ph.exec : job.exec;
      if (pickedExec && allowedExecs.includes(pickedExec)) d.tasks.setExec(child.id, pickedExec);
      d.bus.publish({ type: 'task', taskId: child.id, status: child.status });
      created.push(child);
    }
    // Pass 2: wire dependencies. Linear mode reproduces the old chain exactly. DAG mode maps each
    // phase's dependsOn (planner-local ids) to DB ids. A phase that declared NO deps inherits the
    // epic's current leaves, so a replan never overtakes unfinished work — a fresh epic has no leaves,
    // so such phases start ready (enabling parallel branches). setDeps' cycle guard quietly drops any
    // hallucinated loop, so the mission can never deadlock.
    let prevId: string | null = null;
    created.forEach((child, i) => {
      const ph = job.phases[i]!; // created is built 1:1 from job.phases above, so this is always defined
      if (linear) {
        if (prevId) d.tasks.addDep(child.id, prevId); // chain within the new batch
        else for (const leaf of leaves) d.tasks.addDep(child.id, leaf); // first new phase waits on the tail
        prevId = child.id;
        return;
      }
      const declared = ph.dependsOn ?? [];
      const deps = declared.map((pid) => idMap.get(pid)).filter((x): x is string => !!x);
      // Planner DECLARED dependencies but none resolved (typo'd / hallucinated ids): don't silently
      // drop the ordering and let the phase start early in parallel — fall back to the previous phase
      // in the batch so it still waits (the first phase has no predecessor → leaves/ready). Only a
      // phase that declared no deps at all gets the leaves (genuine parallel/replan-append).
      const effective = deps.length ? deps
        : declared.length > 0 ? (i > 0 ? [created[i - 1]!.id] : leaves)
          : leaves;
      // On a replan into a LIVE epic (pre-existing leaves), a phase that resolved its deps among the
      // new batch would otherwise ignore the still-running frontier and could start alongside it —
      // even a hallucinated cycle, once the guard drops an edge, leaves a root with no leaf dep. Also
      // wait on the existing leaves so the "a replan never overtakes unfinished work" invariant holds.
      // A fresh epic has no leaves, so independent branches still start in parallel as intended.
      const withFrontier = deps.length && leaves.length ? [...new Set([...effective, ...leaves])] : effective;
      d.tasks.setDeps(child.id, withFrontier);
    });
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
      await d.engine.engage({ epicId: epic.id, autonomy: job.engage.autonomy, maxSessions: job.engage.maxSessions, preserveReviewBudget: job.engage.preserveReviewBudget });
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
  // Browse the server's directory tree to pick a new project's path (the new-project file manager).
  // Admin-only — it lists directory names outside any project root, so it sits behind the same gate as
  // project registration. Read-only and directory-only: never returns file contents.
  app.get('/fs/dirs', (c) => {
    if (d.userProjects && d.users) { const u = c.get('user'); if (!u || !d.userProjects.isAdmin(u.id)) return c.json({ error: 'forbidden' }, 403); }
    const q = c.req.query('path');
    try { return c.json(listDirs(q && q.trim() ? q : homedir())); }
    catch { return c.json({ error: 'cannot read directory' }, 400); }
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
    const b = await c.req.json() as { path?: string; notes?: string; icon?: string; pr_enabled?: boolean | null };
    const patch: { path?: string; notes?: string; icon?: string; pr_enabled?: boolean | null } = {};
    if (typeof b.path === 'string' && b.path.trim()) patch.path = b.path.trim();
    if (typeof b.notes === 'string') patch.notes = b.notes;
    // Icon is a project-relative image path. '' clears it; anything else must resolve to a real image
    // file inside the project root (guards against path traversal / pointing at a non-image).
    if (typeof b.icon === 'string') {
      if (b.icon !== '' && !isProjectImage(cur.path, b.icon)) return c.json({ error: 'invalid icon path' }, 400);
      patch.icon = b.icon;
    }
    // Tri-state PR-flow override: null = inherit the global default, a boolean = force on/off. Only a
    // boolean or explicit null is accepted; an absent key leaves it unchanged.
    if (b.pr_enabled === null || typeof b.pr_enabled === 'boolean') patch.pr_enabled = b.pr_enabled;
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

  // Inter-agent handoff notes. Scope defaults to 'mission'; the target is an epic id (a leading `m-`
  // from a mission id is stripped here so workers — which hold the bare epicId — and the overseer —
  // which holds ORCA_MISSION=m-<epicId> — both work). Access is gated by the target epic's project, so
  // an agent can only read/write notes for a mission in a project it is actively working in.
  const noteTarget = (raw: string | undefined): string => {
    const v = raw ?? '';
    // Strip a leading mission `m-` only when the remainder actually resolves to an epic. A blind strip
    // would corrupt the id in a project whose own basename is `m` (its epics are literally `m-<hex>`).
    if (v.startsWith('m-') && d.tasks.get(v.slice(2))) return v.slice(2);
    return v;
  };
  const MAX_NOTE_BODY = 8000;   // a handoff note is a hint for the next agent, not a document dump
  const MAX_NOTES_PER_TARGET = 200; // bound the per-mission log so a looping agent can't inflate the DB
  app.get('/notes', (c) => {
    const scope = c.req.query('scope') || 'mission';
    const target = noteTarget(c.req.query('target'));
    if (!target) return c.json({ error: 'target required' }, 400);
    // Fail CLOSED, mirroring POST: an unresolved target must never list notes unauthenticated. Without
    // this an orphaned note (e.g. one whose epic was deleted) would read back with no project gate at
    // all — a cross-tenant leak reachable even by an agent token. The target must resolve and be allowed.
    const epic = d.tasks.get(target);
    if (!epic) return c.json({ error: 'unknown target' }, 404);
    if (!canAccessProject(c, epic.project_id)) return c.json({ error: 'forbidden' }, 403);
    return c.json(d.notes?.list(scope, target) ?? []);
  });
  app.post('/notes', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const scope = typeof b.scope === 'string' && b.scope ? b.scope : 'mission';
    const target = noteTarget(typeof b.target === 'string' ? b.target : '');
    const body = typeof b.body === 'string' ? b.body.trim() : '';
    if (!target || !body) return c.json({ error: 'target and body required' }, 400);
    // Bound the write: an agent runs with skip-permissions, so cap body size and the per-target count
    // to keep a prompt-injected loop from inflating the DB (the project's rate-limiting policy).
    if (body.length > MAX_NOTE_BODY) return c.json({ error: 'body too large' }, 400);
    const epic = d.tasks.get(target);
    if (!epic) return c.json({ error: 'unknown target' }, 404);
    if (!canAccessProject(c, epic.project_id)) return c.json({ error: 'forbidden' }, 403);
    if (!d.notes) return c.json({ error: 'notes unavailable' }, 400);
    if (d.notes.count(scope, target) >= MAX_NOTES_PER_TARGET) return c.json({ error: 'too many notes' }, 429);
    const author = typeof b.author === 'string' ? b.author : '';
    return c.json(d.notes.add({ scope, target, author, body }), 201);
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
    return c.json(readTaskUsage(task, d.tasks.list({ project_id: task.project_id }), usagePathFor(task), d.fallback));
  });
  // Total token/cost usage aggregated per model (exec spec). Read straight from the `task_usage`
  // snapshots (the UsageRecorder writes one per task as it settles), so this never re-scans the CLIs'
  // session stores. Scoped to the caller's accessible projects; optional `?project_id=N` narrows it.
  app.get('/usage/by-model', c => {
    const allowed = accessibleProjects(c); // Set of project ids, or null for an admin (all projects)
    let projectIds: number[] | undefined = allowed ? [...allowed] : undefined;
    const pidRaw = c.req.query('project_id');
    if (pidRaw !== undefined && pidRaw !== '') {
      const pid = Number(pidRaw);
      if (Number.isFinite(pid)) projectIds = projectIds ? projectIds.filter((p) => p === pid) : [pid];
    }
    return c.json(d.taskUsage?.aggregateByExec(projectIds) ?? []);
  });
  // Reset the usage stats: wipe the `task_usage` snapshots. Admin-only and irreversible, but it only
  // clears Orca's own DB rows — the agents' CLI session transcripts are left untouched.
  app.post('/usage/reset', c => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    return c.json({ ok: true, cleared: d.taskUsage?.deleteAll() ?? 0 });
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
      // and only an approving verdict releases them. A reject verdict leaves them blocked,
      // so a bad result halts the mission for a human instead of rolling on. Default off, and only
      // active with an agent overseer configured.
      const cfg = d.config.get();
      if (b.status === 'closed' && existing.parent_id) {
        const mission = d.missions.active().find((m) => m.epic_id === existing.parent_id);
        // Tracks whether this close handed the phase to the overseer review gate. When it did, the
        // phase's worktree commit happens on the approving verdict (below); when it didn't, the close
        // is final and we commit right here — so a rejected phase never lands a commit.
        let reviewEnqueued = false;
        if (mission && cfg.autopilot.reviewOnDone && cfg.autopilot.overseerExec) {
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
            reviewEnqueued = true;
            // Hand the overseer the REAL evidence — the working-tree changes — not just the agent's
            // self-reported summary, so the review judges the diff instead of rubber-stamping. Workers
            // don't commit, so `git diff HEAD` is the phase's actual change set. In PR-native mode the
            // agent edits the mission's worktree (and Orca commits each approved phase), so read the diff
            // THERE — the main checkout would show nothing. Without a worktree it's the project checkout,
            // where the diff is cumulative across the sequential mission.
            const reviewPath = checkoutPathFor(mission.id, existing.project_id);
            const { changedFiles, diff } = await projectReviewDiff(reviewPath);
            const reviewCtx = buildReviewContext({ title: existing.title, outcome: b.outcome ?? '', summary: b.result_summary ?? '', changedFiles, diff });
            void decisionQueue.enqueue(mission.id, 'review', reviewCtx)
              .then(async (verdict) => {
                // The mission may have torn down while the review was pending (manual disengage, shutdown):
                // the drain settles the queue with a synthetic reject. Never apply a verdict to a dead
                // mission — releasing or self-healing it would only orphan tasks under a mission that's gone.
                const live = d.missions.get(mission.id);
                if (!live || (live.state !== 'active' && live.state !== 'stalled')) return;
                const approved = verdict.approve;
                // Surface the verdict to the UI/timeline — otherwise the rationale dies in the overseer
                // pane and the user only sees an unexplained 'blocked'/'stalled'.
                d.bus.publish({ type: 'review', missionId: mission.id, taskId: id, approve: approved, rationale: verdict.rationale });
                if (approved) {
                  // Commit the approved phase's work BEFORE the next phase ticks (the worktree in PR
                  // mode, else the shared project checkout) so the next agent never edits it mid-commit.
                  // Under the checkout lock so it can't interleave with the next agent's baseline read —
                  // the snapshot below then has a stable base..HEAD that captures exactly this phase.
                  await gitLock.run(reviewPath, async () => {
                    await d.missionGit?.commitPhase(mission.id, existing.title, reviewPath).catch((e) => log.error('phase commit failed', e));
                    await snapshotTaskChanges(d.tasks, id, reviewPath);
                  });
                  // Gate opens: release the gated dependents and resume so the next phase spawns promptly
                  // rather than waiting up to the 90s interval. resumeStalled (not a bare tick) un-freezes
                  // the mission if it stalled while the verdict was pending — otherwise the freeze would
                  // swallow this tick and the approved work would never run.
                  releaseGatedDependents(id);
                  void d.engine.resumeStalled(mission.id).catch((e) => log.error('post-review resume failed', e));
                  return;
                }
                // Rejected. L3 (full autonomy) self-heals: re-open the phase with the review
                // feedback so the agent fixes it, up to REVIEW_FIX_BUDGET times before escalating. L1/L2
                // (human-in-the-loop) leave it — the dependents stay gated for a human to resolve.
                // A `escalated` verdict (the overseer never answered — a timeout) is NOT a real reject:
                // it must wait for a human, never self-heal. Without this guard a slow/absent overseer
                // turned every phase into an infinite reopen loop. Check it BEFORE bumpReviewFix so a
                // timeout doesn't burn the self-heal budget either.
                const fresh = d.tasks.get(id);
                // Read autonomy from `live` (re-fetched above), not the close-time `mission` snapshot:
                // a re-engage between close and this verdict (e.g. a PR-feedback replan) may have changed
                // it, and the self-heal decision must follow the mission's CURRENT autonomy.
                if (fresh && !verdict.escalated && live.autonomy === 'L3' && d.tasks.bumpReviewFix(id) <= REVIEW_FIX_BUDGET) {
                  // Pin the rejection as a single resume note so a multi-round reject loop refreshes it
                  // instead of stacking duplicate feedback blocks onto the description.
                  d.tasks.setResumeNote(id, `[Review rejected — previous attempt was not accepted]: ${verdict.rationale}\nFix the issue and close the task again.`);
                  // Reap the worker if it outlived its task close, so the re-spawn doesn't collide with a
                  // still-live `orca-<agent>` session ("duplicate session" → endless failed re-spawns).
                  await d.engine.stopTask(id);
                  d.tasks.setStatus(id, 'open'); // re-open so the engine tick re-spawns it (its deps are already satisfied)
                  d.bus.publish({ type: 'task', taskId: id, status: 'open' });
                  // Self-heal is autonomous continuation, not an escalation — resume (un-freeze if it
                  // stalled in the verdict window) so the re-opened phase actually re-spawns.
                  void d.engine.resumeStalled(mission.id).catch((e) => log.error('post-review self-heal resume failed', e));
                } else {
                  // Not self-healed (overseer timeout, L1/L2 human-in-the-loop, or self-heal budget
                  // spent): leave the phase closed and its dependents blocked for a human. Tick so the
                  // mission flips to 'stalled' ("needs attention") now instead of reading 'active' until
                  // the next 90s interval — the escalation must be visible, and the mission waits, never
                  // disengages, until the human resolves it (approve-gate / re-run on the Escalations page).
                  void d.engine.tick(mission.id).catch((e) => log.error('post-review escalation tick failed', e));
                }
              })
              // Fire-and-forget review must never crash the daemon — the verdict apply (or the enqueue
              // itself) can throw, so swallow-and-log instead of leaving an unhandled rejection.
              .catch((e) => log.error('review verdict apply failed', e));
          }
        }
        // When a phase's close is final (no review gate pending), commit its work now — the worktree in
        // PR mode, else the shared project checkout. The review path above commits on approval instead,
        // so a rejected phase never commits.
        if (mission && !reviewEnqueued) {
          const snapPath = checkoutPathFor(mission.id, existing.project_id);
          await gitLock.run(snapPath, async () => {
            await d.missionGit?.commitPhase(mission.id, existing.title, snapPath).catch((e) => log.error('phase commit failed', e));
            await snapshotTaskChanges(d.tasks, id, snapPath);
          });
        }
      } else if (b.status === 'closed') {
        // A standalone task (no mission/worktree): its agent commits into the project checkout, so the
        // frozen change list is base..HEAD there. No-op when nothing was committed (empty snapshot).
        // Under the checkout lock so the range can't straddle a concurrent agent's commit on the same path.
        const snapPath = pathFor(existing.project_id);
        await gitLock.run(snapPath, () => snapshotTaskChanges(d.tasks, id, snapPath));
      }
    }
    if (typeof b.exec === 'string') {
      // Gate the executor exactly like the plan/session routes: an unvalidated exec is stored as an
      // `exec:<spec>` label and later interpolated into the agent launch command, so without this check
      // a project member could set an arbitrary executor (escaping the allow-list) or smuggle shell
      // metacharacters through the model field. Empty string clears the override (revert to fallback).
      if (b.exec && !d.config.get().allowedExecs.includes(b.exec)) return c.json({ error: 'exec not allowed' }, 400);
      if (b.exec && !execAllowedForUser(c, b.exec)) return c.json({ error: 'exec not allowed for user' }, 403);
      d.tasks.setExec(id, b.exec);
    }
    if (typeof b.title === 'string' || typeof b.type === 'string' || typeof b.priority === 'string' || typeof b.description === 'string' || b.scheduled_at !== undefined || b.autostart !== undefined) {
      d.tasks.update(id, { title: b.title, type: b.type, priority: b.priority, description: b.description, scheduled_at: b.scheduled_at, autostart: b.autostart });
    }
    if (Array.isArray(b.deps)) d.tasks.setDeps(id, b.deps);
    return c.json(d.tasks.get(id));
  });
  // Diff of one file from a task's FROZEN change list (the commits it landed between base..head). Read
  // from the mission worktree while it's live, else the project checkout (where the commits merged to).
  // Empty when the task has no snapshot, the file isn't in it, or the refs were GC'd by a later squash.
  app.get('/tasks/:id/changed/diff', async c => {
    const id = c.req.param('id');
    const task = d.tasks.get(id);
    if (!task) return c.json({ error: 'task not found' }, 404);
    if (!canAccessProject(c, task.project_id)) return c.json({ error: 'forbidden' }, 403);
    const path = c.req.query('path') ?? '';
    if (!task.base_sha || !task.head_sha || !path) return c.json({ diff: '' });
    const root = checkoutPathFor(task.parent_id ? `m-${task.parent_id}` : null, task.project_id);
    try {
      return c.json({ diff: await projectRangeFileDiff(root, task.base_sha, task.head_sha, path) });
    } catch {
      return c.json({ diff: '' }); // path-traversal reject / bad ref — degrade to empty, never 500
    }
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
    // The escalation froze the whole mission (state 'stalled'); approving here is the human action that
    // un-freezes it. Resume so the released dependents spawn now instead of the mission sitting idle —
    // a stalled mission no longer ticks itself, so without this the approval would release the gate but
    // nothing would ever pick the work up. The phase's parent IS the epic; mission id is `m-<epicId>`.
    if (existing.parent_id) void d.engine.resumeStalled(`m-${existing.parent_id}`).catch((e) => log.error('approve-gate resume failed', e));
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
      // Mission id is `m-<epicId>` by construction. Stop a still-running mission (kills its agents),
      // then free its worktree UNCONDITIONALLY: a naturally-completed ('disengaged') or paused mission
      // keeps its worktree for the PR/feedback path, so disengage() alone would skip it and leak the
      // on-disk worktree when the epic is deleted (the mission_pr row is also pruned by the cascade).
      const missionId = `m-${id}`;
      const mission = d.missions.get(missionId);
      if (mission && mission.state !== 'disengaged') await d.engine.disengage(missionId).catch(() => { /* best-effort */ });
      await d.missionGit?.cleanup(missionId).catch(() => { /* best-effort */ });
      const removed = d.tasks.deleteEpic(id);
      d.bus.publish({ type: 'task', taskId: id, status: 'cancelled' });
      d.events?.deleteForTarget(id);
      d.notes?.deleteAllForTarget(id); // a removed mission leaves no orphan handoff notes under any scope
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
    const b = await c.req.json() as { goal?: string; name?: string; exec?: string; autoModel?: boolean; autonomy?: string; maxSessions?: number; engage?: boolean; phases?: { title?: string; type?: string }[]; dryRun?: boolean; prompt?: string; project_id?: number; prEnabled?: boolean | null };
    const goal = (b.goal ?? '').trim();
    const name = (b.name ?? '').trim(); // optional short mission name → epic title (goal stays the description)
    // Tri-state PR override: true (force on) / false (force off) / null|undefined (inherit project+global).
    let prEnabled = b.prEnabled === true ? true : b.prEnabled === false ? false : null;
    // Parallel sessions only materialise in isolated worktrees — a shared checkout is single-writer, so
    // a >1 max_sessions mission would silently serialize to one agent. Opting into parallelism therefore
    // auto-enables PR-native mode, unless the user explicitly turned it off (then we honour their choice).
    if ((b.maxSessions ?? 1) > 1 && prEnabled === null) prEnabled = true;
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
      const job = planJobs.create({ goal, name, projectId: target.project.id, epicId: null, dryRun: false, exec: b.exec, prEnabled });
      job.phases = phases;
      const { epic, phases: created } = persistPlan(job);
      job.epicId = epic.id;
      planJobs.setPhases(job.id, phases);
      let mission;
      if (b.engage === true) mission = await d.engine.engage({ epicId: epic.id, autonomy: b.autonomy ?? 'L3', maxSessions: b.maxSessions ?? 1, createdBy: c.get('user')?.id ?? null });
      return c.json({ epic, phases: created.map((t) => d.tasks.get(t.id)), mission }, 201);
    }

    // Autopilot mode: always async via a plan job — one path for the relay and the agent backends.
    const cfg = d.config.get();
    const job = planJobs.create({
      goal, name, projectId: target.project.id, epicId: null, dryRun: b.dryRun === true,
      // Auto mode lets the planner pick a model per phase, so no uniform exec rides along.
      exec: b.autoModel ? undefined : b.exec, autoModel: b.autoModel === true,
      engage: b.engage === true ? { autonomy: b.autonomy ?? 'L3', maxSessions: b.maxSessions ?? 1 } : undefined,
      prEnabled, maxSessions: b.maxSessions ?? 1,
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
      // Same parallelism guidance the agent-mode Pilot gets: parallel branches only when >1 session
      // AND the mission will run PR-native (isolated worktrees), resolved exactly as runtime does.
      const isolated = resolvePrEnabled(prEnabled, d.projects?.get(target.project.id)?.pr_enabled ?? null, cfg.autopilot.prEnabled);
      const parallelism = parallelismBlock(b.maxSessions ?? 1, isolated);
      phases = await decompose(inf, goal, b.prompt ?? cfg.autopilot.prompt, { notes }, models, parallelism);
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
    const b = await c.req.json() as { phases?: { title?: string; type?: string; details?: string }[]; goal?: string; prompt?: string; exec?: string };
    if (b.exec && !d.config.get().allowedExecs.includes(b.exec)) return c.json({ error: 'exec not allowed' }, 400);
    if (b.exec && !execAllowedForUser(c, b.exec)) return c.json({ error: 'exec not allowed for user' }, 403);

    // Manual insert: explicit phases, no LLM, no key. persistPlan appends after the epic's tail.
    if (Array.isArray(b.phases) && b.phases.length > 0) {
      const phases: Phase[] = b.phases.map((p) => ({ title: (p.title ?? '').trim(), type: VALID_PHASE_TYPES.has(p.type ?? '') ? p.type! : 'task', details: (p.details ?? '').trim() || undefined })).filter((p) => p.title);
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
    // Carry the mission's intended concurrency into the replan so it keeps planning a wide DAG instead
    // of collapsing back to a linear chain. Resolve isolation from the epic's PR label exactly as the
    // runtime does, so the parallelism guidance matches how the replanned phases will actually run.
    const replanOverride = epic.labels.includes('pr:on') ? true : epic.labels.includes('pr:off') ? false : null;
    const replanIsolated = resolvePrEnabled(replanOverride, d.projects?.get(epic.project_id)?.pr_enabled ?? null, cfg.autopilot.prEnabled);
    const replanMaxSessions = d.missions.get(`m-${epicId}`)?.max_sessions ?? 1;
    const replanParallelism = parallelismBlock(replanMaxSessions, replanIsolated);
    const job = planJobs.create({ goal: b.goal!.trim(), projectId: epic.project_id, epicId, dryRun: false, exec: b.exec, prEnabled: replanOverride, maxSessions: replanMaxSessions });
    d.bus.publish({ type: 'plan', jobId: job.id, status: 'planning' });
    if (cfg.autopilot.pilotExec && d.pilot) {
      void d.pilot(job, pathFor(epic.project_id)).catch((e) => { planJobs.fail(job.id, String(e)); d.bus.publish({ type: 'plan', jobId: job.id, status: 'failed', error: String(e) }); });
      return c.json({ jobId: job.id, epicId }, 202);
    }
    const key = d.config.apiKey();
    if (!key) return c.json({ error: 'autopilot_key_missing' }, 400);
    const inf = (d.makeInference ?? ((rc) => new RelayClient(rc)))({ baseUrl: cfg.autopilot.apiUrl, apiKey: key, model: cfg.autopilot.model });
    let phases: Phase[];
    try { phases = await decompose(inf, b.goal!.trim(), b.prompt ?? cfg.autopilot.prompt, { notes: d.projects?.get(epic.project_id)?.notes }, undefined, replanParallelism); }
    catch {
      planJobs.fail(job.id, 'plan_parse_failed');
      d.bus.publish({ type: 'plan', jobId: job.id, status: 'failed', error: 'plan_parse_failed' });
      return c.json({ jobId: job.id, error: 'plan_parse_failed' }, 502);
    }
    await finalizePlanJob(job.id, phases);
    return c.json({ jobId: job.id, epicId }, 202);
  });

  // Hermes integration — register orca as an MCP server in a same-host Hermes instance.
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
    // Admin-only: this writes credentials + config into a host path. Without the gate any
    // authenticated user could point Hermes at an attacker URL/token.
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const b = await c.req.json().catch(() => ({})) as { home?: string; url?: string; token?: string };
    const url = (b.url ?? '').trim();
    const token = (b.token ?? '').trim();
    if (!url || !token) return c.json({ error: 'url and token required' }, 400);
    const home = hermesHome(b.home);
    if (!home) return c.json({ error: 'home must be under the Hermes root' }, 400);
    try {
      const result = installOrcaMcp({ home, url, token });
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

  // GitHub auth posture for the PR-native workflow — whether a push would succeed (via a stored token
  // or gh's own login) and as whom. The token value is never exposed, only whether one is set.
  app.get('/integrations/github-status', c => c.json(detectGithubAuth(!!d.config.ghToken())));

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
    // Single-writer: a manual launch targets the shared project checkout, so refuse it when another
    // agent (a scheduler task or a non-PR mission phase) is already live there — a second writer would
    // corrupt per-task change attribution. Read in_progress FRESH and flip status synchronously right
    // after, so the check-and-claim is atomic against the concurrent scheduler/engine ticks.
    const cwd = pathFor(projectId);
    const resolver = { projectPath: pathFor, worktreeFor: (mid: string) => d.missionGit?.worktreeFor(mid) };
    if (checkoutBusy(resolver, d.tasks.list({ status: 'in_progress' }), cwd)) return c.json({ error: 'checkout busy' }, 409);
    const agentName = uniqueName();
    d.tasks.setAgent(taskId, agentName);     // link task → orca-<agentName> session for run controls
    d.tasks.markStarted(taskId, d.clock.now()); // precise spawn time → correct usage attribution under concurrency
    d.tasks.setStatus(taskId, 'in_progress'); // claim synchronously after the fresh check above
    // Baseline for the per-task change snapshot, under the checkout lock so it lands after any in-flight commit.
    await gitLock.run(cwd, async () => d.tasks.markBase(taskId, await projectHead(cwd)));
    // When this is a resume (the task ran before), pin a note so the resumed agent knows it was
    // restarted on purpose and should continue rather than wonder why it's running again. Re-read the
    // description afterwards so the note rides along into the worker-resume prompt.
    const resume = parseResumeLabel(task.labels);
    // Only pin the generic manual-restart note when nothing more specific is already there — a
    // review-reject rationale or a stuck-relaunch reason carries actionable context the user is
    // restarting to address, so don't clobber it with boilerplate.
    if (resume && !d.tasks.get(taskId)?.resume_note) d.tasks.setResumeNote(taskId, 'Manually restarted — continue from where you left off and finish the task.');
    const resumeNote = d.tasks.get(taskId)?.resume_note ?? undefined;
    let session: string;
    try {
      ({ session } = await d.spawn.launch({ projectId, projectPath: pathFor(projectId), taskId, agentName, spec, taskTitle: task.title, taskDescription: task.description, resumeNote, epicId: task.parent_id ?? undefined, resume }));
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
    const name = c.req.param('name');
    if (!sessionAccessible(c, name)) return c.json({ error: 'forbidden' }, 403);
    // Killing a user's advisor from the sessions list is an explicit "turn it off" — route it through
    // advisor.stop so it also persists advisor_autostart=false. A bare tmux.kill would leave the flag
    // on, and ensureOnLogin would resurrect the advisor on the next login (the "it comes back after I
    // killed it" bug). Plain agent/overseer sessions just get killed.
    const info = classifySession(name);
    if (info.role === 'advisor' && info.userId !== undefined && d.advisor) {
      await d.advisor.stop(info.userId);
      return c.json({ ok: true });
    }
    await d.tmux.kill(name); return c.json({ ok: true });
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

  // Mint a single-use ticket to open the terminal WebSocket stream for this session. Authenticated
  // here (via the BFF cookie) and ownership-gated by the same access check as every session route; the
  // unauthenticated `/ws/terminal` upgrade then redeems the ticket. The attach is interactive.
  app.post('/sessions/:name/ws-ticket', async (c) => {
    const name = c.req.param('name');
    if (!sessionAccessible(c, name)) return c.json({ error: 'forbidden' }, 403);
    const ticket = tickets.issue({ session: name, userId: c.get('user')?.id ?? null });
    return c.json({ ticket });
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
    catch (e) {
      // A permission rejection is the user's fault (403); a spawn/tmux failure is ours (500).
      const msg = (e as Error).message;
      return c.json({ error: msg }, msg === 'exec not allowed for user' ? 403 : 500);
    }
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
    // Also surface DISENGAGED missions whose PR is still pending (ready to open / open) so a completed
    // PR-native mission keeps its branch/PR affordance in the UI — the manual "Open PR" lives here.
    const liveIds = new Set(live.map((m) => m.id));
    const extra = (d.missionGit?.pendingPrMissionIds() ?? [])
      .filter((id) => !liveIds.has(id))
      .map((id) => d.missions.get(id))
      .filter((m): m is NonNullable<typeof m> => m != null);
    const all = [...live, ...extra];
    const visible = allowed ? all.filter((m) => { const epic = d.tasks.get(m.epic_id); return epic && allowed.has(epic.project_id); }) : all;
    // Attach PR-native metadata (branch/PR url+state) so the tasks view can show a badge + "Open PR"
    // without a per-mission detail fetch. Null for non-PR missions.
    return c.json(visible.map((m) => ({ ...m, pr: d.missionGit?.prInfo(m.id) ?? null })));
  });
  app.get('/missions/:id', (c) => {
    const mission = d.missions.get(c.req.param('id'));
    if (!mission) return c.json({ error: 'mission not found' }, 404);
    if (!missionAccessible(c, mission.epic_id)) return c.json({ error: 'forbidden' }, 403);
    const detail = assembleMissionDetail({ missions: d.missions, tasks: d.tasks }, c.req.param('id'));
    if (!detail) return c.json({ error: 'mission not found' }, 404);
    return c.json({ ...detail, pr: d.missionGit?.prInfo(c.req.param('id')) ?? null });
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
      createdBy: c.get('user')?.id ?? null, // owner for per-mission push routing
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
  // Manually open the PR for a PR-native mission (the "Open PR" affordance, for prAutoOpen=off). Runs
  // the same verify gate, pushes the branch and opens the PR via gh. Returns the PR url on success, or
  // a 4xx with the reason (verify failed / no remote / gh unavailable) so the UI can explain it.
  app.post('/missions/:id/pr', async c => {
    const id = c.req.param('id');
    const mission = d.missions.get(id);
    if (!mission) return c.json({ error: 'mission not found' }, 404);
    if (!missionAccessible(c, mission.epic_id)) return c.json({ error: 'forbidden' }, 403);
    if (!d.missionGit) return c.json({ error: 'PR workflow not enabled' }, 400);
    const res = await d.missionGit.openPr(id);
    switch (res.state) {
      case 'opened': return c.json({ url: res.url, number: res.number });
      case 'incomplete': return c.json({ error: 'mission is not finished yet — wait until all phases complete' }, 409);
      case 'verify-failed': return c.json({ error: 'verify command failed', output: res.output }, 422);
      case 'no-remote': return c.json({ error: 'project has no GitHub remote to push to' }, 422);
      case 'pr-failed': return c.json({ error: 'gh CLI unavailable or unauthenticated' }, 422);
      default: return c.json({ error: 'PR workflow not enabled for this mission' }, 400);
    }
  });
  // Squash-merge a PR-native mission's PR into the base branch (the "Merge to main" affordance). The
  // open/conflict/CI gate lives in mergePR; a refusal returns 422 with a human reason for the UI toast.
  app.post('/missions/:id/merge-pr', async c => {
    const id = c.req.param('id');
    const mission = d.missions.get(id);
    if (!mission) return c.json({ error: 'mission not found' }, 404);
    if (!missionAccessible(c, mission.epic_id)) return c.json({ error: 'forbidden' }, 403);
    if (!d.missionGit) return c.json({ error: 'PR workflow not enabled' }, 400);
    const res = await d.missionGit.mergePr(id);
    return res.ok ? c.json({ ok: true }) : c.json({ error: res.reason }, 422);
  });
  // Overseer long-poll: the parked per-mission overseer agent polls `next` (blocks until a decision
  // is needed or a heartbeat) and answers via `decide`. Decisions are keyed by mission id in the
  // path; both sit behind the bearer middleware. No model output is parsed — the agent posts a
  // structured verdict.
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
      rationale: typeof b.rationale === 'string' ? b.rationale : '',
      // For a 'question' decision: the picked option id. Absent ⇒ the deriver escalates to a human.
      ...(typeof b.choice === 'string' ? { choice: b.choice } : {}),
    });
    return ok ? c.json({ ok: true }) : c.json({ error: 'no such decision' }, 404);
  });

  // --- Web push: the browser's VAPID public key, plus per-user device subscribe/unsubscribe. The
  // public key is safe pre-auth (it's public); subscribe/unsubscribe are scoped to the authed user.
  app.get('/push/vapid-public-key', (c) => c.json({ publicKey: d.config.get().webPush.publicKey }));
  app.post('/push/subscribe', async (c) => {
    const u = c.get('user');
    if (!u) return c.json({ error: 'unauthorized' }, 401);
    const b = await c.req.json().catch(() => ({})) as Partial<WebPushSubscription>;
    if (typeof b.endpoint !== 'string' || !b.endpoint
      || typeof b.keys?.p256dh !== 'string' || typeof b.keys?.auth !== 'string') {
      return c.json({ error: 'endpoint and keys.{p256dh,auth} required' }, 400);
    }
    d.pushSubscriptions?.upsert(u.id, { endpoint: b.endpoint, keys: { p256dh: b.keys.p256dh, auth: b.keys.auth } });
    return c.json({ ok: true }, 201);
  });
  app.post('/push/unsubscribe', async (c) => {
    const u = c.get('user');
    if (!u) return c.json({ error: 'unauthorized' }, 401);
    const b = await c.req.json().catch(() => ({})) as { endpoint?: unknown };
    if (typeof b.endpoint !== 'string' || !b.endpoint) return c.json({ error: 'endpoint required' }, 400);
    d.pushSubscriptions?.removeForUser(u.id, b.endpoint); // scoped: can only remove your own device
    return c.json({ ok: true });
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

  // System panel: the running version, the latest published one, whether an update is available, and
  // the auto-update opt-in. Read-only and cheap (the registry lookup is cached), so any authed user
  // may see it (non-admins still can't trigger the update below).
  app.get('/system', async (c) => {
    const latest = await (d.latestVersion ?? defaultLatestVersion)();
    return c.json({
      version: ORCA_VERSION,
      latest,
      updateAvailable: latest ? isNewer(latest, ORCA_VERSION) : false,
      autoUpdate: d.config.get().autoUpdate,
    });
  });

  // Trigger a manual in-place update. Admin-only (mirrors /config) and refused while a mission is live
  // — the update restarts the services, which would kill the running agent sessions.
  app.post('/system/update', (c) => {
    if (d.users && d.users.count() > 0) { const u = c.get('user'); if (!u || !d.users.isAdmin(u.id)) return c.json({ error: 'forbidden' }, 403); }
    if (d.missions.live().length > 0) return c.json({ error: 'mission_running' }, 409);
    (d.startUpdate ?? defaultStartUpdate)();
    return c.json({ started: true });
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
