'use client';
import { ChevronRight } from 'lucide-react';
import type { Task } from '../../lib/types';
import { ProgressRibbon } from '../../components/ui/ProgressRibbon';
import { taskTypeMeta } from '../tasks/taskMeta';
import { epicProgress, epicLive } from '../../lib/taskTree';
import { useSessions, useSessionSignals } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';

/** Collapsible epic (autopilot) container on the board — header with progress + aggregate live
 *  state; its phases stay hidden until expanded so the board isn't flooded with sub-tasks. */
export function KanbanEpicCard({ epic, phases, expanded, onToggle }: { epic: Task; phases: Task[]; expanded: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const sessions = useSessions();
  const signals = useSessionSignals();
  const { done, total } = epicProgress(phases);
  const { running, needsInput } = epicLive(phases, sessions.data ?? [], signals);
  const Icon = taskTypeMeta('epic').icon;
  const active = needsInput > 0 || running > 0;
  const dotColor = needsInput > 0 ? 'var(--color-warning)' : running > 0 ? 'var(--color-success)' : 'var(--color-border-strong)';
  const dotRing = needsInput > 0 ? 'color-mix(in srgb, var(--color-warning) 50%, transparent)' : 'color-mix(in srgb, var(--color-success) 50%, transparent)';

  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      aria-label={`${epic.title} — ${expanded ? t.tasks.collapsePhases : t.tasks.expandPhases}`}
      onClick={onToggle}
      onKeyDown={(e) => { if (e.key === 'Enter') onToggle(); }}
      className="flex cursor-pointer flex-col gap-2 rounded-md border border-accent/30 bg-accent/[0.04] p-2.5 transition-colors hover:border-accent/50"
    >
      <div className="flex items-center gap-2">
        <ChevronRight size={14} className={`shrink-0 text-text-muted transition-transform ${expanded ? 'rotate-90' : ''}`} aria-hidden />
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-elevated"><Icon size={15} className="text-accent" aria-hidden /></span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text">{epic.title}</span>
        {active ? <span className={`h-2 w-2 shrink-0 rounded-full ${active ? 'live-dot' : ''}`} style={{ backgroundColor: dotColor, ['--live-ring' as string]: dotRing }} aria-hidden /> : null}
      </div>
      <div className="flex items-center gap-2 pl-6">
        <ProgressRibbon phases={phases} className="flex-1" />
        <span className="shrink-0 font-mono text-[11px] text-text-muted">{done}/{total}</span>
      </div>
    </div>
  );
}
