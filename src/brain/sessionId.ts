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

/** The one place the `brain-*` session-id prefixes are written. Everything else (minters, predicates,
 *  strippers, and the store's SQL) derives from these so a rename can never leave a stale literal that
 *  silently stops matching (a task session leaking into personal-chat search, an ownership gate misfiring). */
export const CHANNEL_PREFIX = 'brain-ch-';
export const TASK_PREFIX = 'brain-task-';
/** The platform name the subagent plugin registers itself under. A channel session id is built as
 *  CHANNEL_PREFIX + `<platform>-<channelId>` (see `keyOf` in platforms.ts), so this string is the ONLY
 *  thing tying a delegated session to {@link isSubagentSession} — and the plugin mints the channelId
 *  half itself. Renaming the platform on one side alone would silently reclassify every sub-agent as an
 *  ordinary channel: recall gating, the delegation listing and the retention janitor all key off that
 *  predicate. `subagentSessionIdParity.test.ts` holds both sides together. */
export const SUBAGENT_PLATFORM = 'subagent';
/** Delegated sub-agent sessions are a sub-family of channel sessions (internal — reached via
 *  {@link isSubagentSession}). */
const SUBAGENT_PREFIX = `${CHANNEL_PREFIX}${SUBAGENT_PLATFORM}-`;

/** The session id a delegated turn lands on, given the channelId the subagent plugin minted for it.
 *  Mirrors what platforms.ts builds — the one place a test can ask "does the router still recognise
 *  what the plugin mints?" without reaching into either. */
export function subagentSessionId(channelId: string): string {
  return `${CHANNEL_PREFIX}${SUBAGENT_PLATFORM}-${channelId}`;
}

export function channelSessionId(channelId: string): string {
  return `${CHANNEL_PREFIX}${channelId}`;
}

/** A fresh, unique id to ARCHIVE a channel conversation under when it idle-rolls over: the old
 *  transcript is re-keyed here so it stays browsable (it's still a `brain-ch-*` session → shows in the
 *  admin sessions view, stays out of the personal chat list/search), while the deterministic
 *  `channelSessionId` is freed for the fresh session. Suffixed with a timestamp + random tail so
 *  repeated rollovers on the same channel never collide. Mirrors owner-chat's `freshUserSessionId`
 *  suffix scheme, but here the NEW id is the archive and the deterministic one carries the fresh turn. */
export function archivedChannelSessionId(channelId: string): string {
  return `${CHANNEL_PREFIX}${channelId}-arch-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function taskSessionId(taskId: string): string {
  return `${TASK_PREFIX}${taskId}`;
}

export function isChannelSession(id: string): boolean {
  return id.startsWith(CHANNEL_PREFIX);
}

export function isTaskSession(id: string): boolean {
  return id.startsWith(TASK_PREFIX);
}

/** A delegated sub-agent session (a channel sub-family). */
export function isSubagentSession(id: string): boolean {
  return id.startsWith(SUBAGENT_PREFIX);
}

/** WHOSE personal skills a session may load. A skill set is fixed at spawn, so a SHARED channel — where
 *  the sender changes from turn to turn — can only carry the instance-wide ones; a sub-agent is
 *  channel-keyed too but serves exactly ONE owner, so it inherits that owner's set. */
export function skillOwnerForSession(sessionId: string, ownerUserId: number | null | undefined): number | null {
  if (isChannelSession(sessionId) && !isSubagentSession(sessionId)) return null;
  return ownerUserId ?? null;
}

/** Recover the channel id from a `brain-ch-*` session id (inverse of {@link channelSessionId}). */
export function channelIdOf(id: string): string {
  return id.slice(CHANNEL_PREFIX.length);
}

/** Not a user conversation — excluded from the user's session list / resume / delete. */
export function isNonUserSession(id: string): boolean {
  return isChannelSession(id) || isTaskSession(id);
}

/** The three-clause "this is the caller's own continuable conversation" rule — the row exists, the caller
 *  owns it, and it is a real user conversation (not a channel/task session). The single predicate the
 *  delete / rename / terminal / originSend paths share so the rule can't drift between them. */
export function isOwnedUserSession<T extends { user_id: number }>(row: T | undefined, userId: number, sessionId: string): row is T {
  return !!row && row.user_id === userId && !isNonUserSession(sessionId);
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
