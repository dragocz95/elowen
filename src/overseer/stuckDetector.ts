import type { TaskStore } from '../store/taskStore.js';
import type { EventBus } from '../api/sse.js';
import type { Task } from '../store/types.js';

const agentOf = (t: Task): string | null => t.labels.find((l) => l.startsWith('agent:'))?.slice('agent:'.length) ?? null;

/** Epoch-ms the task's agent was spawned: the precise `started:<ms>` label, falling back to the
 *  whole-second `created_at` (stored UTC). Null only for a task that has neither. */
function startedOf(t: Task): number | null {
  const label = t.labels.find((l) => l.startsWith('started:'));
  if (label) { const n = Number(label.slice('started:'.length)); if (Number.isFinite(n)) return n; }
  if (t.created_at) { const n = Date.parse(t.created_at.replace(' ', 'T') + 'Z'); if (Number.isFinite(n)) return n; }
  return null;
}

/** in_progress tasks whose agent tmux session is no longer live — the agent exited or crashed
 *  (no `orca close`), or the task never got an agent label. Shared by the startup zombie
 *  reconcile and the runtime stuck detector. */
export function deadAgentTasks(liveSessions: Set<string>, inProgress: Task[]): Task[] {
  return inProgress.filter((t) => { const name = agentOf(t); return !name || !liveSessions.has(`orca-${name}`); });
}

export interface StuckDetectorDeps {
  tmux: { list(): Promise<string[]> };
  tasks: TaskStore;
  bus: EventBus;
  /** Current epoch ms (injected for testability). */
  now: number;
  /** Don't reap a task started < graceMs ago — covers the brief setStatus→tmux.spawn window. */
  graceMs: number;
  /** After this many dead-agent reverts, escalate (set `blocked`) instead of relaunching. */
  maxRelaunch: number;
}

/**
 * Detect agents that died without `orca close`: their task is stuck `in_progress` while the tmux
 * session is gone, so the mission would never advance. Each such task is reverted to `open` (so the
 * mission/scheduler re-spawns it) until it has been relaunched `maxRelaunch` times, after which it
 * is escalated to a human (`blocked`) to avoid an infinite crash loop.
 * Returns the task ids it touched.
 */
export async function sweepStuckTasks(d: StuckDetectorDeps): Promise<{ reverted: string[]; escalated: string[] }> {
  const live = new Set((await d.tmux.list()).filter((s) => s.startsWith('orca-')));
  const reverted: string[] = []; const escalated: string[] = [];
  for (const t of deadAgentTasks(live, d.tasks.list({ status: 'in_progress' }))) {
    const started = startedOf(t);
    if (started != null && d.now - started < d.graceMs) continue; // freshly spawned — not stuck
    // `stuck:<n>` counts total relaunches of this task instance. We never reset it: a child runs
    // to completion once, so the only thing it bounds is how many times we re-spawn a dying agent
    // before handing it to a human. This guarantees a flaky task always escalates eventually
    // (no silent infinite churn), at the cost of escalating a task whose agent died maxRelaunch+1
    // times even if the deaths were spread out — which, for an autonomous run, is the safe default
    // (escalation is recoverable: a human un-blocks it).
    const count = d.tasks.bumpStuck(t.id);
    if (count > d.maxRelaunch) {
      d.tasks.setStatus(t.id, 'blocked');
      d.bus.publish({ type: 'task', taskId: t.id, status: 'blocked' });
      escalated.push(t.id);
    } else {
      d.tasks.setStatus(t.id, 'open');
      d.bus.publish({ type: 'task', taskId: t.id, status: 'open' });
      reverted.push(t.id);
    }
  }
  return { reverted, escalated };
}
