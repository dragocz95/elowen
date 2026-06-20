import { ListChecks, Bug, Sparkles, Layers, Wrench, Circle, type LucideIcon } from 'lucide-react';
import type { Tone } from '../../components/ui/tone';
import type { LocaleDict } from '../../lib/i18n/types';

export interface TaskTypeMeta { icon: LucideIcon; label: string; tone: Tone }

const MAP: Record<string, TaskTypeMeta> = {
  task: { icon: ListChecks, label: 'Task', tone: 'default' },
  bug: { icon: Bug, label: 'Bug', tone: 'danger' },
  feature: { icon: Sparkles, label: 'Feature', tone: 'accent' },
  epic: { icon: Layers, label: 'Epic', tone: 'accent' },
  chore: { icon: Wrench, label: 'Chore', tone: 'muted' },
};

/** Icon + label + tone for a task type. Unknown types fall back to a neutral circle. */
export function taskTypeMeta(type?: string): TaskTypeMeta {
  return MAP[type ?? 'task'] ?? { icon: Circle, label: type ?? 'Task', tone: 'default' };
}

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
