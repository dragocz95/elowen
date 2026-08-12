import { resolvePrEnabled } from './prMode.js';
import type { AgentsPluginConfig } from '../config.js';
import type { AgentsPlanFlow, PluginHostConfig } from '../../../../src/plugins/api.js';
import type { Mission, PlanJob } from '../../../../src/shared/agentEvents.js';
import type { Task } from '../../../../src/store/types.js';
import type { MissionStore } from '../store/missionStore.js';

export interface PlanFlowDeps {
  tasks: { get(id: string): Task | null };
  missions: MissionStore;
  /** Host config: the global exec allow-list the overrides validate against. */
  config: PluginHostConfig;
  /** The plugin's own effective config (pilotExec backend choice, the global prEnabled default). */
  pluginConfig: () => AgentsPluginConfig;
  projects: { get(id: number): { pr_enabled?: boolean | null } | null };
  users: { list(): { id: number; is_admin: boolean }[]; allowedExecs(id: number): readonly string[] | null };
  engine: {
    engage(input: { epicId: string; autonomy: string; maxSessions: number; createdBy?: number | null; pilotExec?: string; overseerExec?: string; preserveReviewBudget?: boolean }): Promise<Mission>;
    isActive(id: string): boolean;
    tick(id: string): Promise<void>;
  };
  pilot: (job: PlanJob, projectPath: string) => Promise<void>;
}

/** The agents-side half of the plan/replan flow (see AgentsPlanFlow in the plugin API). The core
 *  routes keep the goal→epic+phases skeleton and call in here for every agents-domain decision, so
 *  the core plan path carries no mission/PR/pilot vocabulary of its own. */
export function createPlanFlow(d: PlanFlowDeps): AgentsPlanFlow {
  return {
    // Mirror the core execAllowedForUser semantics for the pilot/overseer overrides: the global
    // allow-list is the outer bound; a non-admin with a non-empty personal list is confined to it.
    execOverrideError(overrides, userId) {
      const allowed = d.config.get().allowedExecs;
      for (const o of overrides) {
        if (!o) continue;
        if (!allowed.includes(o)) return { error: 'exec not allowed', status: 400 };
        if (userId != null) {
          const u = d.users.list().find((x) => x.id === userId);
          if (u && !u.is_admin) {
            const personal = d.users.allowedExecs(userId) ?? [];
            if (personal.length > 0 && !personal.includes(o)) return { error: 'exec not allowed for user', status: 403 };
          }
        }
      }
      return null;
    },

    planPrMode(requested, maxSessions, projectId) {
      // Tri-state PR override: true (force on) / false (force off) / null (inherit project+global).
      let prEnabled = requested === true ? true : requested === false ? false : null;
      // Parallel sessions only materialise in isolated worktrees — a shared checkout is single-writer,
      // so a >1 max_sessions mission would silently serialize to one agent. Opting into parallelism
      // therefore auto-enables PR-native mode, unless the user explicitly turned it off.
      if (maxSessions > 1 && prEnabled === null) prEnabled = true;
      const isolated = resolvePrEnabled(prEnabled, d.projects.get(projectId)?.pr_enabled ?? null, d.pluginConfig().prEnabled);
      return { prEnabled, isolated };
    },

    pilotBackend(pilotExec) {
      return (pilotExec || d.pluginConfig().pilotExec) ? d.pilot : null;
    },

    planLabels() {
      return {
        // A per-task PR override rides as a `pr:on`/`pr:off` epic label (missionGit reads it first,
        // before the project/global default). Only stamped on a fresh epic — a replan never flips it.
        epic: (prEnabled) => prEnabled === true ? ['pr:on'] : prEnabled === false ? ['pr:off'] : [],
        // Agent names double as tmux session names AND as the janitor/deriver's session↔task key, so
        // the "one agent name ↔ one task" invariant is load-bearing. The pilot (an LLM) can hand the
        // same name to several phases; honour each only while it's still free (across the epic's
        // existing tasks and this batch), else drop it so the engine assigns a fresh unique name via
        // freeAgentName at spawn.
        phaseLabeler: (existing) => {
          const used = new Set(existing.flatMap((t) => t.labels.filter((l) => l.startsWith('agent:')).map((l) => l.slice('agent:'.length))));
          return (agent) => {
            if (!agent || used.has(agent)) return [];
            used.add(agent);
            return [`agent:${agent}`];
          };
        },
      };
    },

    async planEngage(job, epicId) {
      if (job.engage) {
        return d.engine.engage({
          epicId, autonomy: job.engage.autonomy, maxSessions: job.engage.maxSessions,
          preserveReviewBudget: job.engage.preserveReviewBudget, createdBy: job.createdBy,
          pilotExec: job.pilotExec, overseerExec: job.overseerExec,
        });
      }
      const missionId = `m-${epicId}`;
      if (d.engine.isActive(missionId)) await d.engine.tick(missionId); // replan into a live mission
      return undefined;
    },

    replanContext(epicId) {
      const epic = d.tasks.get(epicId);
      // The PR mode is frozen in the epic's labels at plan time — a replan must never flip it.
      const prEnabled = epic?.labels.includes('pr:on') ? true : epic?.labels.includes('pr:off') ? false : null;
      const projectPr = epic ? d.projects.get(epic.project_id)?.pr_enabled ?? null : null;
      const isolated = resolvePrEnabled(prEnabled, projectPr, d.pluginConfig().prEnabled);
      const mission = d.missions.get(`m-${epicId}`);
      return {
        prEnabled, isolated,
        maxSessions: mission?.max_sessions ?? 1,
        pilotExec: mission?.pilot_exec || undefined,
        overseerExec: mission?.overseer_exec || undefined,
      };
    },
  };
}
