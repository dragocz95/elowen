import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDb, type Db } from '../../src/store/db.js';
import { BrainStore, SESSION_EVENT_KINDS, syntheticRestartResultId } from '../../src/store/brainStore.js';

describe('BrainStore', () => {
  let store: BrainStore;
  let db: Db;
  beforeEach(() => { db = openDb(':memory:'); store = new BrainStore(db); });

  it('creates and reads back a session', () => {
    const s = store.createSession({ id: 's1', userId: 7, model: 'anthropic/claude' });
    expect(s.user_id).toBe(7);
    expect(s.parent_session_id).toBeNull();
    expect(store.getSession('s1')?.model).toBe('anthropic/claude');
  });

  it('creates direct and nested delegated sessions only under a same-user parent', () => {
    store.createSession({ id: 'root', userId: 7, model: 'm' });
    const child = store.createSession({ id: 'child', userId: 7, model: 'm', parentSessionId: 'root' });
    const nested = store.createSession({ id: 'nested', userId: 7, model: 'm', parentSessionId: 'child' });
    store.createSession({ id: 'foreign', userId: 9, model: 'm' });

    expect(child.parent_session_id).toBe('root');
    expect(nested.parent_session_id).toBe('child');
    expect(() => store.createSession({ id: 'missing-child', userId: 7, model: 'm', parentSessionId: 'nope' })).toThrow(/parent brain session not found/);
    expect(() => store.createSession({ id: 'foreign-child', userId: 7, model: 'm', parentSessionId: 'foreign' })).toThrow(/another user/);
    expect(store.getSession('missing-child')).toBeUndefined();
    expect(store.getSession('foreign-child')).toBeUndefined();
  });

  it('persists a canonical immutable delegated execution scope and fails closed for legacy/corrupt rows', () => {
    store.createSession({ id: 'root', userId: 7, model: 'm' });
    store.createSession({
      id: 'child', userId: 7, model: 'm', parentSessionId: 'root',
      delegatedAccess: {
        admin: false, projectIds: [9, 3, 9], owner: false,
        permissionBoundary: null,
        toolPolicy: { allow: [], deny: ['DiscordApi', 'DiscordApi'] },
        promptAppend: ['focused child', 'focused child'],
      },
    });
    store.createSession({ id: 'legacy', userId: 7, model: 'm', parentSessionId: 'root' });

    expect(store.delegatedAccessFor('child')).toEqual({
      admin: false, projectIds: [3, 9], owner: false,
      permissionBoundary: null,
      toolPolicy: { allow: [], deny: ['DiscordApi'] }, promptAppend: ['focused child'],
    });
    expect(store.hasDelegatedAccess('child', {
      admin: false, projectIds: [3, 9], owner: false,
      permissionBoundary: null,
      toolPolicy: { allow: [], deny: ['DiscordApi'] }, promptAppend: ['focused child'],
    })).toBe(true);
    expect(store.hasDelegatedAccess('child', {
      admin: true, projectIds: [], owner: true, permissionBoundary: null,
    })).toBe(false);
    expect(store.delegatedAccessFor('legacy')).toBeUndefined();
    // A row minted before permissionBoundary existed is no safer than a NULL legacy scope: it must not
    // resume under the row owner's current settings after an idle child eviction.
    db.prepare("UPDATE brain_sessions SET delegated_access = ? WHERE id = 'child'").run(JSON.stringify({
      admin: false, projectIds: [3, 9], owner: false, toolPolicy: { allow: [], deny: ['DiscordApi'] },
    }));
    expect(store.delegatedAccessFor('child')).toBeUndefined();
    db.prepare("UPDATE brain_sessions SET delegated_access = '{bad json' WHERE id = 'child'").run();
    expect(store.delegatedAccessFor('child')).toBeUndefined();
  });

  it('reassignSession keeps delegated children attached to the archived parent id', () => {
    store.createSession({ id: 'root', userId: 1, model: 'm' });
    store.createSession({ id: 'child', userId: 1, model: 'm', parentSessionId: 'root' });
    store.reassignSession('root', 'root-archived');
    expect(store.getSession('root')).toBeUndefined();
    expect(store.getSession('child')?.parent_session_id).toBe('root-archived');
  });

  it('the /context three-step move archives the channel slot, then re-keys the chosen session into it, leaving no copy of the chosen id', () => {
    // Whatever currently occupies the deterministic channel slot...
    store.createSession({ id: 'brain-ch-discord-c1', userId: 1, model: 'm' });
    store.appendMessage({ id: 'ch1', sessionId: 'brain-ch-discord-c1', parentId: null, role: 'user', content: { text: 'channel history' } });
    // ...and the caller's own personal conversation being bound in.
    store.createSession({ id: 'brain-1-abc', userId: 1, model: 'm' });
    store.appendMessage({ id: 'p1', sessionId: 'brain-1-abc', parentId: null, role: 'user', content: { text: 'personal history' } });

    // Step 1 (archive the slot), step 2 (move the chosen session into the freed slot) — the exact pair
    // BrainService.bindChannelContext performs after channelDispose.
    store.reassignSession('brain-ch-discord-c1', 'brain-ch-discord-c1-arch-x');
    store.reassignSession('brain-1-abc', 'brain-ch-discord-c1');

    // The chosen id is GONE (uniqueness: a second bind of it would hit getSession()===undefined).
    expect(store.getSession('brain-1-abc')).toBeUndefined();
    // The channel slot now carries the chosen conversation's history verbatim...
    expect(store.getMessages('brain-ch-discord-c1').map((m) => JSON.parse(m.content).text)).toEqual(['personal history']);
    // ...and the previous channel conversation survives, browsable under the archive id (nothing lost).
    expect(store.getMessages('brain-ch-discord-c1-arch-x').map((m) => JSON.parse(m.content).text)).toEqual(['channel history']);
  });

  it('persists only validated direct same-owner sub-agent progress', () => {
    store.createSession({ id: 'root', userId: 1, model: 'm' });
    store.createSession({ id: 'child', userId: 1, model: 'm', parentSessionId: 'root' });
    store.createSession({ id: 'same-owner-unrelated', userId: 1, model: 'm' });
    store.createSession({ id: 'foreign', userId: 2, model: 'm' });
    // Simulate a corrupted/manual cross-owner relation: the upsert must still reject it.
    db.prepare("UPDATE brain_sessions SET parent_session_id = 'root' WHERE id = 'foreign'").run();

    expect(store.upsertSubagentRun('root', {
      id: 'delegate-1', sessionId: 'child', status: 'running', task: 'inspect',
      detail: 'Read src/a.ts', tools: 2, tokens: 1234, seconds: 2, model: 'm', background: true,
    })).toBe(true);
    expect(store.getSubagentRuns('root')).toEqual([{
      toolCallId: 'delegate-1', sessionId: 'child', status: 'running', task: 'inspect',
      detail: 'Read src/a.ts', tools: 2, tokens: 1234, seconds: 2, model: 'm', background: true,
    }]);
    expect(store.upsertSubagentRun('root', {
      id: 'unrelated', sessionId: 'same-owner-unrelated', status: 'running', task: 'x', tools: 0, seconds: 0,
    })).toBe(false);
    expect(store.upsertSubagentRun('root', {
      id: 'foreign', sessionId: 'foreign', status: 'running', task: 'x', tools: 0, seconds: 0,
    })).toBe(false);
    expect(store.upsertSubagentRun('root', {
      id: 'bad', sessionId: 'child', status: 'running', task: 'x', tools: -1, seconds: 0,
    })).toBe(false);
    // A call id cannot later be rebound to a different child.
    store.createSession({ id: 'child-2', userId: 1, model: 'm', parentSessionId: 'root' });
    expect(store.upsertSubagentRun('root', {
      id: 'delegate-1', sessionId: 'child-2', status: 'done', task: 'x', tools: 1, seconds: 1,
    })).toBe(false);
    db.prepare("UPDATE brain_subagent_runs SET state = '{bad json' WHERE tool_call_id = 'delegate-1'").run();
    expect(store.getSubagentRuns('root')).toEqual([]); // corrupt state never reaches a renderer
  });

  it('persists sub-agent results as an idempotent pending inbox and acknowledges them explicitly', () => {
    store.createSession({ id: 'root', userId: 1, model: 'm' });
    store.createSession({ id: 'child', userId: 1, model: 'm', parentSessionId: 'root' });
    expect(store.upsertSubagentRun('root', {
      id: 'delegate-1', sessionId: 'child', status: 'done', task: 'inspect', tools: 3, seconds: 4,
      background: true, autoDeliver: true,
    })).toBe(true);

    const completion = {
      id: 'dlg-stable', toolCallId: 'delegate-1', sessionId: 'child', status: 'done' as const,
      task: 'inspect', result: 'all clear', tools: 3, seconds: 4,
    };
    expect(store.enqueueSubagentResult('root', completion)).toBe(true);
    expect(store.enqueueSubagentResult('root', completion)).toBe(true); // duplicate completion callback
    expect(store.pendingSubagentResults('root')).toEqual([
      expect.objectContaining({ id: 'dlg-stable', parentSessionId: 'root', delivery: 'pending', result: 'all clear' }),
    ]);
    expect(store.getSubagentRuns('root')[0]).toMatchObject({ resultDelivery: 'pending' });

    expect(store.acknowledgeSubagentResult('root', 'dlg-stable')).toBe(true);
    expect(store.pendingSubagentResults('root')).toEqual([]);
    expect(store.getSubagentRuns('root')[0]).toMatchObject({ resultDelivery: 'acknowledged' });
  });

  describe('enqueueSubagentResult synthetic-vs-real upgrade', () => {
    /** Seed root + child and the running-run row the inbox relation check requires, returning the
     *  synthetic restart id and a real completion for the same (parent, tool-call). */
    const seed = () => {
      store.createSession({ id: 'root', userId: 1, model: 'm' });
      store.createSession({ id: 'child', userId: 1, model: 'm', parentSessionId: 'root' });
      store.upsertSubagentRun('root', {
        id: 'delegate-1', sessionId: 'child', status: 'running', task: 'inspect', tools: 0, seconds: 0,
        background: true, autoDeliver: true,
      });
      const syntheticId = syntheticRestartResultId('root', 'delegate-1');
      const synthetic = {
        id: syntheticId, toolCallId: 'delegate-1', sessionId: 'child', status: 'error' as const,
        task: 'inspect', error: 'sub-agent interrupted by daemon restart', tools: 0, seconds: 0,
      };
      const real = {
        id: 'dlg-stable', toolCallId: 'delegate-1', sessionId: 'child', status: 'done' as const,
        task: 'inspect', result: 'all clear', tools: 3, seconds: 4,
      };
      return { syntheticId, synthetic, real };
    };

    it('upgrades a pending synthetic restart result to the real completion, resetting retry state', () => {
      const { syntheticId, synthetic, real } = seed();
      expect(store.enqueueSubagentResult('root', synthetic)).toBe(true);
      store.noteSubagentResultFailure('root', syntheticId); // attempts → 1
      expect(store.pendingSubagentResults('root')[0]).toMatchObject({ id: syntheticId, status: 'error', attempts: 1 });

      // The real completion arriving after the restart placeholder upgrades the pending row IN PLACE.
      expect(store.enqueueSubagentResult('root', real)).toBe(true);
      const pending = store.pendingSubagentResults('root');
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        id: 'dlg-stable', status: 'done', result: 'all clear', attempts: 0, delivery: 'pending',
      });
    });

    it('never lets a synthetic restart result overwrite an already-pending real completion', () => {
      const { synthetic, real } = seed();
      expect(store.enqueueSubagentResult('root', real)).toBe(true);
      expect(store.enqueueSubagentResult('root', synthetic)).toBe(false);
      expect(store.pendingSubagentResults('root')[0]).toMatchObject({ id: 'dlg-stable', result: 'all clear' });
    });

    it('never revives an already-acknowledged result with a late synthetic restart placeholder', () => {
      const { synthetic, real } = seed();
      expect(store.enqueueSubagentResult('root', real)).toBe(true);
      expect(store.acknowledgeSubagentResult('root', 'dlg-stable')).toBe(true);
      expect(store.enqueueSubagentResult('root', synthetic)).toBe(false);
      expect(store.pendingSubagentResults('root')).toEqual([]);
    });

    it('keeps the first real completion when a second distinct real result races in (first-write-wins)', () => {
      seed();
      expect(store.enqueueSubagentResult('root', {
        id: 'dlg-1', toolCallId: 'delegate-1', sessionId: 'child', status: 'done', task: 'inspect',
        result: 'first', tools: 1, seconds: 1,
      })).toBe(true);
      expect(store.enqueueSubagentResult('root', {
        id: 'dlg-2', toolCallId: 'delegate-1', sessionId: 'child', status: 'done', task: 'inspect',
        result: 'second', tools: 1, seconds: 1,
      })).toBe(false);
      const pending = store.pendingSubagentResults('root');
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ id: 'dlg-1', result: 'first' });
    });
  });

  it('rejects inbox results that do not match the durable direct child/tool-call relation', () => {
    store.createSession({ id: 'root', userId: 1, model: 'm' });
    store.createSession({ id: 'child', userId: 1, model: 'm', parentSessionId: 'root' });
    store.createSession({ id: 'other', userId: 1, model: 'm', parentSessionId: 'root' });
    store.upsertSubagentRun('root', {
      id: 'delegate-1', sessionId: 'child', status: 'done', task: 'inspect', tools: 1, seconds: 1,
    });
    expect(store.enqueueSubagentResult('root', {
      id: 'wrong-child', toolCallId: 'delegate-1', sessionId: 'other', status: 'done', task: 'x', result: 'x', tools: 1, seconds: 1,
    })).toBe(false);
    expect(store.enqueueSubagentResult('root', {
      id: 'wrong-call', toolCallId: 'missing', sessionId: 'child', status: 'done', task: 'x', result: 'x', tools: 1, seconds: 1,
    })).toBe(false);
  });

  it('reassigns and deletes sub-agent sidecars with their session tree', () => {
    store.createSession({ id: 'root', userId: 1, model: 'm' });
    store.createSession({ id: 'child', userId: 1, model: 'm', parentSessionId: 'root' });
    store.createSession({ id: 'nested', userId: 1, model: 'm', parentSessionId: 'child' });
    expect(store.upsertSubagentRun('root', {
      id: 'root-call', sessionId: 'child', status: 'running', task: 'child', tools: 0, seconds: 0,
    })).toBe(true);
    expect(store.upsertSubagentRun('child', {
      id: 'child-call', sessionId: 'nested', status: 'done', task: 'nested', tools: 3, seconds: 5,
    })).toBe(true);

    store.reassignSession('root', 'root-archived');
    expect(store.getSubagentRuns('root-archived')[0]).toMatchObject({ toolCallId: 'root-call', sessionId: 'child' });
    store.reassignSession('child', 'child-archived');
    expect(store.getSubagentRuns('root-archived')[0]).toMatchObject({ sessionId: 'child-archived' });
    expect(store.getSubagentRuns('child-archived')[0]).toMatchObject({ toolCallId: 'child-call', sessionId: 'nested' });

    store.deleteSession('child-archived');
    expect(store.getSubagentRuns('root-archived')).toEqual([]);
    expect(store.getSubagentRuns('child-archived')).toEqual([]);
  });

  it('removeForUser drops all of that owner\'s sub-agent sidecars', () => {
    store.createSession({ id: 'root', userId: 1, model: 'm' });
    store.createSession({ id: 'child', userId: 1, model: 'm', parentSessionId: 'root' });
    expect(store.upsertSubagentRun('root', {
      id: 'delegate-1', sessionId: 'child', status: 'running', task: 'x', tools: 0, seconds: 0,
    })).toBe(true);
    store.removeForUser(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM brain_subagent_runs').get() as { n: number }).n).toBe(0);
  });

  // The read boundary re-validates the stored kind against a list, and the compiler cannot help: the row
  // is a `string` from SQLite, so a boundary left behind on an older list stays perfectly well-typed while
  // silently dropping the new kind on every reload. Every kind must survive the round trip.
  it('reads back every session-event kind it accepts, so none is written and then dropped', () => {
    store.createSession({ id: 's1', userId: 1, model: 'm' });
    for (const kind of SESSION_EVENT_KINDS) store.appendSessionEvent('s1', kind, `detail-${kind}`);

    expect(store.getSessionEvents('s1').map((e) => e.kind)).toEqual([...SESSION_EVENT_KINDS]);
    expect(store.getSessionEvents('s1').map((e) => e.detail)).toEqual(SESSION_EVENT_KINDS.map((k) => `detail-${k}`));
  });

  // Deleting a user must not leave rows holding their conversation content behind, keyed to session ids
  // that no longer exist. Every per-session sidecar, not just the sub-agent ones.
  it('removeForUser drops every per-session sidecar, leaving nothing of that owner behind', () => {
    store.createSession({ id: 'mine', userId: 1, model: 'm' });
    store.createSession({ id: 'theirs', userId: 2, model: 'm' });
    for (const id of ['mine', 'theirs']) {
      store.upsertCard(id, { id: 'todos', title: 'T', items: [{ text: 'x' }] });
      store.appendSessionEvent(id, 'mode', 'Workflow');
      store.upsertWorkflowRun(id, { id: `wf-${id}`, toolCallId: 'c1', status: 'done', nodes: [] });
    }

    store.removeForUser(1);

    const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
    expect(count("SELECT COUNT(*) AS n FROM brain_cards WHERE session_id = 'mine'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM brain_session_events WHERE session_id = 'mine'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM brain_workflows WHERE parent_session_id = 'mine'")).toBe(0);
    // ...and the other user is untouched.
    expect(count("SELECT COUNT(*) AS n FROM brain_cards WHERE session_id = 'theirs'")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM brain_session_events WHERE session_id = 'theirs'")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM brain_workflows WHERE parent_session_id = 'theirs'")).toBe(1);
  });

  it('appends messages and returns them in order', () => {
    store.createSession({ id: 's1', userId: 7, model: 'm' });
    store.appendMessage({ id: 'm1', sessionId: 's1', parentId: null, role: 'user', content: { text: 'hi' } });
    store.appendMessage({ id: 'm2', sessionId: 's1', parentId: 'm1', role: 'assistant', content: { text: 'yo' } });
    const msgs = store.getMessages('s1');
    expect(msgs.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(JSON.parse(msgs[0]!.content)).toEqual({ text: 'hi' });
  });

  it('scopes sessions per user', () => {
    store.createSession({ id: 'a', userId: 1, model: 'm' });
    store.createSession({ id: 'b', userId: 2, model: 'm' });
    expect(store.listSessions(1).map((s) => s.id)).toEqual(['a']);
  });

  it('touchSession updates the model when provided', () => {
    store.createSession({ id: 'a', userId: 1, model: 'm1' });
    store.touchSession('a', 'm2');
    expect(store.getSession('a')?.model).toBe('m2');
  });

  it('conditionally replaces only the still-current provisional title', () => {
    store.createSession({ id: 'a', userId: 1, model: 'm' });
    store.setTitle('a', 'provisional');
    expect(store.setTitleIfCurrent('a', 'provisional', 'Generated title')).toBe(true);
    store.renameSession('a', 'Manual title');
    expect(store.setTitleIfCurrent('a', 'Generated title', 'Late generated title')).toBe(false);
    expect(store.getSession('a')?.title).toBe('Manual title');
  });

  it('sessions start cwd-less; setWorkDir binds them to a directory', () => {
    store.createSession({ id: 'a', userId: 1, model: 'm' });
    expect(store.getSession('a')?.work_dir).toBe('');
    store.setWorkDir('a', '/repo/project');
    expect(store.getSession('a')?.work_dir).toBe('/repo/project');
  });

  it('staleConversationIds returns only a user\'s own aged, spoken-in, top-level conversations', () => {
    const spoke = (id: string) => store.appendMessage({ id: `${id}-m`, sessionId: id, parentId: null, role: 'user', content: { text: 'hi' } });
    const age = (id: string) => db.prepare("UPDATE brain_sessions SET updated_at = datetime('now', '-90 days') WHERE id = ?").run(id);

    store.createSession({ id: 'old-convo', userId: 7, model: 'm' }); spoke('old-convo'); age('old-convo');
    store.createSession({ id: 'fresh-convo', userId: 7, model: 'm' }); spoke('fresh-convo'); // recent → kept
    store.createSession({ id: 'old-unspoken', userId: 7, model: 'm' }); age('old-unspoken'); // empty shell → skip
    store.createSession({ id: 'brain-ch-x', userId: 7, model: 'm' }); spoke('brain-ch-x'); age('brain-ch-x'); // channel → skip
    store.createSession({ id: 'brain-task-y', userId: 7, model: 'm' }); spoke('brain-task-y'); age('brain-task-y'); // task → skip
    store.createSession({ id: 'root', userId: 7, model: 'm' }); spoke('root'); age('root');
    store.createSession({ id: 'delegated', userId: 7, model: 'm', parentSessionId: 'root' }); spoke('delegated'); age('delegated'); // child → skip
    store.createSession({ id: 'other-user', userId: 9, model: 'm' }); spoke('other-user'); age('other-user'); // not this user → skip

    expect(store.staleConversationIds(7, 30).sort()).toEqual(['old-convo', 'root']);
    // A shorter horizon than the sessions' age still returns them; a longer one excludes everything.
    expect(store.staleConversationIds(7, 365)).toEqual([]);
    // Foreign user's own aged conversation is visible only under their id.
    expect(store.staleConversationIds(9, 30)).toEqual(['other-user']);
  });

  it('lastMessageAt returns the newest message timestamp, undefined for an empty session', () => {
    store.createSession({ id: 'a', userId: 1, model: 'm' });
    expect(store.lastMessageAt('a')).toBeUndefined();
    store.appendMessage({ id: 'm1', sessionId: 'a', parentId: null, role: 'user', content: { text: 'hi' } });
    const first = store.lastMessageAt('a');
    expect(first).toBe(store.getMessages('a')[0]!.created_at);
    store.appendMessage({ id: 'm2', sessionId: 'a', parentId: null, role: 'assistant', content: { text: 'yo' } });
    expect(store.lastMessageAt('a')! >= first!).toBe(true); // MAX — never an older row
  });

  it('removeForUser drops the user rows and their messages', () => {
    store.createSession({ id: 'a', userId: 1, model: 'm' });
    store.appendMessage({ id: 'x', sessionId: 'a', parentId: null, role: 'user', content: {} });
    store.removeForUser(1);
    expect(store.getSession('a')).toBeUndefined();
    expect(store.getMessages('a')).toHaveLength(0);
  });

  it('recursively sums descendant normalized usage and compaction rollups without changing global totals', () => {
    const usage = (sessionId: string, id: string, totalTokens: number, cost: number, input = 0) =>
      store.appendMessage({
        id, sessionId, parentId: null, role: 'assistant',
        content: {
          role: 'assistant', model: 'm', timestamp: Date.now(),
          usage: { input, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 1, totalTokens, cost: { total: cost } },
        },
      });

    store.createSession({ id: 'root', userId: 1, model: 'm' });
    store.createSession({ id: 'child', userId: 1, model: 'm', parentSessionId: 'root' });
    store.createSession({ id: 'nested', userId: 1, model: 'm', parentSessionId: 'child' });
    store.createSession({ id: 'unrelated', userId: 1, model: 'm' });
    usage('root', 'root-msg', 100, 0.1, 10); // root is deliberately excluded from descendantUsage
    usage('child', 'child-msg', 20, 0.02, 2);
    usage('nested', 'nested-old', 30, 0.03, 3);
    usage('nested', 'nested-keep', 40, 0.04, 4);
    usage('unrelated', 'other-msg', 500, 0.5, 50);
    // The old nested row now exists only in the compaction divider's `usageRollup`.
    store.compactSessionMessages('nested', { id: 'nested-summary', role: 'compaction', content: { role: 'compactionSummary' } }, 1);

    expect(store.descendantUsage('root')).toEqual({
      input: 9, output: 6, cacheRead: 9, cacheWrite: 12, totalTokens: 90, reasoning: 3, cost: 0.09,
    });
    expect(store.descendantUsage('child')).toEqual({
      input: 7, output: 4, cacheRead: 6, cacheWrite: 8, totalTokens: 70, reasoning: 2, cost: 0.07,
    });
    expect(store.descendantUsage('unrelated')).toEqual({
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, reasoning: 0, cost: 0,
    });
    expect(store.descendantUsage('missing')).toEqual({
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, reasoning: 0, cost: 0,
    });

    // Global accounting still reads every stored session exactly once; the tree helper is additive
    // status metadata only and never rewrites or filters `/usage/by-*` source rows.
    const [global] = store.usageByModel(1);
    expect(global!.usage.total).toBe(690);
    expect(global!.usage.costUsd).toBeCloseTo(0.69);
  });

  describe('compactSessionMessages', () => {
    /** Seed s1 with 4 clean rows (q1/a1/q2/a2) and hand back their pre-compaction created_at by id. */
    const seedFour = () => {
      store.createSession({ id: 's1', userId: 1, model: 'm' });
      store.appendMessage({ id: 'old1', sessionId: 's1', parentId: null, role: 'user', content: { role: 'user', content: 'q1' } });
      store.appendMessage({ id: 'old2', sessionId: 's1', parentId: null, role: 'assistant', content: { role: 'assistant', content: 'a1' } });
      store.appendMessage({ id: 'keep1', sessionId: 's1', parentId: null, role: 'user', content: { role: 'user', content: 'q2' } });
      store.appendMessage({ id: 'keep2', sessionId: 's1', parentId: null, role: 'assistant', content: { role: 'assistant', content: 'a2' } });
      // Backdate every row to distinct, chronologically-ordered times in the past, so a "reset every
      // created_at to compaction time" regression is visible AND the ASC ordering stays old→keep.
      db.prepare("UPDATE brain_messages SET created_at = '2020-01-01 00:00:01' WHERE id = 'old1'").run();
      db.prepare("UPDATE brain_messages SET created_at = '2020-01-01 00:00:02' WHERE id = 'old2'").run();
      db.prepare("UPDATE brain_messages SET created_at = '2020-01-01 00:00:05' WHERE id = 'keep1'").run();
      db.prepare("UPDATE brain_messages SET created_at = '2020-01-01 00:00:06' WHERE id = 'keep2'").run();
      return new Map(store.getMessages('s1').map((r) => [r.id, r.created_at]));
    };

    it('keeps the last N clean rows + a summary divider, drops the older log, and PRESERVES their original text + created_at', () => {
      const before = seedFour();
      store.compactSessionMessages('s1', { id: 'c', role: 'compaction', content: { role: 'compactionSummary', summary: 'older' } }, 2);
      const rows = store.getMessages('s1');
      // divider first, then the exact kept tail (its original ids, not fresh ones).
      expect(rows.map((r) => r.role)).toEqual(['compaction', 'user', 'assistant']);
      expect(rows.map((r) => r.id)).toEqual(['c', 'keep1', 'keep2']);
      expect(JSON.parse(rows[0]!.content)).toMatchObject({ role: 'compactionSummary', summary: 'older' });
      // The pre-compaction log is gone; the kept rows keep their CLEAN original text …
      expect(rows.some((r) => r.id === 'old1' || r.id === 'old2')).toBe(false);
      expect(JSON.parse(rows[1]!.content)).toMatchObject({ content: 'q2' });
      // … and their ORIGINAL timestamps (searchMessages / lastMessageAt must not read "just now").
      expect(rows[1]!.created_at).toBe(before.get('keep1'));
      expect(rows[2]!.created_at).toBe(before.get('keep2'));
      // The divider sorts before the tail (its created_at pinned to the oldest kept row's).
      expect(rows[0]!.created_at).toBe(before.get('keep1'));
      // lastMessageAt still reflects the newest kept row, not the compaction moment.
      expect(store.lastMessageAt('s1')).toBe(before.get('keep2'));
    });

    it('keepLastN >= total keeps the whole log (only the summary is prepended)', () => {
      seedFour();
      store.compactSessionMessages('s1', { id: 'c', role: 'compaction', content: { summary: 's' } }, 99);
      expect(store.getMessages('s1').map((r) => r.id)).toEqual(['c', 'old1', 'old2', 'keep1', 'keep2']);
    });

    it('drops markers whose turns were summarized away, keeping the ones annotating the kept tail', () => {
      seedFour();
      const gone = store.appendSessionEvent('s1', 'mode', 'Plan');    // belongs to the old1/old2 region
      const kept = store.appendSessionEvent('s1', 'model', 'opus');   // belongs to the kept tail
      const at = (eventId: string, ts: string): void => {
        db.prepare('UPDATE brain_session_events SET created_at = ? WHERE event_id = ?').run(ts, eventId);
      };
      at(gone.id, '2020-01-01 00:00:03');
      at(kept.id, '2020-01-01 00:00:06');

      store.compactSessionMessages('s1', { id: 'c', role: 'compaction', content: { summary: 's' } }, 2);

      // A marker older than the divider would render ABOVE it, annotating a turn that no longer exists —
      // and nothing else ever prunes it, so they would stack up for the life of the session.
      expect(store.getSessionEvents('s1').map((e) => e.detail)).toEqual(['opus']);
    });

    it('keepLastN <= 0 keeps only the summary divider', () => {
      seedFour();
      store.compactSessionMessages('s1', { id: 'c', role: 'compaction', content: { summary: 's' } }, 0);
      expect(store.getMessages('s1').map((r) => r.id)).toEqual(['c']);
    });

    it('is atomic: a summary id colliding with a kept row rolls back the DELETE (original rows survive)', () => {
      store.createSession({ id: 's1', userId: 1, model: 'm' });
      store.appendMessage({ id: 'keep', sessionId: 's1', parentId: null, role: 'user', content: { content: 'orig' } });
      // The summary id duplicates the kept row's id → the tail re-insert throws on the PK collision; the
      // whole transaction (DELETE included) must roll back, leaving the original message untouched.
      expect(() => store.compactSessionMessages('s1', { id: 'keep', role: 'compaction', content: {} }, 1)).toThrow();
      const rows = store.getMessages('s1');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe('keep');
      expect(JSON.parse(rows[0]!.content)).toMatchObject({ content: 'orig' });
    });
  });

  describe('usageByModel', () => {
    /** Append an assistant row carrying the full PI `usage` breakdown (+ a top-level ms `timestamp` and,
     *  when given, the PI `$.model` the row was produced with — the per-row attribution basis). */
    const usageMsg = (session: string, id: string, u: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number; totalTokens: number; cost?: number }, tsMs = Date.now(), model?: string) =>
      store.appendMessage({
        id, sessionId: session, parentId: null, role: 'assistant',
        content: {
          role: 'assistant',
          ...(model == null ? {} : { model }),
          usage: {
            input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0,
            reasoning: u.reasoning ?? 0, totalTokens: u.totalTokens, ...(u.cost == null ? {} : { cost: { total: u.cost } }),
          },
          timestamp: tsMs,
        },
      });
    /** Write the task_usage snapshot BrainWorkerService.recordUsage would leave for a healthy worker run
     *  — its presence is what makes a `brain-task-<id>` session's spend get excluded from the brain
     *  aggregates (no double count); a crashed worker leaves none. */
    const snapshotTask = (taskId: string) =>
      db.prepare("INSERT INTO task_usage (task_id, project_id, exec, total) VALUES (?, 1, 'elowen:claude-opus-4-8', 1)").run(taskId);

    it('sums a chat session per model with provider-reported cost, folding into an `elowen:<model>` bucket', () => {
      store.createSession({ id: 'brain-a', userId: 1, model: 'claude-opus-4-8' });
      usageMsg('brain-a', 'm1', { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 3, totalTokens: 100, cost: 0.1 });
      usageMsg('brain-a', 'm2', { input: 20, output: 8, cacheRead: 4, cacheWrite: 2, reasoning: 1, totalTokens: 200, cost: 0.2 });
      const rows = store.usageByModel(1);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.exec).toBe('elowen:claude-opus-4-8');
      expect(rows[0]!.usage.total).toBe(300);
      expect(rows[0]!.usage.input).toBe(30);
      expect(rows[0]!.usage.cacheRead).toBe(6);
      expect(rows[0]!.usage.reasoning).toBe(4);
      expect(rows[0]!.usage.costUsd).toBeCloseTo(0.3);
      expect(rows[0]!.usage.currency).toBe('USD');
      expect(rows[0]!.usage.costSource).toBe('provider_reported');
    });

    it('EXCLUDES a brain-task session that already snapshotted to task_usage (no double count)', () => {
      store.createSession({ id: 'brain-a', userId: 1, model: 'claude-opus-4-8' });
      usageMsg('brain-a', 'm1', { totalTokens: 100, cost: 0.1 });
      store.createSession({ id: 'brain-task-9', userId: 1, model: 'claude-opus-4-8' });
      usageMsg('brain-task-9', 't1', { totalTokens: 999, cost: 9.9 });
      snapshotTask('9'); // healthy worker → its spend lives in task_usage, so it must NOT re-count here
      const rows = store.usageByModel(1);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.usage.total).toBe(100); // the task worker's 999 is NOT folded in
      expect(rows[0]!.usage.costUsd).toBeCloseTo(0.1);
    });

    it('KEEPS a crashed brain-task session with NO task_usage snapshot (spend would otherwise vanish)', () => {
      store.createSession({ id: 'brain-a', userId: 1, model: 'claude-opus-4-8' });
      usageMsg('brain-a', 'm1', { totalTokens: 100, cost: 0.1 });
      // Worker died mid-run and the task was failed/cancelled, never relaunched → no snapshot ever written.
      store.createSession({ id: 'brain-task-9', userId: 1, model: 'claude-opus-4-8' });
      usageMsg('brain-task-9', 't1', { totalTokens: 40, cost: 0.04 }, Date.now(), 'claude-opus-4-8');
      const rows = store.usageByModel(1);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.usage.total).toBe(140); // 100 chat + 40 crashed-worker spend, both counted
      expect(rows[0]!.usage.costUsd).toBeCloseTo(0.14);
    });

    it('scopes to the caller, drops empty-model and zero-token rows', () => {
      store.createSession({ id: 'brain-a', userId: 1, model: 'claude-opus-4-8' });
      usageMsg('brain-a', 'm1', { totalTokens: 100, cost: 0.1 });
      store.createSession({ id: 'brain-b', userId: 1, model: '' }); // no model → excluded
      usageMsg('brain-b', 'm2', { totalTokens: 50, cost: 0.5 });
      store.createSession({ id: 'brain-c', userId: 1, model: 'relay/kimi' }); // usage-less → total 0, dropped
      usageMsg('brain-c', 'm3', { totalTokens: 0 });
      store.createSession({ id: 'brain-d', userId: 2, model: 'claude-opus-4-8' }); // other user → excluded
      usageMsg('brain-d', 'm4', { totalTokens: 700, cost: 7 });
      const rows = store.usageByModel(1);
      expect(rows.map((r) => r.exec)).toEqual(['elowen:claude-opus-4-8']);
      expect(rows[0]!.usage.total).toBe(100);
    });

    it('INCLUDES platform channel sessions (brain-ch-*) — the operator anchors them', () => {
      store.createSession({ id: 'brain-a', userId: 1, model: 'claude-opus-4-8' });
      usageMsg('brain-a', 'm1', { totalTokens: 100, cost: 0.1 });
      // A Discord channel session owned by the same operator (e.g. sarah-mimo-v2.5): its spend is the
      // operator's own and MUST show up in the per-model breakdown.
      store.createSession({ id: 'brain-ch-12345', userId: 1, model: 'sarah-mimo-v2.5' });
      usageMsg('brain-ch-12345', 'c1', { totalTokens: 5000, cost: 0.2 }, Date.now(), 'sarah-mimo-v2.5');
      const rows = store.usageByModel(1);
      expect(rows.map((r) => r.exec).sort()).toEqual(['elowen:claude-opus-4-8', 'elowen:sarah-mimo-v2.5']);
      expect(rows.find((r) => r.exec === 'elowen:sarah-mimo-v2.5')!.usage.total).toBe(5000);
    });

    it('reads cost as unavailable / null when no message carried one', () => {
      store.createSession({ id: 'brain-a', userId: 1, model: 'relay/glm' });
      usageMsg('brain-a', 'm1', { totalTokens: 100 });
      const [row] = store.usageByModel(1);
      expect(row!.usage.costUsd).toBeNull();
      expect(row!.usage.currency).toBeNull();
      expect(row!.usage.costSource).toBe('unavailable');
    });

    it('narrows to a from/to message-timestamp window', () => {
      store.createSession({ id: 'brain-a', userId: 1, model: 'claude-opus-4-8' });
      usageMsg('brain-a', 'old', { totalTokens: 100, cost: 0.1 }, Date.parse('2020-01-01T00:00:00Z'));
      usageMsg('brain-a', 'new', { totalTokens: 200, cost: 0.2 }, Date.parse('2026-06-15T00:00:00Z'));
      const rows = store.usageByModel(1, { fromIso: '2026-01-01T00:00:00Z' });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.usage.total).toBe(200); // only the in-window row
    });

    it('attributes each assistant row to the model that PRODUCED it, not the session current model', () => {
      store.createSession({ id: 'brain-a', userId: 1, model: 'claude-opus-4-8' });
      usageMsg('brain-a', 'm1', { totalTokens: 300, cost: 30 }, Date.now(), 'claude-opus-4-8');
      usageMsg('brain-a', 'm2', { totalTokens: 50, cost: 0.5 }, Date.now(), 'relay/kimi'); // same session, cheap model
      // User later runs /model, switching the SESSION's current model — history must NOT re-attribute.
      store.touchSession('brain-a', 'relay/kimi');
      const rows = store.usageByModel(1).sort((a, b) => a.exec.localeCompare(b.exec));
      expect(rows.map((r) => r.exec)).toEqual(['elowen:claude-opus-4-8', 'elowen:relay/kimi']);
      expect(rows.find((r) => r.exec === 'elowen:claude-opus-4-8')!.usage.total).toBe(300); // opus spend stays on opus
      expect(rows.find((r) => r.exec === 'elowen:relay/kimi')!.usage.total).toBe(50);
    });

    it('falls back to the session model for legacy rows with no per-message $.model', () => {
      store.createSession({ id: 'brain-a', userId: 1, model: 'claude-opus-4-8' });
      usageMsg('brain-a', 'm1', { totalTokens: 100, cost: 0.1 }); // no $.model → session model
      const rows = store.usageByModel(1);
      expect(rows.map((r) => r.exec)).toEqual(['elowen:claude-opus-4-8']);
    });

    it('keeps a bucket that reports cost with zero tokens (cost must not be filtered away)', () => {
      store.createSession({ id: 'brain-a', userId: 1, model: 'weird/model' });
      usageMsg('brain-a', 'm1', { totalTokens: 0, cost: 0.25 });
      const rows = store.usageByModel(1);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.usage.total).toBe(0);
      expect(rows[0]!.usage.costUsd).toBeCloseTo(0.25);
    });

    it('excludes an undated row from BOTH windowed and unwindowed views so the totals stay consistent', () => {
      store.createSession({ id: 'brain-a', userId: 1, model: 'claude-opus-4-8' });
      usageMsg('brain-a', 'dated', { totalTokens: 100, cost: 0.1 }, Date.parse('2026-06-15T00:00:00Z'), 'claude-opus-4-8');
      // A legacy assistant row that carries usage but NO `$.timestamp`.
      store.appendMessage({
        id: 'undated', sessionId: 'brain-a', parentId: null, role: 'assistant',
        content: { role: 'assistant', model: 'claude-opus-4-8', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 70, cost: { total: 0.07 } } },
      });
      const unwindowed = store.usageByModel(1);
      const windowed = store.usageByModel(1, { fromIso: '2026-01-01T00:00:00Z', toIso: '2027-01-01T00:00:00Z' });
      // The undated 70 is excluded from both, so a window that covers everything sums to the same total.
      expect(unwindowed[0]!.usage.total).toBe(100);
      expect(windowed[0]!.usage.total).toBe(100);
    });

    it('excludes a snapshotted brain-task session from usageByDay but keeps a crashed one', () => {
      store.createSession({ id: 'brain-a', userId: 1, model: 'm' });
      usageMsg('brain-a', 'm1', { totalTokens: 100, cost: 0.1 });
      store.createSession({ id: 'brain-task-9', userId: 1, model: 'm' });
      usageMsg('brain-task-9', 't1', { totalTokens: 900, cost: 0.9 });
      snapshotTask('9'); // in task_usage → excluded here
      store.createSession({ id: 'brain-task-8', userId: 1, model: 'm' });
      usageMsg('brain-task-8', 't2', { totalTokens: 30, cost: 0.03 }); // crashed, no snapshot → kept
      const days = store.usageByDay(1, 7);
      const tokens = days.reduce((s, d) => s + d.tokens, 0);
      expect(tokens).toBe(130); // 100 chat + 30 crashed-worker; the snapshotted 900 is NOT counted
    });

    it('includes platform channel (brain-ch-*) sessions in usageByDay', () => {
      store.createSession({ id: 'brain-a', userId: 1, model: 'm' });
      usageMsg('brain-a', 'm1', { totalTokens: 100, cost: 0.1 });
      store.createSession({ id: 'brain-ch-777', userId: 1, model: 'sarah-mimo-v2.5' });
      usageMsg('brain-ch-777', 'c1', { totalTokens: 5000, cost: 0.2 });
      const tokens = store.usageByDay(1, 7).reduce((s, d) => s + d.tokens, 0);
      expect(tokens).toBe(5100); // Discord channel spend IS counted (operator-anchored)
    });

    describe('survives compaction (rollup on the divider)', () => {
      it('keeps dropped assistant rows spend in usageByModel + usageByDay', () => {
        store.createSession({ id: 'brain-a', userId: 1, model: 'claude-opus-4-8' });
        usageMsg('brain-a', 'old1', { input: 5, totalTokens: 100, cost: 0.1 });
        usageMsg('brain-a', 'old2', { input: 5, totalTokens: 150, cost: 0.15 });
        usageMsg('brain-a', 'keep1', { input: 5, totalTokens: 200, cost: 0.2 });
        // Compact: keep only the last row, drop old1+old2 — their spend must roll onto the divider.
        store.compactSessionMessages('brain-a', { id: 'sum', role: 'compaction', content: { role: 'compactionSummary', summary: 's' } }, 1);
        expect(store.getMessages('brain-a').map((m) => m.id)).toEqual(['sum', 'keep1']);
        const [row] = store.usageByModel(1);
        expect(row!.usage.total).toBe(450); // 100 + 150 (rolled up) + 200 (kept)
        expect(row!.usage.input).toBe(15);
        expect(row!.usage.costUsd).toBeCloseTo(0.45);
        expect(store.usageByDay(1, 3650).reduce((s, d) => s + d.tokens, 0)).toBe(450);
      });

      it('keeps rolled-up spend at its ORIGINAL date even when the summary carries a PI timestamp', () => {
        const spendMs = Date.parse('2026-01-10T00:00:00Z');   // when the tokens were actually burned
        const compactMs = Date.parse('2026-06-20T00:00:00Z'); // months later, when the session compacted
        store.createSession({ id: 'brain-a', userId: 1, model: 'claude-opus-4-8' });
        usageMsg('brain-a', 'old', { totalTokens: 100, cost: 0.1 }, spendMs, 'claude-opus-4-8');
        usageMsg('brain-a', 'keep', { totalTokens: 5, cost: 0.005 }, compactMs, 'claude-opus-4-8');
        // Real PI CompactionSummaryMessage ALWAYS carries `timestamp` (the compaction moment) — the field
        // that used to shadow the rollup's own `at` and re-date historical spend to the compaction day.
        store.compactSessionMessages('brain-a', { id: 'sum', role: 'compaction', content: { role: 'compactionSummary', summary: 's', tokensBefore: 105, timestamp: compactMs } }, 1);

        // A window fully containing the ORIGINAL spend (ending BEFORE the compaction) still returns it.
        const early = store.usageByModel(1, { fromIso: '2026-01-01T00:00:00Z', toIso: '2026-02-01T00:00:00Z' });
        expect(early).toHaveLength(1);
        expect(early[0]!.usage.total).toBe(100); // rolled-up spend attributed to Jan, not June
        // A window over ONLY the compaction moment sees just the kept row, never the rolled-up spend.
        const late = store.usageByModel(1, { fromIso: '2026-06-01T00:00:00Z', toIso: '2026-07-01T00:00:00Z' });
        expect(late).toHaveLength(1);
        expect(late[0]!.usage.total).toBe(5);
        // usageByDay places the rolled-up spend on the spend day, not the compaction day.
        const days = store.usageByDay(1, 3650);
        expect(days.find((d) => d.day === '2026-01-10')?.tokens).toBe(100);
        expect(days.find((d) => d.day === '2026-06-20')?.tokens).toBe(5);
      });

      it('chains across a second compaction without losing the earlier rollup', () => {
        store.createSession({ id: 'brain-a', userId: 1, model: 'claude-opus-4-8' });
        usageMsg('brain-a', 'a', { totalTokens: 100, cost: 0.1 });
        usageMsg('brain-a', 'b', { totalTokens: 100, cost: 0.1 });
        store.compactSessionMessages('brain-a', { id: 'sum1', role: 'compaction', content: { role: 'compactionSummary' } }, 1);
        usageMsg('brain-a', 'c', { totalTokens: 100, cost: 0.1 });
        // Second compaction drops the first divider (its rollup) + row 'b' — both must survive.
        store.compactSessionMessages('brain-a', { id: 'sum2', role: 'compaction', content: { role: 'compactionSummary' } }, 1);
        const [row] = store.usageByModel(1);
        expect(row!.usage.total).toBe(300); // 100(a, rolled twice) + 100(b) + 100(c, kept)
        expect(row!.usage.costUsd).toBeCloseTo(0.3);
      });

      it('leaves the divider clean when nothing dropped carried usage', () => {
        store.createSession({ id: 'brain-a', userId: 1, model: 'm' });
        store.appendMessage({ id: 'u', sessionId: 'brain-a', parentId: null, role: 'user', content: { role: 'user', content: 'hi' } });
        store.appendMessage({ id: 'k', sessionId: 'brain-a', parentId: null, role: 'assistant', content: { role: 'assistant', content: 'yo' } });
        store.compactSessionMessages('brain-a', { id: 'sum', role: 'compaction', content: { role: 'compactionSummary' } }, 1);
        expect(JSON.parse(store.getMessages('brain-a')[0]!.content)).not.toHaveProperty('usageRollup');
      });
    });
  });

  describe('searchMessages', () => {
    const userMsg = (id: string, sessionId: string, text: string) =>
      store.appendMessage({ id, sessionId, parentId: null, role: 'user', content: { role: 'user', content: text } });

    it('finds matches only in the caller\'s own sessions', () => {
      store.createSession({ id: 'mine', userId: 1, title: 'Mine', model: 'm' });
      store.createSession({ id: 'theirs', userId: 2, title: 'Theirs', model: 'm' });
      userMsg('m1', 'mine', 'deploy the daemon tonight');
      userMsg('m2', 'theirs', 'deploy the daemon tonight');
      const hits = store.searchMessages(1, 'daemon');
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ sessionId: 'mine', sessionTitle: 'Mine', role: 'user' });
    });

    it('is case-insensitive over the user own chat sessions', () => {
      store.createSession({ id: 'mine2', userId: 1, title: 'Ops', model: 'm' });
      userMsg('m1', 'mine2', 'Restart NGINX please');
      expect(store.searchMessages(1, 'nginx')[0]?.sessionId).toBe('mine2');
    });

    it('excludes shared channel and ephemeral subagent sessions (personal chat search only)', () => {
      store.createSession({ id: 'brain-ch-42', userId: 1, title: 'Discord', model: 'm' });
      store.createSession({ id: 'brain-task-9', userId: 1, title: 'Subagent', model: 'm' });
      userMsg('c1', 'brain-ch-42', 'Restart NGINX please');
      userMsg('t1', 'brain-task-9', 'Restart NGINX please');
      expect(store.searchMessages(1, 'nginx')).toHaveLength(0);
    });

    it('treats LIKE wildcards as literals', () => {
      store.createSession({ id: 's', userId: 1, model: 'm' });
      userMsg('m1', 's', 'coverage is 100% done');
      userMsg('m2', 's', 'coverage is 100x done');
      userMsg('m3', 's', 'abc alphabet');
      expect(store.searchMessages(1, '100%')).toHaveLength(1);
      expect(store.searchMessages(1, '100%')[0]?.snippet).toContain('100% done');
      expect(store.searchMessages(1, 'a_c')).toHaveLength(0); // '_' must not act as a single-char wildcard ('abc')
    });

    it('never matches JSON structure, only display text', () => {
      store.createSession({ id: 's', userId: 1, model: 'm' });
      userMsg('m1', 's', 'plain words');
      expect(store.searchMessages(1, 'role')).toHaveLength(0); // every row's JSON carries "role"
    });

    it('returns [] for queries shorter than 2 chars', () => {
      store.createSession({ id: 's', userId: 1, model: 'm' });
      userMsg('m1', 's', 'x marks the spot');
      expect(store.searchMessages(1, 'x')).toHaveLength(0);
      expect(store.searchMessages(1, '  ')).toHaveLength(0);
    });

    it('clips the snippet to ±60 chars around the match with ellipses', () => {
      store.createSession({ id: 's', userId: 1, model: 'm' });
      userMsg('m1', 's', `${'a'.repeat(100)} needle ${'b'.repeat(100)}`);
      const [hit] = store.searchMessages(1, 'needle');
      expect(hit?.snippet.startsWith('…')).toBe(true);
      expect(hit?.snippet.endsWith('…')).toBe(true);
      expect(hit?.snippet).toContain('needle');
      expect(hit!.snippet.length).toBeLessThanOrEqual(2 + 'needle'.length + 120 + 2); // pads + match + 2×radius + ellipses
    });

    it('respects the limit, newest first', () => {
      store.createSession({ id: 's', userId: 1, model: 'm' });
      for (let i = 0; i < 5; i++) userMsg(`m${i}`, 's', `needle ${i}`);
      expect(store.searchMessages(1, 'needle', 3).map((h) => h.snippet)).toEqual(['needle 4', 'needle 3', 'needle 2']);
    });
  });

  describe('userStats', () => {
    it('counts a user\'s sessions and picks the model used in the most of them', () => {
      store.createSession({ id: 'a', userId: 1, model: 'anthropic/opus' });
      store.createSession({ id: 'b', userId: 1, model: 'anthropic/opus' });
      store.createSession({ id: 'c', userId: 1, model: 'relay/kimi' });
      store.createSession({ id: 'd', userId: 2, model: 'other/model' }); // another user — excluded
      const stats = store.userStats(1);
      expect(stats.sessionCount).toBe(3);
      expect(stats.topModel).toBe('anthropic/opus');
    });

    it('returns a zero count and null top model for a user with no sessions', () => {
      expect(store.userStats(99)).toEqual({ sessionCount: 0, topModel: null });
    });

    it('ignores sessions with an empty model when choosing the top model', () => {
      store.createSession({ id: 'a', userId: 5, model: '' });
      store.createSession({ id: 'b', userId: 5, model: 'relay/glm' });
      const stats = store.userStats(5);
      expect(stats.sessionCount).toBe(2); // both counted
      expect(stats.topModel).toBe('relay/glm'); // but the blank-model one isn't the "top"
    });
  });

  describe('display cards', () => {
    const card = (id: string, text: string) => ({ id, title: 'Todos', pinned: true, items: [{ text, status: 'pending' as const }] });

    it('stores a card and reads it back whole', () => {
      store.upsertCard('s1', card('todos', 'Ship it'));
      expect(store.getCards('s1')).toEqual([card('todos', 'Ship it')]);
    });

    it('re-emitting a card updates it in place instead of appending a second panel', () => {
      store.upsertCard('s1', card('todos', 'Ship it'));
      store.upsertCard('s1', card('todos', 'Shipped'));
      const cards = store.getCards('s1');
      expect(cards).toHaveLength(1);
      expect(cards[0].items![0].text).toBe('Shipped');
    });

    it('keeps emit order, and an update does not jump the card to the end', () => {
      store.upsertCard('s1', card('a', '1'));
      store.upsertCard('s1', card('b', '2'));
      store.upsertCard('s1', card('a', '1 again'));
      expect(store.getCards('s1').map((c) => c.id)).toEqual(['a', 'b']);
    });

    it('scopes cards to their conversation, and deleting one takes only its own', () => {
      store.createSession({ id: 's1', userId: 7, model: 'm' });
      store.upsertCard('s1', card('todos', 'mine'));
      store.upsertCard('s2', card('todos', 'theirs'));
      store.deleteSession('s1');
      expect(store.getCards('s1')).toEqual([]);
      expect(store.getCards('s2')).toHaveLength(1);
    });

    it('carries the cards along when a conversation is re-keyed (channel rollover)', () => {
      store.createSession({ id: 'old', userId: 7, model: 'm' });
      store.upsertCard('old', card('todos', 'Ship it'));
      store.reassignSession('old', 'archived');
      expect(store.getCards('old')).toEqual([]);
      expect(store.getCards('archived')).toHaveLength(1);
    });

    // The panel is rebuilt from whatever the DB holds, so one bad row must cost one card — not the list.
    it('skips a payload it cannot parse rather than taking the whole panel down', () => {
      store.upsertCard('s1', card('good', 'Ship it'));
      db.prepare("INSERT INTO brain_cards (session_id, card_id, payload) VALUES ('s1', 'broken', '{oops')").run();
      expect(store.getCards('s1').map((c) => c.id)).toEqual(['good']);
    });
  });

  describe('workflow runs', () => {
    const wf = (over: Record<string, unknown> = {}) => ({
      id: 'wf-1', toolCallId: 'call-1', title: 'Ship it', status: 'running',
      nodes: [{ id: 'gather', task: 'gather facts', status: 'done', deps: [], sessionId: 'child', tokens: 120, seconds: 4 }],
      ...over,
    });

    it('persists a snapshot and reads it back', () => {
      store.createSession({ id: 'root', userId: 1, model: 'm' });
      store.createSession({ id: 'child', userId: 1, model: 'm', parentSessionId: 'root' });
      expect(store.upsertWorkflowRun('root', wf())).toBe(true);
      expect(store.getWorkflowRuns('root')).toEqual([wf()]);
    });

    // The normalizer is a rebuild whitelist, so a field it does not name is silently dropped on every
    // persist — this round trip is what pins result/error/startedAt into it.
    it('round-trips startedAt and bounded result/error previews on nodes', () => {
      store.createSession({ id: 'root', userId: 1, model: 'm' });
      const nodes = [
        { id: 'good', task: 't', status: 'done', deps: [], startedAt: 1700000000000, result: `r${'x'.repeat(700)}` },
        { id: 'bad', task: 't', status: 'error', deps: [], error: 'boom' },
      ];
      expect(store.upsertWorkflowRun('root', wf({ nodes }))).toBe(true);
      const [run] = store.getWorkflowRuns('root');
      const good = run!.nodes.find((n) => n.id === 'good')!;
      expect(good.startedAt).toBe(1700000000000);
      expect(good.result).toHaveLength(600); // bounded, not the raw 701 chars
      expect(run!.nodes.find((n) => n.id === 'bad')!.error).toBe('boom');
      // Malformed variants of the new fields reject the snapshot rather than coercing.
      expect(store.upsertWorkflowRun('root', wf({ nodes: [{ id: 'a', task: 't', status: 'done', deps: [], startedAt: -5 }] }))).toBe(false);
      expect(store.upsertWorkflowRun('root', wf({ nodes: [{ id: 'a', task: 't', status: 'done', deps: [], result: 42 }] }))).toBe(false);
    });

    it('keeps only the newest snapshot per tool call, and binds a tool call to its first workflow id', () => {
      store.createSession({ id: 'root', userId: 1, model: 'm' });
      store.upsertWorkflowRun('root', wf({ nodes: [] }));
      store.upsertWorkflowRun('root', wf({ status: 'done', nodes: [] }));
      expect(store.getWorkflowRuns('root')).toEqual([wf({ status: 'done', nodes: [] })]);
      // A second workflow claiming the same tool call would fork the transcript marker.
      expect(store.upsertWorkflowRun('root', wf({ id: 'wf-2', nodes: [] }))).toBe(false);
      expect(store.getWorkflowRuns('root')[0]?.id).toBe('wf-1');
    });

    it('rejects an unknown origin and malformed snapshots rather than coercing them', () => {
      store.createSession({ id: 'root', userId: 1, model: 'm' });
      expect(store.upsertWorkflowRun('nope', wf({ nodes: [] }))).toBe(false);
      expect(store.upsertWorkflowRun('root', wf({ status: 'weird', nodes: [] }))).toBe(false);
      expect(store.upsertWorkflowRun('root', wf({ toolCallId: '' }))).toBe(false);
      expect(store.upsertWorkflowRun('root', wf({ nodes: [{ id: 'a', task: 't', status: 'nope', deps: [] }] }))).toBe(false);
      expect(store.upsertWorkflowRun('root', wf({ nodes: [{ id: 'a', task: 't', status: 'done', deps: 'x' }] }))).toBe(false);
      expect(store.upsertWorkflowRun('root', wf({ nodes: [{ id: 'a', task: 't', status: 'done', deps: [], tokens: -1 }] }))).toBe(false);
      // A duplicate node id would make the modal's per-node keying ambiguous.
      expect(store.upsertWorkflowRun('root', wf({ nodes: [
        { id: 'a', task: 't', status: 'done', deps: [] }, { id: 'a', task: 't2', status: 'done', deps: [] },
      ] }))).toBe(false);
      expect(store.upsertWorkflowRun('root', wf({
        nodes: Array.from({ length: 65 }, (_, i) => ({ id: `n${i}`, task: 't', status: 'pending', deps: [] })),
      }))).toBe(false);
      expect(store.getWorkflowRuns('root')).toEqual([]);
    });

    it('bounds oversized text instead of storing it whole', () => {
      store.createSession({ id: 'root', userId: 1, model: 'm' });
      store.upsertWorkflowRun('root', wf({
        title: 'T'.repeat(400),
        nodes: [{ id: 'a', task: 'x'.repeat(5_000), status: 'running', deps: [], detail: 'd'.repeat(2_000) }],
      }));
      const [run] = store.getWorkflowRuns('root');
      expect(run?.title).toHaveLength(200);
      expect(run?.nodes[0]?.task).toHaveLength(600);
      expect(run?.nodes[0]?.detail).toHaveLength(500);
    });

    it('drops a corrupt row rather than taking the whole conversation down', () => {
      store.createSession({ id: 'root', userId: 1, model: 'm' });
      store.upsertWorkflowRun('root', wf({ nodes: [] }));
      db.prepare("INSERT INTO brain_workflows (parent_session_id, tool_call_id, workflow_id, state) VALUES ('root', 'call-2', 'wf-9', '{oops')").run();
      expect(store.getWorkflowRuns('root').map((r) => r.id)).toEqual(['wf-1']);
    });

    // The stored sessionId is never trusted: it is re-derived from the live relation on every read, so a
    // node can only ever point the drill-in at a direct child of THIS conversation.
    it('resolves a node drill-in only for a direct same-owner child, keeping the node either way', () => {
      store.createSession({ id: 'root', userId: 1, model: 'm' });
      store.createSession({ id: 'child', userId: 1, model: 'm', parentSessionId: 'root' });
      store.createSession({ id: 'unrelated', userId: 1, model: 'm' });
      store.createSession({ id: 'foreign', userId: 2, model: 'm' });
      db.prepare("UPDATE brain_sessions SET parent_session_id = 'root' WHERE id = 'foreign'").run();
      const node = (id: string, sessionId: string) => ({ id, task: 't', status: 'done' as const, deps: [], sessionId });
      store.upsertWorkflowRun('root', wf({ nodes: [
        node('ok', 'child'), node('loose', 'unrelated'), node('cross', 'foreign'), node('gone', 'deleted-id'),
      ] }));

      const nodes = store.getWorkflowRuns('root')[0]?.nodes ?? [];
      expect(nodes.map((n) => n.id)).toEqual(['ok', 'loose', 'cross', 'gone']); // every node survives
      expect(nodes[0]?.sessionId).toBe('child');
      expect(nodes[1]?.sessionId).toBeUndefined();
      expect(nodes[2]?.sessionId).toBeUndefined();
      expect(nodes[3]?.sessionId).toBeUndefined();
    });

    it('survives deleting a node child, but goes with its origin', () => {
      store.createSession({ id: 'root', userId: 1, model: 'm' });
      store.createSession({ id: 'child', userId: 1, model: 'm', parentSessionId: 'root' });
      store.upsertWorkflowRun('root', wf());

      store.deleteSession('child');
      const [run] = store.getWorkflowRuns('root');
      expect(run?.nodes[0]?.id).toBe('gather');        // the DAG is still the record of what ran
      expect(run?.nodes[0]?.sessionId).toBeUndefined(); // only the drill-in goes

      store.deleteSession('root');
      expect(store.getWorkflowRuns('root')).toEqual([]);
    });

    it('carries the workflow along when a conversation is re-keyed (channel rollover)', () => {
      store.createSession({ id: 'old', userId: 7, model: 'm' });
      store.upsertWorkflowRun('old', wf({ nodes: [] }));
      store.reassignSession('old', 'archived');
      expect(store.getWorkflowRuns('old')).toEqual([]);
      expect(store.getWorkflowRuns('archived')).toEqual([wf({ nodes: [] })]);
    });
  });

  describe('session events', () => {
    it('appends a marker and reads it back in insertion order with an ISO timestamp', () => {
      store.createSession({ id: 's1', userId: 7, model: 'm' });
      const first = store.appendSessionEvent('s1', 'model', 'anthropic/claude');
      const second = store.appendSessionEvent('s1', 'mode', 'Workflow');
      expect(first.id).not.toBe(second.id);
      expect(first.at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
      expect(store.getSessionEvents('s1')).toEqual([
        { id: first.id, kind: 'model', detail: 'anthropic/claude', at: first.at },
        { id: second.id, kind: 'mode', detail: 'Workflow', at: second.at },
      ]);
    });

    it('scopes markers to their conversation, and deleting one takes only its own', () => {
      store.createSession({ id: 's1', userId: 7, model: 'm' });
      store.appendSessionEvent('s1', 'rename', 'Mine');
      store.appendSessionEvent('s2', 'rename', 'Theirs');
      store.deleteSession('s1');
      expect(store.getSessionEvents('s1')).toEqual([]);
      expect(store.getSessionEvents('s2')).toHaveLength(1);
    });

    it('carries the markers along when a conversation is re-keyed (channel rollover)', () => {
      store.createSession({ id: 'old', userId: 7, model: 'm' });
      const event = store.appendSessionEvent('old', 'reasoning', 'high');
      store.reassignSession('old', 'archived');
      expect(store.getSessionEvents('old')).toEqual([]);
      expect(store.getSessionEvents('archived')).toEqual([{ id: event.id, kind: 'reasoning', detail: 'high', at: event.at }]);
    });
  });

  describe('deleteSession', () => {
    it('removes the session\'s tool-result spill dir along with its rows', async () => {
      const { mkdtempSync, mkdirSync, writeFileSync, existsSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');
      const home = mkdtempSync(join(tmpdir(), 'elowen-spill-purge-'));
      vi.stubEnv('HOME', home);
      try {
        store.createSession({ id: 's1', userId: 7, model: 'm' });
        store.createSession({ id: 's2', userId: 7, model: 'm' });
        const spill1 = join(home, '.config/elowen/tool-results/s1');
        const spill2 = join(home, '.config/elowen/tool-results/s2');
        mkdirSync(spill1, { recursive: true });
        mkdirSync(spill2, { recursive: true });
        writeFileSync(join(spill1, 'call-1.txt'), 'x');
        writeFileSync(join(spill2, 'call-2.txt'), 'y');
        store.deleteSession('s1');
        expect(existsSync(spill1)).toBe(false);
        expect(existsSync(spill2)).toBe(true); // the other session's spills are untouched
        expect(store.getSession('s1')).toBeUndefined();
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  describe('reassignSession', () => {
    it('moves the tool-result spill dir along with the re-keyed conversation', async () => {
      const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');
      const home = mkdtempSync(join(tmpdir(), 'elowen-spill-move-'));
      vi.stubEnv('HOME', home);
      try {
        store.createSession({ id: 'chan-x', userId: 7, model: 'm' });
        const oldDir = join(home, '.config/elowen/tool-results/chan-x');
        const newDir = join(home, '.config/elowen/tool-results/arch-1');
        mkdirSync(oldDir, { recursive: true });
        writeFileSync(join(oldDir, 'call-1.txt'), 'spilled');
        store.reassignSession('chan-x', 'arch-1');
        expect(existsSync(oldDir)).toBe(false);
        expect(readFileSync(join(newDir, 'call-1.txt'), 'utf8')).toBe('spilled');
        // …so a later delete of the archived conversation actually cleans its spills up.
        store.deleteSession('arch-1');
        expect(existsSync(newDir)).toBe(false);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('reassign without any spills on disk is fine', () => {
      store.createSession({ id: 'a', userId: 7, model: 'm' });
      expect(() => store.reassignSession('a', 'b')).not.toThrow();
      expect(store.getSession('b')).toBeDefined();
    });
  });
});
