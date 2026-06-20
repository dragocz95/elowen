'use client';
import { useState } from 'react';
import { Pencil, Play, Square, Pause, Archive, Trash2, Clock, Zap, Timer } from 'lucide-react';
import type { Task } from '../../lib/types';
import { useCloseTask, useDeleteTask } from '../../lib/mutations';
import { useConfig, useSessionSignal } from '../../lib/queries';
import { taskExec } from '../../lib/taskExec';
import { taskAgentName, taskElapsed } from '../../lib/agentUtils';
import { useTaskControls } from '../../lib/useTaskControls';
import { Badge } from '../../components/ui/Badge';
import { Checkbox } from '../../components/ui/Checkbox';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { IconButton } from '../../components/ui/IconButton';
import { ActionMenu } from '../../components/ui/ActionMenu';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { AgentStatusDot } from '../../components/ui/AgentStatusDot';
import { AgentIdentityStrip } from '../../components/ui/AgentIdentityStrip';
import { TaskContextLine } from '../../components/ui/TaskContextLine';
import { OutcomeBadge } from '../../components/ui/OutcomeBadge';
import { TaskUsageBadge } from '../../components/ui/TaskUsageBadge';
import { ChangeStrip } from '../../components/ui/ChangeStrip';
import { useSessionStall } from '../../lib/useSessionStall';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { formatTaskTime } from '../../lib/formatTime';
import { taskTypeMeta } from './taskMeta';
import { statusTone } from '../dashboard/statusTone';

export function TaskCard({ task, onEdit, onSelect, active = false, blockers, selected = false, onToggleSelect, selecting = false }: { task: Task; onEdit: (t: Task) => void; onSelect?: (t: Task) => void; active?: boolean; blockers?: Task[]; selected?: boolean; onToggleSelect?: (id: string) => void; selecting?: boolean }) {
  const close = useCloseTask();
  const del = useDeleteTask();
  const { toast } = useToast();
  const { t, locale } = useTranslation();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { data: config } = useConfig();
  const meta = taskTypeMeta(task.type);
  const Icon = meta.icon;
  const exec = taskExec(task.labels);
  const iconExec = exec || config?.defaults?.exec || ''; // effective model: explicit, else the configured default
  const isClosed = task.status === 'closed';

  const { session, running, start, stop, pause } = useTaskControls(task);
  const signal = useSessionSignal(session ?? '');
  const hasAgent = !!taskAgentName(task);
  const stall = useSessionStall(session ?? '', running && !!session);
  const stallProps = session ? { stall: stall.state, silenceSec: stall.silenceSec } : {};

  const STATUS_LABEL: Record<string, string> = { open: t.tasks.statusOpen, in_progress: t.tasks.statusInProgress, blocked: t.tasks.statusBlocked, closed: t.tasks.statusClosed, cancelled: t.tasks.statusCancelled };
  const open = () => (onSelect ?? onEdit)(task);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => { if (e.key === 'Enter') open(); }}
      className={`card-interactive group relative flex cursor-pointer gap-3.5 rounded-lg border p-3.5 ${selected || active ? 'border-accent bg-accent/[0.06]' : 'border-border bg-surface'}`}
    >
      {/* left column: big model-icon bubble (running → accent ring), divided from the content */}
      <div className="flex shrink-0 flex-col items-center justify-center self-stretch border-r border-border pr-3.5">
        <span className={`flex h-24 w-24 items-center justify-center rounded-2xl border-2 bg-elevated transition-shadow ${running ? 'border-accent' : 'border-border'}`}>
          {iconExec ? <ModelIcon name={iconExec} size={58} /> : <Icon size={52} className="text-text-muted" aria-hidden />}
        </span>
      </div>

      {/* right column: all the content */}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-medium text-text">{task.title}</span>
              <AgentStatusDot signal={signal} live={running} size="sm" {...stallProps} />
            </div>
            <div className="mt-0.5 flex items-center gap-1.5">
              <Icon size={11} className="shrink-0 text-text-muted" aria-hidden />
              <span className="truncate font-mono text-[11px] text-text-muted">{task.id}</span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
            {/* run control reflects live state: Start when idle, Stop (+Pause) when running */}
            {running
              ? <IconButton icon={Square} label={t.tasks.stop} variant="danger" onClick={stop} />
              : <IconButton icon={Play} label={t.tasks.start} onClick={start} />}
            <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
              {running ? <IconButton icon={Pause} label={t.tasks.pause} onClick={pause} /> : null}
              <IconButton icon={Pencil} label={t.common.edit} onClick={() => onEdit(task)} />
              <ActionMenu
                label={t.tasks.deleteOrClose}
                items={[
                  { label: t.tasks.closeArchive, icon: Archive, onSelect: () => close.mutate(task.id, { onSuccess: () => toast(t.tasks.closed.replace('{id}', task.id)), onError: (e) => toast(String(e), 'error') }) },
                  { label: t.tasks.deletePermanently, icon: Trash2, tone: 'danger', onSelect: () => setConfirmDelete(true) },
                ]}
              />
            </div>
          </div>
        </div>

        {hasAgent ? <AgentIdentityStrip task={task} showTime={false} /> : null}

        <TaskContextLine task={task} sessionName={running ? session : null} blockers={blockers} />

        {running ? <ChangeStrip /> : null}

        {/* run footer: agent runtime + token usage on their own line, left-aligned */}
        {hasAgent ? (() => { const ran = taskElapsed(task, Date.now()); return (
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
            {ran ? <span className="flex shrink-0 items-center gap-1" title={t.tasks.resultDuration}><Timer size={11} aria-hidden />{ran}</span> : null}
            <TaskUsageBadge taskId={task.id} live={running} />
          </div>
        ); })() : null}

        <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-0.5">
          <Badge tone={statusTone(task.status)}>{STATUS_LABEL[task.status] ?? task.status}</Badge>
          {isClosed ? <OutcomeBadge outcome={task.outcome} /> : null}
          {exec ? <Badge>{exec}</Badge> : null}
          {task.scheduled_at ? (
            <Badge tone="muted">
              {task.autostart ? <Zap size={11} className="mr-1 inline" aria-hidden /> : <Clock size={11} className="mr-1 inline" aria-hidden />}
              {(() => { const w = formatTaskTime(task.scheduled_at, Date.now(), locale); return <span title={w.title}>{w.label}</span>; })()}
            </Badge>
          ) : (task.closed_at || task.created_at) ? (
            (() => { const w = formatTaskTime(task.closed_at || task.created_at, Date.now(), locale); return <span title={w.title}><Badge tone="muted"><Clock size={11} className="mr-1 inline" aria-hidden />{w.label}</Badge></span>; })()
          ) : null}
        </div>
      </div>

      {onToggleSelect ? (
        <button
          type="button"
          role="checkbox"
          aria-checked={selected}
          aria-label={t.sessions.selectLabel.replace('{id}', task.id)}
          onClick={(e) => { e.stopPropagation(); onToggleSelect(task.id); }}
          className={`absolute bottom-2.5 right-2.5 transition-opacity ${selecting || selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
        >
          <Checkbox checked={selected} />
        </button>
      ) : null}

      {confirmDelete && (
        <div onClick={(e) => e.stopPropagation()}>
          <ConfirmDialog
            open={confirmDelete}
            title={t.tasks.confirmDeleteTitle.replace('{id}', task.id)}
            description={t.tasks.confirmDeleteDescription}
            onClose={() => setConfirmDelete(false)}
            onConfirm={() => { setConfirmDelete(false); del.mutate(task.id, { onSuccess: () => toast(t.tasks.deleted.replace('{id}', task.id)), onError: (e) => toast(String(e), 'error') }); }}
          />
        </div>
      )}
    </div>
  );
}
