import type { BrainSessionRow, BrainStore } from '../store/brainStore.js';
import type { PluginConversationTarget, PluginHostConversations } from '../plugins/api.js';
import { isArchivedChannelSession, isChannelSession, isEphemeralRunSession, platformOfSession } from './sessionId.js';
import { lastAssistantText } from './conversationRead.js';

/** THE predicate for "a person could organize something under this conversation". One answer, asked by the
 *  host projection a plugin picker reads and by the link listing that validates what comes back, so the
 *  two can never disagree about what a target is.
 *
 *  Eligible: an ordinary owner conversation, and a platform conversation people actually talk in — direct
 *  or shared alike, each still governed by its own visibility elsewhere. Not eligible: a delegated child
 *  (it belongs to the turn that spawned it), a one-shot worker run (sub-agent or cron execution — those
 *  are records of a run, not places anyone returns to) and an archived channel transcript nothing will
 *  ever be added to again.
 *
 *  Emptiness is NOT decided here: whether a row is still an unspoken shell is the store's question
 *  (see unspokenSessionIds), and this predicate stays a pure function of the id and its ancestry. */
export function isEligibleConversationTarget(row: Pick<BrainSessionRow, 'id' | 'parent_session_id'>): boolean {
  if (row.parent_session_id) return false;
  if (!isChannelSession(row.id)) return true;
  return !isEphemeralRunSession(row.id) && !isArchivedChannelSession(row.id);
}

function toTarget(row: BrainSessionRow): PluginConversationTarget {
  return {
    id: row.id,
    key: row.spill_ns,
    title: row.title,
    ownerUserId: row.user_id,
    platform: platformOfSession(row.id),
    direct: row.direct === 1,
    updatedAt: row.updated_at,
  };
}

export interface ConversationTargetDeps {
  store: BrainStore;
  /** The core-owned administrator rule, resolved live — never a flag captured when a plugin loaded. */
  isAdmin(userId: number): boolean;
}

/** Build the host's conversation projection. The scope check lives here, once: a plugin passes the
 *  identity it verified and gets back either the conversations that identity may organize under, or a
 *  throw. See {@link PluginHostConversations} for the contract this implements. */
export function createConversationTargets(deps: ConversationTargetDeps): PluginHostConversations {
  const assertScope = (actorUserId: number, ownerUserId?: number | null): void => {
    if (ownerUserId == null) {
      if (!deps.isAdmin(actorUserId)) throw new Error('the instance conversation scope requires an administrator');
      return;
    }
    if (ownerUserId !== actorUserId && !deps.isAdmin(actorUserId)) {
      throw new Error('another account\'s conversation scope requires an administrator');
    }
  };

  return {
    lastAssistantText: (sessionId, userId) => lastAssistantText(deps.store, sessionId, userId),

    list({ actorUserId, ownerUserId }) {
      assertScope(actorUserId, ownerUserId);
      const rows = ownerUserId == null
        ? deps.store.listAllSessionsWithOwner()
        : deps.store.listSessions(ownerUserId);
      const shells = ownerUserId == null
        ? deps.store.unspokenSessionIdsAll()
        : deps.store.unspokenSessionIds(ownerUserId);
      return rows.filter((row) => isEligibleConversationTarget(row) && !shells.has(row.id)).map(toTarget);
    },

    resolve({ actorUserId, ownerUserId, sessionId }) {
      assertScope(actorUserId, ownerUserId);
      const row = deps.store.getSession(sessionId);
      if (!row) return null;
      if (ownerUserId != null && row.user_id !== ownerUserId) return null;
      if (!isEligibleConversationTarget(row)) return null;
      // Scoped to the row's own owner, which is the same query the personal listing runs — the empty-shell
      // rule has one implementation and this cannot drift from what the picker showed.
      if (deps.store.unspokenSessionIds(row.user_id).has(row.id)) return null;
      return toTarget(row);
    },

    resolveKey(key) {
      const row = deps.store.sessionBySpillNamespace(key);
      return row ? toTarget(row) : null;
    },
  };
}
