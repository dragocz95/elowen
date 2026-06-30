import { assembleMissionDetail } from '../../store/missionDetail.js';
import { parseBody } from '../validation.js';
import { engageMissionSchema, missionActionSchema, overseerDecideSchema } from '../schemas/missions.js';
import type { AccessCtx, OrcaApp, RouteContext } from '../context.js';

/** Mission lifecycle + the overseer long-poll: list/detail, engage, pause/resume, disengage, manual
 *  PR open/merge, and the parked overseer's next/decide endpoints (gated by the mission's own project). */
export function registerMissionRoutes(app: OrcaApp, ctx: RouteContext): void {
  const { d, accessibleProjects, missionAccessible, decisionQueue } = ctx;
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
    // Validate the epic up front: an absent/unknown epicId would otherwise create a zombie mission
    // (id `m-undefined`, no epic to tick) that reports `active` over SSE but never progresses.
    const b = await parseBody(c, engageMissionSchema);
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
    const { action } = await parseBody(c, missionActionSchema);
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
    const b = await parseBody(c, overseerDecideSchema);
    const ok = decisionQueue.resolve(id, b.id, {
      approve: b.approve === true,
      confidence: typeof b.confidence === 'number' ? Math.max(0, Math.min(1, b.confidence)) : 0,
      rationale: typeof b.rationale === 'string' ? b.rationale : '',
      // For a 'question' decision: the picked option id. Absent ⇒ the deriver escalates to a human.
      ...(typeof b.choice === 'string' ? { choice: b.choice } : {}),
      // For a 'message' decision: the overseer's free-text reply. Absent ⇒ askService falls to the
      // human window (the overseer chose --escalate, or answered with nothing).
      ...(typeof b.message === 'string' ? { message: b.message } : {}),
      // For a 'check' decision: restart the idle worker rather than nudge/escalate it.
      ...(b.restart === true ? { restart: true } : {}),
    });
    return ok ? c.json({ ok: true }) : c.json({ error: 'no such decision' }, 404);
  });
}
