'use client';
import { useHealth, usePulse } from '../../lib/queries';
import type { PulsePerson } from '../../lib/types';

export type PresenceState = 'offline' | 'idle' | 'thinking' | 'working' | 'needs_input' | 'success' | 'error';

export interface Presence {
  state: PresenceState;
  /** Whoever the hero speaks for: the first person mid-turn, else nobody. */
  primary?: PulsePerson;
  activeCount: number;
}

/** One visual state for Elowen's presence.
 *
 *  This used to fold daemon health together with classified tmux sessions, counting the `agents`
 *  plugin's unattended workers. That plugin is gone and the question it answered changed with it:
 *  the instance is no longer "how many agents are running" but "who is working right now", which
 *  `/activity/pulse` already reports as the daemon's LIVE view of running turns. Reading it here
 *  keeps a single source for that fact — the pulse tile below the hero draws the same flag.
 *
 *  Only three of the states are reachable from the data available today. `thinking`, `needs_input`,
 *  `success` and `error` remain in the union because `ElowenPresence` styles them and the dictionary
 *  names them, and because the signal that would produce them — a parked question, a failed turn — is
 *  per-conversation state the chat surface owns rather than something the dashboard aggregates. If an
 *  instance-wide aggregate ever lands, this is the one place that has to learn about it.
 */
export function usePresence(): Presence {
  const health = useHealth();
  const pulse = usePulse();
  const offline = health.isError || (health.data != null && health.data.ok !== true);
  const working = (pulse.data?.people ?? []).filter((person) => person.working);

  return {
    // Cached pulse data is not trustworthy while the daemon is unreachable: showing "2 working"
    // beside "Offline" would be two contradictory claims drawn from the same screen.
    state: offline ? 'offline' : working.length > 0 ? 'working' : 'idle',
    primary: offline ? undefined : working[0],
    activeCount: offline ? 0 : working.length,
  };
}
