import type { Task, DerivedSignal } from './types';
import { parseAnsi } from './ansi';
import { compactElapsed, parseTs } from './format';

const AGENT_PREFIX = 'agent:';
const EXEC_PREFIX = 'exec:';

/** The exec spec from a task's `exec:<spec>` label, or '' if it has none. */
export function taskExec(labels?: string[]): string {
  const label = labels?.find((l) => l.startsWith(EXEC_PREFIX));
  return label ? label.slice(EXEC_PREFIX.length) : '';
}

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

/** The epic id a mission governs: `m-orca-1234` → `orca-1234` (mission ids are `m-${epicId}`). */
export function missionEpicId(missionId: string): string {
  return missionId.replace(/^m-/, '');
}

/** Epoch ms the task's agent actually spawned: the precise `started:<ms>` label, falling back to
 *  `created_at`. For a mission, every child row is created up front at plan time, so `created_at`
 *  long predates the agent's real start — only `started:<ms>` reflects when work began. */
export function taskStartedMs(task: Pick<Task, 'labels' | 'created_at'>): number | null {
  const label = task.labels?.find((l) => l.startsWith('started:'));
  if (label) { const n = Number(label.slice('started:'.length)); if (Number.isFinite(n)) return n; }
  return parseTs(task.created_at);
}

/** Compact, language-neutral elapsed time (e.g. "12s", "3m", "5h", "2d") the agent has run. */
export function taskElapsed(task: Pick<Task, 'labels' | 'created_at' | 'closed_at' | 'status'>, nowMs: number): string | null {
  const start = taskStartedMs(task);
  if (start == null) return null;
  // A finished task's run is frozen at its close time — otherwise the duration keeps growing
  // from 'now' and reads as if the agent were still working.
  const finished = task.status === 'closed' || task.status === 'cancelled';
  const end = finished ? (parseTs(task.closed_at) ?? nowMs) : nowMs;
  return compactElapsed(end - start);
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

/** Keys that select an option in an agent's multiple-choice list UI. The list opens with option 1
 *  focused, so the 1-based position id maps to Down × (id-1) then Enter — the same navigation the
 *  daemon's deriver uses when the overseer picks. Shared by every surface that answers a question. */
export function keysForOption(id: string): string[] {
  const steps = Math.max(0, Number(id) - 1);
  return [...Array<string>(steps).fill('Down'), 'Enter'];
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
