import { z } from 'zod';
import { classifySession } from '../overseer/sessionInfo.js';
import { checkoutBusy, checkoutOf } from '../overseer/checkout.js';
import { resolveExecutor } from '../overseer/routing.js';
import { parseResumeLabel } from '../spawn/resume/index.js';
import { resolveOwnerId } from '../lib/owner.js';
import { uniqueName } from '../lib/uniqueName.js';
import { json, canProject, agentForbidden, type ApiAuth } from './http.js';
import type { PluginApiRequest, PluginContext, PluginHttpResponse } from '../../../../src/plugins/api.js';
import type { Task } from '../../../../src/store/types.js';
import type { AgentsRuntime } from '../runtime.js';

const launchSessionSchema = z.object({
  taskId: z.string().min(1),
  exec: z.string().optional(),
});

/** tmux `send-keys` tokens. A non-empty list of plain key tokens; reject any leading-'-' entry so a
 *  crafted token can't smuggle a tmux flag (e.g. `-t <other-session>`) and redirect keystrokes into a
 *  session the caller shouldn't reach. */
const sessionKeysSchema = z.object({
  keys: z.array(z.string().min(1).refine((k) => !k.startsWith('-'), 'flag tokens are not allowed'))
    .min(1, 'keys must be a non-empty array of non-flag strings'),
});

const sessionInputSchema = z.object({ data: z.string().min(1) });
const sessionResizeSchema = z.object({ cols: z.number(), rows: z.number() });

type LaunchOutcome =
  | { ok: true; session: string }
  | { ok: false; reason: 'busy' | 'spawn-failed' | 'gone'; message: string };

/** Ownership guard for the session-control routes. The caller must be able to access the project the
 *  session's task belongs to; admin passes — but an advisor session is owner-or-admin, a chat terminal
 *  is OWNER-ONLY (a second admin is refused), and an agent-scoped token reaches neither. The same
 *  shape the core sessionAccessible had; open mode (no user rows) has no tenancy boundary. */
function sessionAccessibleFor(rt: () => AgentsRuntime, auth: ApiAuth, name: string): boolean {
  if (auth.userId === null) return true; // open / single-user mode
  const info = classifySession(name);
  if (info.role === 'advisor') {
    if (auth.tokenScope === 'agent') return false;
    return auth.userId === info.userId || auth.admin;
  }
  if (info.role === 'chat') {
    if (auth.tokenScope === 'agent') return false;
    return auth.userId === info.userId;
  }
  // Admin sees every session — but NOT via an agent-scoped token (it stays confined to its working
  // set; fall through to the project check below).
  if (auth.tokenScope !== 'agent' && auth.admin) return true;
  const task = rt().taskForSession(name);
  return !!task && canProject(auth, task.project_id);
}

/** The '/sessions' list payload: live `elowen-*` tmux sessions the caller may control, each classified
 *  (role/agent/mission) and tagged with its project from the agent registry. Shared by the GET route
 *  and the ElowenListSessions brain tool. */
export async function sessionsListPayload(tmux: { list(): Promise<string[]> }, rt: () => AgentsRuntime, auth: ApiAuth): Promise<object[]> {
  return (await tmux.list())
    .filter((s) => s.startsWith('elowen-'))
    // Visibility mirrors operability: a caller only sees sessions it may control (its projects'
    // agents, its own advisor; admin sees all).
    .filter((s) => sessionAccessibleFor(rt, auth, s))
    .map((s) => {
      const info = classifySession(s);
      // Tag each session with its project from the agent store (every role upserts there at spawn).
      return { ...info, projectId: rt().agents.projectFor(s.slice('elowen-'.length)) ?? undefined };
    });
}

/** Live tmux session surface, ROOT-mounted at the grandfathered '/sessions' paths: list, manual
 *  launch, kill, keystrokes/raw input, resize, pane capture, the live ANSI stream and a single-use
 *  ticket for the terminal WebSocket. Every control route is ownership-gated by sessionAccessible; a
 *  manual launch claims the shared checkout atomically. Advisor/chat-terminal teardown and the ticket
 *  store reach the core services through the ctx.host.terminals() seam. */
export function registerSessionsApi(ctx: PluginContext, rt: () => AgentsRuntime): void {
  const tmux = ctx.host.tmux();
  const tasks = () => ctx.host.stores().tasks;

  const sessionAccessible = (auth: ApiAuth, name: string): boolean => sessionAccessibleFor(rt, auth, name);

  // Per-user model allow-list: a non-admin whose allowed_execs is non-empty may only use those execs.
  // Open mode, admins, or an empty list → unrestricted. The global config.allowedExecs check still
  // applies independently and is the outer bound.
  const execAllowedForUser = (auth: ApiAuth, exec: string): boolean => {
    if (auth.userId === null) return true;
    const usersRead = ctx.host.stores().usersRead;
    if (usersRead.isAdmin(auth.userId)) return true;
    const allowed = usersRead.allowedExecs(auth.userId);
    if (!allowed || allowed.length === 0) return true;
    return allowed.includes(exec);
  };

  /** Manually (re)launch a worker for a task into its project checkout: claim the shared checkout
   *  atomically, baseline the per-task change snapshot, pin a manual-restart resume note and spawn,
   *  reverting the claim if the spawn fails and stopping the fresh agent again if the claim did not
   *  survive the spawn. The caller has already gated exec/project access. */
  const launchManual = async (task: Task, exec: string | undefined): Promise<LaunchOutcome> => {
    const r = rt();
    const spec = resolveExecutor(exec ? [`exec:${exec}`] : [], r.resumeFallback);
    const projectId = task.project_id;
    const taskId = task.id;
    if (exec) tasks().setExec(taskId, exec); // remember which model ran it — drives the model icon
    // Single-writer: a manual launch targets the shared project checkout, so refuse it when another
    // agent (a scheduler task or a non-PR mission phase) is already live there — a second writer would
    // corrupt per-task change attribution. Read in_progress FRESH and flip status synchronously right
    // after, so the check-and-claim is atomic against the concurrent scheduler/engine ticks.
    const projects = ctx.host.stores().projects;
    const resolver = {
      projectPath: (pid: number) => projects.get(pid)?.path ?? ctx.host.stores().homeProject().path,
      worktreeFor: (mid: string) => r.missionGit.worktreeFor(mid),
    };
    // A task that belongs to a PR-native mission runs in that mission's ISOLATED worktree, not the
    // shared project checkout — resolve its real cwd the same way the scheduler/engine do.
    const cwd = checkoutOf(resolver, task);
    if (checkoutBusy(resolver, tasks().list({ status: 'in_progress' }), cwd)) return { ok: false, reason: 'busy', message: 'checkout busy' };
    const agentName = uniqueName();
    tasks().setAgent(taskId, agentName);     // link task → elowen-<agentName> session for run controls
    tasks().markStarted(taskId, Date.now()); // precise spawn time → correct usage attribution under concurrency
    tasks().setStatus(taskId, 'in_progress'); // claim synchronously after the fresh check above
    // Baseline for the per-task change snapshot, under the checkout lock so it lands after any in-flight commit.
    await r.gitLock.run(cwd, async () => tasks().markBase(taskId, await ctx.host.git().projectHead(cwd)));
    // When this is a resume (the task ran before), pin a note so the resumed agent knows it was
    // restarted on purpose — unless a more specific note (review-reject rationale, stuck relaunch
    // reason) already carries actionable context.
    const resume = parseResumeLabel(task.labels);
    if (resume && !tasks().get(taskId)?.resume_note) tasks().setResumeNote(taskId, 'Manually restarted — continue from where you left off and finish the task.');
    const resumeNote = tasks().get(taskId)?.resume_note ?? undefined;
    const ownerId = resolveOwnerId({ tasks: tasks(), missions: r.missions, users: { list: () => ctx.host.stores().usersRead.list().map((u) => ({ id: u.id })) } }, { taskId });
    let session: string;
    try {
      ({ session } = await r.spawn.launch({ projectId, projectPath: cwd, taskId, agentName, spec, taskTitle: task.title, taskDescription: task.description, resumeNote, epicId: task.parent_id ?? undefined, resume, ownerId }));
    } catch (e) {
      // The task was already flipped to in_progress above; a spawn failure would otherwise leave it
      // stuck with no live session until the stuck detector reverts it. Revert immediately.
      tasks().setStatus(taskId, 'open');
      ctx.publishEvent({ type: 'task', taskId, status: 'open' });
      return { ok: false, reason: 'spawn-failed', message: (e as Error).message };
    }
    // The claim and the spawn are not one step: a DELETE/status revert landing in between would leave
    // the fresh agent editing the checkout with nothing left to stop it by. Re-read the row and
    // require it to still be exactly the claim this call made; otherwise stop what was spawned.
    const claimed = tasks().get(taskId);
    if (!claimed || claimed.status !== 'in_progress' || !claimed.labels.includes(`agent:${agentName}`)) {
      await tmux.kill(session).catch((e) => ctx.logger.error(`failed to stop orphaned session ${session}: ${e instanceof Error ? e.message : String(e)}`));
      return { ok: false, reason: 'gone', message: 'task was removed or reassigned during launch' };
    }
    ctx.publishEvent({ type: 'task', taskId, status: 'in_progress' });
    return { ok: true, session };
  };

  const list = async (auth: ApiAuth): Promise<PluginHttpResponse> => json(await sessionsListPayload(tmux, rt, auth));

  const launch = async (req: PluginApiRequest): Promise<PluginHttpResponse> => {
    const { taskId, exec } = launchSessionSchema.parse(await req.json());
    if (exec && !ctx.host.config().get().allowedExecs.includes(exec)) return json({ error: 'exec not allowed' }, 400);
    if (exec && !execAllowedForUser(req.auth, exec)) return json({ error: 'exec not allowed for user' }, 403);
    const task = tasks().get(taskId);
    if (!task) return json({ error: 'task not found' }, 404); // don't spawn a phantom agent for a missing task
    // Launch in the task's own project (multi-project), gated to the caller's access.
    if (!canProject(req.auth, task.project_id)) return json({ error: 'forbidden' }, 403);
    const result = await launchManual(task, exec);
    if (!result.ok) {
      if (result.reason === 'busy') return json({ error: 'checkout busy' }, 409);
      return json({ error: `spawn failed: ${result.message}` }, 500);
    }
    return json({ session: result.session }, 201);
  };

  const kill = async (auth: ApiAuth, name: string): Promise<PluginHttpResponse> => {
    if (!sessionAccessible(auth, name)) return json({ error: 'forbidden' }, 403);
    // Killing a user's advisor from the sessions list is an explicit "turn it off" — route it through
    // the (plugin-owned) advisor service so it also persists advisor_autostart=false (else
    // ensureOnLogin resurrects it on the next login). An admin's chat terminal goes through its core
    // service: the stop also revokes the per-terminal token and drops the durable binding. Plain
    // agent/overseer sessions just get killed.
    const info = classifySession(name);
    const terminals = ctx.host.terminals();
    if (info.role === 'advisor' && info.userId !== undefined) {
      const advisor = rt().advisor();
      if (advisor) await advisor.stop(info.userId);
      else await tmux.kill(name); // no collaborators in this process — at least kill the pane
      return json({ ok: true });
    }
    if (info.role === 'chat' && info.userId !== undefined && auth.userId !== null) {
      await terminals.chatTerminalStop(auth.userId, name);
      return json({ ok: true });
    }
    // Embedded-brain workers have no tmux pane — kill controls route to the in-process session.
    if (terminals.brainWorkerLive(name)) { await terminals.brainWorkerAbort(name); return json({ ok: true }); }
    await tmux.kill(name);
    return json({ ok: true });
  };

  const stream = (auth: ApiAuth, name: string): PluginHttpResponse => {
    if (!sessionAccessible(auth, name)) return json({ error: 'forbidden' }, 403);
    return {
      sse: async (send, signal) => {
        let done = false;          // flips once: on abort or after a run of failed frames
        const frame = async () => send(JSON.stringify({ pane: await tmux.capturePaneAnsi(name, 200) }), 'pane');
        await frame(); // first frame synchronously so clients render immediately
        let errs = 0;
        // capturePaneAnsi returns '' for a vanished session, so a throw here means the write failed
        // (closed client). After a short run of consecutive failures, stop pushing frames forever.
        const timer = setInterval(() => {
          frame().then(() => { errs = 0; }).catch(() => { if (++errs >= 5) done = true; });
        }, 1000);
        timer.unref?.();
        signal.addEventListener('abort', () => { done = true; });
        while (!done && !signal.aborted) await new Promise((r) => setTimeout(r, 1000));
        clearInterval(timer);
      },
    };
  };

  // ONE mount per method; handlers route by the remainder's segments. access:'agent' on GET admits the
  // worker service token to the LIST (the core middleware allow-list confines agent GETs to exactly
  // '/sessions'); every control route is 'user'.
  ctx.registerApiRoute({
    rootMount: '/sessions', path: '', method: 'GET', access: 'agent',
    handler: async (req) => {
      const segs = req.path === '' ? [] : req.path.split('/');
      // Agent tokens may reach ONLY the list (the exact verb the core allow-list admitted).
      if (agentForbidden(req.auth, segs.length === 0)) return json({ error: 'forbidden' }, 403);
      if (segs.length === 0) return list(req.auth);
      const name = decodeURIComponent(segs[0]!);
      if (segs.length === 2 && segs[1] === 'pane') {
        if (!sessionAccessible(req.auth, name)) return json({ error: 'forbidden' }, 403);
        const pane = req.query['ansi'] ? await tmux.capturePaneAnsi(name, 60) : await tmux.capturePane(name, 60);
        return json({ pane });
      }
      if (segs.length === 2 && segs[1] === 'stream') return stream(req.auth, name);
      return json({ error: 'not found' }, 404);
    },
  });
  ctx.registerApiRoute({
    rootMount: '/sessions', path: '', method: 'POST', access: 'user',
    handler: async (req) => {
      const segs = req.path === '' ? [] : req.path.split('/');
      if (segs.length === 0) return launch(req);
      const name = decodeURIComponent(segs[0]!);
      if (segs.length !== 2) return json({ error: 'not found' }, 404);
      if (!sessionAccessible(req.auth, name)) return json({ error: 'forbidden' }, 403);
      if (segs[1] === 'keys') {
        const { keys } = sessionKeysSchema.parse(await req.json());
        await tmux.sendKeys(name, keys);
        return json({ ok: true });
      }
      if (segs[1] === 'input') {
        // Raw interactive input: the xterm `onData` bytes are forwarded verbatim via `send-keys -l`,
        // so the advisor terminal behaves like a real one (`-l` + `--` make a leading '-' safe).
        const { data } = sessionInputSchema.parse(await req.json());
        await tmux.sendRaw(name, data);
        return json({ ok: true });
      }
      if (segs[1] === 'resize') {
        const { cols, rows } = sessionResizeSchema.parse(await req.json());
        await tmux.resize(name, cols, rows);
        return json({ ok: true });
      }
      if (segs[1] === 'ws-ticket') {
        // Mint a single-use ticket for the terminal WebSocket stream — the unauthenticated
        // /ws/terminal upgrade redeems it from the SAME core store (host terminals seam).
        return json({ ticket: ctx.host.terminals().ticketIssue(name, req.auth.userId) });
      }
      return json({ error: 'not found' }, 404);
    },
  });
  ctx.registerApiRoute({
    rootMount: '/sessions', path: '', method: 'DELETE', access: 'user',
    handler: async (req) => {
      const segs = req.path === '' ? [] : req.path.split('/');
      if (segs.length !== 1) return json({ error: 'not found' }, 404);
      return kill(req.auth, decodeURIComponent(segs[0]!));
    },
  });
}
