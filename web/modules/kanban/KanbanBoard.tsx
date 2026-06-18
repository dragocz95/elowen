'use client';
import { Link2 } from 'lucide-react';
import type { Task, TaskStatus } from '../../lib/types';
import { Badge } from '../../components/ui/Badge';
import { statusTone } from '../dashboard/statusTone';
import { taskTypeMeta } from '../tasks/taskMeta';
import { groupByStatus } from './groupByStatus';
import { useTranslation } from '../../lib/i18n';

const COLUMNS: { status: TaskStatus; labelKey: string }[] = [
  { status: 'open', labelKey: 'columnOpen' },
  { status: 'in_progress', labelKey: 'columnInProgress' },
  { status: 'blocked', labelKey: 'columnBlocked' },
  { status: 'closed', labelKey: 'columnClosed' },
  { status: 'cancelled', labelKey: 'columnCancelled' },
];

export function KanbanBoard({ tasks, onMove, onSelect, blockedIds }: { tasks: Task[]; onMove: (taskId: string, status: TaskStatus) => void; onSelect?: (t: Task) => void; blockedIds?: Set<string> }) {
  const { t } = useTranslation();
  const STATUS_LABEL: Record<string, string> = { open: t.tasks.statusOpen, in_progress: t.tasks.statusInProgress, blocked: t.tasks.statusBlocked, closed: t.tasks.statusClosed, cancelled: t.tasks.statusCancelled };
  const groups = groupByStatus(tasks);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return (
    <div className="flex gap-3 overflow-x-auto">
      {COLUMNS.map((col) => {
        const colLabel = t.kanban[col.labelKey as keyof typeof t.kanban] as string;
        return (
        <div
          key={col.status}
          data-testid={`column-${col.status}`}
          className="flex min-w-[14rem] flex-1 flex-col gap-2 rounded-lg border border-border bg-surface p-2"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const id = e.dataTransfer.getData('text/plain');
            if (id && byId.get(id)?.status !== col.status) onMove(id, col.status);
          }}
        >
          <header className="flex items-center justify-between px-1 font-mono uppercase tracking-widest text-text-muted" style={{ fontSize: 'var(--text-caption)' }}>
            <span>{colLabel}</span>
            <span>{groups[col.status].length}</span>
          </header>
          {groups[col.status].map((task) => {
            const Icon = taskTypeMeta(task.type).icon;
            const blocked = blockedIds?.has(task.id) ?? false;
            return (
              <div
                key={task.id}
                draggable={!blocked}
                onDragStart={(e) => { if (blocked) { e.preventDefault(); return; } e.dataTransfer.setData('text/plain', task.id); }}
                onClick={() => onSelect?.(task)}
                className={`flex flex-col gap-1.5 rounded-md border bg-bg p-2.5 transition-colors ${blocked ? 'cursor-pointer border-danger/40' : 'cursor-grab border-border hover:border-border-strong'}`}
              >
                <div className="flex items-start gap-2">
                  <Icon size={14} className="mt-0.5 shrink-0 text-text-muted" aria-hidden />
                  <span className="min-w-0 text-sm text-text">{task.title}</span>
                  {blocked ? <span className="live-dot ml-auto shrink-0 text-danger" style={{ ['--live-ring' as string]: 'rgba(239,68,68,0.5)' }} title={t.kanban.blockedDeps}><Link2 size={13} aria-hidden /></span> : null}
                </div>
                {task.description?.trim() ? <span className="truncate pl-6 text-[11px] text-text-muted">{task.description.trim()}</span> : null}
                <div className="flex items-center justify-between gap-2 pl-6">
                  <span className="font-mono text-[11px] text-text-muted">{task.id}</span>
                  <Badge tone={statusTone(task.status)}>{STATUS_LABEL[task.status] ?? task.status}</Badge>
                </div>
              </div>
            );
          })}
        </div>
      );
    })}
    </div>
  );
}
