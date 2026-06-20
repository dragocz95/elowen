'use client';
import { Fragment } from 'react';
import { ChevronRight } from 'lucide-react';
import type { MissionTask, MissionDeps } from '../../lib/types';
import { layoutPhases } from './layoutPhases';
import { isFailGate, isTerminal } from './missionUtils';
import { taskTypeMeta, statusLabel } from '../tasks/taskMeta';
import { TaskUsageBadge } from '../../components/ui/TaskUsageBadge';
import { useTranslation } from '../../lib/i18n';

const STATUS_COLOR: Record<string, string> = {
  closed: 'var(--color-success)', in_progress: 'var(--color-info)', blocked: 'var(--color-error)',
  cancelled: 'var(--color-cancelled)', open: 'var(--color-cancelled)',
};

/** Horizontal flow of a mission's phases as pills that auto-shrink to fit the available width
 *  (flex-1 / basis-0 / truncate) — no horizontal scrollbar. Ordered topologically; connectors
 *  between sequential phases. Running phases show their live token usage. */
export function TaskFlow({ tasks, deps, selectedId, onSelect }: {
  tasks: MissionTask[];
  deps: MissionDeps[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const ordered = layoutPhases(tasks, deps).flat(); // topological order
  const byId = new Map(tasks.map((task) => [task.id, task]));

  const depsByTask = new Map<string, string[]>();
  for (const d of deps) {
    if (byId.has(d.taskId) && byId.has(d.dependsOnId)) {
      const list = depsByTask.get(d.taskId) ?? [];
      list.push(d.dependsOnId);
      depsByTask.set(d.taskId, list);
    }
  }
  const ready = (task: MissionTask) => task.status === 'open' && (depsByTask.get(task.id) ?? []).every((id) => isTerminal(byId.get(id)?.status ?? 'open'));
  const gated = (task: MissionTask) => (depsByTask.get(task.id) ?? []).some((id) => { const dep = byId.get(id); return dep ? isFailGate(dep) : false; });

  return (
    <div className="flex items-stretch gap-1">
      {ordered.map((task, i) => {
        const running = task.status === 'in_progress';
        const isReady = ready(task);
        const isGated = gated(task);
        const Icon = taskTypeMeta(task.type).icon;
        const color = STATUS_COLOR[task.status] ?? 'var(--color-cancelled)';
        const border = isGated ? 'var(--color-danger)' : running || isReady ? 'var(--color-info)' : selectedId === task.id ? 'var(--color-accent)' : 'var(--color-border)';
        const locked = task.status === 'open' && !isReady;
        return (
          <Fragment key={task.id}>
            {i > 0 ? <ChevronRight size={14} className="shrink-0 self-center text-text-muted" aria-hidden /> : null}
            <button
              type="button"
              onClick={() => onSelect(task.id)}
              title={task.title}
              className={`group flex min-w-0 flex-1 basis-0 flex-col gap-1 rounded-lg border bg-surface px-2.5 py-2 text-left transition-colors hover:bg-elevated ${selectedId === task.id ? 'bg-accent/[0.06]' : ''}`}
              style={{ borderColor: border, borderWidth: running || isReady || isGated || selectedId === task.id ? 1.5 : 1, opacity: locked ? 0.6 : 1 }}
            >
              <div className="flex min-w-0 items-center gap-1.5">
                <span className={`h-2 w-2 shrink-0 rounded-full ${running ? 'live-dot' : ''}`} style={{ backgroundColor: color, ['--live-ring' as string]: 'color-mix(in srgb, var(--color-info) 50%, transparent)' }} aria-hidden />
                <Icon size={12} className="shrink-0 text-text-muted" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-text">{task.title}</span>
                {isGated ? <span className="shrink-0 text-[10px] font-bold text-danger" title={t.missions.failGate}>!</span> : null}
              </div>
              <div className="flex min-w-0 items-center justify-between gap-1">
                <span className="truncate text-tiny capitalize text-text-muted">{isReady ? t.tasks.statusOpen : statusLabel(t, task.status)}</span>
                {running ? <TaskUsageBadge taskId={task.id} live /> : null}
              </div>
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}
