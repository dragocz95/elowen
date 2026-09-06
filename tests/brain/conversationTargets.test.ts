import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { createConversationTargets, isEligibleConversationTarget } from '../../src/brain/conversationTargets.js';
import type { PluginHostConversations } from '../../src/plugins/api.js';

/** The CANONICAL answer to "which conversation may a recurring job be organized under". It is a
 *  read-only projection: ids, titles and owner/platform metadata, never messages, and it decides nothing
 *  about where a job RUNS or delivers. The host checks the requested scope here so a plugin cannot widen
 *  it by passing an actor of its own choosing. */
describe('conversation target projection', () => {
  let db: Db;
  let store: BrainStore;
  let targets: PluginHostConversations;
  const admins = new Set([1]);

  const spoke = (id: string) =>
    store.appendMessage({ id: `${id}-m`, sessionId: id, parentId: null, role: 'user', content: { text: 'hi' } });

  beforeEach(() => {
    db = openDb(':memory:');
    store = new BrainStore(db);
    targets = createConversationTargets({ store, isAdmin: (id) => admins.has(id) });
  });

  it('offers human conversation roots and withholds delegated, worker and archived sessions', () => {
    store.createSession({ id: 'brain-2', userId: 2, model: 'm' }); spoke('brain-2');
    store.createSession({ id: 'brain-ch-discord-42', userId: 2, model: 'm' }); spoke('brain-ch-discord-42');
    store.createSession({ id: 'brain-ch-subagent-x', userId: 2, model: 'm', parentSessionId: 'brain-2' }); spoke('brain-ch-subagent-x');
    store.createSession({ id: 'brain-ch-cron-job-7', userId: 2, model: 'm' }); spoke('brain-ch-cron-job-7');
    store.createSession({ id: 'brain-ch-discord-9-arch-abc', userId: 2, model: 'm' }); spoke('brain-ch-discord-9-arch-abc');
    store.createSession({ id: 'brain-2-shell', userId: 2, model: 'm' });

    const ids = targets.list({ actorUserId: 2, ownerUserId: 2 }).map((t) => t.id);

    expect(ids.sort()).toEqual(['brain-2', 'brain-ch-discord-42']);
  });

  /** The organizational root a person creates for their recurring jobs: named, never spoken in. */
  it('offers an explicitly named, never-spoken owner conversation', () => {
    store.createSession({ id: 'brain-2-jobs', userId: 2, model: 'm' });
    store.renameSession('brain-2-jobs', 'CRON JOBS');

    const target = targets.list({ actorUserId: 2, ownerUserId: 2 })[0];

    expect(target?.id).toBe('brain-2-jobs');
    expect(target?.title).toBe('CRON JOBS');
    expect(target?.ownerUserId).toBe(2);
    expect(target?.platform).toBeNull();
    expect(target?.key).toBeTruthy();
  });

  it('never returns message content or foreign fields on a target', () => {
    store.createSession({ id: 'brain-2', userId: 2, model: 'm' }); spoke('brain-2');

    const target = targets.list({ actorUserId: 2, ownerUserId: 2 })[0]!;

    expect(Object.keys(target).sort()).toEqual(['direct', 'id', 'key', 'ownerUserId', 'platform', 'title', 'updatedAt']);
  });

  it('refuses a foreign personal scope but allows an admin acting on that account\'s behalf', () => {
    store.createSession({ id: 'brain-2', userId: 2, model: 'm' }); spoke('brain-2');

    expect(() => targets.list({ actorUserId: 3, ownerUserId: 2 })).toThrow();
    expect(targets.list({ actorUserId: 1, ownerUserId: 2 }).map((t) => t.id)).toEqual(['brain-2']);
  });

  it('spans every account for an instance scope and refuses it to a non-admin', () => {
    store.createSession({ id: 'brain-2', userId: 2, model: 'm' }); spoke('brain-2');
    store.createSession({ id: 'brain-3', userId: 3, model: 'm' }); spoke('brain-3');

    expect(targets.list({ actorUserId: 1 }).map((t) => t.id).sort()).toEqual(['brain-2', 'brain-3']);
    expect(() => targets.list({ actorUserId: 2 })).toThrow();
  });

  it('resolves a named target only inside the requested scope', () => {
    store.createSession({ id: 'brain-2', userId: 2, model: 'm' }); spoke('brain-2');
    store.createSession({ id: 'brain-3', userId: 3, model: 'm' }); spoke('brain-3');
    store.createSession({ id: 'brain-ch-subagent-x', userId: 2, model: 'm', parentSessionId: 'brain-2' }); spoke('brain-ch-subagent-x');

    expect(targets.resolve({ actorUserId: 2, ownerUserId: 2, sessionId: 'brain-2' })?.id).toBe('brain-2');
    // A conversation owned by someone else is not a personal target, even for an admin acting for user 2.
    expect(targets.resolve({ actorUserId: 1, ownerUserId: 2, sessionId: 'brain-3' })).toBeNull();
    // Worker sessions and unknown ids are simply not targets.
    expect(targets.resolve({ actorUserId: 2, ownerUserId: 2, sessionId: 'brain-ch-subagent-x' })).toBeNull();
    expect(targets.resolve({ actorUserId: 2, ownerUserId: 2, sessionId: 'nope' })).toBeNull();
    // Instance scope reaches any eligible root, admin only.
    expect(targets.resolve({ actorUserId: 1, sessionId: 'brain-3' })?.id).toBe('brain-3');
    expect(() => targets.resolve({ actorUserId: 2, sessionId: 'brain-3' })).toThrow();
  });

  /** The saved association survives what a session id does not. */
  it('resolves a saved key across a channel re-key and never after a delete that frees the id', () => {
    store.createSession({ id: 'brain-ch-discord-42', userId: 2, model: 'm' }); spoke('brain-ch-discord-42');
    const saved = targets.resolve({ actorUserId: 2, ownerUserId: 2, sessionId: 'brain-ch-discord-42' })!;

    store.reassignSession('brain-ch-discord-42', 'brain-ch-discord-42-arch-1');
    expect(targets.resolveKey(saved.key)?.id).toBe('brain-ch-discord-42-arch-1');

    // A NEW conversation minted onto the freed id must never inherit the association.
    store.createSession({ id: 'brain-ch-discord-42', userId: 3, model: 'm' });
    store.appendMessage({ id: 'next-occupant-m', sessionId: 'brain-ch-discord-42', parentId: null, role: 'user', content: { text: 'hi' } });
    expect(targets.resolveKey(saved.key)?.id).toBe('brain-ch-discord-42-arch-1');

    store.deleteSession('brain-ch-discord-42-arch-1');
    expect(targets.resolveKey(saved.key)).toBeNull();
  });

  /** A client-supplied key is worthless by construction: it only ever resolves to the row that minted it. */
  it('ignores a forged key', () => {
    store.createSession({ id: 'brain-2', userId: 2, model: 'm' }); spoke('brain-2');

    expect(targets.resolveKey('brain-2')).toBeNull();
    expect(targets.resolveKey('')).toBeNull();
  });
});

describe('isEligibleConversationTarget', () => {
  it('is the one predicate both the picker and the link projection ask', () => {
    expect(isEligibleConversationTarget({ id: 'brain-2', parent_session_id: null })).toBe(true);
    expect(isEligibleConversationTarget({ id: 'brain-ch-discord-42', parent_session_id: null })).toBe(true);
    expect(isEligibleConversationTarget({ id: 'brain-2-child', parent_session_id: 'brain-2' })).toBe(false);
    expect(isEligibleConversationTarget({ id: 'brain-ch-subagent-x', parent_session_id: null })).toBe(false);
    expect(isEligibleConversationTarget({ id: 'brain-ch-cron-job-7', parent_session_id: null })).toBe(false);
    expect(isEligibleConversationTarget({ id: 'brain-ch-teams-9-arch-ab', parent_session_id: null })).toBe(false);
  });
});
