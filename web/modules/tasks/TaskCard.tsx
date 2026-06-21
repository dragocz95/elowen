'use client';
import { useState } from 'react';
import { Pencil, Play, Square, Pause, Archive, Trash2, Clock, Zap } from 'lucide-react';
import type { Task } from '../../lib/types';
import { useCloseTask, useDeleteTask } from '../../lib/mutations';
import { useConfig, useSessionSignal } from '../../lib/queries';
import { taskExec } from '../../lib/taskExec';
import { useTaskControls } from '../../lib/useTaskControls';
import { Badge } from '../../components/ui/Badge';
import { Checkbox } from '../../components/ui/Checkbox';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { IconButton } from '../../components/ui/IconButton';
import { ActionMenu } from '../../components/ui/ActionMenu';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { AgentStatusDot } from '../../components/ui/AgentStatusDot';
import { ProjectPill } from '../../components/ui/ProjectPill';
import { OutcomeBadge } from '../../components/ui/OutcomeBadge';
import { useSessionStall } from '../../lib/useSessionStall';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { formatTaskTime } from '../../lib/formatTime';
import { taskTypeMeta, statusLabel } from './taskMeta';
import { statusTone } from '../dashboard/statusTone';

/** A single task as a compact list row — mirrors the autopilot epic's collapsed row so the task
 *  list stays dense. Quick run controls + status sit on the row; the full detail (agent, usage,
 *  changes, context) opens in the detail pane on click, so nothing is lost by slimming the card. */
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
  const stall = useSessionStall(session ?? '', running && !!session);
  const stallProps = session ? { stall: stall.state, silenceSec: stall.silenceSec } : {};
  const blocked = (blockers?.length ?? 0) > 0;

  const open = () => (onSelect ?? onEdit)(task);
  const when = task.scheduled_at || task.closed_at || task.created_at;
  const whenFmt = when ? formatTaskTime(when, Date.now(), locale) : null;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => { if (e.key === 'Enter') open(); }}
      className={`card-interactive group relative flex cursor-pointer items-center gap-3 rounded-lg border p-2.5 ${selected || active ? 'border-accent bg-accent/[0.06]' : 'border-border bg-surface'}`}
    >
      {/* model-icon bubble — accent ring while the agent is live */}
      <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border-2 bg-elevated ${running ? 'border-accent' : 'border-border'}`}>
        {iconExec ? <ModelIcon name={iconExec} size={26} /> : <Icon size={22} className="text-text-muted" aria-hidden />}
      </span>

      {/* title + id */}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium text-text">{task.title}</span>
          <AgentStatusDot signal={signal} live={running} size="sm" {...stallProps} />
        </div>
        <div className="flex items-center gap-1.5">
          <Icon size={11} className="shrink-0 text-text-muted" aria-hidden />
          <span className="truncate font-mono text-[11px] text-text-muted">{task.id}</span>
          {blocked ? <span className="shrink-0 text-[11px] text-warning" title={blockers!.map((b) => b.title).join(', ')}>· {t.tasks.dependencies} {blockers!.length}</span> : null}
        </div>
      </div>

      {/* status + meta badges */}
      <div className="flex shrink-0 items-center gap-1.5">
        {whenFmt ? (
          <span title={whenFmt.title}><Badge tone="muted">
            {task.scheduled_at ? (task.autostart ? <Zap size={11} className="mr-1 inline" aria-hidden /> : <Clock size={11} className="mr-1 inline" aria-hidden />) : <Clock size={11} className="mr-1 inline" aria-hidden />}
            {whenFmt.label}
          </Badge></span>
        ) : null}
        <ProjectPill projectId={task.project_id} />
        {isClosed ? <OutcomeBadge outcome={task.outcome} /> : null}
        <Badge tone={statusTone(task.status)}>{statusLabel(t, task.status)}</Badge>
      </div>

      {/* run controls — always visible so the dropdown trigger never vanishes mid-interaction */}
      <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
        {running
          ? <IconButton icon={Square} label={t.tasks.stop} variant="danger" onClick={stop} />
          : <IconButton icon={Play} label={t.tasks.start} onClick={start} />}
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

      {onToggleSelect ? (
        <button
          type="button"
          role="checkbox"
          aria-checked={selected}
          aria-label={t.sessions.selectLabel.replace('{id}', task.id)}
          onClick={(e) => { e.stopPropagation(); onToggleSelect(task.id); }}
          className={`shrink-0 transition-opacity ${selecting || selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
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
