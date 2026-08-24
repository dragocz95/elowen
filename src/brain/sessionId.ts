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
export const SUBAGENT_PREFIX = `${CHANNEL_PREFIX}${SUBAGENT_PLATFORM}-`;

/** The cronjob plugin's scheduled runs. Like `subagent` this is a PLATFORM name (the plugin routes with
 *  `platform: 'cron', channelId: 'job-<id>'`), so the core is naming a platform here, not guessing at a
 *  string shape. It has to know it for the same reason it knows `subagent`: retention must be able to
 *  tell a one-shot RUN from a conversation people come back to. */
export const CRON_PLATFORM = 'cron';
export const CRON_PREFIX = `${CHANNEL_PREFIX}${CRON_PLATFORM}-`;

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

/** A session that recorded ONE finished run rather than a conversation anyone returns to: a delegated
 *  sub-agent, or a scheduled cron execution. Both are minted fresh per run and never reused, so they
 *  accumulate without bound — 2594 of 2683 sessions on this instance when it was first measured.
 *
 *  They wear the `brain-ch-` prefix purely because they route through the channel machinery, and the
 *  retention janitor used to exclude the whole prefix as "channel shells that must never be deleted".
 *  That is right for a Discord channel, which is a LIVE resource holding an ongoing conversation with
 *  people; it is wrong for these, and the effect was that retention could reach 5 sessions out of 2683.
 *  A real platform channel is deliberately NOT included here. */
export function isEphemeralRunSession(id: string): boolean {
  return isSubagentSession(id) || id.startsWith(CRON_PREFIX);
}

/** Archived channel transcript produced by {@link archivedChannelSessionId}; never a live delivery target. */
export function isArchivedChannelSession(id: string): boolean {
  return isChannelSession(id) && /-arch-[a-z0-9]+$/.test(id);
}

/** WHOSE personal contributions — skills, and any owner-scoped plugin tool — a turn may reach. THE one
 *  answer: the spawner composes a session's skill set from it, the channel service announces that set per
 *  turn from it, and it is what every surface puts on the turn scope for `currentContributionUserId()`, so
 *  what the model is TOLD it may load and what a tool will actually load for it cannot drift apart.
 *
 *  An own conversation (owner chat, task worker) is its owner's, and so is a DIRECT 1:1 platform chat:
 *  it has exactly one human in it.
 *
 *  A SHARED room does not belong to whoever opened it — its sender changes from turn to turn — so it has
 *  no session-wide answer at all and resolves to the VERIFIED WRITER of the turn in flight, and to nobody
 *  when that writer is unlinked, when the turn is a cron job running as no account, or when it is instance
 *  automation. Never the row owner: their private skill names, descriptions and file paths would otherwise
 *  surface for whichever colleague happens to be writing. Same rule `liveRecallUserId` applies to memories
 *  one screen up, and for the same reason.
 *
 *  A sub-agent serves exactly one turn, so it may inherit personal contributions — but from the turn that
 *  DELEGATED it, never from the account that happens to own its session row. Those differ precisely in the
 *  dangerous case: a child spawned out of a shared room is owned by the row owner, so inheriting on the row
 *  would hand that account's private skills to whichever room member triggered the delegation. A child of a
 *  non-shared parent therefore takes the row owner (they are the same person), and a child of a room takes
 *  the writer its caller read off the parent's LIVE record — never the row, and nobody when the parent is
 *  gone or its writer unlinked. */
export function contributionOwnerForSession(
  sessionId: string,
  ownerUserId: number | null | undefined,
  opts: {
    parentSessionId?: string;
    /** The session is a DIRECT 1:1 platform chat (see `direct` in schema.sql). A sub-agent is intentionally
     *  left out: proving its PARENT is direct needs that parent's row, which this pure predicate does not
     *  have, and guessing here is exactly the leak described above. */
    direct?: boolean;
    /** The account writing THIS turn — the room's verified sender, or (for a delegated child) the writer of
     *  the parent turn that spawned it. Absent wherever the session already has one owner. */
    writerUserId?: number | null;
  } = {},
): number | null {
  const writer = opts.writerUserId != null && opts.writerUserId > 0 ? opts.writerUserId : null;
  if (isSubagentSession(sessionId)) {
    if (!opts.parentSessionId) return null;
    return isChannelSession(opts.parentSessionId) ? writer : ownerUserId ?? null;
  }
  if (isChannelSession(sessionId)) return opts.direct ? ownerUserId ?? null : writer;
  return ownerUserId ?? null;
}

/** Whether this session resolves WHOSE personal contributions it may reach per TURN rather than once at
 *  spawn. True for a shared room only, and it is exactly the case {@link contributionOwnerForSession} has
 *  no session-wide answer for. Three things follow from it, and they must follow together:
 *
 *   - the available-skills block is composed per turn instead of into the cached system prompt;
 *   - the session composes EVERY account's owner-scoped plugin tools (`toolsFor(..., allOwners)`) rather
 *     than one account's, because PI's tool registry is fixed for the life of a session and a room that
 *     composed the first writer's tools would serve them to everyone who writes afterwards;
 *   - and each turn then narrows both to the writer, so the model is never told about a tool or a skill
 *     that will be refused, nor left ignorant of one it holds.
 *
 *  It costs the skills block's tokens on every room turn instead of once. That is the honest price: the
 *  block lands in the per-turn region, so the cached system-prompt prefix stays byte-identical no matter
 *  who writes — a room whose writers alternate keeps ONE warm cache rather than re-warming a prefix each
 *  time the speaker changes, which is what composing either of these per writer would have cost. */
export function resolvesContributionsPerTurn(sessionId: string, direct: boolean): boolean {
  return isChannelSession(sessionId) && !isSubagentSession(sessionId) && !direct;
}

/** Recover the channel id from a `brain-ch-*` session id (inverse of {@link channelSessionId}). */
export function channelIdOf(id: string): string {
  return id.slice(CHANNEL_PREFIX.length);
}

/** WHICH platform a channel session came from (`msteams`, `discord`, `subagent`, `cron`, …), or null when
 *  the id is not a channel session at all.
 *
 *  A channel id is minted as `<platform>-<channelId>` (`keyOf` in platforms.ts) and no platform name
 *  contains a hyphen, so the first segment IS the platform. Deliberately DERIVED rather than stored: the
 *  session id already records where a conversation came from, and a second copy on the row could drift
 *  out of agreement with the id the router actually keys on. */
export function platformOfSession(id: string): string | null {
  if (!isChannelSession(id)) return null;
  const channelId = channelIdOf(id);
  const cut = channelId.indexOf('-');
  return cut > 0 ? channelId.slice(0, cut) : null;
}

/** Not a user conversation — excluded from the user's session list / resume / delete. */
export function isNonUserSession(id: string): boolean {
  return isChannelSession(id) || isTaskSession(id);
}

/** The three-clause "this is the caller's own continuable conversation" rule — the row exists, the caller
 *  owns it, and it is a real user conversation (not a channel/task session). Shared by delete / rename /
 *  terminal / listing, so the rule can't drift between them.
 *
 *  A direct 1:1 platform chat deliberately does NOT pass: it stays out of the web conversation list and
 *  cannot be renamed or deleted from there. Delivering INTO it is a different question — see
 *  {@link mayDeliverToSession}. */
export function isOwnedUserSession<T extends { user_id: number }>(row: T | undefined, userId: number, sessionId: string): row is T {
  return !!row && row.user_id === userId && !isNonUserSession(sessionId);
}

/** May a scheduled result be delivered INTO this conversation on the account's behalf?
 *
 *  Deliberately WIDER than {@link isOwnedUserSession}, and the difference is the point: posting a message
 *  into a conversation somebody owns is what they just asked for, while listing/renaming/deleting it is
 *  managing a transcript. A direct 1:1 platform chat therefore accepts delivery — that is how "remind me
 *  here in ten minutes" reaches the DM it was promised in — yet stays invisible in the web session list.
 *
 *  A SHARED channel is still refused: its row is anchored on the operator, so one member's scheduled job
 *  would otherwise report in front of everyone else in the room. */
export function mayDeliverToSession<T extends { user_id: number; direct: number }>(
  row: T | undefined,
  userId: number,
  sessionId: string,
): row is T {
  if (!row || row.user_id !== userId) return false;
  if (!isNonUserSession(sessionId)) return true;
  return isChannelSession(sessionId)
    && !isSubagentSession(sessionId)
    && !isArchivedChannelSession(sessionId)
    && row.direct === 1;
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
