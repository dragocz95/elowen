'use client';
import { useHealth, useSessionInfos, useSessionSignals } from '../../lib/queries';
import type { SessionInfo } from '../../lib/types';

export type AgentPresenceState = 'offline' | 'idle' | 'thinking' | 'working' | 'needs_input' | 'success' | 'error';

export interface AgentPresence {
  state: AgentPresenceState;
  primary?: SessionInfo;
  activeCount: number;
  waitingCount: number;
}

/** One visual state for Elowen's presence. It folds the existing daemon health + classified sessions
 *  + derived signal cache; the visual layer never parses tmux names or invents another runtime state. */
export function useAgentPresence(): AgentPresence {
  const health = useHealth();
  const sessions = useSessionInfos();
  const signals = useSessionSignals();
  const agents = (sessions.data ?? []).filter((session: SessionInfo) => session.role === 'agent');
  const waiting = agents.filter((session) => signals[session.name]?.type === 'needs_input');
  const working = agents.filter((session) => signals[session.name]?.type === 'working');
  const complete = agents.filter((session) => signals[session.name]?.type === 'complete');
  const offline = health.isError || (health.data != null && health.data.ok !== true);

  let state: AgentPresenceState;
  if (offline) state = 'offline';
  else if (waiting.length > 0) state = 'needs_input';
  else if (working.length > 0) state = 'working';
  else if (complete.length > 0) state = 'success';
  else if (agents.length > 0) state = 'thinking';
  else state = 'idle';

  return {
    state,
    // Cached tmux/session data is not trustworthy while the daemon is unreachable. Hiding it avoids
    // contradictory "Offline" + "Agents working" UI until health recovers and queries refresh.
    primary: offline ? undefined : waiting[0] ?? working[0] ?? complete[0] ?? agents[0],
    activeCount: offline ? 0 : agents.length,
    waitingCount: offline ? 0 : waiting.length,
  };
}
