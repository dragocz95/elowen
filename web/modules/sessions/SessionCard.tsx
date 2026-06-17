'use client';
import { TerminalSquare, SquareSlash, Power, SquareTerminal } from 'lucide-react';
import { useKillSession, useSendInput } from '../../lib/mutations';
import { useTasks } from '../../lib/queries';
import { taskTypeMeta } from '../tasks/taskMeta';
import { IconButton } from '../../components/ui/IconButton';
import { ActionMenu } from '../../components/ui/ActionMenu';
import { SendInput } from '../../components/control/SendInput';
import { useToast } from '../../components/ui/Toast';
import { useSessionPane } from './useSessionPane';

export function SessionCard({ name, onOpenTerminal }: { name: string; onOpenTerminal: () => void }) {
  const kill = useKillSession();
  const send = useSendInput();
  const { toast } = useToast();
  const { tail, isLoading } = useSessionPane(name);
  const tasks = useTasks();

  // Map session → its task via the agent:<name> label so we can show the task's type icon.
  const agent = name.startsWith('orca-') ? name.slice('orca-'.length) : null;
  const task = agent ? tasks.data?.find((t) => (t.labels ?? []).includes(`agent:${agent}`)) : undefined;
  const Icon = task ? taskTypeMeta(task.type).icon : SquareTerminal;

  return (
    <div className="card-interactive flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center gap-2">
        <Icon size={15} className="shrink-0 text-text-muted" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-text" title={task?.title}>{name}</span>
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: '#10b981' }} aria-label="online" title="online" />
      </div>
      <pre className="h-32 overflow-hidden whitespace-pre-wrap break-all rounded-md border border-border bg-bg p-2 font-mono text-[11px] leading-snug text-text-muted">
        {isLoading ? 'loading…' : (tail || '— no output —')}
      </pre>
      <div className="flex items-center justify-between gap-2">
        <SendInput onSend={(keys) => send.mutate({ name, keys }, { onSuccess: () => toast(`Sent to ${name}`), onError: (e) => toast(String(e), 'error') })} />
        <div className="flex items-center gap-1">
          <IconButton icon={TerminalSquare} label="Terminal" onClick={onOpenTerminal} />
          <IconButton icon={SquareSlash} label="Interrupt" onClick={() => send.mutate({ name, keys: ['C-c'] }, { onSuccess: () => toast(`Interrupted ${name}`) })} />
          <ActionMenu label="Kill session" items={[{ label: 'Kill session', icon: Power, tone: 'danger', onSelect: () => kill.mutate(name, { onSuccess: () => toast(`Killed ${name}`), onError: (e) => toast(String(e), 'error') }) }]} />
        </div>
      </div>
    </div>
  );
}
