'use client';
import Link from 'next/link';
import { ListChecks, Rocket, ArrowRight, Plus, Radio } from 'lucide-react';
import { useTasks, useSessions, useMissions } from '../../lib/queries';
import { deriveDashboardMetrics } from './metrics';
import { statusTone } from './statusTone';
import { Badge } from '../../components/ui/Badge';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { useTranslation } from '../../lib/i18n';
import { useSessionPane } from '../sessions/useSessionPane';
import { parseAnsi } from '../sessions/ansi';
import { taskExec } from '../../lib/taskExec';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { taskTypeMeta } from '../tasks/taskMeta';
import type { Task } from '../../lib/types';

/** A single live agent lane in the hero: status pulse, model icon, name, current activity line. */
function LiveLane({ name, task }: { name: string; task?: Task }) {
  const { tail } = useSessionPane(name, 4);
  const exec = taskExec(task?.labels);
  const line = parseAnsi(tail).map((s) => s.text).join('').split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '…';
  return (
    <Link href="/sessions" className="flex items-center gap-2.5 rounded-md border border-border bg-bg px-3 py-2 transition-colors hover:border-border-strong">
      <span className="live-dot h-2 w-2 shrink-0 rounded-full bg-accent" style={{ ['--live-ring' as string]: 'color-mix(in srgb, var(--color-info) 50%, transparent)' }} aria-hidden />
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border bg-elevated">
        {exec ? <ModelIcon name={exec} size={13} /> : <Radio size={12} className="text-text-muted" aria-hidden />}
      </span>
      <span className="shrink-0 font-mono text-xs text-text">{name}</span>
      <span className="min-w-0 flex-1 truncate text-[11px] text-text-muted">{line}</span>
    </Link>
  );
}

function Metric({ value, label, tone }: { value: number; label: string; tone?: 'accent' | 'danger' }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className={`font-mono text-xl tabular-nums ${tone === 'danger' ? 'text-danger' : tone === 'accent' ? 'text-accent' : 'text-text'}`}>{value}</span>
      <span className="text-[11px] uppercase tracking-wide text-text-muted">{label}</span>
    </span>
  );
}

export function DashboardView() {
  const { t } = useTranslation();
  const tasks = useTasks();
  const sessions = useSessions();
  const missions = useMissions();

  const metrics = deriveDashboardMetrics(tasks.data, sessions.data, missions.data);
  const TASK_STATUS_LABEL: Record<string, string> = { open: t.tasks.statusOpen, in_progress: t.tasks.statusInProgress, blocked: t.tasks.statusBlocked, closed: t.tasks.statusClosed, cancelled: t.tasks.statusCancelled };
  const MISSION_STATE_LABEL: Record<string, string> = { active: t.missions.stateActive, paused: t.missions.paused, disengaged: t.missions.stateDisengaged };

  const live = (sessions.data ?? []).slice(0, 4);
  const taskForSession = (s: string): Task | undefined => {
    const agent = s.startsWith('orca-') ? s.slice('orca-'.length) : null;
    return agent ? tasks.data?.find((x) => (x.labels ?? []).includes(`agent:${agent}`)) : undefined;
  };
  const recent = (tasks.data ?? []).filter((x) => x.type !== 'epic').slice(0, 6);

  return (
    <div className="flex w-full flex-col gap-5">
      {/* ── Hero: NOW ─────────────────────────────────────────── */}
      <section className="rounded-lg border border-border border-t-2 border-t-accent/40 bg-surface p-5" style={{ boxShadow: 'var(--shadow-card)' }}>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-text-muted">{t.dashboard.now}</span>
          <span className="h-5 w-px bg-border" aria-hidden />
          <Metric value={metrics.inProgress} label={t.dashboard.inProgress} tone="accent" />
          <Metric value={metrics.open} label={t.dashboard.open} />
          <Metric value={metrics.blocked} label={t.dashboard.blocked} tone={metrics.blocked > 0 ? 'danger' : undefined} />
          <Metric value={metrics.liveSessions} label={t.dashboard.liveSessions} />
          <Metric value={metrics.activeMissions} label={t.dashboard.activeMissions} />
        </div>

        <div className="mt-4 flex flex-col gap-2">
          {live.length > 0
            ? live.map((s) => <LiveLane key={s} name={s} task={taskForSession(s)} />)
            : <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-text-muted">{t.dashboard.nothingRunning}</p>}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Link href="/tasks?new=1" className="inline-flex h-9 items-center gap-1.5 rounded-md border border-accent bg-accent px-3.5 text-sm font-medium text-white transition-opacity hover:opacity-90"><Plus size={14} aria-hidden />{t.tasks.newTask}</Link>
          <Link href="/missions?new=1" className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-elevated px-3.5 text-sm font-medium text-text transition-colors hover:border-border-strong"><Rocket size={14} aria-hidden />{t.missions.newMission}</Link>
        </div>
      </section>

      {/* ── Workspace: recent tasks · missions ───────────────────── */}
      <div className="grid gap-5 lg:grid-cols-2">
        {/* recent tasks */}
        <section className="flex flex-col rounded-lg border border-border bg-surface" style={{ boxShadow: 'var(--shadow-card)' }}>
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-2"><ListChecks size={15} className="text-text-muted" aria-hidden /><h2 className="text-sm font-medium text-text">{t.page.tasks}</h2></div>
            <Link href="/tasks" className="inline-flex items-center gap-1 text-xs font-medium text-accent transition-opacity hover:opacity-80">{t.dashboard.viewAll}<ArrowRight size={12} aria-hidden /></Link>
          </div>
          {tasks.isLoading ? <div className="p-4"><LoadingState /></div>
            : tasks.isError ? <div className="p-4"><ErrorState message={t.common.daemonUnreachable} onRetry={() => tasks.refetch()} /></div>
            : recent.length === 0 ? <EmptyState title={t.tasks.empty} icon={ListChecks} />
            : (
              <div className="flex flex-col divide-y divide-border">
                {recent.map((task) => {
                  const Icon = taskTypeMeta(task.type).icon;
                  return (
                    <Link key={task.id} href="/tasks" className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-elevated">
                      <Icon size={14} className="shrink-0 text-text-muted" aria-hidden />
                      <span className="min-w-0 flex-1 truncate text-sm text-text">{task.title}</span>
                      <Badge tone={statusTone(task.status)}>{TASK_STATUS_LABEL[task.status] ?? task.status}</Badge>
                    </Link>
                  );
                })}
              </div>
            )}
        </section>

        {/* missions */}
        <section className="flex flex-col rounded-lg border border-border bg-surface" style={{ boxShadow: 'var(--shadow-card)' }}>
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-2"><Rocket size={15} className="text-text-muted" aria-hidden /><h2 className="text-sm font-medium text-text">{t.page.missions}</h2></div>
            <Link href="/missions" className="inline-flex items-center gap-1 text-xs font-medium text-accent transition-opacity hover:opacity-80">{t.dashboard.viewAll}<ArrowRight size={12} aria-hidden /></Link>
          </div>
          {missions.isLoading ? <div className="p-4"><LoadingState /></div>
            : missions.isError ? <div className="p-4"><ErrorState message={t.common.daemonUnreachable} onRetry={() => missions.refetch()} /></div>
            : !missions.data || missions.data.length === 0 ? <EmptyState title={t.missions.empty} icon={Rocket} />
            : (
              <div className="flex flex-col divide-y divide-border">
                {missions.data.map((m) => {
                  const epic = tasks.data?.find((x) => x.id === m.epic_id);
                  const kids = (tasks.data ?? []).filter((x) => x.parent_id === m.epic_id);
                  const done = kids.filter((x) => x.status === 'closed' || x.status === 'cancelled').length;
                  return (
                    <Link key={m.id} href="/missions" className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-elevated">
                      <span className="min-w-0 flex-1 truncate text-sm text-text">{epic?.title ?? m.epic_id}</span>
                      <span className="shrink-0 font-mono text-[11px] text-text-muted">{done}/{kids.length}</span>
                      <Badge tone={m.state === 'disengaged' ? 'muted' : 'accent'}>{MISSION_STATE_LABEL[m.state] ?? m.state}</Badge>
                    </Link>
                  );
                })}
              </div>
            )}
        </section>
      </div>
    </div>
  );
}
