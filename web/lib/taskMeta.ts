import { ListChecks, Bug, Sparkles, Layers, Wrench, Circle, type LucideIcon } from 'lucide-react';
import type { Tone } from '../components/ui/tone';

/** Icon + label + tone per task type. HOST-owned rather than owned by the task views: the plugin UI
 *  runtime hands it to every bundle (`utils.taskTypeMeta`), so it must not live in a module that is
 *  itself on its way into a plugin — the contract would then depend on one of its own consumers. */
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
