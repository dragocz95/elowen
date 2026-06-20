'use client';
import Link from 'next/link';
import { TerminalSquare, SquareSlash, Power, SquareTerminal, Eye, Bot } from 'lucide-react';
import { useKillSession, useSendInput } from '../../lib/mutations';
import { useTasks, useSessionSignal, useConfig } from '../../lib/queries';
import { taskTypeMeta } from '../tasks/taskMeta';
import { taskExec } from '../../lib/taskExec';
import { taskForSession, missionEpicId } from '../../lib/agentUtils';
import { execModel } from '../../lib/modelProvider';
import type { SessionInfo } from '../../lib/types';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { OutcomeBadge } from '../../components/ui/OutcomeBadge';
import { IconButton } from '../../components/ui/IconButton';
import { ActionMenu } from '../../components/ui/ActionMenu';
import { ChangeStrip } from '../../components/ui/ChangeStrip';
import { TaskUsageBadge } from '../../components/ui/TaskUsageBadge';
import { LiveTail } from '../../components/terminal/LiveTail';
import { SendInput } from '../../components/control/SendInput';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';

export function SessionCard({ info, onOpenTerminal, compact = false }: { info: SessionInfo; onOpenTerminal: () => void; compact?: boolean }) {
  const kill = useKillSession();
  const send = useSendInput();
  const { toast } = useToast();
  const { t } = useTranslation();
  const tasks = useTasks();
  const config = useConfig();
  const name = info.name;
  const signal = useSessionSignal(name);

  // Map session → its task (prefer the in_progress one; agent names are reused across tasks).
  const task = taskForSession(tasks.data ?? [], name);
  const exec = taskExec(task?.labels);
  // The model running in this session: the task's exec for a worker, else the configured
  // pilot/overseer backend for the autopilot's own reasoning agents.
  const roleExec = info.role === 'overseer' ? config.data?.autopilot.overseerExec
    : info.role === 'pilot' ? config.data?.autopilot.pilotExec : undefined;
  const modelExec = exec ?? (roleExec || undefined);
  // The epic an overseer governs — its title is the human name of the mission.
  const epic = info.role === 'overseer' && info.missionId
    ? (tasks.data ?? []).find((x) => x.id === missionEpicId(info.missionId!))
    : undefined;
  const TypeIcon = task ? taskTypeMeta(task.type).icon : SquareTerminal;
  const needsInput = signal?.type === 'needs_input';
  const dot = needsInput ? 'var(--color-warning)' : 'var(--color-approve)';
  const finished = !!task && (task.status === 'closed' || task.status === 'cancelled');

  return (
    <div className={`card-interactive flex flex-col gap-3 rounded-lg border bg-surface ${compact ? 'p-3' : 'p-4'} ${needsInput ? 'border-warning/60' : 'border-border'}`}>
      <div className="flex items-center gap-2.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-elevated">
          {info.role === 'overseer' ? <Eye size={18} className="text-text-muted" aria-hidden />
            : info.role === 'pilot' ? <Bot size={18} className="text-text-muted" aria-hidden />
            : exec ? <ModelIcon name={exec} size={20} /> : <TypeIcon size={18} className="text-text-muted" aria-hidden />}
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          {info.role === 'overseer' ? (
            <>
              <span className="truncate text-xs font-semibold text-text" title={epic?.title}>{t.sessions.roleOverseer}{epic ? ` · ${epic.title}` : ''}</span>
              <span className="truncate font-mono text-[11px] text-text-muted">{info.missionId}</span>
            </>
          ) : info.role === 'pilot' ? (
            <>
              <span className="truncate text-xs font-semibold text-text">{t.sessions.rolePilot}</span>
              <span className="truncate text-[11px] text-text-muted">{info.agent}</span>
            </>
          ) : (
            <>
              <span className="truncate text-xs font-semibold text-text" title={task?.title}>{info.agent}</span>
              {task ? <Link href={`/tasks?select=${encodeURIComponent(task.id)}`} className="truncate text-[11px] text-text-muted transition-colors hover:text-accent" title={task.title}>{task.title}</Link> : null}
            </>
          )}
        </div>
        {needsInput ? <span className="shrink-0 rounded-full border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-tiny font-medium text-warning" title={signal?.type === 'needs_input' ? signal.question : ''}>{t.sessions.needsInput}</span> : null}
        <span className="live-dot h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: dot, ['--live-ring' as string]: needsInput ? 'color-mix(in srgb, var(--color-warning) 50%, transparent)' : 'color-mix(in srgb, var(--color-approve) 50%, transparent)' }} aria-label={needsInput ? t.sessions.needsInput : t.sessions.online} title={needsInput ? t.sessions.needsInput : t.sessions.online} />
      </div>
      {/* token usage on its own row under the header (not crammed into the identity column) */}
      {task ? <TaskUsageBadge taskId={task.id} live={!finished} /> : null}
      {finished && task ? (
        <div className={`flex flex-col gap-1.5 rounded-md border border-border bg-bg p-2.5 ${compact ? '' : 'min-h-32'}`}>
          <OutcomeBadge outcome={task.outcome} />
          <p className="text-[11px] leading-snug text-text-muted">{task.result_summary?.trim() || t.tasks.noSummary}</p>
        </div>
      ) : (
        <LiveTail name={name} lines={compact ? 14 : 22} heightClass={compact ? 'h-32' : 'h-52'} onExpand={onOpenTerminal} />
      )}
      {!finished && <ChangeStrip />}
      {needsInput && signal?.type === 'needs_input' && (
        <div className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/10 p-2.5">
          <p className="text-xs text-text">{signal.question}</p>
          <div className="flex items-center gap-1.5">
            <button type="button" onClick={() => send.mutate({ name, keys: ['Enter'] }, { onSuccess: () => toast(t.sessions.approved.replace('{name}', name)), onError: (e) => toast(String(e), 'error') })} className="rounded-md border border-approve/50 bg-approve/10 px-2.5 py-1 text-xs font-medium text-approve transition-colors hover:bg-approve hover:text-white active:scale-95">{t.sessions.allow}</button>
            <button type="button" onClick={() => send.mutate({ name, keys: ['Escape'] }, { onSuccess: () => toast(t.sessions.rejected.replace('{name}', name)), onError: (e) => toast(String(e), 'error') })} className="rounded-md border border-danger/50 bg-danger/10 px-2.5 py-1 text-xs font-medium text-danger transition-colors hover:bg-danger hover:text-white active:scale-95">{t.sessions.reject}</button>
          </div>
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <SendInput onSend={(keys) => send.mutate({ name, keys }, { onSuccess: () => toast(t.sessions.sentTo.replace('{name}', name)), onError: (e) => toast(String(e), 'error') })} />
        <div className="flex items-center gap-1.5">
          {modelExec ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-border bg-elevated px-2 py-0.5 text-[11px] text-text-muted" title={modelExec}>
              <ModelIcon name={modelExec} size={13} /><span className="max-w-28 truncate">{execModel(modelExec)}</span>
            </span>
          ) : null}
          <IconButton icon={TerminalSquare} label={t.sessions.terminal} onClick={onOpenTerminal} />
          <IconButton icon={SquareSlash} label={t.sessions.interrupt} onClick={() => send.mutate({ name, keys: ['C-c'] }, { onSuccess: () => toast(t.sessions.interrupted.replace('{name}', name)) })} />
          <ActionMenu label={t.sessions.kill} items={[{ label: t.sessions.kill, icon: Power, tone: 'danger', onSelect: () => kill.mutate(name, { onSuccess: () => toast(t.sessions.killed.replace('{name}', name)), onError: (e) => toast(String(e), 'error') }) }]} />
        </div>
      </div>
    </div>
  );
}
