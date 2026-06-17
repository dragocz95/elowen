'use client';
import type { Task, TaskStatus } from '../../lib/types';
import { Badge } from '../../components/ui/Badge';
import { statusTone } from '../dashboard/statusTone';
import { taskTypeMeta } from '../tasks/taskMeta';
import { groupByStatus } from './groupByStatus';

const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: 'open', label: 'Open' },
  { status: 'in_progress', label: 'In progress' },
  { status: 'blocked', label: 'Blocked' },
  { status: 'closed', label: 'Closed' },
  { status: 'cancelled', label: 'Cancelled' },
];

export function KanbanBoard({ tasks, onMove, onSelect }: { tasks: Task[]; onMove: (taskId: string, status: TaskStatus) => void; onSelect?: (t: Task) => void }) {
  const groups = groupByStatus(tasks);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return (
    <div className="flex gap-3 overflow-x-auto">
      {COLUMNS.map((col) => (
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
            <span>{col.label}</span>
            <span>{groups[col.status].length}</span>
          </header>
          {groups[col.status].map((task) => {
            const Icon = taskTypeMeta(task.type).icon;
            return (
              <div
                key={task.id}
                draggable
                onDragStart={(e) => e.dataTransfer.setData('text/plain', task.id)}
                onClick={() => onSelect?.(task)}
                className="flex cursor-grab flex-col gap-1.5 rounded-md border border-border bg-bg p-2.5 transition-colors hover:border-border-strong"
              >
                <div className="flex items-start gap-2">
                  <Icon size={14} className="mt-0.5 shrink-0 text-text-muted" aria-hidden />
                  <span className="min-w-0 text-sm text-text">{task.title}</span>
                </div>
                {task.description?.trim() ? <span className="truncate pl-6 text-[11px] text-text-muted">{task.description.trim()}</span> : null}
                <div className="flex items-center justify-between gap-2 pl-6">
                  <span className="font-mono text-[11px] text-text-muted">{task.id}</span>
                  <Badge tone={statusTone(task.status)}>{task.status}</Badge>
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
