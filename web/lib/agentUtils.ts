import type { Task, DerivedSignal } from './types';
import { parseAnsi } from '../modules/sessions/ansi';

const AGENT_PREFIX = 'agent:';

/** Extract the agent name from a task's `agent:<name>` label, if present. */
export function taskAgentName(task: Pick<Task, 'labels'>): string | null {
  const label = task.labels?.find((l) => l.startsWith(AGENT_PREFIX));
  return label ? label.slice(AGENT_PREFIX.length) : null;
}

/** The tmux session name (`orca-<agent>`) for a task's agent, or null if it has none. */
export function taskSessionName(task: Pick<Task, 'labels'>): string | null {
  const agent = taskAgentName(task);
  return agent ? `orca-${agent}` : null;
}

/** Normalize a SQLite ("2026-06-18 10:38:49", UTC) or ISO timestamp to epoch ms. */
export function parseTs(iso?: string | null): number | null {
  if (!iso) return null;
  const norm = iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z';
  const ms = new Date(norm).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** Compact, language-neutral elapsed time (e.g. "12s", "3m", "5h", "2d") since the task started. */
export function taskElapsed(task: Pick<Task, 'created_at'>, nowMs: number): string | null {
  const start = parseTs(task.created_at);
  if (start == null) return null;
  const secs = Math.max(0, Math.floor((nowMs - start) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export interface DepEdge { task_id: string; depends_on_id: string }

/** Unresolved dependencies (not closed/cancelled) that keep a task blocked. */
export function taskBlockers(taskId: string, deps: DepEdge[], byId: Map<string, Task>): Task[] {
  return deps
    .filter((d) => d.task_id === taskId)
    .map((d) => byId.get(d.depends_on_id))
    .filter((t): t is Task => !!t && t.status !== 'closed' && t.status !== 'cancelled');
}

export type LiveState = 'working' | 'needs_input' | 'complete' | 'idle';

/** Resolve the agent's live state from its SSE signal and whether its session is live.
 *  The signal is authoritative when present; a live session with no signal yet reads as working. */
export function liveState(signal: DerivedSignal | undefined, live: boolean): LiveState {
  if (signal?.type === 'needs_input') return 'needs_input';
  if (live || signal?.type === 'working') return 'working';
  if (signal?.type === 'complete') return 'complete';
  return 'idle';
}

/** Last non-empty terminal line, with ANSI escapes stripped — for a one-line live preview. */
export function tailSnippet(pane: string): string {
  const lines = pane.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const text = parseAnsi(lines[i]).map((s) => s.text).join('').trim();
    if (text) return text;
  }
  return '';
}
