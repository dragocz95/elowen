'use client';
import { Link2, CheckCircle2, XCircle, ChevronRight } from 'lucide-react';
import type { Task } from '../../lib/types';
import { tailSnippet } from '../../lib/agentUtils';
import { sessionActivity } from '../../lib/sessionActivity';
import { useSessionPane } from '../../lib/useSessionPane';
import { useTranslation } from '../../lib/i18n';
import { Badge } from './Badge';
import type { Tone } from './tone';

/** Activity badge tone for a given category. */
function activityTone(cat: string): Tone {
  if (cat === 'error') return 'danger';
  if (cat === 'prompted') return 'warning';
  if (cat === 'unknown') return 'muted';
  return 'accent';
}

/** Live tail line for a running session — polls only while mounted, so closed cards stay quiet. */
function LiveTailLine({ name }: { name: string }) {
  const { t } = useTranslation();
  const { tail, isLoading } = useSessionPane(name, 3);
  const line = tailSnippet(tail);
  const activity = sessionActivity(tail);
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <ChevronRight size={12} className="shrink-0 text-success" aria-hidden />
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-muted">{line || (isLoading ? t.sessions.loading : t.sessions.noOutput)}</span>
      <Badge tone={activityTone(activity)}>{t.activity[activity]}</Badge>
    </div>
  );
}

/** One context line per task: live tail (running), result summary (closed), blocker reason
 *  (blocked) or a subtle Ready state (open). Renders nothing when there is nothing to say. */
export function TaskContextLine({ task, sessionName, blockers }: { task: Task; sessionName?: string | null; blockers?: Task[] }) {
  const { t } = useTranslation();

  if (sessionName) return <LiveTailLine name={sessionName} />;

  if (task.status === 'closed' || task.status === 'cancelled') {
    const fail = task.outcome === 'fail';
    return (
      <p className="flex min-w-0 items-center gap-1.5 text-[11px] text-text-muted">
        {fail ? <XCircle size={12} className="shrink-0 text-error" aria-hidden /> : <CheckCircle2 size={12} className="shrink-0 text-success" aria-hidden />}
        <span className="truncate">{task.result_summary?.trim() || t.tasks.noSummary}</span>
      </p>
    );
  }

  if (blockers && blockers.length > 0) {
    return (
      <p className="flex min-w-0 items-center gap-1.5 text-[11px] text-danger">
        <Link2 size={12} className="shrink-0" aria-hidden />
        <span className="truncate">{t.agent.waitingFor.replace('{deps}', blockers.map((b) => b.title).join(', '))}</span>
      </p>
    );
  }

  if (task.status === 'open') {
    return <p className="text-[11px] text-text-muted opacity-70">{t.agent.ready}</p>;
  }

  return null;
}