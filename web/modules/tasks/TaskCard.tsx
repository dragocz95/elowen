'use client';
import { useState } from 'react';
import { Pencil, Play, Square, Pause, Archive, Trash2, Clock, Zap, CheckCircle2, XCircle } from 'lucide-react';
import type { Task } from '../../lib/types';
import { useSpawn, useCloseTask, useDeleteTask, useKillSession, useSetTaskStatus, useSendInput } from '../../lib/mutations';
import { useSessions, useConfig } from '../../lib/queries';
import { taskExec } from '../../lib/taskExec';
import { Badge } from '../../components/ui/Badge';
import { Checkbox } from '../../components/ui/Checkbox';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { IconButton } from '../../components/ui/IconButton';
import { ActionMenu } from '../../components/ui/ActionMenu';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { taskTypeMeta } from './taskMeta';
import { statusTone } from '../dashboard/statusTone';

/** The tmux session running this task, derived from its agent:<name> label. */
function taskSession(labels?: string[]): string | null {
  const agent = labels?.find((l) => l.startsWith('agent:'))?.slice('agent:'.length);
  return agent ? `orca-${agent}` : null;
}

function fmtWhen(iso: string, locale?: string): string {
  // Normalize SQLite ("2026-06-18 10:38:49", UTC) and ISO ("…T…Z") timestamps alike.
  const norm = iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z';
  const d = new Date(norm);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function TaskCard({ task, onEdit, selected = false, onToggleSelect, selecting = false }: { task: Task; onEdit: (t: Task) => void; selected?: boolean; onToggleSelect?: (id: string) => void; selecting?: boolean }) {
  const spawn = useSpawn();
  const close = useCloseTask();
  const del = useDeleteTask();
  const kill = useKillSession();
  const setStatus = useSetTaskStatus();
  const send = useSendInput();
  const sessions = useSessions();
  const { toast } = useToast();
  const { t, locale } = useTranslation();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { data: config } = useConfig();
  const meta = taskTypeMeta(task.type);
  const Icon = meta.icon;
  const exec = taskExec(task.labels);
  const iconExec = exec || config?.defaults?.exec || ''; // effective model: explicit, else the configured default
  const hasDesc = !!task.description?.trim();
  const isClosed = task.status === 'closed';

  // Run state: a task is running when it's in_progress AND its tmux session is live.
  const session = taskSession(task.labels);
  const running = task.status === 'in_progress' && !!session && (sessions.data ?? []).includes(session);
  const start = () => spawn.mutate({ taskId: task.id, exec: exec || undefined }, { onSuccess: (r) => toast(t.tasks.launched.replace('{session}', r.session)), onError: (e) => toast(String(e), 'error') });
  const stop = () => {
    if (session) kill.mutate(session);
    setStatus.mutate({ id: task.id, status: 'open' }, { onSuccess: () => toast(t.tasks.stopped.replace('{id}', task.id)), onError: (e) => toast(String(e), 'error') });
  };
  const pause = () => { if (session) send.mutate({ name: session, keys: ['C-c'] }, { onSuccess: () => toast(t.sessions.interrupted.replace('{name}', session)), onError: (e) => toast(String(e), 'error') }); };
  const STATUS_LABEL: Record<string, string> = { open: t.tasks.statusOpen, in_progress: t.tasks.statusInProgress, blocked: t.tasks.statusBlocked, closed: t.tasks.statusClosed, cancelled: t.tasks.statusCancelled };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onEdit(task)}
      onKeyDown={(e) => { if (e.key === 'Enter') onEdit(task); }}
      className={`card-interactive group relative flex cursor-pointer gap-3.5 rounded-lg border p-3.5 ${selected ? 'border-accent bg-accent/[0.06]' : 'border-border bg-surface'}`}
    >
      {/* left column: big model-icon bubble (running → accent ring), divided from the content */}
      <div className="flex shrink-0 flex-col items-center justify-center self-stretch border-r border-border pr-3.5">
        <span className={`flex h-24 w-24 items-center justify-center rounded-2xl border-2 bg-elevated transition-shadow ${running ? 'border-accent ring-2 ring-accent/30' : 'border-border'}`}>
          {iconExec ? <ModelIcon name={iconExec} size={58} /> : <Icon size={52} className="text-text-muted" aria-hidden />}
        </span>
      </div>

      {/* right column: all the content */}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-text">{task.title}</div>
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

        {hasDesc ? <p className="line-clamp-2 text-xs leading-relaxed text-text-muted">{task.description}</p> : null}

        {isClosed && (task.result_summary || task.outcome) ? (
          <div className="rounded-md border border-border bg-bg/60 p-2">
            <div className="mb-1 flex items-center gap-1.5">
              {task.outcome === 'fail'
                ? <XCircle size={12} className="text-[#ef4444]" aria-hidden />
                : <CheckCircle2 size={12} className="text-[#22c55e]" aria-hidden />}
              <span className={`text-[10px] font-semibold uppercase tracking-wide ${task.outcome === 'fail' ? 'text-[#ef4444]' : 'text-[#22c55e]'}`}>
                {task.outcome === 'fail' ? t.tasks.outcomeFail : t.tasks.outcomeOk}
              </span>
            </div>
            <p className="text-xs leading-relaxed text-text-muted">{task.result_summary || t.tasks.noSummary}</p>
          </div>
        ) : null}

        <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-0.5">
          <Badge tone={statusTone(task.status)}>{STATUS_LABEL[task.status] ?? task.status}</Badge>
          {exec ? <Badge>{exec}</Badge> : null}
          {task.scheduled_at ? (
            <Badge tone="muted">
              {task.autostart ? <Zap size={11} className="mr-1 inline" aria-hidden /> : <Clock size={11} className="mr-1 inline" aria-hidden />}
              {fmtWhen(task.scheduled_at, locale)}
            </Badge>
          ) : (task.closed_at || task.created_at) ? (
            <Badge tone="muted"><Clock size={11} className="mr-1 inline" aria-hidden />{fmtWhen((task.closed_at || task.created_at)!, locale)}</Badge>
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
