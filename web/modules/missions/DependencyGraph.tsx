'use client';
import type { MissionTask, MissionDeps } from '../../lib/types';
import { layoutPhases } from './layoutPhases';
import { taskTypeMeta } from '../tasks/taskMeta';

const COL_W = 230, ROW_H = 78, NODE_W = 188, NODE_H = 54, PAD = 14;
const STATUS_COLOR: Record<string, string> = {
  closed: '#22c55e', in_progress: '#3b82f6', blocked: '#ef4444', cancelled: '#6b7280', open: '#6b7280',
};
const isTerminal = (s: string) => s === 'closed' || s === 'cancelled';

/** Node-link dependency graph of an epic's tasks, laid out by topological phase. */
export function DependencyGraph({ tasks, deps, onSelect }: { tasks: MissionTask[]; deps: MissionDeps[]; onSelect?: (id: string) => void }) {
  const phases = layoutPhases(tasks, deps);
  const byId = new Map(tasks.map((t) => [t.id, t]));

  const pos = new Map<string, { x: number; y: number }>();
  phases.forEach((layer, li) => layer.forEach((t, ri) => pos.set(t.id, { x: PAD + li * COL_W, y: PAD + ri * ROW_H })));
  const maxRows = Math.max(1, ...phases.map((l) => l.length));
  const width = PAD * 2 + Math.max(1, phases.length) * COL_W - (COL_W - NODE_W);
  const height = PAD * 2 + maxRows * ROW_H - (ROW_H - NODE_H);

  // A task's dependencies, and whether it is "ready" (all deps terminal) vs "locked".
  const depsByTask = new Map<string, string[]>();
  for (const d of deps) {
    if (byId.has(d.taskId) && byId.has(d.dependsOnId)) {
      const list = depsByTask.get(d.taskId) ?? [];
      list.push(d.dependsOnId);
      depsByTask.set(d.taskId, list);
    }
  }
  const ready = (t: MissionTask) => t.status === 'open' && (depsByTask.get(t.id) ?? []).every((id) => isTerminal(byId.get(id)?.status ?? 'open'));
  const locked = (t: MissionTask) => t.status === 'open' && !ready(t);

  const edges = deps.filter((d) => pos.has(d.taskId) && pos.has(d.dependsOnId));

  return (
    <div className="overflow-auto rounded-lg border border-border bg-bg p-1">
      <svg width={width} height={height} style={{ minWidth: width, display: 'block' }}>
        {/* dependency edges: blocker → dependent */}
        {edges.map((d, i) => {
          const a = pos.get(d.dependsOnId)!;
          const b = pos.get(d.taskId)!;
          const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2;
          const mx = (x1 + x2) / 2;
          const done = isTerminal(byId.get(d.dependsOnId)?.status ?? '');
          return (
            <path
              key={i}
              className="animate-draw"
              pathLength={1}
              style={{ animationDelay: `${Math.min(i, 10) * 40}ms` }}
              d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
              fill="none"
              stroke={done ? '#22c55e' : 'var(--color-border-strong)'}
              strokeWidth={done ? 1.6 : 1.2}
              opacity={done ? 0.8 : 0.55}
            />
          );
        })}
        {/* nodes */}
        {tasks.map((t, ni) => {
          const p = pos.get(t.id);
          if (!p) return null;
          const c = STATUS_COLOR[t.status] ?? '#6b7280';
          const dim = locked(t);
          const running = t.status === 'in_progress';
          const isReady = ready(t);
          const Icon = taskTypeMeta(t.type).icon;
          const border = running ? '#3b82f6' : isReady ? '#3b82f6' : 'var(--color-border)';
          return (
            <foreignObject key={t.id} x={p.x} y={p.y} width={NODE_W} height={NODE_H}>
              <div
                onClick={() => onSelect?.(t.id)}
                className={`animate-pop-in flex h-full items-center gap-2 rounded-lg border bg-surface px-2.5 ${onSelect ? 'cursor-pointer' : ''}`}
                style={{ borderColor: border, borderWidth: running || isReady ? 1.5 : 1, opacity: dim ? 0.55 : 1, animationDelay: `${Math.min(ni, 10) * 40}ms` }}
                title={t.title}
              >
                <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${running ? 'live-dot' : ''}`} style={{ backgroundColor: c, ['--live-ring' as string]: 'rgba(59,130,246,0.5)' }} aria-hidden />
                <Icon size={13} className="shrink-0 text-text-muted" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] leading-tight text-text">{t.title}</div>
                  <div className="text-[10px] capitalize text-text-muted">{isReady ? 'ready' : t.status.replace('_', ' ')}</div>
                </div>
              </div>
            </foreignObject>
          );
        })}
      </svg>
    </div>
  );
}
