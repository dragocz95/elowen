import type { Task, CreateTaskInput, TaskStatus } from './types.js';
import type { CommitFileChange } from '../integrations/projectFiles.js';
import type { TokenUsage } from '../integrations/usage/types.js';

/** THE task domain's shape, stated once as a type so the domain's OWNER can move without every consumer
 *  moving with it. Core keeps this file (a contract is not an implementation): the host seam and the
 *  `tasks` plugin control are both typed by it, the class implementing it may live in core today and in a
 *  plugin tomorrow, and a consumer written against it cannot tell which. `implements` on the concrete
 *  stores keeps the two in lockstep — a method added to the class but not here (or removed here while a
 *  caller still needs it) is a compile error, not a runtime surprise.
 *
 *  Deliberately the FULL surface rather than a hand-picked subset: the whole task workflow (stuck/nudge
 *  counters, resume notes, review-fix budgets, agent/exec binding, change snapshots) is grandfathered
 *  from the core era, and a re-spelled shorter interface would only drift from what callers really use. */
export interface TaskStoreContract {
  create(input: CreateTaskInput): Task;
  get(id: string): Task | null;
  list(filter?: { status?: TaskStatus; project_id?: number }): Task[];
  setStatus(id: string, status: TaskStatus): void;
  close(id: string, opts?: { summary?: string | null; outcome?: string | null }): void;
  update(id: string, patch: { title?: string; type?: string; priority?: string; description?: string; scheduled_at?: string | null; autostart?: number }): Task | null;
  delete(id: string): void;
  deleteEpic(epicId: string): { tasks: number };
  reparent(taskId: string, epicId: string): { task: Task } | { error: string };
  deleteAll(): { tasks: number; missions: number };
  listMissionIds(): string[];
  transaction<T>(fn: () => T): T;
  addDep(taskId: string, dependsOnId: string): boolean;
  setDeps(taskId: string, dependsOnIds: string[]): void;
  depsFor(taskId: string): string[];
  allDeps(): { task_id: string; depends_on_id: string }[];
  depsAmong(ids: string[]): { task_id: string; depends_on_id: string }[];
  children(parentId: string): Task[];
  descendants(rootId: string): Task[];
  setExec(id: string, exec: string): void;
  addLabel(id: string, label: string): void;
  removeLabel(id: string, label: string): void;
  setResumeLabel(id: string, program: string, sessionId: string): void;
  setResumeNote(id: string, note: string): void;
  setAgent(id: string, name: string): void;
  markStarted(id: string, ms: number): void;
  markBase(id: string, sha: string): void;
  saveChangedFiles(id: string, files: CommitFileChange[], base: string, head: string): void;
  bumpStuck(id: string): number;
  bumpNudge(id: string): number;
  bumpReviewFix(id: string): number;
  resetReviewFix(epicId: string): void;
}

/** Dependency-cleared open tasks — the scheduler / mission engine working set. */
export interface ReadinessContract {
  ready(projectId: number): Task[];
  readyForEpic(epicId: string): Task[];
}

/** Per-task token-usage snapshots, captured once when a task settles. */
export interface TaskUsageContract {
  record(taskId: string, projectId: number, exec: string, usage: TokenUsage): void;
  get(taskId: string): TokenUsage | null;
  aggregateByExec(projectIds?: number[], window?: { fromIso?: string; toIso?: string }): { exec: string; usage: TokenUsage }[];
  aggregateByDay(projectIds?: number[], days?: number): { day: string; tokens: number; cost: number | null }[];
  deleteAll(): number;
}
