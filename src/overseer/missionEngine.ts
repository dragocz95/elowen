import type { TaskStore } from '../store/taskStore.js';
import { resolveOwnerId } from '../prompts/owner.js';
import type { Task } from '../store/types.js';
import type { Readiness } from '../store/readiness.js';
import type { MissionStore, Mission } from '../store/missionStore.js';
import type { SpawnService } from '../spawn/spawn.js';
import type { TmuxDriver } from '../tmux/types.js';
import type { AgentSpec } from '../spawn/commandBuilder.js';
import type { EventBus } from '../api/sse.js';
import { resolveExecutor } from './routing.js';
import { parseResumeLabel } from '../spawn/resume/index.js';
import { projectHead } from '../integrations/projectFiles.js';
import { checkoutBusy } from './checkout.js';
import { freeAgentName } from '../daemon/uniqueName.js';
import type { OverseerController } from './overseerAgent.js';
import type { MissionGit } from './missionGit.js';
import type { Clock } from '../shared/clock.js';
import { KeyedMutex } from '../shared/keyedMutex.js';
import { logger } from '../shared/logger.js';

const log = logger('overseer');

export interface MissionEngineDeps {
  tasks: TaskStore; readiness: Readiness; missions: MissionStore;
  spawn: SpawnService; tmux: TmuxDriver; bus: EventBus;
  /** User store, used only for the admin fallback when attributing a phase agent to its owner (per-user
   *  prompt resolution). Optional: absent in minimal test wiring → file-default prompts. */
  users?: { list(): { id: number }[] };
  /** Resolves a mission's project from its epic's project_id — the engine is project-agnostic and
   *  drives missions across every registered project, not a single fixed one. */
  projects: { get(id: number): { id: number; path: string } | null };
  fallback: AgentSpec;
  nameAgent: () => string; clock: Clock;
  /** Serializes the spawn-time baseline read on a shared checkout so it lands after any in-flight
   *  commit (a just-closed phase) and the per-task snapshot range stays exact. Must be the SAME
   *  instance shared with the scheduler and API server. Absent → a private lock (fine for unit tests). */
  gitLock?: KeyedMutex;
  /** Optional parked-overseer lifecycle. Started on engage, stopped on pause/disengage. Absent (or
   *  inert when no overseerExec is configured) → relay-fallback decisions, no parked agent. */
  overseer?: OverseerController;
  /** Optional PR-native git lifecycle. When wired and PR mode is enabled, each mission runs in an
   *  isolated worktree on its own branch; absent (or PR mode off) → agents run in the main checkout. */
  missionGit?: MissionGit;
  /** Optional overseer-model summariser: given the mission goal and each phase's own result, returns
   *  prose describing what the mission accomplished. Stamped on the epic on natural completion so the
   *  dashboard can show it. Absent (or on error/blank) → the engine writes a deterministic digest. */
  summarize?: (ctx: SummaryContext) => Promise<string>;
}

export interface SummaryContext {
  goal: string;
  phases: { title: string; outcome: string | null; summary: string | null }[];
}

export class MissionEngine {
  private readonly gitLock: KeyedMutex;
  constructor(private d: MissionEngineDeps) { this.gitLock = d.gitLock ?? new KeyedMutex(); }

  /** Mission ids with a tick currently in flight. tick() is async and is driven from several places
   *  (the 90s overseer interval, engage/resume) — without this guard two overlapping ticks for the
   *  same mission can both read the same `running` count and dispatch past `max_sessions`. */
  private ticking = new Set<string>();
  // A tick requested for a mission whose tick is already in flight (review approval, self-heal, gate
  // release). Coalesced into one more pass after the running tick, so freed work spawns promptly instead
  // of waiting up to the 90s interval — without re-entrantly stacking ticks.
  private retick = new Set<string>();

  async engage(input: { epicId: string; autonomy: string; maxSessions: number; createdBy?: number | null; preserveReviewBudget?: boolean }): Promise<Mission> {
    const id = `m-${input.epicId}`;
    const m = this.d.missions.create({ id, epic_id: input.epicId, autonomy: input.autonomy, max_sessions: input.maxSessions, created_by: input.createdBy ?? null });
    // Fresh self-heal budget: a brand-new (or aborted-and-restarted) engage must not inherit
    // `reviewfix:<n>` labels from a prior run, or the mission escalates after fewer real review retries.
    // A PR-feedback re-engage CONTINUES a finished mission, though, so it passes preserveReviewBudget to
    // keep the existing budgets — otherwise every PR fix round would silently hand a re-opened phase a
    // full fresh budget back.
    if (!input.preserveReviewBudget) this.d.tasks.resetReviewFix(input.epicId);
    this.d.bus.publish({ type: 'mission', missionId: m.id, state: 'active' });
    // Park the per-mission overseer agent (no-op when no overseerExec is configured) so it is ready
    // to answer decisions (e.g. post-completion reviews) for this mission.
    const epic = this.d.tasks.get(input.epicId);
    const project = epic ? this.d.projects.get(epic.project_id) : null;
    // Provision the mission's branch + worktree (no-op when PR mode is off) BEFORE the first tick, so
    // the very first agent already spawns inside the isolated worktree.
    await this.d.missionGit?.onEngage(id, input.epicId);
    if (project) await this.d.overseer?.start(id, project.id, project.path);
    await this.tick(id);
    return m;
  }

  isActive(id: string): boolean { return this.d.missions.get(id)?.state === 'active'; }

  /** Hard-stop a mission's active work: kill the live tmux session of every in-progress child
   *  and revert it to open. Without this, pausing/disengaging only flips the mission state while
   *  the agent keeps running — so the UI still reads as "running". A later resume re-spawns from
   *  open. Returns the number of agents stopped. */
  async stopRunning(epicId: string): Promise<number> {
    const live = new Set(await this.d.tmux.list());
    let stopped = 0;
    for (const t of this.children(epicId)) {
      if (t.status !== 'in_progress') continue;
      const agent = t.labels.find((l) => l.startsWith('agent:'))?.slice('agent:'.length);
      const session = agent ? `orca-${agent}` : null;
      // Guard the kill: if the session exited between `list()` and here, the driver rejects — without
      // the catch one dead session would abort the loop and strand the remaining children in_progress
      // forever (the UI would still read "running"). Mirror overseerAgent.stop / janitor.
      if (session && live.has(session)) { try { await this.d.tmux.kill(session); } catch { /* already gone — fine */ } }
      this.d.tasks.setStatus(t.id, 'open');
      this.d.bus.publish({ type: 'task', taskId: t.id, status: 'open' });
      stopped++;
    }
    return stopped;
  }

  /** Kill the live tmux session of a single task, if any. A re-open path (review self-heal, stuck
   *  revert) calls this first so the re-spawn never collides with a worker that outlived its task
   *  close ("duplicate session"). Mirrors stopRunning but for one task; the caller owns the status. */
  async stopTask(taskId: string): Promise<void> {
    const agent = this.d.tasks.get(taskId)?.labels.find((l) => l.startsWith('agent:'))?.slice('agent:'.length);
    if (!agent) return;
    const session = `orca-${agent}`;
    if ((await this.d.tmux.list()).includes(session)) {
      try { await this.d.tmux.kill(session); } catch { /* already gone — fine */ }
    }
  }

  /** Resume after work was just unblocked (gate approved, self-heal re-opened a phase): un-freeze the
   *  mission if it had stalled, then tick so the freed work spawns immediately instead of waiting on
   *  the interval — which, for a stalled mission, never comes (it no longer ticks itself). The un-stall
   *  matters because the mission can flip to 'stalled' in the window between a phase closing and its
   *  review verdict returning; a plain tick would then be a no-op (frozen) and the work would never run.
   *  Always ticks; the un-stall is conditional, so this is a safe drop-in wherever we'd otherwise tick. */
  async resumeStalled(id: string): Promise<void> {
    const m = this.d.missions.get(id);
    if (m?.state === 'stalled') {
      this.d.missions.setState(id, 'active');
      this.d.bus.publish({ type: 'mission', missionId: id, state: 'active' });
    }
    await this.tick(id);
  }

  async disengage(id: string): Promise<void> {
    const m = this.d.missions.get(id);
    if (!m || m.state === 'disengaged') return; // idempotent: a repeat call must not re-publish the event
    await this.stopRunning(m.epic_id);
    await this.markDisengaged(id);
    // Explicit disengage tears down the worktree (the branch is kept). Natural completion does NOT —
    // it routes through markDisengaged directly so the worktree survives for the PR/feedback path.
    await this.d.missionGit?.cleanup(id);
  }

  /** The single disengage transition: mark the mission disengaged, announce it, and tear down the
   *  parked overseer (kill its session + drain its queue). Shared by explicit disengage AND the
   *  natural-completion branch in tick — otherwise a self-completing mission leaks its overseer. */
  private async markDisengaged(id: string): Promise<void> {
    // Re-check state under the (single-threaded) call: two overlapping ticks can both see "all kids
    // closed" and call this. Bail if already disengaged so the event + overseer.stop fire exactly once.
    if (this.d.missions.get(id)?.state === 'disengaged') return;
    this.d.missions.setState(id, 'disengaged');
    this.d.bus.publish({ type: 'mission', missionId: id, state: 'disengaged' });
    await this.d.overseer?.stop(id);
  }

  /** On natural completion, stamp a human-readable "what happened" summary onto the epic so the
   *  dashboard can show it on the task. Prefer the overseer model's prose; fall back to a
   *  deterministic digest of each phase's own result if no summariser is wired or it errors/blanks.
   *  Re-closing an epic the final agent already closed simply overwrites its summary with the prose. */
  private async writeMissionSummary(epic: Task, kids: Task[]): Promise<void> {
    const phases = kids
      .filter(k => k.status !== 'cancelled') // cancelled phases never ran — don't report them as outcomes
      .map(k => ({ title: k.title, outcome: k.outcome, summary: k.result_summary }));
    let summary = '';
    try {
      summary = (await this.d.summarize?.({ goal: epic.title, phases }))?.trim() ?? '';
    } catch (e) {
      log.error(`mission summary generation failed for epic ${epic.id} — using digest`, e);
    }
    if (!summary) summary = this.digest(phases);
    this.d.tasks.close(epic.id, { summary, outcome: 'ok' });
    this.d.bus.publish({ type: 'task', taskId: epic.id, status: 'closed' });
  }

  private digest(phases: SummaryContext['phases']): string {
    const lines = phases.map(p => `- ${p.title}: ${p.summary?.trim() || p.outcome || 'dokončeno'}`);
    return `Mise dokončena (${phases.length} fází).\n${lines.join('\n')}`;
  }

  async pause(id: string): Promise<void> {
    const m = this.d.missions.get(id);
    if (!m || m.state === 'paused') return; // idempotent: a repeat call must not re-publish the event
    await this.stopRunning(m.epic_id);
    this.d.missions.setState(id, 'paused');
    this.d.bus.publish({ type: 'mission', missionId: id, state: 'paused' });
    await this.d.overseer?.stop(id); // a paused mission keeps no parked overseer; resume restarts it
    await this.d.missionGit?.cleanup(id); // free the worktree; resume re-provisions it via onEngage
  }

  /** Resume a paused mission: flip active, re-park the overseer (pause stopped it), then tick so it
   *  re-spawns work. Single source of truth for the resume transition (the API delegates here). */
  async resume(id: string): Promise<void> {
    const m = this.d.missions.get(id);
    if (!m) return;
    this.d.missions.setState(id, 'active');
    this.d.bus.publish({ type: 'mission', missionId: id, state: 'active' });
    const epic = this.d.tasks.get(m.epic_id);
    const project = epic ? this.d.projects.get(epic.project_id) : null;
    // Pause freed the worktree, so re-provision it (no-op when PR mode is off or it still exists).
    await this.d.missionGit?.onEngage(id, m.epic_id);
    if (project) await this.d.overseer?.start(id, project.id, project.path);
    await this.tick(id);
  }

  // Epic ids are globally unique, so children resolve by parent_id alone — no project scoping needed.
  // An epic's own parent_id is never its own id, so no `type !== 'epic'` filter is needed.
  private children(epicId: string) {
    return this.d.tasks.list().filter(t => t.parent_id === epicId);
  }

  async tick(id: string): Promise<void> {
    if (this.ticking.has(id)) { this.retick.add(id); return; } // in flight — request one more pass after it
    this.ticking.add(id);
    try {
      await this.tickOnce(id);
      // A tick that arrived while we were running (e.g. a review approval released a gate) set `retick`.
      // Drain those requests with one more pass each so the freed work spawns now, not 90s later. Each
      // extra pass needs a NEW external request to loop again, so this converges.
      while (this.retick.delete(id)) await this.tickOnce(id);
    } finally {
      this.ticking.delete(id);
    }
  }

  private async tickOnce(id: string): Promise<void> {
    const m = this.d.missions.get(id); if (!m || (m.state !== 'active' && m.state !== 'stalled')) return;
    // The mission's project is wherever its epic lives — resolve it per tick.
    const epic = this.d.tasks.get(m.epic_id); if (!epic) return;
    const project = this.d.projects.get(epic.project_id);
    if (!project) {
      // A live epic whose project row is gone is an invariant violation; surface it instead of
      // silently no-opping every tick forever (the mission would otherwise look active but stuck).
      log.error(`mission ${id}: project ${epic.project_id} not found for epic ${epic.id} — cannot tick`);
      return;
    }

    const kids = this.children(m.epic_id);
    if (kids.length > 0 && kids.every(t => t.status === 'closed' || t.status === 'cancelled')) {
      // A mission already held by a failed PR verify gate stays stalled for a human — never re-summarise
      // or re-run the (possibly slow) gate on every subsequent tick.
      if (this.d.missionGit?.prState(id) === 'verify_failed') {
        if (m.state !== 'stalled') { this.d.missions.setState(id, 'stalled'); this.d.bus.publish({ type: 'mission', missionId: id, state: 'stalled' }); }
        return;
      }
      await this.writeMissionSummary(epic, kids); // stamp a "what happened" summary on the epic first…
      // Finalise git (no-op unless PR mode): verify gate → push → open PR (auto) or wait for manual.
      const fin = await this.d.missionGit?.finishMission(id);
      if (fin?.state === 'verify-failed') {
        // The quality gate failed: hold the mission for a human (worktree + branch kept), don't open a
        // PR, and don't disengage. Surface the failure so the UI shows why it stalled.
        this.d.missions.setState(id, 'stalled');
        this.d.bus.publish({ type: 'mission', missionId: id, state: 'stalled' });
        this.d.bus.publish({ type: 'review', missionId: id, taskId: epic.id, approve: false, rationale: `Verify command failed:\n${fin.output}` });
        return;
      }
      await this.markDisengaged(id); return; // …then tear down the parked overseer (no leak on self-completion)
    }

    // Escalated → frozen. A stalled mission is waiting on a human (approve-gate / re-run on the
    // Escalations page); it must NOT churn — no re-spawns, no overseer re-park. The human action
    // un-stalls it explicitly (resumeStalled → active + tick). Without this freeze an escalated mission
    // retries spawns and re-parks a crashed overseer every interval, burning tokens while it should wait.
    if (m.state === 'stalled') return;

    // Watchdog: keep the parked overseer alive. It can exit on its own (full context / clean exit per
    // its prompt) and nothing else re-parks it mid-mission — without this its post-phase reviews and
    // prompt decisions silently stop. Idempotent: a no-op while it is still parked (or none configured).
    await this.d.overseer?.ensure(id, project.id, project.path);

    // Slots in use = this epic's own in-progress children — NOT all global orca- tmux
    // sessions (other projects/missions would otherwise starve this one).
    let running = kids.filter(t => t.status === 'in_progress').length;
    // Shared (non-PR) checkouts are single-writer: at most one agent edits project.path at a time, so
    // each phase's committed delta stays cleanly attributable (base..HEAD never straddles a neighbour's
    // commit, `git add -A` never sweeps in its edits). The occupied set is read FRESH at each claim
    // below (not snapshotted here) so a concurrent scheduler/engine tick's launch is always visible.
    const resolver = { projectPath: (pid: number) => this.d.projects.get(pid)?.path ?? '', worktreeFor: (mid: string) => this.d.missionGit?.worktreeFor(mid) };
    // readyForEpic returns only this epic's direct, dependency-cleared children — so a project with
    // several parallel missions no longer has each one walk every ready task in the project (#34/S15).
    for (const task of this.d.readiness.readyForEpic(m.epic_id)) {
      if (running >= m.max_sessions) break;
      // Autonomy gate: only L0 (Recommend) is hands-off — it just proposes the plan and spawns nothing.
      // L1–L3 dispatch work autonomously; they differ later, at how the deriver/overseer gate the
      // agent's permission prompts (L1 escalates more, L3 the least).
      if (m.autonomy === 'L0') continue;
      // In PR-native mode the agent runs inside the mission's isolated worktree, not the main checkout.
      const cwd = this.d.missionGit?.worktreeFor(id) ?? project.path;
      const spec = resolveExecutor(task.labels, this.d.fallback);
      const named = task.labels.find((l) => l.startsWith('agent:'))?.slice('agent:'.length);
      // A fresh name is picked clear of any live session, so a lingering worker (or the counter
      // resetting to 0 on a daemon restart) can never collide with `tmux new-session`. A re-spawn
      // of an already-named task reuses its name — its prior session is dead by the time we get here.
      // Resolve it BEFORE the claim below so the busy-check and the setStatus flip stay synchronous.
      const agentName = named || await freeAgentName(this.d.nameAgent, () => this.d.tmux.list());
      // A shared checkout already has a live agent → serialize: leave this phase open and retry next
      // tick. Every non-PR phase of this mission shares project.path, so none can start until it frees.
      // Read the occupied set FRESH here (not a tick-start snapshot) and AFTER the freeAgentName await:
      // the engine and scheduler tick concurrently, so another tick may have claimed this checkout while
      // we awaited above. The check + setStatus run synchronously below (no await between) → the
      // check-and-claim is atomic and a concurrent tick that re-reads in_progress can't double-occupy.
      if (checkoutBusy(resolver, this.d.tasks.list({ status: 'in_progress' }), cwd)) break;
      // Tag the agent BEFORE marking in_progress, so an in_progress child always carries its
      // agent label — otherwise a crash between the two writes would leave stopRunning unable to
      // find (and kill) the session.
      if (!named) this.d.tasks.setAgent(task.id, agentName);
      this.d.tasks.markStarted(task.id, this.d.clock.now()); // precise spawn time → correct usage attribution under concurrency
      this.d.tasks.setStatus(task.id, 'in_progress');
      // Read HEAD + stamp the baseline under the checkout lock so it lands AFTER any in-flight commit
      // (a just-closed phase still committing) — then `git diff base..HEAD` captures exactly this phase.
      await this.gitLock.run(cwd, async () => { const base = await projectHead(cwd); if (base) this.d.tasks.markBase(task.id, base); });
      try {
        await this.d.spawn.launch({ projectId: epic.project_id, projectPath: cwd, taskId: task.id, agentName, spec, taskTitle: task.title, taskDescription: task.description, resumeNote: task.resume_note ?? undefined, epicId: m.epic_id, resume: parseResumeLabel(task.labels), ownerId: resolveOwnerId(this.d, { taskId: task.id }) });
      } catch (e) {
        // Spawn failed (tmux down, bin missing): roll back to open so the task doesn't sit in_progress
        // with no agent — which would otherwise burn the stuck-detector's relaunch budget before it
        // ever really ran. Mirrors Scheduler's rollback. Skip running++ so a later tick retries it.
        this.d.tasks.setStatus(task.id, 'open');
        this.d.bus.publish({ type: 'task', taskId: task.id, status: 'open' });
        log.error(`spawn failed for task ${task.id} in mission ${id} — reverted to open`, e);
        continue;
      }
      running++;
      // Announce the claim so the web cache invalidates and the task shows as running — the scheduler
      // and manual launch both publish this; without it an engine-spawned phase sits in_progress in
      // the DB but never surfaces as live in /tasks until some later event happens to refresh it.
      this.d.bus.publish({ type: 'task', taskId: task.id, status: 'in_progress' });
    }

    // Stall: with nothing running and a blocked child present, the mission can't advance until a
    // human unblocks it — mark it 'stalled' so the UI reads "needs attention" rather than a misleading
    // "active". From here it freezes (see the early return above); the human action resumes it via
    // resumeStalled. We only reach this point on an active mission, so no un-stall branch is needed.
    // Re-fetch the children on purpose: the dispatch loop above may have just set one 'blocked'
    // (overseer denial), and that mutation isn't reflected in the pre-loop `kids` snapshot.
    const stalled = this.children(m.epic_id);
    if (running === 0 && stalled.some(t => t.status === 'blocked')) {
      this.d.missions.setState(id, 'stalled');
      this.d.bus.publish({ type: 'mission', missionId: id, state: 'stalled' });
    }
  }
}
