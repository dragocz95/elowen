'use client';
import { useState } from 'react';
import { Link2, Circle, LoaderCircle, Ban, CheckCircle2, XCircle, type LucideIcon } from 'lucide-react';
import type { Task, TaskStatus } from '../../lib/types';
import { Badge } from '../../components/ui/Badge';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { statusTone } from '../dashboard/statusTone';
import { taskTypeMeta } from '../tasks/taskMeta';
import { taskExec } from '../../lib/taskExec';
import { useConfig } from '../../lib/queries';
import { groupByStatus } from './groupByStatus';
import { useTranslation } from '../../lib/i18n';

const COLUMNS: { status: TaskStatus; labelKey: string; icon: LucideIcon; color: string }[] = [
  { status: 'open', labelKey: 'columnOpen', icon: Circle, color: 'var(--color-success)' },
  { status: 'in_progress', labelKey: 'columnInProgress', icon: LoaderCircle, color: 'var(--color-warning)' },
  { status: 'blocked', labelKey: 'columnBlocked', icon: Ban, color: 'var(--color-error)' },
  { status: 'closed', labelKey: 'columnClosed', icon: CheckCircle2, color: 'var(--color-error)' },
  { status: 'cancelled', labelKey: 'columnCancelled', icon: XCircle, color: 'var(--color-cancelled)' },
];

export function KanbanBoard({ tasks, onMove, onSelect, blockedIds }: { tasks: Task[]; onMove: (taskId: string, status: TaskStatus) => void; onSelect?: (t: Task) => void; blockedIds?: Set<string> }) {
  const { t } = useTranslation();
  const { data: config } = useConfig();
  const STATUS_LABEL: Record<string, string> = { open: t.tasks.statusOpen, in_progress: t.tasks.statusInProgress, blocked: t.tasks.statusBlocked, closed: t.tasks.statusClosed, cancelled: t.tasks.statusCancelled };
  const groups = groupByStatus(tasks);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const [dragOver, setDragOver] = useState<TaskStatus | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  return (
    <div className="flex gap-3 overflow-x-auto">
      {COLUMNS.map((col) => {
        const colLabel = t.kanban[col.labelKey as keyof typeof t.kanban] as string;
        const isDropTarget = dragOver === col.status;
        return (
        <div
          key={col.status}
          data-testid={`column-${col.status}`}
          className={`flex min-w-[14rem] flex-1 flex-col gap-2 rounded-lg border bg-surface p-2 transition-colors ${isDropTarget ? 'border-accent/60 bg-elevated/40' : 'border-border'}`}
          onDragOver={(e) => { e.preventDefault(); if (dragOver !== col.status) setDragOver(col.status); }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver((s) => (s === col.status ? null : s)); }}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(null); setDraggingId(null);
            const id = e.dataTransfer.getData('text/plain');
            if (id && byId.get(id)?.status !== col.status) onMove(id, col.status);
          }}
        >
          <header className="flex items-center justify-between px-1 font-mono uppercase tracking-widest text-text-muted" style={{ fontSize: 'var(--text-caption)' }}>
            <span className="flex items-center gap-1.5"><col.icon size={12} style={{ color: col.color }} aria-hidden />{colLabel}</span>
            <span>{groups[col.status].length}</span>
          </header>
          {groups[col.status].map((task) => {
            const Icon = taskTypeMeta(task.type).icon;
            const iconExec = taskExec(task.labels) || config?.defaults?.exec || '';
            const blocked = blockedIds?.has(task.id) ?? false;
            return (
              <div
                key={task.id}
                draggable={!blocked}
                onDragStart={(e) => { if (blocked) { e.preventDefault(); return; } e.dataTransfer.setData('text/plain', task.id); setDraggingId(task.id); }}
                onDragEnd={() => { setDraggingId(null); setDragOver(null); }}
                onClick={() => onSelect?.(task)}
                className={`flex gap-2.5 rounded-md border bg-bg p-2.5 transition-all ${blocked ? 'cursor-pointer border-danger/40' : 'cursor-grab border-border hover:border-border-strong'} ${draggingId === task.id ? 'rotate-[1deg] opacity-50' : ''}`}
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-elevated">
                  {iconExec ? <ModelIcon name={iconExec} size={19} /> : <Icon size={16} className="text-text-muted" aria-hidden />}
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <div className="flex items-start gap-2">
                    <span className="min-w-0 text-sm text-text">{task.title}</span>
                    {blocked ? <span className="live-dot ml-auto shrink-0 text-danger" style={{ ['--live-ring' as string]: 'color-mix(in srgb, var(--color-error) 50%, transparent)' }} title={t.kanban.blockedDeps}><Link2 size={13} aria-hidden /></span> : null}
                  </div>
                  {task.description?.trim() ? <span className="truncate text-[11px] text-text-muted">{task.description.trim()}</span> : null}
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 font-mono text-[11px] text-text-muted"><Icon size={11} className="shrink-0" aria-hidden />{task.id}</span>
                    <Badge tone={statusTone(task.status)}>{STATUS_LABEL[task.status] ?? task.status}</Badge>
                  </div>
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
