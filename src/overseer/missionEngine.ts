import type { TaskStore } from '../store/taskStore.js';
import type { Readiness } from '../store/readiness.js';
import type { MissionStore, Mission } from '../store/missionStore.js';
import type { SpawnService } from '../spawn/spawn.js';
import type { TmuxDriver } from '../tmux/types.js';
import type { AgentSpec } from '../spawn/commandBuilder.js';
import type { EventBus } from '../api/sse.js';
import { detectGuardrails, isCleared } from './guardrails.js';
import { resolveExecutor } from './routing.js';

export interface MissionEngineDeps {
  tasks: TaskStore; readiness: Readiness; missions: MissionStore;
  spawn: SpawnService; tmux: TmuxDriver; bus: EventBus;
  project: { id: number; path: string }; fallback: AgentSpec;
  nameAgent: () => string;
}

export class MissionEngine {
  constructor(private d: MissionEngineDeps) {}

  async engage(input: { epicId: string; autonomy: string; maxSessions: number; clearedGuardrails: string[] }): Promise<Mission> {
    const id = `m-${input.epicId}`;
    const m = this.d.missions.create({ id, epic_id: input.epicId, autonomy: input.autonomy, max_sessions: input.maxSessions, cleared_guardrails: input.clearedGuardrails });
    this.d.bus.publish({ type: 'mission', missionId: m.id, state: 'active' });
    await this.tick(id);
    return m;
  }

  isActive(id: string): boolean { return this.d.missions.get(id)?.state === 'active'; }

  async disengage(id: string): Promise<void> { this.d.missions.setState(id, 'disengaged'); this.d.bus.publish({ type: 'mission', missionId: id, state: 'disengaged' }); }

  private children(epicId: string) {
    return this.d.tasks.list({ project_id: this.d.project.id }).filter(t => t.parent_id === epicId && t.type !== 'epic');
  }

  async tick(id: string): Promise<void> {
    const m = this.d.missions.get(id); if (!m || m.state !== 'active') return;

    const kids = this.children(m.epic_id);
    if (kids.length > 0 && kids.every(t => t.status === 'closed' || t.status === 'cancelled')) {
      this.d.missions.setState(id, 'disengaged'); this.d.bus.publish({ type: 'mission', missionId: id, state: 'disengaged' }); return;
    }

    // Slots in use = this epic's own in-progress children — NOT all global orca- tmux
    // sessions (other projects/missions would otherwise starve this one).
    let running = kids.filter(t => t.status === 'in_progress').length;
    for (const task of this.d.readiness.ready(this.d.project.id)) {
      if (running >= m.max_sessions) break;
      if (task.parent_id !== m.epic_id) continue;
      const triggered = detectGuardrails(`${task.title} ${task.labels.join(' ')}`);
      const permitted = (m.autonomy === 'L3' || m.autonomy === 'L2') && isCleared(triggered, m.cleared_guardrails);
      if (!permitted) continue;
      const spec = resolveExecutor(task.labels, this.d.fallback);
      const named = task.labels.find((l) => l.startsWith('agent:'))?.slice('agent:'.length);
      this.d.tasks.setStatus(task.id, 'in_progress');
      await this.d.spawn.launch({ projectId: this.d.project.id, projectPath: this.d.project.path, taskId: task.id, agentName: named || this.d.nameAgent(), spec, taskTitle: task.title, taskDescription: task.description, epicId: m.epic_id });
      running++;
    }
  }
}
