import type { TmuxDriver } from '../tmux/types.js';

export interface JanitorDeps {
  tmux: TmuxDriver;
  /** Resolve the task an orca- session is working, or null if none is found. */
  taskForSession: (session: string) => { status: string } | null;
}

/**
 * Kill orca- tmux sessions whose task is already closed/cancelled — finished agents
 * (e.g. an exited `opencode run` left at an idle shell) shouldn't linger as zombies.
 * Returns the names of the sessions it reaped.
 */
export async function sweepFinishedSessions(d: JanitorDeps): Promise<string[]> {
  const live = (await d.tmux.list()).filter((s) => s.startsWith('orca-'));
  const reaped: string[] = [];
  for (const session of live) {
    const task = d.taskForSession(session);
    if (task && (task.status === 'closed' || task.status === 'cancelled')) {
      try { await d.tmux.kill(session); reaped.push(session); } catch { /* already gone — ignore */ }
    }
  }
  return reaped;
}
