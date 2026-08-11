import { z } from 'zod';
import { assembleMissionDetail } from './missionDetail.js';
import { json, canProject, agentForbidden, type ApiAuth } from './http.js';
import type { PluginApiRequest, PluginContext, PluginHttpResponse } from '../../../../src/plugins/api.js';
import type { AgentsRuntime } from '../runtime.js';

/** Upper bound on a mission's concurrent agents. Every session is a real spawned agent (a tmux session
 *  plus a model), so an unbounded value lets a single request exhaust the machine. */
const MAX_MISSION_SESSIONS = 20;

const engageMissionSchema = z.object({
  epicId: z.string().min(1),
  autonomy: z.string().optional(),
  maxSessions: z.number().int().min(1).max(MAX_MISSION_SESSIONS).optional(),
});

const missionActionSchema = z.object({
  action: z.string().optional(),
});

const overseerDecideSchema = z.object({
  id: z.string().min(1),
  approve: z.boolean().optional(),
  confidence: z.number().optional(),
  rationale: z.string().optional(),
  choice: z.string().optional(),
  message: z.string().optional(),
  restart: z.boolean().optional(),
});

/** Mission lifecycle + the overseer long-poll, ROOT-mounted at the grandfathered '/missions' paths the
 *  web BFF and CLI already call: list/detail, engage, pause/resume, disengage, manual PR open/merge,
 *  and the parked overseer's next/decide endpoints — every route gated by the mission's own project
 *  through the dispatcher's verified tenancy set. Registered with access:'agent' where the core agent
 *  allow-list admits an agent token (overseer next/decide only — the middleware allow-list stays the
 *  fine-grained gate, exactly as before the extraction). With the plugin disabled these mounts do not
 *  exist and the paths answer 404. */
export function registerMissionsApi(ctx: PluginContext, rt: () => AgentsRuntime): void {
  const tasks = () => ctx.host.stores().tasks;

  // A mission belongs to its epic's project. Unrestricted callers (admin / open mode) pass even when
  // the epic row is absent — the same shape the core missionAccessible had.
  const missionAccessible = (auth: ApiAuth, epicId: string): boolean => {
    if (auth.accessibleProjects === null) return true;
    const epic = tasks().get(epicId);
    return !!epic && canProject(auth, epic.project_id);
  };

  const list = (auth: ApiAuth): PluginHttpResponse => {
    const r = rt();
    const live = r.missions.live();
    // Also surface DISENGAGED missions whose PR is still pending (ready to open / open) so a completed
    // PR-native mission keeps its branch/PR affordance in the UI — the manual "Open PR" lives here.
    const liveIds = new Set(live.map((m) => m.id));
    const extra = r.missionGit.pendingPrMissionIds()
      .filter((id) => !liveIds.has(id))
      .map((id) => r.missions.get(id))
      .filter((m): m is NonNullable<typeof m> => m != null);
    const all = [...live, ...extra];
    const allowed = auth.accessibleProjects;
    const visible = allowed ? all.filter((m) => { const epic = tasks().get(m.epic_id); return epic && allowed.includes(epic.project_id); }) : all;
    // Attach PR-native metadata (branch/PR url+state) so the tasks view can show a badge + "Open PR"
    // without a per-mission detail fetch. Null for non-PR missions.
    return json(visible.map((m) => ({ ...m, pr: r.missionGit.prInfo(m.id) ?? null })));
  };

  const detail = (auth: ApiAuth, id: string): PluginHttpResponse => {
    const r = rt();
    const mission = r.missions.get(id);
    if (!mission) return json({ error: 'mission not found' }, 404);
    if (!missionAccessible(auth, mission.epic_id)) return json({ error: 'forbidden' }, 403);
    const d = assembleMissionDetail({ missions: r.missions, tasks: tasks() }, id);
    if (!d) return json({ error: 'mission not found' }, 404);
    return json({ ...d, pr: r.missionGit.prInfo(id) ?? null });
  };

  // Aggregate every phase's frozen change list into a single per-file churn summary for the mission —
  // the dashboard's "files changed by this mission" view. A file touched by more than one phase has its
  // added/deleted summed; the result is ordered by total churn (added+deleted) desc.
  const changedFiles = (auth: ApiAuth, id: string): PluginHttpResponse => {
    const mission = rt().missions.get(id);
    if (!mission) return json({ error: 'mission not found' }, 404);
    if (!missionAccessible(auth, mission.epic_id)) return json({ error: 'forbidden' }, 403);
    const totals = new Map<string, { path: string; added: number; deleted: number }>();
    for (const phase of tasks().children(mission.epic_id)) { // the epic's direct phases only
      for (const f of phase.changed_files) {
        const cur = totals.get(f.path);
        if (cur) { cur.added += f.added; cur.deleted += f.deleted; }
        else totals.set(f.path, { path: f.path, added: f.added, deleted: f.deleted });
      }
    }
    return json([...totals.values()].sort((a, b) => (b.added + b.deleted) - (a.added + a.deleted)));
  };

  const engage = async (req: PluginApiRequest): Promise<PluginHttpResponse> => {
    // Validate the epic up front: an absent/unknown epicId would otherwise create a zombie mission
    // (id `m-undefined`, no epic to tick) that reports `active` over SSE but never progresses.
    const b = engageMissionSchema.parse(await req.json());
    const target = tasks().get(b.epicId);
    if (!target) return json({ error: 'epic not found' }, 404);
    if (!missionAccessible(req.auth, b.epicId)) return json({ error: 'forbidden' }, 403);
    // Only an epic can carry a mission: the engine spawns and completes the target's CHILD phases, and
    // a plain task has none.
    if (target.type !== 'epic') return json({ error: 'task is not an epic' }, 400);
    return json(await rt().engine.engage({
      epicId: b.epicId,
      autonomy: b.autonomy ?? 'L3',
      maxSessions: typeof b.maxSessions === 'number' ? b.maxSessions : 1,
      createdBy: req.auth.userId, // owner for per-mission push routing
    }), 201);
  };

  const patch = async (req: PluginApiRequest, id: string): Promise<PluginHttpResponse> => {
    const r = rt();
    const mission = r.missions.get(id);
    if (!mission) return json({ error: 'mission not found' }, 404);
    if (!missionAccessible(req.auth, mission.epic_id)) return json({ error: 'forbidden' }, 403);
    const { action } = missionActionSchema.parse(await req.json());
    if (action === 'pause') {
      await r.engine.pause(id); // kills running agents + reverts their tasks, then marks paused
    } else if (action === 'resume') {
      await r.engine.resume(id); // flips active, re-parks the overseer, then ticks
    }
    return json(r.missions.get(id) ?? { error: 'mission not found' });
  };

  const disengage = async (auth: ApiAuth, id: string): Promise<PluginHttpResponse> => {
    const r = rt();
    const mission = r.missions.get(id);
    if (!mission) return json({ error: 'mission not found' }, 404);
    if (!missionAccessible(auth, mission.epic_id)) return json({ error: 'forbidden' }, 403);
    await r.engine.disengage(id);
    return json({ ok: true });
  };

  // Manually open the PR for a PR-native mission (the "Open PR" affordance, for prAutoOpen=off).
  const openPr = async (auth: ApiAuth, id: string): Promise<PluginHttpResponse> => {
    const r = rt();
    const mission = r.missions.get(id);
    if (!mission) return json({ error: 'mission not found' }, 404);
    if (!missionAccessible(auth, mission.epic_id)) return json({ error: 'forbidden' }, 403);
    const res = await r.missionGit.openPr(id);
    switch (res.state) {
      case 'opened': return json({ url: res.url, number: res.number });
      case 'incomplete': return json({ error: 'mission is not finished yet — wait until all phases complete' }, 409);
      case 'verify-failed': return json({ error: 'verify command failed', output: res.output }, 422);
      case 'no-remote': return json({ error: 'project has no GitHub remote to push to' }, 422);
      case 'pr-failed': return json({ error: 'gh CLI unavailable or unauthenticated' }, 422);
      default: return json({ error: 'PR workflow not enabled for this mission' }, 400);
    }
  };

  // Squash-merge a PR-native mission's PR into the base branch (the "Merge to main" affordance).
  const mergePr = async (auth: ApiAuth, id: string): Promise<PluginHttpResponse> => {
    const r = rt();
    const mission = r.missions.get(id);
    if (!mission) return json({ error: 'mission not found' }, 404);
    if (!missionAccessible(auth, mission.epic_id)) return json({ error: 'forbidden' }, 403);
    const res = await r.missionGit.mergePr(id);
    return res.ok ? json({ ok: true }) : json({ error: res.reason }, 422);
  };

  // Overseer long-poll: the parked per-mission overseer agent polls `next` (blocks until a decision is
  // needed or a heartbeat) and answers via `decide`. Gated by the mission's OWN project so a
  // cross-project user can't read/answer another tenant's decisions. A non-existent mission id has
  // nothing to leak, so it falls through (harmless heartbeat / no-op).
  const overseerForbidden = (auth: ApiAuth, missionId: string): boolean => {
    const mission = rt().missions.get(missionId);
    return !!mission && !missionAccessible(auth, mission.epic_id);
  };

  const overseerNext = async (req: PluginApiRequest, id: string): Promise<PluginHttpResponse> => {
    if (overseerForbidden(req.auth, id)) return json({ error: 'forbidden' }, 403);
    const raw = Number(req.query['timeoutMs']);
    const timeoutMs = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 30_000) : undefined;
    const next = await rt().decisionQueue.next(id, timeoutMs);
    return json(next ?? {});
  };

  const overseerDecide = async (req: PluginApiRequest, id: string): Promise<PluginHttpResponse> => {
    if (overseerForbidden(req.auth, id)) return json({ error: 'forbidden' }, 403);
    const b = overseerDecideSchema.parse(await req.json());
    const ok = rt().decisionQueue.resolve(id, b.id, {
      approve: b.approve === true,
      confidence: typeof b.confidence === 'number' ? Math.max(0, Math.min(1, b.confidence)) : 0,
      rationale: typeof b.rationale === 'string' ? b.rationale : '',
      ...(typeof b.choice === 'string' ? { choice: b.choice } : {}),
      ...(typeof b.message === 'string' ? { message: b.message } : {}),
      ...(b.restart === true ? { restart: true } : {}),
    });
    return ok ? json({ ok: true }) : json({ error: 'no such decision' }, 404);
  };

  // ONE mount per method; the handler routes by the remainder's segments (the dispatcher's
  // longest-prefix contract — same as the namespaced plugin API). access:'agent' on GET/POST admits
  // the overseer's service token; the core middleware allow-list still confines agent tokens to
  // exactly the overseer next/decide paths, and user tenancy is enforced per handler above.
  ctx.registerApiRoute({
    rootMount: '/missions', path: '', method: 'GET', access: 'agent',
    handler: async (req) => {
      const segs = req.path === '' ? [] : req.path.split('/');
      // Agent tokens may reach ONLY the overseer long-poll (the exact set the core allow-list admitted).
      if (agentForbidden(req.auth, segs.length === 3 && segs[1] === 'overseer' && segs[2] === 'next')) return json({ error: 'forbidden' }, 403);
      if (segs.length === 0) return list(req.auth);
      const id = decodeURIComponent(segs[0]!);
      if (segs.length === 1) return detail(req.auth, id);
      if (segs.length === 2 && segs[1] === 'changed-files') return changedFiles(req.auth, id);
      if (segs.length === 3 && segs[1] === 'overseer' && segs[2] === 'next') return overseerNext(req, id);
      return json({ error: 'not found' }, 404);
    },
  });
  ctx.registerApiRoute({
    rootMount: '/missions', path: '', method: 'POST', access: 'agent',
    handler: async (req) => {
      const segs = req.path === '' ? [] : req.path.split('/');
      // Agent tokens may reach ONLY the overseer decide verb.
      if (agentForbidden(req.auth, segs.length === 3 && segs[1] === 'overseer' && segs[2] === 'decide')) return json({ error: 'forbidden' }, 403);
      if (segs.length === 0) return engage(req);
      const id = decodeURIComponent(segs[0]!);
      if (segs.length === 2 && segs[1] === 'pr') return openPr(req.auth, id);
      if (segs.length === 2 && segs[1] === 'merge-pr') return mergePr(req.auth, id);
      if (segs.length === 3 && segs[1] === 'overseer' && segs[2] === 'decide') return overseerDecide(req, id);
      return json({ error: 'not found' }, 404);
    },
  });
  ctx.registerApiRoute({
    rootMount: '/missions', path: '', method: 'PATCH', access: 'user',
    handler: async (req) => {
      const segs = req.path === '' ? [] : req.path.split('/');
      if (segs.length !== 1) return json({ error: 'not found' }, 404);
      return patch(req, decodeURIComponent(segs[0]!));
    },
  });
  ctx.registerApiRoute({
    rootMount: '/missions', path: '', method: 'DELETE', access: 'user',
    handler: async (req) => {
      const segs = req.path === '' ? [] : req.path.split('/');
      if (segs.length !== 1) return json({ error: 'not found' }, 404);
      return disengage(req.auth, decodeURIComponent(segs[0]!));
    },
  });
}
