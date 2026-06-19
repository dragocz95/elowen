'use client';
import { Link2, Clock } from 'lucide-react';
import type { Task } from '../../lib/types';
import { Badge } from '../../components/ui/Badge';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { AgentStatusDot } from '../../components/ui/AgentStatusDot';
import { AgentIdentityStrip } from '../../components/ui/AgentIdentityStrip';
import { TaskContextLine } from '../../components/ui/TaskContextLine';
import { OutcomeBadge } from '../../components/ui/OutcomeBadge';
import { statusTone } from '../dashboard/statusTone';
import { taskTypeMeta } from '../tasks/taskMeta';
import { taskExec } from '../../lib/taskExec';
import { taskSessionName } from '../../lib/agentUtils';
import { formatTaskTime } from '../../lib/formatTime';
import { useConfig, useSessions, useSessionSignal } from '../../lib/queries';
import { useSessionStall } from '../../lib/useSessionStall';
import { useTranslation } from '../../lib/i18n';

/** Enriched kanban card: model icon, live-state dot, agent identity, context line, outcome. */
export function KanbanCard({ task, blocked, blockers, dragging, statusLabel, isPhase = false, onSelect, onDragStart, onDragEnd }: {
  task: Task;
  blocked: boolean;
  blockers: Task[];
  dragging: boolean;
  statusLabel: string;
  isPhase?: boolean;
  onSelect?: (t: Task) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}) {
  const { t, locale } = useTranslation();
  const { data: config } = useConfig();
  const sessions = useSessions();
  const sessionName = taskSessionName(task);
  const live = task.status === 'in_progress' && !!sessionName && (sessions.data ?? []).includes(sessionName);
  const signal = useSessionSignal(sessionName ?? '');
  const stall = useSessionStall(sessionName ?? '', live && !!sessionName);
  const exec = taskExec(task.labels) || config?.defaults?.exec || '';
  const TypeIcon = taskTypeMeta(task.type).icon;
  const isClosed = task.status === 'closed' || task.status === 'cancelled';

  return (
    <div
      draggable={!blocked}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={() => onSelect?.(task)}
      className={`flex gap-2.5 rounded-md border bg-bg p-2.5 transition-all ${blocked ? 'cursor-pointer border-danger/40' : 'cursor-grab border-border hover:border-border-strong'} ${isPhase ? 'ml-2 border-l-2 border-l-accent/40' : ''} ${dragging ? 'rotate-[1deg] opacity-50' : ''}`}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-elevated">
        {exec ? <ModelIcon name={exec} size={19} /> : <TypeIcon size={16} className="text-text-muted" aria-hidden />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-start gap-2">
          <span className="min-w-0 flex-1 text-sm text-text">{task.title}</span>
          {blocked
            ? <span className="live-dot shrink-0 text-danger" style={{ ['--live-ring' as string]: 'color-mix(in srgb, var(--color-error) 50%, transparent)' }} title={t.kanban.blockedDeps}><Link2 size={13} aria-hidden /></span>
            : <span className="mt-1.5"><AgentStatusDot signal={signal} live={live} stall={stall.state} silenceSec={stall.silenceSec} /></span>}
        </div>
        <AgentIdentityStrip task={task} />
        <TaskContextLine task={task} sessionName={live ? sessionName : null} blockers={blockers} />
        <div className="flex items-center justify-between gap-2 pt-0.5">
          <span className="truncate font-mono text-[11px] text-text-muted">{task.id}</span>
          <div className="flex shrink-0 items-center gap-1.5">
            {(() => { const w = formatTaskTime(task.closed_at || task.created_at, Date.now(), locale); return w.label ? <span title={w.title}><Badge tone="muted"><Clock size={11} className="mr-1 inline" aria-hidden />{w.label}</Badge></span> : null; })()}
            {isClosed ? <OutcomeBadge outcome={task.outcome} /> : null}
            <Badge tone={statusTone(task.status)}>{statusLabel}</Badge>
          </div>
        </div>
      </div>
    </div>
  );
}
