'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { TerminalSquare, SquareSlash, Power, SquareTerminal } from 'lucide-react';
import { useKillSession, useSendInput } from '../../lib/mutations';
import { useTasks, useSessionSignal } from '../../lib/queries';
import { taskTypeMeta } from '../tasks/taskMeta';
import { taskExec } from '../../lib/taskExec';
import { taskForSession } from '../../lib/agentUtils';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { OutcomeBadge } from '../../components/ui/OutcomeBadge';
import { IconButton } from '../../components/ui/IconButton';
import { ActionMenu } from '../../components/ui/ActionMenu';
import { ChangeStrip } from '../../components/ui/ChangeStrip';
import { SendInput } from '../../components/control/SendInput';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { useSessionPane } from './useSessionPane';
import { parseAnsi } from './ansi';

export function SessionCard({ name, onOpenTerminal, compact = false }: { name: string; onOpenTerminal: () => void; compact?: boolean }) {
  const kill = useKillSession();
  const send = useSendInput();
  const { toast } = useToast();
  const { t } = useTranslation();
  const { tail, isLoading } = useSessionPane(name);
  const tasks = useTasks();
  const signal = useSessionSignal(name);

  // Map session → its task (prefer the in_progress one; agent names are reused across tasks).
  const task = taskForSession(tasks.data ?? [], name);
  const exec = taskExec(task?.labels);
  const TypeIcon = task ? taskTypeMeta(task.type).icon : SquareTerminal;
  const needsInput = signal?.type === 'needs_input';
  const dot = needsInput ? 'var(--color-warning)' : 'var(--color-approve)';
  const finished = !!task && (task.status === 'closed' || task.status === 'cancelled');

  // Flash the tail's bottom edge whenever fresh output streams in.
  const [flash, setFlash] = useState(false);
  const prevTail = useRef(tail);
  useEffect(() => {
    if (prevTail.current === tail) return;
    prevTail.current = tail;
    if (!tail) return;
    setFlash(true);
    const id = setTimeout(() => setFlash(false), 600);
    return () => clearTimeout(id);
  }, [tail]);

  return (
    <div className={`card-interactive flex flex-col gap-3 rounded-lg border bg-surface ${compact ? 'p-3' : 'p-4'} ${needsInput ? 'border-warning/60' : 'border-border'}`}>
      <div className="flex items-center gap-2.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-elevated">
          {exec ? <ModelIcon name={exec} size={20} /> : <TypeIcon size={18} className="text-text-muted" aria-hidden />}
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-mono text-xs text-text" title={task?.title}>{name}</span>
          {task ? <Link href={`/tasks?select=${encodeURIComponent(task.id)}`} className="truncate text-[11px] text-text-muted transition-colors hover:text-accent" title={task.title}>{task.title}</Link> : null}
        </div>
        {needsInput ? <span className="shrink-0 rounded-full border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-tiny font-medium text-warning" title={signal?.type === 'needs_input' ? signal.question : ''}>{t.sessions.needsInput}</span> : null}
        <span className="live-dot h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: dot, ['--live-ring' as string]: needsInput ? 'color-mix(in srgb, var(--color-warning) 50%, transparent)' : 'color-mix(in srgb, var(--color-approve) 50%, transparent)' }} aria-label={needsInput ? t.sessions.needsInput : t.sessions.online} title={needsInput ? t.sessions.needsInput : t.sessions.online} />
      </div>
      {finished && task ? (
        <div className={`flex flex-col gap-1.5 rounded-md border border-border bg-bg p-2.5 ${compact ? '' : 'min-h-32'}`}>
          <OutcomeBadge outcome={task.outcome} />
          <p className="text-[11px] leading-snug text-text-muted">{task.result_summary?.trim() || t.tasks.noSummary}</p>
        </div>
      ) : (
        <pre data-flash={flash ? 'true' : undefined} className={`tail-live ${compact ? 'h-16' : 'h-32'} overflow-hidden whitespace-pre-wrap break-all rounded-md border border-border bg-bg p-2 font-mono text-[11px] leading-snug text-text-muted`}>
          {isLoading ? t.sessions.loading : tail
            ? <>{parseAnsi(tail).map((s, i) => <span key={i} style={s.color ? { color: s.color } : undefined}>{s.text}</span>)}<span className="ml-px inline-block h-3 w-1.5 -translate-y-px bg-text-muted align-middle" style={{ animation: 'skel-pulse 1.2s ease-in-out infinite' }} aria-hidden /></>
            : t.sessions.noOutput}
        </pre>
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
        <div className="flex items-center gap-1">
          <IconButton icon={TerminalSquare} label={t.sessions.terminal} onClick={onOpenTerminal} />
          <IconButton icon={SquareSlash} label={t.sessions.interrupt} onClick={() => send.mutate({ name, keys: ['C-c'] }, { onSuccess: () => toast(t.sessions.interrupted.replace('{name}', name)) })} />
          <ActionMenu label={t.sessions.kill} items={[{ label: t.sessions.kill, icon: Power, tone: 'danger', onSelect: () => kill.mutate(name, { onSuccess: () => toast(t.sessions.killed.replace('{name}', name)), onError: (e) => toast(String(e), 'error') }) }]} />
        </div>
      </div>
    </div>
  );
}
