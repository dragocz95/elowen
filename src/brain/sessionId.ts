/** Brain session id conventions — the ONE place the `brain-*` prefixes live. Three kinds share the
 *  `brain_sessions` table: user conversations (`brain-<uid>` / `brain-<uid>-<ts36>` for fresh ones),
 *  platform channel sessions (`brain-ch-<channel>`) and task-worker sessions (`brain-task-<id>`).
 *  Channel/task sessions are never listable, resumable or deletable through the user-facing routes. */

export function defaultUserSessionId(userId: number): string {
  return `brain-${userId}`;
}

export function freshUserSessionId(userId: number): string {
  // Timestamp for rough ordering + a random suffix so two clients opening fresh conversations in the
  // same millisecond (two CLIs launched together) can never mint the SAME id and share a session.
  return `brain-${userId}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function channelSessionId(channelId: string): string {
  return `brain-ch-${channelId}`;
}

/** A fresh, unique id to ARCHIVE a channel conversation under when it idle-rolls over: the old
 *  transcript is re-keyed here so it stays browsable (it's still a `brain-ch-*` session → shows in the
 *  admin sessions view, stays out of the personal chat list/search), while the deterministic
 *  `channelSessionId` is freed for the fresh session. Suffixed with a timestamp + random tail so
 *  repeated rollovers on the same channel never collide. Mirrors owner-chat's `freshUserSessionId`
 *  suffix scheme, but here the NEW id is the archive and the deterministic one carries the fresh turn. */
export function archivedChannelSessionId(channelId: string): string {
  return `brain-ch-${channelId}-arch-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function taskSessionId(taskId: string): string {
  return `brain-task-${taskId}`;
}

function isChannelSession(id: string): boolean {
  return id.startsWith('brain-ch-');
}

function isTaskSession(id: string): boolean {
  return id.startsWith('brain-task-');
}

/** Not a user conversation — excluded from the user's session list / resume / delete. */
export function isNonUserSession(id: string): boolean {
  return isChannelSession(id) || isTaskSession(id);
}

/** The deterministic tmux session name for an admin's interactive `elowen chat` terminal bound to one
 *  brain conversation. Derived (never reverse-hashed): the DB row stays authoritative for the exact
 *  `brainSessionId` + token, while `classifySession` can extract the owner userId back out of the name.
 *    brain-<uid>        → elowen-chat-<uid>-default
 *    brain-<uid>-<tail> → elowen-chat-<uid>-<tail>
 *  The `chat-` prefix is reserved (workers are personas, advisors use `advisor-`), so it never collides. */
export function brainTerminalName(userId: number, brainSessionId: string): string {
  const tail = brainSessionId === defaultUserSessionId(userId)
    ? 'default'
    : brainSessionId.slice(`brain-${userId}-`.length);
  return `elowen-chat-${userId}-${tail}`;
}
