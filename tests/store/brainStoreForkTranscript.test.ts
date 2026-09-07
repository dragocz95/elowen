import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { buildForkBoundaryMessages, FORK_PLACEHOLDER_RESULT } from '../../src/brain/session/forkPrefix.js';

const SCOPE = { admin: true, projectIds: [], owner: true, permissionBoundary: null, fork: true };

/** A fork child resumes mid-turn from its parent's transcript, so its seed carries the two message shapes
 *  the platform-import seed deliberately rejects: an assistant with tool calls, and a toolResult. */
describe('BrainStore.seedForkTranscript', () => {
  let store: BrainStore;
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
    store = new BrainStore(db);
    store.createSession({ id: 'parent', userId: 1, model: 'm' });
    store.createSession({
      id: 'brain-ch-subagent-sub-1', userId: 1, model: 'm',
      parentSessionId: 'parent', delegatedAccess: SCOPE,
    });
  });

  const boundary = buildForkBoundaryMessages(
    'audit the store',
    { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'Delegate' }] },
    1_700_000_000_000,
  );
  const history = [
    { role: 'user', content: { role: 'user', content: 'hello' } },
    { role: 'assistant', content: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
  ];

  it('writes the parent history and the fork boundary in order, as settled history', () => {
    const written = store.seedForkTranscript('brain-ch-subagent-sub-1', [...history, ...boundary.map(
      (message) => ({ role: message.role, content: message }),
    )]);

    expect(written).toBe(5);
    const rows = store.getMessages('brain-ch-subagent-sub-1');
    expect(rows.map((row) => row.role)).toEqual(['user', 'assistant', 'assistant', 'toolResult', 'user']);
    // Settled, not pending: this is history the child starts FROM, and settlePartialTurn must not try to
    // answer the boundary's tool call a second time.
    expect(rows.every((row) => row.pending === 0)).toBe(true);
  });

  it('round-trips a toolResult answering the parent tool call', () => {
    store.seedForkTranscript('brain-ch-subagent-sub-1', boundary.map(
      (message) => ({ role: message.role, content: message }),
    ));
    const result = store.getMessages('brain-ch-subagent-sub-1').find((row) => row.role === 'toolResult');
    const parsed = JSON.parse(result!.content) as { toolCallId: string; content: { text: string }[] };
    expect(parsed.toolCallId).toBe('c1');
    expect(parsed.content[0]!.text).toBe(FORK_PLACEHOLDER_RESULT);
  });

  it('gives every row a fresh id rather than reusing the parent’s', () => {
    store.appendMessage({ id: 'shared-id', sessionId: 'parent', parentId: null, role: 'user', content: 'x' });
    store.seedForkTranscript('brain-ch-subagent-sub-1', history);
    const ids = store.getMessages('brain-ch-subagent-sub-1').map((row) => row.id);
    expect(ids).not.toContain('shared-id');
    expect(new Set(ids).size).toBe(ids.length);
  });

  // Seeding is a spawn-time act. Running it again over a live child would prepend a second copy of the
  // parent's history behind everything the child has already said.
  it('refuses a child that already has messages, without writing anything', () => {
    store.seedForkTranscript('brain-ch-subagent-sub-1', history);
    expect(store.seedForkTranscript('brain-ch-subagent-sub-1', history)).toBe(0);
    expect(store.getMessages('brain-ch-subagent-sub-1')).toHaveLength(2);
  });

  it('writes nothing for an empty seed', () => {
    expect(store.seedForkTranscript('brain-ch-subagent-sub-1', [])).toBe(0);
    expect(store.getMessages('brain-ch-subagent-sub-1')).toHaveLength(0);
  });

  it('rejects a role it cannot replay, leaving the child empty', () => {
    expect(() => store.seedForkTranscript('brain-ch-subagent-sub-1', [
      { role: 'system', content: { role: 'system' } },
    ])).toThrow(/invalid seeded fork message role/);
    expect(store.getMessages('brain-ch-subagent-sub-1')).toHaveLength(0);
  });

  it('rejects an unbounded transcript rather than writing it in one transaction', () => {
    const huge = Array.from({ length: 10_001 }, () => ({ role: 'user', content: { role: 'user', content: 'x' } }));
    expect(() => store.seedForkTranscript('brain-ch-subagent-sub-1', huge)).toThrow(/too long/);
    expect(store.getMessages('brain-ch-subagent-sub-1')).toHaveLength(0);
  });
});
