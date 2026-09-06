import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { BrainStatusService } from '../../src/brain/service/statusService.js';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';
import { ClientAttachments } from '../../src/brain/service/attachments.js';
import type { LiveBrain } from '../../src/brain/session/liveBrain.js';

/** The admin register nests delegated sessions under the conversation that actually spawned them, so the
 *  row has to carry the durable ancestry the store already holds. Nothing else about the DTO moves: the
 *  contract stays a FLAT array and every existing field keeps its meaning. */
function statusService(store: BrainStore) {
  return new BrainStatusService({
    store,
    sessions: new LiveSessionRegistry<LiveBrain>(),
    attachments: new ClientAttachments(),
    lifecycle: { activeSessionId: () => 'brain-1' },
  } as never);
}

function seed() {
  const db = openDb(':memory:');
  const store = new BrainStore(db);
  db.prepare("INSERT INTO users (id,username,password_hash,name) VALUES (1,'admin','x','Filip')").run();
  db.prepare("INSERT INTO users (id,username,password_hash,name) VALUES (2,'bob','x','Bob')").run();
  const spoke = (id: string) =>
    store.appendMessage({ id: `${id}-m`, sessionId: id, parentId: null, role: 'user', content: { text: 'hi' } });
  return { db, store, spoke };
}

describe('ManagedSessionView ancestry', () => {
  it('reports the durable parent for a child and a grandchild, and null for a root', () => {
    const { store, spoke } = seed();
    store.createSession({ id: 'brain-1', userId: 1, model: 'm' }); spoke('brain-1');
    store.createSession({ id: 'brain-ch-subagent-a', userId: 1, model: 'm', parentSessionId: 'brain-1' }); spoke('brain-ch-subagent-a');
    store.createSession({ id: 'brain-ch-subagent-b', userId: 1, model: 'm', parentSessionId: 'brain-ch-subagent-a' }); spoke('brain-ch-subagent-b');

    const rows = new Map(statusService(store).listManagedSessions(1).map((r) => [r.id, r.parentSessionId]));

    expect(rows.get('brain-1')).toBeNull();
    expect(rows.get('brain-ch-subagent-a')).toBe('brain-1');
    expect(rows.get('brain-ch-subagent-b')).toBe('brain-ch-subagent-a');
  });

  /** Deleting a parent detaches its children rather than cascading, so an orphaned child must read as a
   *  root here — the register cannot hang it under a row it will never find. */
  it('reports an orphaned child as a root once its parent is deleted', () => {
    const { store, spoke } = seed();
    store.createSession({ id: 'brain-1', userId: 1, model: 'm' }); spoke('brain-1');
    store.createSession({ id: 'brain-ch-subagent-a', userId: 1, model: 'm', parentSessionId: 'brain-1' }); spoke('brain-ch-subagent-a');

    store.deleteSession('brain-1');
    const rows = statusService(store).listManagedSessions(1);

    expect(rows.map((r) => r.id)).toEqual(['brain-ch-subagent-a']);
    expect(rows[0]!.parentSessionId).toBeNull();
  });

  /** The additive field must not disturb what the register already answers. */
  it('keeps owner, kind and token columns unchanged alongside the new field', () => {
    const { store, spoke } = seed();
    store.createSession({ id: 'brain-2', userId: 2, model: 'm' }); spoke('brain-2');

    const row = statusService(store).listManagedSessions(1)[0]!;

    expect(row.ownerId).toBe(2);
    expect(row.ownerLabel).toBe('Bob');
    expect(row.kind).toBe('conversation');
    expect(row.tokens).toBe(0);
    expect(row.parentSessionId).toBeNull();
  });

  /** The organizational root a person creates for recurring jobs is named and never spoken in. It has to
   *  be reachable in BOTH listings, or a cron could be grouped under a conversation nobody can see. */
  it('lists an explicitly named, never-spoken conversation in the personal list and the register', () => {
    const { store } = seed();
    store.createSession({ id: 'brain-1-jobs', userId: 1, model: 'm' });
    store.renameSession('brain-1-jobs', 'CRON JOBS');
    store.createSession({ id: 'brain-1-blank', userId: 1, model: 'm' });

    const svc = statusService(store);

    expect(svc.listSessions(1).map((s) => s.id)).toEqual(['brain-1-jobs']);
    expect(svc.listManagedSessions(1).map((s) => s.id)).toEqual(['brain-1-jobs']);
  });
});
