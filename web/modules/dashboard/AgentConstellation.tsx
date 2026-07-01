'use client';
import Link from 'next/link';
import { Radar, Radio } from 'lucide-react';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { AgentStatusDot } from '../../components/ui/AgentStatusDot';
import { EmptyState } from '../../components/ui/states';
import { useSessionStall } from '../../lib/useSessionStall';
import { useSessionPane } from '../../lib/useSessionPane';
import { sessionActivity } from '../../lib/sessionActivity';
import { agentDisplayName, taskExec, taskForSession } from '../../lib/agentUtils';
import { useTranslation } from '../../lib/i18n';
import type { SessionInfo, DerivedSignal, Task } from '../../lib/types';

/** Place N agents evenly on an orbit around the hub. Elliptical radii (wider than tall) leave room
 *  for the name labels without clipping at the container edges. Percentages so it scales fluidly. */
function orbitPosition(i: number, n: number): { x: number; y: number } {
  const angle = (-90 + (i * 360) / Math.max(1, n)) * (Math.PI / 180);
  return { x: 50 + 38 * Math.cos(angle), y: 50 + 34 * Math.sin(angle) };
}

function ConstellationNode({ session, signal, task, pos }: { session: SessionInfo; signal?: DerivedSignal; task?: Task; pos: { x: number; y: number } }) {
  const exec = taskExec(task?.labels) || session.agent;
  const { state: stall, silenceSec } = useSessionStall(session.name, true);
  // Surface a raw pane condition the derived signal can miss — an errored or prompt-blocked agent
  // (the old per-agent lane flagged this; keep it visible on the node's ring).
  const { tail } = useSessionPane(session.name, 8, true);
  const activity = sessionActivity(tail);
  const ring = activity === 'error' ? 'border-danger' : activity === 'prompted' ? 'border-warning' : 'border-border hover:border-border-strong';
  return (
    <Link
      href="/sessions"
      title={task?.title ?? agentDisplayName(session.name)}
      className="absolute flex w-24 -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1"
      style={{ left: `${pos.x}%`, top: `${pos.y}%` }}
    >
      <span className={`relative flex h-10 w-10 items-center justify-center rounded-xl border bg-elevated transition-colors ${ring}`}>
        {exec ? <ModelIcon name={exec} size={18} /> : <Radio size={16} className="text-text-muted" aria-hidden />}
        <span className="absolute -right-1 -top-1">
          <AgentStatusDot signal={signal} live stall={stall} silenceSec={silenceSec} />
        </span>
      </span>
      <span className="max-w-full truncate font-mono text-[11px] text-text">{agentDisplayName(session.name)}</span>
    </Link>
  );
}

/** The agent constellation: live agents as nodes orbiting a central Orca hub on a faint sonar
 *  backdrop, each pulsing with its live state and linking to the sessions view. This is the
 *  dashboard's "something is happening" centrepiece; empty, it reads as a quiet radar. */
export function AgentConstellation({ sessions, signals, tasks }: { sessions: SessionInfo[]; signals: Record<string, DerivedSignal>; tasks: Task[] }) {
  const { t } = useTranslation();
  const agents = sessions.filter((s) => s.role === 'agent');

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-widest text-text-muted">{t.dashboard.constellation}</h2>
      {agents.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface" style={{ boxShadow: 'var(--shadow-card)' }}>
          <EmptyState title={t.dashboard.constellationEmpty} description={t.dashboard.constellationEmptyDesc} icon={Radar} />
        </div>
      ) : (
        <div className="relative h-64 overflow-hidden rounded-lg border border-border bg-surface" style={{ boxShadow: 'var(--shadow-card)' }}>
          {/* Sonar backdrop: concentric rings, kept circular via CSS (aspect-ratio-independent). */}
          <div aria-hidden className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
            {[220, 150, 80].map((d) => (
              <span key={d} className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-border/40" style={{ width: d, height: d }} />
            ))}
            <span className="live-dot absolute -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ width: 80, height: 80, ['--live-ring' as string]: 'color-mix(in srgb, var(--color-accent) 22%, transparent)' }} />
          </div>
          {/* Connector lines hub → each node (linear map, so preserveAspectRatio none is fine). */}
          <svg aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
            {agents.map((s, i) => {
              const p = orbitPosition(i, agents.length);
              return <line key={s.name} x1={50} y1={50} x2={p.x} y2={p.y} stroke="var(--color-border-strong)" strokeWidth={0.3} />;
            })}
          </svg>
          {/* Central Orca hub. */}
          <span className="absolute left-1/2 top-1/2 flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-accent/40 bg-elevated">
            <Radar size={16} className="text-accent" aria-hidden />
          </span>
          {agents.map((s, i) => (
            <ConstellationNode key={s.name} session={s} signal={signals[s.name]} task={taskForSession(tasks, s.name)} pos={orbitPosition(i, agents.length)} />
          ))}
        </div>
      )}
    </section>
  );
}
