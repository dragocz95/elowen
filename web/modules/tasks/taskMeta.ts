import { taskTypeMeta } from '../../lib/taskMeta';
import type { LocaleDict } from '../../lib/i18n/types';

// The type meta itself is HOST-owned (web/lib/taskMeta) because the plugin UI runtime hands it to every
// bundle. Re-exported here so this module's own views keep their single import while they still live in
// core; what stays below is the localized copy, which belongs to the views.
export { taskTypeMeta };

export const TASK_TYPES = ['task', 'feature', 'bug', 'chore', 'epic'] as const;
export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;

/** Localized label for a task status. Single source of truth (was duplicated ~8×). */
export function statusLabel(t: LocaleDict, status: string): string {
  const map: Record<string, string> = {
    open: t.tasks.statusOpen,
    in_progress: t.tasks.statusInProgress,
    blocked: t.tasks.statusBlocked,
    closed: t.tasks.statusClosed,
    cancelled: t.tasks.statusCancelled,
  };
  return map[status] ?? status;
}

/** Localized label for a task type (for selects/dropdowns). Falls back to the English meta label. */
export function taskTypeLabel(t: LocaleDict, type: string): string {
  const map: Record<string, string> = {
    task: t.tasks.typeTask,
    bug: t.tasks.typeBug,
    feature: t.tasks.typeFeature,
    epic: t.tasks.typeEpic,
    chore: t.tasks.typeChore,
  };
  return map[type] ?? taskTypeMeta(type).label;
}
