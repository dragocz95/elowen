'use client';
import { useState } from 'react';
import { Circle, LoaderCircle, Ban, CheckCircle2, XCircle, type LucideIcon } from 'lucide-react';
import type { Task, TaskStatus } from '../../lib/types';
import { groupByStatus } from './groupByStatus';
import { epicChildren, phaseIds } from '../../lib/taskTree';
import { KanbanCard } from './KanbanCard';
import { KanbanEpicCard } from './KanbanEpicCard';
import { useTranslation } from '../../lib/i18n';

const COLUMNS: { status: TaskStatus; labelKey: string; icon: LucideIcon; color: string }[] = [
  { status: 'open', labelKey: 'columnOpen', icon: Circle, color: 'var(--color-success)' },
  { status: 'in_progress', labelKey: 'columnInProgress', icon: LoaderCircle, color: 'var(--color-warning)' },
  { status: 'blocked', labelKey: 'columnBlocked', icon: Ban, color: 'var(--color-error)' },
  { status: 'closed', labelKey: 'columnClosed', icon: CheckCircle2, color: 'var(--color-error)' },
  { status: 'cancelled', labelKey: 'columnCancelled', icon: XCircle, color: 'var(--color-cancelled)' },
];

export function KanbanBoard({ tasks, onMove, onSelect, blockedBy }: { tasks: Task[]; onMove: (taskId: string, status: TaskStatus) => void; onSelect?: (t: Task) => void; blockedBy?: Map<string, Task[]> }) {
  const { t } = useTranslation();
  const STATUS_LABEL: Record<string, string> = { open: t.tasks.statusOpen, in_progress: t.tasks.statusInProgress, blocked: t.tasks.statusBlocked, closed: t.tasks.statusClosed, cancelled: t.tasks.statusCancelled };
  const groups = groupByStatus(tasks);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const childMap = epicChildren(tasks);
  const phaseSet = phaseIds(tasks);
  const [dragOver, setDragOver] = useState<TaskStatus | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // Autopilot epics start collapsed so their phases don't flood the board.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleEpic = (id: string) => setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
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
            // Autopilot epic → collapsible container; its phases stay hidden until expanded.
            if (task.type === 'epic' && childMap.has(task.id)) {
              return <KanbanEpicCard key={task.id} epic={task} phases={childMap.get(task.id) ?? []} expanded={expanded.has(task.id)} onToggle={() => toggleEpic(task.id)} />;
            }
            const isPhase = phaseSet.has(task.id);
            if (isPhase && !(task.parent_id && expanded.has(task.parent_id))) return null;
            const blockers = blockedBy?.get(task.id) ?? [];
            return (
              <KanbanCard
                key={task.id}
                task={task}
                isPhase={isPhase}
                blocked={blockers.length > 0}
                blockers={blockers}
                dragging={draggingId === task.id}
                statusLabel={STATUS_LABEL[task.status] ?? task.status}
                onSelect={onSelect}
                onDragStart={(e) => { e.dataTransfer.setData('text/plain', task.id); setDraggingId(task.id); }}
                onDragEnd={() => { setDraggingId(null); setDragOver(null); }}
              />
            );
          })}
        </div>
      );
    })}
    </div>
  );
}
