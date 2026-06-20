'use client';
import { useState } from 'react';
import { Pencil, Play, Square, SquareSlash, Archive, TerminalSquare, Link2, Copy } from 'lucide-react';
import type { Task } from '../../lib/types';
import { useTasks, useAllDeps, useSessionSignal, useActivity, useConfig } from '../../lib/queries';
import { useCloseTask } from '../../lib/mutations';
import { useTaskControls } from '../../lib/useTaskControls';
import { taskExec } from '../../lib/taskExec';
import { taskSessionName, taskAgentName } from '../../lib/agentUtils';
import { formatTaskTime } from '../../lib/formatTime';
import { Badge } from '../../components/ui/Badge';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { IconButton } from '../../components/ui/IconButton';
import { AgentStatusDot } from '../../components/ui/AgentStatusDot';
import { OutcomeBadge } from '../../components/ui/OutcomeBadge';
import { TaskUsageBadge } from '../../components/ui/TaskUsageBadge';
import { LiveTail } from '../../components/terminal/LiveTail';
import { TerminalModal } from '../../components/terminal/TerminalModal';
import { useToast } from '../../components/ui/Toast';
import { EmptyState } from '../../components/ui/states';
import { statusTone } from '../dashboard/statusTone';
import { taskTypeMeta, statusLabel } from './taskMeta';
import { useTranslation } from '../../lib/i18n';

/** Persistent task detail: identity, actions, description, dependencies, live tail / result,
 *  and recent activity. Resolves the full task by id so it works from tasks and missions alike. */
export function TaskDetailPane({ taskId, onEdit }: { taskId: string; onEdit?: (t: Task) => void }) {
  const { t, locale } = useTranslation();
  const tasks = useTasks();
  const deps = useAllDeps();
  const activity = useActivity('signal');
  const { data: config } = useConfig();
  const close = useCloseTask();
  const { toast } = useToast();
  const [openTerm, setOpenTerm] = useState(false);

  const task = tasks.data?.find((x) => x.id === taskId);
  const { session, running, start, stop, pause } = useTaskControls(task ?? { id: taskId, title: '', status: 'open' });
  const signal = useSessionSignal(session ?? '');

  if (!task) return <EmptyState title={t.tasks.selectHint} icon={TerminalSquare} />;

  const Icon = taskTypeMeta(task.type).icon;
  const exec = taskExec(task.labels);
  const iconExec = exec || config?.defaults?.exec || '';
  const agentName = taskAgentName(task);
  const isClosed = task.status === 'closed' || task.status === 'cancelled';
  const whenIso = task.closed_at || task.created_at;
  const when = formatTaskTime(whenIso, Date.now(), locale);

  const byId = new Map((tasks.data ?? []).map((x) => [x.id, x]));
  const depTasks = (deps.data ?? []).filter((d) => d.task_id === taskId).map((d) => byId.get(d.depends_on_id)).filter((x): x is Task => !!x);
  const events = (activity.data ?? []).filter((e) => e.target === taskId || (session && e.target === session)).slice(0, 6);

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(task.id);
      toast(t.tasks.idCopied.replace('{id}', task.id));
    } catch {
      toast(t.tasks.idCopyFailed, 'error');
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Identity + actions — sticky so it stays pinned while the detail scrolls. */}
      <div className="sticky top-0 z-10 -mx-4 flex flex-col gap-2 border-b border-border bg-surface px-4 pb-3 pt-1">
        <div className="flex items-start gap-3">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-border bg-elevated">
            {iconExec ? <ModelIcon name={iconExec} size={26} /> : <Icon size={22} className="text-text-muted" aria-hidden />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="min-w-0 flex-1 text-base font-semibold text-text">{task.title}</h2>
              <AgentStatusDot signal={signal} live={running} />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-text-muted">
              <span>{task.id}</span>
              <IconButton icon={Copy} label={t.tasks.copyId} onClick={copyId} />
              {agentName ? <><span aria-hidden className="opacity-50">·</span><span>{taskSessionName(task)}</span></> : null}
              {when.label ? <><span aria-hidden className="opacity-50">·</span><span title={when.title}>{when.label}</span></> : null}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={statusTone(task.status)}>{statusLabel(t, task.status)}</Badge>
          {isClosed ? <OutcomeBadge outcome={task.outcome} /> : null}
          {exec ? <Badge>{exec}</Badge> : null}
          {agentName ? <TaskUsageBadge taskId={task.id} live={running} /> : null}
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {running
            ? <><IconButton icon={Square} label={t.tasks.stop} variant="danger" onClick={stop} /><IconButton icon={SquareSlash} label={t.sessions.interrupt} onClick={pause} /></>
            : <IconButton icon={Play} label={t.tasks.start} onClick={start} />}
          {session ? <IconButton icon={TerminalSquare} label={t.tasks.openTerminal} onClick={() => setOpenTerm(true)} /> : null}
          {onEdit ? <IconButton icon={Pencil} label={t.common.edit} onClick={() => onEdit(task)} /> : null}
          {!isClosed ? <IconButton icon={Archive} label={t.tasks.closeArchive} onClick={() => close.mutate(task.id, { onSuccess: () => toast(t.tasks.closed.replace('{id}', task.id)), onError: (e) => toast(String(e), 'error') })} /> : null}
        </div>
      </div>

      {task.description?.trim() ? (
        <Field label={t.tasks.fieldDetails}>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-text-muted">{task.description}</p>
        </Field>
      ) : null}

      {depTasks.length > 0 ? (
        <Field label={t.tasks.dependencies}>
          <ul className="flex flex-col gap-1">
            {depTasks.map((d) => (
              <li key={d.id} className="flex items-center gap-2 text-xs">
                <Link2 size={12} className="shrink-0 text-text-muted" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-text">{d.title}</span>
                <Badge tone={statusTone(d.status)}>{statusLabel(t, d.status)}</Badge>
              </li>
            ))}
          </ul>
        </Field>
      ) : null}

      {running && session ? <Field label={t.tasks.liveOutput}><LiveTail name={session} lines={28} heightClass="max-h-96" onExpand={() => setOpenTerm(true)} /></Field> : null}

      {isClosed && (task.result_summary || task.outcome) ? (
        <Field label={t.tasks.resultTitle}>
          <p className="text-sm leading-relaxed text-text-muted">{task.result_summary?.trim() || t.tasks.noSummary}</p>
        </Field>
      ) : null}

      {events.length > 0 ? (
        <Field label={t.tasks.recentActivity}>
          <ul className="flex flex-col divide-y divide-border">
            {events.map((e) => (
              <li key={e.id} className="flex items-center gap-2 py-1.5 text-xs">
                <span className="min-w-0 flex-1 truncate font-mono text-text-muted">{e.detail}</span>
                <span className="shrink-0 font-mono text-text-muted opacity-70">{e.ts.slice(11, 16)}</span>
              </li>
            ))}
          </ul>
        </Field>
      ) : null}

      {openTerm && session && <TerminalModal session={session} onClose={() => setOpenTerm(false)} />}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">{label}</span>
      {children}
    </div>
  );
}
