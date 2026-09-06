import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';

/** A conversation nobody has spoken into is normally an empty shell: the CLI mints one simply by
 *  launching, so listings withhold it and the quit sweep removes it. Two things make such a row a real
 *  conversation anyway — `cleared_at` (it was used and deliberately emptied) and, since organizational
 *  grouping exists, an explicit TITLE on an owner conversation. The only way one of those carries a title
 *  before its first message is `renameSession`, a deliberate human act; a channel/worker shell is
 *  excluded because task sessions name THEMSELVES at spawn. */
describe('BrainStore empty-shell rules for explicitly named conversations', () => {
  let db: Db;
  let store: BrainStore;
  beforeEach(() => {
    db = openDb(':memory:');
    store = new BrainStore(db);
  });

  it('withholds an anonymous shell but keeps an explicitly named, message-less owner conversation', () => {
    store.createSession({ id: 'brain-7-blank', userId: 7, model: 'm' });
    store.createSession({ id: 'brain-7-named', userId: 7, model: 'm' });
    store.renameSession('brain-7-named', 'CRON JOBS');

    expect(store.unspokenSessionIds(7).has('brain-7-blank')).toBe(true);
    expect(store.unspokenSessionIds(7).has('brain-7-named')).toBe(false);
    expect(store.unspokenSessionIdsAll().has('brain-7-blank')).toBe(true);
    expect(store.unspokenSessionIdsAll().has('brain-7-named')).toBe(false);
  });

  /** The exception is deliberately narrow: a channel/worker session is titled by the spawner, so a title
   *  there says nothing about a person's intent and must not resurrect every empty platform shell. */
  it('still withholds a titled but message-less channel shell', () => {
    store.createSession({ id: 'brain-ch-discord-42', userId: 7, model: 'm', title: 'general' });

    expect(store.unspokenSessionIds(7).has('brain-ch-discord-42')).toBe(true);
    expect(store.unspokenSessionIdsAll().has('brain-ch-discord-42')).toBe(true);
  });

  /** Retention already refuses message-less rows, and that must not change: an organizational root is
   *  never swept just because nobody types in it. */
  it('leaves a named, message-less conversation out of retention candidates', () => {
    store.createSession({ id: 'brain-7-named', userId: 7, model: 'm' });
    store.renameSession('brain-7-named', 'CRON JOBS');
    db.prepare("UPDATE brain_sessions SET updated_at = datetime('now', '-400 days') WHERE id = ?").run('brain-7-named');

    expect(store.staleConversationIds(7, 30)).toEqual([]);
  });
});

/** The immutable association identity: a saved organizational link is resolved by the session row's
 *  `spill_ns`, which is minted once and travels with the row through a channel rollover's re-key. */
describe('BrainStore.sessionBySpillNamespace', () => {
  let db: Db;
  let store: BrainStore;
  beforeEach(() => {
    db = openDb(':memory:');
    store = new BrainStore(db);
  });

  it('resolves a session by its immutable namespace and follows the row across a re-key', () => {
    const created = store.createSession({ id: 'brain-ch-discord-42', userId: 7, model: 'm' });
    expect(store.sessionBySpillNamespace(created.spill_ns)?.id).toBe('brain-ch-discord-42');

    store.reassignSession('brain-ch-discord-42', 'brain-ch-discord-42-arch-1');
    expect(store.sessionBySpillNamespace(created.spill_ns)?.id).toBe('brain-ch-discord-42-arch-1');
  });

  it('never resolves a deleted conversation, even after its id is reused by another account', () => {
    const gone = store.createSession({ id: 'brain-ch-discord-42', userId: 7, model: 'm' });
    store.deleteSession('brain-ch-discord-42');
    store.createSession({ id: 'brain-ch-discord-42', userId: 9, model: 'm' });

    expect(store.sessionBySpillNamespace(gone.spill_ns)).toBeUndefined();
  });

  /** A blank key must never equality-match a row: it would otherwise hand back an arbitrary conversation. */
  it('refuses a blank namespace', () => {
    store.createSession({ id: 'brain-7', userId: 7, model: 'm' });
    db.prepare("UPDATE brain_sessions SET spill_ns = '' WHERE id = 'brain-7'").run();

    expect(store.sessionBySpillNamespace('')).toBeUndefined();
    expect(store.sessionBySpillNamespace('   ')).toBeUndefined();
  });
});
