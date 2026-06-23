'use client';
import { CheckCircle2, XCircle, Archive, Bot, Clock, CalendarCheck, type LucideIcon } from 'lucide-react';
import type { Task } from '../../lib/types';
import { statusLabel } from './taskMeta';
import { useConfig } from '../../lib/queries';
import { taskExec } from '../../lib/agentUtils';
import { taskSessionName } from '../../lib/agentUtils';
import { taskStartedMs } from '../../lib/agentUtils';
import { parseTs, formatTaskTime, formatDuration } from '../../lib/format';
import { Modal, ModalBody, ModalFooter } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { OutcomeBadge } from '../../components/ui/OutcomeBadge';
import { TaskUsageBadge } from '../../components/ui/TaskUsageBadge';
import { statusTone } from '../dashboard/statusTone';
import { useTranslation } from '../../lib/i18n';

/** Read-only outcome view for a finished (closed/cancelled) task or autopilot agent.
 *  Shown instead of the edit modal when a closed card is clicked — editing a done task
 *  is pointless, so we present its result, agent, timing and summary nicely instead. */
export function TaskResultsModal({ task, onClose }: { task: Task; onClose: () => void }) {
  const { t, locale } = useTranslation();
  const { data: config } = useConfig();

  const exec = taskExec(task.labels);
  const iconExec = exec || config?.defaults?.exec || '';
  const session = taskSessionName(task);
  const fail = task.outcome === 'fail';
  const HeaderIcon = task.outcome ? (fail ? XCircle : CheckCircle2) : Archive;

  const finishedIso = task.closed_at || task.created_at;
  const finished = formatTaskTime(finishedIso, Date.now(), locale);
  const startMs = taskStartedMs(task); // real spawn time, not the plan-time row insert
  const endMs = parseTs(task.closed_at);
  const duration = startMs != null && endMs != null && endMs >= startMs ? formatDuration(endMs - startMs) : null;

  const meta: { icon: LucideIcon; label: string; value: string; modelIcon?: string }[] = [];
  if (exec || iconExec) meta.push({ icon: Bot, label: t.tasks.resultExecutor, value: exec || iconExec, modelIcon: iconExec });
  if (session) meta.push({ icon: Bot, label: t.tasks.resultAgent, value: session });
  if (finished.label) meta.push({ icon: CalendarCheck, label: t.tasks.resultFinished, value: finished.label });
  if (duration) meta.push({ icon: Clock, label: t.tasks.resultDuration, value: duration });

  return (
    <Modal title={task.title} description={task.id} onClose={onClose} size="md" icon={HeaderIcon}>
      <ModalBody>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={statusTone(task.status)}>{statusLabel(t, task.status)}</Badge>
          <OutcomeBadge outcome={task.outcome} />
          {exec ? <Badge>{exec}</Badge> : null}
          <TaskUsageBadge taskId={task.id} />
        </div>

        {meta.length > 0 ? (
          <dl className="grid grid-cols-2 gap-2">
            {meta.map((m) => (
              <div key={m.label} className="flex flex-col gap-1 rounded-md border border-border bg-elevated/40 p-2.5">
                <dt className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                  <m.icon size={12} aria-hidden /> {m.label}
                </dt>
                <dd className="flex min-w-0 items-center gap-1.5 text-sm text-text">
                  {m.modelIcon ? <ModelIcon name={m.modelIcon} size={16} /> : null}
                  <span className="min-w-0 truncate font-mono text-xs" title={finished.title || m.value}>{m.value}</span>
                </dd>
              </div>
            ))}
          </dl>
        ) : null}

        {task.description?.trim() ? (
          <Section label={t.tasks.fieldDetails}>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-text-muted">{task.description}</p>
          </Section>
        ) : null}

        <Section label={t.tasks.resultTitle}>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-text-muted">
            {task.result_summary?.trim() || t.tasks.noSummary}
          </p>
        </Section>
      </ModalBody>
      <ModalFooter>
        <Button variant="accent" onClick={onClose}>{t.tasks.done}</Button>
      </ModalFooter>
    </Modal>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">{label}</span>
      {children}
    </div>
  );
}
