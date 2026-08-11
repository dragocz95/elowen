import type { MissionStore } from '../store/missionStore.js';

/** Read-only user view with the admin flag, shaped like the core UserStore rows the original read —
 *  the composition root adapts the host's usersRead (isAdmin) onto it. */
export interface PushUsersView { list(): { id: number; is_admin: boolean }[] }

export interface RecipientDeps { missions: MissionStore; users: PushUsersView }

/** User ids that should be notified about a mission: its owner (the user who engaged it) plus every
 *  admin. Deduped. An unknown/owner-less mission falls back to admins only — never throws, so a
 *  deleted mission simply yields no owner. */
export function recipientsForMission(missionId: string, d: RecipientDeps): number[] {
  const ids = new Set<number>();
  const owner = d.missions.get(missionId)?.created_by;
  if (owner != null) ids.add(owner);
  for (const u of d.users.list()) if (u.is_admin) ids.add(u.id);
  return [...ids];
}
