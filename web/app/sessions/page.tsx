'use client';
import { useSessions } from '../../lib/queries';
import { useKillSession, useSendInput } from '../../lib/mutations';
import { SendInput } from '../../components/control/SendInput';
import { useToast } from '../../components/ui/Toast';
import { Panel } from '../../components/ui/Panel';
import { PageHeader } from '../../components/ui/PageHeader';
import { Button } from '../../components/ui/Button';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';

export default function SessionsPage() {
  const sessions = useSessions();
  const kill = useKillSession();
  const send = useSendInput();
  const { toast } = useToast();

  return (
    <Panel>
      <PageHeader title="Sessions" count={sessions.data?.length} />
      {sessions.isLoading ? <LoadingState /> : sessions.isError ? <ErrorState message="orca daemon unreachable" onRetry={() => sessions.refetch()} />
        : sessions.data && sessions.data.length > 0 ? (
          <ul className="flex flex-col divide-y divide-border">
            {sessions.data.map((s) => (
              <li key={s} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="font-mono text-xs text-text-muted">{s}</span>
                <div className="flex items-center gap-2">
                  <SendInput onSend={(keys) => send.mutate({ name: s, keys }, { onSuccess: () => toast(`Sent to ${s}`), onError: (e) => toast(String(e), 'error') })} />
                  <Button onClick={() => send.mutate({ name: s, keys: ['C-c'] }, { onSuccess: () => toast(`Interrupted ${s}`) })}>Interrupt</Button>
                  <Button variant="danger" onClick={() => kill.mutate(s, { onSuccess: () => toast(`Killed ${s}`), onError: (e) => toast(String(e), 'error') })}>Kill</Button>
                </div>
              </li>
            ))}
          </ul>
        ) : <EmptyState title="No live sessions" />}
    </Panel>
  );
}
