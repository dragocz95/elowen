import type { ElowenEvent } from './sse.js';

/** Lookups needed to resolve an event's owning project. Each returns the project id or null when the
 *  referenced row is gone (events outlive their tasks/jobs), so resolution always fails safe. */
export interface EventProjectDeps {
  /** project_id of a task/epic by its id */
  taskProject(taskId: string): number | null;
  /** Plugin-contributed resolvers (read from the live registry, so a reload swaps them), consulted only
   *  when the core lookups above yielded nothing. First non-null wins. The agents plugin's resolver is
   *  the SOLE source for `signal`/`plan` tenancy — absent (plugin disabled) those events resolve null,
   *  which every caller treats as admin-only (fail closed). */
  pluginResolvers?(): readonly ((e: ElowenEvent) => number | null)[];
}

/** The project an event belongs to, or null when it has no project (or its row is gone). Single source
 *  of truth shared by the activity-log stamping (persisted rows) and the live SSE per-subscriber gate,
 *  so both scope identically. A null result is treated as "admin-only" by callers — fail closed. */
export function eventProjectId(e: ElowenEvent, d: EventProjectDeps): number | null {
  // A plugin event carries its tenancy from its publisher — authoritative, including null (admin-only).
  // Resolvers must not widen it: they exist for core-shaped events whose lookup moved into a plugin.
  if (e.type === 'plugin') return e.projectId;
  const core = coreEventProjectId(e, d);
  if (core !== null) return core;
  // Core could not place the event — let a plugin try (e.g. an extracted subsystem resolving its own
  // session naming). A throwing resolver is skipped: tenancy fails CLOSED, it never crashes the bus.
  for (const resolve of d.pluginResolvers?.() ?? []) {
    try {
      const pid = resolve(e);
      if (pid !== null) return pid;
    } catch { /* fail closed for this resolver */ }
  }
  return null;
}

function coreEventProjectId(e: Exclude<ElowenEvent, { type: 'plugin' }>, d: EventProjectDeps): number | null {
  switch (e.type) {
    case 'task':
    case 'review':
    case 'decision':
    case 'message':
    case 'ask':
    case 'change':
      return d.taskProject(e.taskId);
    case 'mission': {
      // A mission id is `m-<epicId>`; the epic carries the project. Strip the prefix to reach it.
      const epicId = e.missionId.startsWith('m-') ? e.missionId.slice(2) : e.missionId;
      return d.taskProject(epicId);
    }
    case 'signal':
      // Session→project lives in the agents plugin's resolver (agent:<name> label / mission epic).
      return null;
    case 'plan':
      // A plan job knows its target project up front; once the epic exists, resolve via it directly.
      // Before that, the job record lives in the agents plugin's runtime — its resolver answers.
      return e.epicId ? d.taskProject(e.epicId) : null;
    case 'memory':
      // Memories are scoped by owner, not by project. The SSE gate handles this event by user id before
      // reaching here; null keeps it out of the project-scoped activity log.
      return null;
  }
}
