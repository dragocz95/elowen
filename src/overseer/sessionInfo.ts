/** Structured identity of a live agent tmux session, derived from the daemon's own naming
 *  convention. The daemon owns how it names sessions, so classifying them here keeps the role a
 *  first-class fact the API exposes — clients never reverse-engineer meaning from the raw name. */
export type SessionRole = 'overseer' | 'pilot' | 'agent';

export interface SessionInfo {
  /** The tmux session id (`orca-…`) — the stable handle for all session operations. */
  name: string;
  role: SessionRole;
  /** Friendly agent name (`Patricita`); empty for the overseer, which has no agent persona. */
  agent: string;
  /** The mission this overseer governs (role `overseer` only). */
  missionId?: string;
}

const ORCA = 'orca-';
const OVERSEER = 'overseer-';
const PILOT = 'pilot-';

/** Classify a live session name into its role + identity. Mirrors the spawn-time conventions:
 *  overseer → `orca-overseer-<missionId>`, pilot → `orca-pilot-<name>`, worker → `orca-<name>`. */
export function classifySession(name: string): SessionInfo {
  const bare = name.startsWith(ORCA) ? name.slice(ORCA.length) : name;
  if (bare.startsWith(OVERSEER)) return { name, role: 'overseer', agent: '', missionId: bare.slice(OVERSEER.length) };
  if (bare.startsWith(PILOT)) return { name, role: 'pilot', agent: bare.slice(PILOT.length) };
  return { name, role: 'agent', agent: bare };
}
