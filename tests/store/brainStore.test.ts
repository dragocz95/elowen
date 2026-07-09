import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';

describe('BrainStore', () => {
  let store: BrainStore;
  let db: Db;
  beforeEach(() => { db = openDb(':memory:'); store = new BrainStore(db); });

  it('creates and reads back a session', () => {
    const s = store.createSession({ id: 's1', userId: 7, model: 'anthropic/claude' });
    expect(s.user_id).toBe(7);
    expect(store.getSession('s1')?.model).toBe('anthropic/claude');
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

  it('sessions start cwd-less; setWorkDir binds them to a directory', () => {
    store.createSession({ id: 'a', userId: 1, model: 'm' });
    expect(store.getSession('a')?.work_dir).toBe('');
    store.setWorkDir('a', '/repo/project');
    expect(store.getSession('a')?.work_dir).toBe('/repo/project');
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
});
