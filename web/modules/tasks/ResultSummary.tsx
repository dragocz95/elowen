'use client';
import { ScrollText } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import type { Task } from '../../lib/types';

/** The closed-task "what the agent did / result" block. Shared by the single-task detail pane and the
 *  mission flow so both surfaces render the summary identically. Renders nothing for an open task or
 *  one with no summary/outcome. An epic gets the mission-summary label, a task the result label.
 *  `accent` lifts it to a highlighted hero card (used at the top of the mission view). */
export function ResultSummary({ task, className = '', accent = false }: { task: Pick<Task, 'status' | 'type' | 'result_summary' | 'outcome'>; className?: string; accent?: boolean }) {
  const { t } = useTranslation();
  const isClosed = task.status === 'closed' || task.status === 'cancelled';
  if (!isClosed || !(task.result_summary || task.outcome)) return null;
  const label = task.type === 'epic' ? t.tasks.missionSummaryTitle : t.tasks.resultTitle;
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <span className={`text-[11px] font-semibold uppercase tracking-wide ${accent ? 'text-accent' : 'text-text-muted'}`}>{label}</span>
      <div className={`flex items-start gap-2.5 rounded-lg border p-3.5 ${accent ? 'border-accent/30 bg-accent/[0.07]' : 'border-border bg-elevated'}`} style={accent ? { boxShadow: 'var(--shadow-card)' } : undefined}>
        <ScrollText size={15} className={`mt-0.5 shrink-0 ${accent ? 'text-accent' : 'text-text-muted'}`} aria-hidden />
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-text">{task.result_summary?.trim() || t.tasks.noSummary}</p>
      </div>
    </div>
  );
}
