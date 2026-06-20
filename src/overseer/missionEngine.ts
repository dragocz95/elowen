import type { TaskStore } from '../store/taskStore.js';
import type { Readiness } from '../store/readiness.js';
import type { MissionStore, Mission } from '../store/missionStore.js';
import type { SpawnService } from '../spawn/spawn.js';
import type { TmuxDriver } from '../tmux/types.js';
import type { AgentSpec } from '../spawn/commandBuilder.js';
import type { EventBus } from '../api/sse.js';
import { detectGuardrails, isCleared } from './guardrails.js';
import { resolveExecutor } from './routing.js';
import type { TaskContext } from './decision.js';
import type { OverseerController } from './overseerAgent.js';
import type { Clock } from '../shared/clock.js';

export interface MissionEngineDeps {
  tasks: TaskStore; readiness: Readiness; missions: MissionStore;
  spawn: SpawnService; tmux: TmuxDriver; bus: EventBus;
  /** Resolves a mission's project from its epic's project_id — the engine is project-agnostic and
   *  drives missions across every registered project, not a single fixed one. */
  projects: { get(id: number): { id: number; path: string } | null };
  fallback: AgentSpec;
  nameAgent: () => string; clock: Clock;
  /** Optional overseer gate consulted before dispatching a guardrail-triggering task. When it
   *  returns approve=false (or destructive), the task is escalated (set `blocked`) instead of
   *  spawned. Absent (no relay configured) → unchanged boolean guardrail behaviour. The `missionId`
   *  lets a queue-backed implementation route the decision to this mission's parked overseer agent. */
  decideTask?: (missionId: string, input: TaskContext) => Promise<{ approve: boolean; destructive: boolean }>;
  /** Optional parked-overseer lifecycle. Started on engage, stopped on pause/disengage. Absent (or
   *  inert when no overseerExec is configured) → relay-fallback decisions, no parked agent. */
  overseer?: OverseerController;
}

export class MissionEngine {
  constructor(private d: MissionEngineDeps) {}

  async engage(input: { epicId: string; autonomy: string; maxSessions: number; clearedGuardrails: string[] }): Promise<Mission> {
    const id = `m-${input.epicId}`;
    const m = this.d.missions.create({ id, epic_id: input.epicId, autonomy: input.autonomy, max_sessions: input.maxSessions, cleared_guardrails: input.clearedGuardrails });
    this.d.bus.publish({ type: 'mission', missionId: m.id, state: 'active' });
    // Park the per-mission overseer agent (no-op when no overseerExec is configured) so it is ready
    // to answer decisions before the first guardrail task dispatches.
    const epic = this.d.tasks.get(input.epicId);
    const project = epic ? this.d.projects.get(epic.project_id) : null;
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

  async disengage(id: string): Promise<void> {
    const m = this.d.missions.get(id);
    if (!m || m.state === 'disengaged') return; // idempotent: a repeat call must not re-publish the event
    await this.stopRunning(m.epic_id);
    await this.markDisengaged(id);
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

  async pause(id: string): Promise<void> {
    const m = this.d.missions.get(id);
    if (!m || m.state === 'paused') return; // idempotent: a repeat call must not re-publish the event
    await this.stopRunning(m.epic_id);
    this.d.missions.setState(id, 'paused');
    this.d.bus.publish({ type: 'mission', missionId: id, state: 'paused' });
    await this.d.overseer?.stop(id); // a paused mission keeps no parked overseer; resume restarts it
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
    if (project) await this.d.overseer?.start(id, project.id, project.path);
    await this.tick(id);
  }

  // Epic ids are globally unique, so children resolve by parent_id alone — no project scoping needed.
  // An epic's own parent_id is never its own id, so no `type !== 'epic'` filter is needed.
  private children(epicId: string) {
    return this.d.tasks.list().filter(t => t.parent_id === epicId);
  }

  async tick(id: string): Promise<void> {
    const m = this.d.missions.get(id); if (!m || (m.state !== 'active' && m.state !== 'stalled')) return;
    // The mission's project is wherever its epic lives — resolve it per tick.
    const epic = this.d.tasks.get(m.epic_id); if (!epic) return;
    const project = this.d.projects.get(epic.project_id);
    if (!project) {
      // A live epic whose project row is gone is an invariant violation; surface it instead of
      // silently no-opping every tick forever (the mission would otherwise look active but stuck).
      console.error(`[orca] mission ${id}: project ${epic.project_id} not found for epic ${epic.id} — cannot tick`);
      return;
    }

    const kids = this.children(m.epic_id);
    if (kids.length > 0 && kids.every(t => t.status === 'closed' || t.status === 'cancelled')) {
      await this.markDisengaged(id); return; // also tears down the parked overseer (no leak on self-completion)
    }

    // Slots in use = this epic's own in-progress children — NOT all global orca- tmux
    // sessions (other projects/missions would otherwise starve this one).
    let running = kids.filter(t => t.status === 'in_progress').length;
    // readyForEpic returns only this epic's direct, dependency-cleared children — so a project with
    // several parallel missions no longer has each one walk every ready task in the project (#34/S15).
    for (const task of this.d.readiness.readyForEpic(m.epic_id)) {
      if (running >= m.max_sessions) break;
      const triggered = detectGuardrails(`${task.title} ${task.labels.join(' ')}`);
      const permitted = (m.autonomy === 'L3' || m.autonomy === 'L2') && isCleared(triggered, m.cleared_guardrails);
      if (!permitted) continue;
      // Overseer LLM gate: for guardrail-triggering tasks, consult the relay (when wired) before
      // dispatch. A denial — or a destructive verdict — escalates the task to a human (set
      // `blocked`, excluded from readiness) rather than spawning, halting the mission until a
      // human intervenes. The boolean clearance above is necessary; this is an extra safety net.
      if (triggered.length > 0 && this.d.decideTask) {
        const verdict = await this.d.decideTask(m.id, { title: task.title, description: task.description, labels: task.labels, guardrails: triggered, autonomy: m.autonomy });
        if (!verdict.approve || verdict.destructive) {
          this.d.tasks.setStatus(task.id, 'blocked');
          this.d.bus.publish({ type: 'task', taskId: task.id, status: 'blocked' });
          continue;
        }
      }
      const spec = resolveExecutor(task.labels, this.d.fallback);
      const named = task.labels.find((l) => l.startsWith('agent:'))?.slice('agent:'.length);
      const agentName = named || this.d.nameAgent();
      // Tag the agent BEFORE marking in_progress, so an in_progress child always carries its
      // agent label — otherwise a crash between the two writes would leave stopRunning unable to
      // find (and kill) the session.
      if (!named) this.d.tasks.setAgent(task.id, agentName);
      this.d.tasks.markStarted(task.id, this.d.clock.now()); // precise spawn time → correct usage attribution under concurrency
      this.d.tasks.setStatus(task.id, 'in_progress');
      await this.d.spawn.launch({ projectId: epic.project_id, projectPath: project.path, taskId: task.id, agentName, spec, taskTitle: task.title, taskDescription: task.description, epicId: m.epic_id });
      running++;
    }

    // Stall vs resume: with nothing running and a blocked child present, the mission can't advance
    // until a human unblocks it — mark it 'stalled' so the UI reads "needs attention" rather than a
    // misleading "active". The overseer keeps ticking stalled missions (missions.live()), so once
    // the blocker clears and work resumes (running > 0), it flips back to 'active'. Re-fetch the
    // children here on purpose: the dispatch loop above may have just set one 'blocked' (overseer
    // denial), and that mutation isn't reflected in the pre-loop `kids` snapshot.
    const stalled = this.children(m.epic_id);
    if (running === 0 && stalled.some(t => t.status === 'blocked')) {
      if (m.state !== 'stalled') { this.d.missions.setState(id, 'stalled'); this.d.bus.publish({ type: 'mission', missionId: id, state: 'stalled' }); }
    } else if (m.state === 'stalled') {
      this.d.missions.setState(id, 'active'); this.d.bus.publish({ type: 'mission', missionId: id, state: 'active' });
    }
  }
}
