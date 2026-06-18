'use client';
import { TerminalSquare, SquareSlash, Power, SquareTerminal } from 'lucide-react';
import { useKillSession, useSendInput } from '../../lib/mutations';
import { useTasks, useSessionSignal } from '../../lib/queries';
import { taskTypeMeta } from '../tasks/taskMeta';
import { IconButton } from '../../components/ui/IconButton';
import { ActionMenu } from '../../components/ui/ActionMenu';
import { SendInput } from '../../components/control/SendInput';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { useSessionPane } from './useSessionPane';
import { parseAnsi } from './ansi';

export function SessionCard({ name, onOpenTerminal }: { name: string; onOpenTerminal: () => void }) {
  const kill = useKillSession();
  const send = useSendInput();
  const { toast } = useToast();
  const { t } = useTranslation();
  const { tail, isLoading } = useSessionPane(name);
  const tasks = useTasks();
  const signal = useSessionSignal(name);

  // Map session → its task via the agent:<name> label so we can show the task's type icon.
  const agent = name.startsWith('orca-') ? name.slice('orca-'.length) : null;
  const task = agent ? tasks.data?.find((t) => (t.labels ?? []).includes(`agent:${agent}`)) : undefined;
  const Icon = task ? taskTypeMeta(task.type).icon : SquareTerminal;
  const needsInput = signal?.type === 'needs_input';
  const dot = needsInput ? '#f59e0b' : '#10b981';

  return (
    <div className={`card-interactive flex flex-col gap-3 rounded-lg border bg-surface p-4 ${needsInput ? 'border-[#f59e0b]/60' : 'border-border'}`}>
      <div className="flex items-center gap-2">
        <Icon size={15} className="shrink-0 text-text-muted" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-text" title={task?.title}>{name}</span>
        {needsInput ? <span className="shrink-0 rounded-full border border-[#f59e0b]/40 bg-[#f59e0b]/10 px-1.5 py-0.5 text-[10px] font-medium text-[#f59e0b]" title={signal?.type === 'needs_input' ? signal.question : ''}>{t.sessions.needsInput}</span> : null}
        <span className="live-dot h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: dot, ['--live-ring' as string]: needsInput ? 'rgba(245,158,11,0.5)' : 'rgba(16,185,129,0.5)' }} aria-label={needsInput ? t.sessions.needsInput : t.sessions.online} title={needsInput ? t.sessions.needsInput : t.sessions.online} />
      </div>
      <pre className="h-32 overflow-hidden whitespace-pre-wrap break-all rounded-md border border-border bg-bg p-2 font-mono text-[11px] leading-snug text-text-muted">
        {isLoading ? t.sessions.loading : tail
          ? parseAnsi(tail).map((s, i) => <span key={i} style={s.color ? { color: s.color } : undefined}>{s.text}</span>)
          : t.sessions.noOutput}
      </pre>
      {needsInput && signal?.type === 'needs_input' && (
        <div className="flex flex-col gap-2 rounded-md border border-[#f59e0b]/40 bg-[#f59e0b]/10 p-2.5">
          <p className="text-xs text-text">{signal.question}</p>
          <div className="flex items-center gap-1.5">
            <button type="button" onClick={() => send.mutate({ name, keys: ['Enter'] }, { onSuccess: () => toast(t.sessions.approved.replace('{name}', name)), onError: (e) => toast(String(e), 'error') })} className="rounded-md border border-[#10b981]/50 bg-[#10b981]/10 px-2.5 py-1 text-xs font-medium text-[#10b981] transition-colors hover:bg-[#10b981] hover:text-white active:scale-95">{t.sessions.allow}</button>
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
