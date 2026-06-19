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

/** The friendly agent name from a session id: `orca-Iris` → `Iris`. Falls back to the raw id. */
export function agentDisplayName(session: string): string {
  return session.replace(/^orca-/, '') || session;
}

/** Normalize a SQLite ("2026-06-18 10:38:49", UTC) or ISO timestamp to epoch ms. */
export function parseTs(iso?: string | null): number | null {
  if (!iso) return null;
  const norm = iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z';
  const ms = new Date(norm).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** Compact, language-neutral elapsed time (e.g. "12s", "3m", "5h", "2d") since the task started. */
export function taskElapsed(task: Pick<Task, 'created_at' | 'closed_at' | 'status'>, nowMs: number): string | null {
  const start = parseTs(task.created_at);
  if (start == null) return null;
  // A finished task's run is frozen at its close time — otherwise the duration keeps growing
  // from 'now' and reads as if the agent were still working.
  const finished = task.status === 'closed' || task.status === 'cancelled';
  const end = finished ? (parseTs(task.closed_at) ?? nowMs) : nowMs;
  const secs = Math.max(0, Math.floor((end - start) / 1000));
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

export type LiveState = 'working' | 'needs_input' | 'complete' | 'idle' | 'stalled' | 'stuck';

/** Resolve the agent's live state from its SSE signal and whether its session is live.
 *  The signal is authoritative when present; a live session with no signal yet reads as working. */
export function liveState(signal: DerivedSignal | undefined, live: boolean): LiveState {
  if (signal?.type === 'needs_input') return 'needs_input';
  if (live || signal?.type === 'working') return 'working';
  if (signal?.type === 'complete') return 'complete';
  return 'idle';
}

/** Live session names currently asking for human input. */
export function needsInputSessions(sessions: string[], signals: Record<string, DerivedSignal>): string[] {
  return sessions.filter((s) => signals[s]?.type === 'needs_input');
}

/** The most recently closed task (by closed_at), for the "last outcome" surfaces. */
export function lastClosedTask(tasks: Task[]): Task | null {
  const closed = tasks.filter((x) => x.status === 'closed');
  if (closed.length === 0) return null;
  return closed.reduce((a, b) => ((parseTs(b.closed_at) ?? 0) > (parseTs(a.closed_at) ?? 0) ? b : a));
}

/** Resolve the task a live session (`orca-<agent>`) belongs to. Agent names come from a small
 *  pool and get reused across tasks, so prefer an in_progress match, then the most recent. */
export function taskForSession(tasks: Task[], sessionName: string): Task | undefined {
  if (!sessionName.startsWith('orca-')) return undefined;
  const label = `${AGENT_PREFIX}${sessionName.slice('orca-'.length)}`;
  const matches = tasks.filter((t) => (t.labels ?? []).includes(label));
  if (matches.length <= 1) return matches[0];
  return matches.find((t) => t.status === 'in_progress')
    ?? [...matches].sort((a, b) => (parseTs(b.created_at) ?? 0) - (parseTs(a.created_at) ?? 0))[0];
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
