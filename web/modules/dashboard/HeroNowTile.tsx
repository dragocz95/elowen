'use client';
import { useMemo } from 'react';
import Link from 'next/link';
import { Bot, FileCode2, GitCompareArrows, Plus, Terminal } from 'lucide-react';
import { BentoTile } from './BentoTile';
import { useSessionInfos, useSessionSignals, useTasks, useMissions, useActivity, useMissionChangedFiles } from '../../lib/queries';
import { useSessionPane } from '../../lib/useSessionPane';
import { taskForSession, tailSnippet, agentDisplayName } from '../../lib/agentUtils';
import { compactElapsed, parseTs } from '../../lib/format';
import { useTranslation } from '../../lib/i18n';
import type { SessionInfo } from '../../lib/types';

/** A live equalizer — four dancing bars that only run while the agent is working. */
function Equalizer() {
  return (
    <span className="flex h-3.5 items-end gap-[2.5px]" aria-hidden>
      {[0, 0.18, 0.36, 0.54].map((d, i) => (
        <span key={i} className="eq-bar w-[3px] rounded-[2px] bg-success" style={{ height: '100%', animationDelay: `${d}s` }} />
      ))}
    </span>
  );
}

function Stat({ icon: Icon, value, label }: { icon: typeof FileCode2; value: string; label: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <Icon size={15} className="text-text-muted" aria-hidden />
      <div>
        <div className="font-mono text-[17px] font-semibold leading-none tabular-nums tracking-[-0.03em]">{value}</div>
        <div className="mt-0.5 text-[11px] text-text-muted">{label}</div>
      </div>
    </div>
  );
}

/** The 2×2 focal tile: what Orca is doing *right now*. Picks the primary live agent (a working one, or
 *  the first), the task it's on, and — when that task is a mission phase — the mission's progress and
 *  churn. Shows a live terminal line, a working pill with elapsed time + equalizer, a phase progress
 *  bar, and file/line stats. Falls back to a calm "resting" state with a CTA when no agent runs. */
export function HeroNowTile({ now }: { now: number }) {
  const { t } = useTranslation();
  const infos = useSessionInfos();
  const signals = useSessionSignals();
  const tasks = useTasks();
  const missions = useMissions();
  const activity = useActivity();

  const agents = (infos.data ?? []).filter((s: SessionInfo) => s.role === 'agent');
  const primary = agents.find((s) => signals[s.name]?.type === 'working') ?? agents[0];
  const primaryName = primary?.name ?? '';
  const working = primaryName ? signals[primaryName]?.type === 'working' : false;

  const task = primaryName ? taskForSession(tasks.data ?? [], primaryName) : undefined;
  const epicId = task?.parent_id ?? null;
  const mission = epicId ? (missions.data ?? []).find((m) => m.epic_id === epicId) : undefined;

  const pane = useSessionPane(primaryName, 8, !!primaryName);
  const changed = useMissionChangedFiles(mission?.id ?? '');

  // Phase progress: closed sibling phases over total (only meaningful for a mission phase).
  const progress = useMemo(() => {
    if (!epicId) return null;
    const phases = (tasks.data ?? []).filter((p) => p.parent_id === epicId);
    if (phases.length === 0) return null;
    return { closed: phases.filter((p) => p.status === 'closed').length, total: phases.length };
  }, [tasks.data, epicId]);

  // Elapsed since the task last went in-progress, from the activity log (newest-first).
  const elapsed = useMemo(() => {
    if (!task) return null;
    const ev = (activity.data ?? []).find((e) => e.type === 'task' && e.target === task.id && (e.detail === 'in_progress' || e.detail === 'working'));
    const ts = ev ? parseTs(ev.ts) : null;
    return ts != null ? compactElapsed(now - ts) : null;
  }, [activity.data, task, now]);

  const churn = useMemo(() => {
    const files = changed.data ?? [];
    return files.length ? { files: files.length, added: files.reduce((s, f) => s + f.added, 0) } : null;
  }, [changed.data]);

  const line = tailSnippet(pane.tail);

  // ── Resting: no live agent ──
  if (!primary) {
    return (
      <BentoTile tone="accent" icon={Bot} label={t.dashboard.rightNow} span="hero">
        <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
          <div>
            <h2 className="font-display text-xl font-semibold tracking-[-0.02em]">{t.dashboard.resting}</h2>
            <p className="mt-1.5 text-sm text-text-muted">{t.dashboard.restingDesc}</p>
          </div>
          <Link href="/tasks?new=1" className="inline-flex h-9 items-center gap-1.5 rounded-md border border-accent bg-accent px-3.5 text-sm font-medium text-white transition-[filter] hover:brightness-110">
            <Plus size={14} aria-hidden />{t.tasks.newTask}
          </Link>
        </div>
      </BentoTile>
    );
  }

  return (
    <BentoTile
      tone="accent" icon={Bot} label={t.dashboard.rightNow} span="hero"
      trailing={working ? (
        <div className="flex items-center gap-2.5">
          <Equalizer />
          <span className="inline-flex items-center gap-1.5 rounded-full border border-success/35 bg-success/15 px-2.5 py-1 text-[11px] font-semibold text-success">
            <span className="live-dot h-1.5 w-1.5 rounded-full bg-success" />
            {elapsed ? t.dashboard.running.replace('{d}', elapsed) : t.dashboard.workingNow}
          </span>
        </div>
      ) : undefined}
    >
      <div className="mt-1 flex flex-col gap-1">
        <h2 className="font-display text-xl font-semibold tracking-[-0.025em]">{task?.title ?? agentDisplayName(primaryName)}</h2>
        <p className="text-sm text-text-muted">{t.dashboard.byAgent.replace('{agent}', agentDisplayName(primaryName))}</p>
      </div>

      {line && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-bg px-3 py-2 font-mono text-[12px] text-text-muted">
          <Terminal size={13} className="shrink-0 text-success" aria-hidden />
          <span className="truncate">{line}</span>
        </div>
      )}

      {progress && (
        <div className="mt-auto flex flex-col gap-1.5">
          <div className="flex justify-between text-[12px] text-text-muted">
            <span>{t.dashboard.phaseProgress.replace('{closed}', String(progress.closed)).replace('{total}', String(progress.total))}</span>
            <span className="font-mono tabular-nums">{Math.round((progress.closed / progress.total) * 100)} %</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-elevated">
            <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${(progress.closed / progress.total) * 100}%` }} />
          </div>
        </div>
      )}

      {churn && (
        <div className={`flex gap-6 border-t border-border pt-3 ${progress ? '' : 'mt-auto'}`}>
          <Stat icon={FileCode2} value={String(churn.files)} label={t.dashboard.filesLabel} />
          <Stat icon={GitCompareArrows} value={`+${churn.added}`} label={t.dashboard.linesLabel} />
        </div>
      )}
    </BentoTile>
  );
}
