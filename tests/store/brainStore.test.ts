import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolve, dirname } from 'node:path';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type Db } from '../../src/store/db.js';
import { openDb } from '../../src/store/db.js';
import { BrainStore, SESSION_EVENT_KINDS, syntheticRestartResultId } from '../../src/store/brainStore.js';
import { rollupDroppedUsage } from '../../src/store/brainUsageStore.js';
import { planSlug } from '../../src/shared/planSlug.js';

// The delivery path's tail truncation is a deliberate mirror of the subagent plugin's (neither side can
// import the other). Loading the plugin copy here is what keeps the two from drifting apart.
const { clipTail } = await import(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../plugins/subagent/lib/results.mjs')
) as { clipTail(text: string, limit: number): string };

describe('BrainStore', () => {
  let store: BrainStore;
  let db: Db;
  let dirs: string[] = [];
  afterEach(() => { for (const p of dirs) rmSync(p, { recursive: true, force: true }); dirs = []; });
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
      detail: 'Read src/a.ts', tools: 2, tokens: 1234, seconds: 2, model: 'm',
      thinkingLevel: 'high', thinkingLabel: 'High', background: true, workspaceId: 'ws_abc123',
    })).toBe(true);
    // The DTO reads both timestamps from the existing tables; neither lives in the JSON state.
    db.prepare("UPDATE brain_sessions SET created_at = '2026-08-30 05:00:00' WHERE id = 'child'").run();
    db.prepare("UPDATE brain_subagent_runs SET updated_at = '2026-08-30 05:00:07' WHERE tool_call_id = 'delegate-1'").run();
    expect(store.getSubagentRuns('root')).toEqual([{
      toolCallId: 'delegate-1', sessionId: 'child', status: 'running', task: 'inspect',
      detail: 'Read src/a.ts', tools: 2, tokens: 1234, seconds: 2, model: 'm',
      thinkingLevel: 'high', thinkingLabel: 'High', background: true, workspaceId: 'ws_abc123',
      startedAt: '2026-08-30 05:00:00', updatedAt: '2026-08-30 05:00:07',
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
    expect(store.upsertSubagentRun('root', {
      id: 'bad-workspace', sessionId: 'child', status: 'running', task: 'x', tools: 0, seconds: 0, workspaceId: 123,
    })).toBe(false);
    // A call id cannot later be rebound to a different child.
    store.createSession({ id: 'child-2', userId: 1, model: 'm', parentSessionId: 'root' });
    expect(store.upsertSubagentRun('root', {
      id: 'delegate-1', sessionId: 'child-2', status: 'done', task: 'x', tools: 1, seconds: 1,
    })).toBe(false);
    // A pre-reasoning JSON state still receives the relational timestamps and simply omits newer metadata.
    db.prepare("UPDATE brain_subagent_runs SET state = ? WHERE tool_call_id = 'delegate-1'").run(JSON.stringify({
      status: 'done', task: 'legacy', tools: 1, seconds: 9,
    }));
    expect(store.getSubagentRuns('root')).toEqual([expect.objectContaining({
      task: 'legacy', status: 'done', startedAt: '2026-08-30 05:00:00', updatedAt: '2026-08-30 05:00:07',
    })]);
    expect(store.getSubagentRuns('root')[0]).not.toHaveProperty('thinkingLevel');
    db.prepare("UPDATE brain_subagent_runs SET state = '{bad json' WHERE tool_call_id = 'delegate-1'").run();
    expect(store.getSubagentRuns('root')).toEqual([]); // corrupt state never reaches a renderer
  });

  it('stamps lifecycle and this boot on a running sub-agent row, and keeps the owner on terminal states', () => {
    store.setDelegationBootId('boot-A');
    store.createSession({ id: 'root', userId: 1, model: 'm' });
    store.createSession({ id: 'child', userId: 1, model: 'm', parentSessionId: 'root' });
    const row = () => db.prepare("SELECT lifecycle, owner_boot_id FROM brain_subagent_runs WHERE tool_call_id = 'd1'").get() as { lifecycle: string; owner_boot_id: string | null };

    expect(store.upsertSubagentRun('root', { id: 'd1', sessionId: 'child', status: 'running', task: 't', tools: 0, seconds: 0 })).toBe(true);
    // A running row mirrors the status into lifecycle AND records the boot that owns it, so a later boot
    // can recognise it as a restart orphan (owner_boot_id != that later boot).
    expect(row()).toEqual({ lifecycle: 'running', owner_boot_id: 'boot-A' });

    expect(store.upsertSubagentRun('root', { id: 'd1', sessionId: 'child', status: 'done', task: 't', tools: 1, seconds: 1 })).toBe(true);
    // Terminal state updates lifecycle but leaves the owner intact — a done row is never claimed (the claim
    // filters on lifecycle), so its owner is a harmless audit trail, not a signal.
    expect(row()).toEqual({ lifecycle: 'done', owner_boot_id: 'boot-A' });
  });

  it('claims restart orphans for the new boot but leaves its own live work and a leased concurrent recovery alone', () => {
    // Boot A ran three children, then the daemon restarted as boot B.
    store.setDelegationBootId('boot-A');
    store.createSession({ id: 'root', userId: 1, model: 'm' });
    for (const c of ['c1', 'c2', 'c3']) store.createSession({ id: c, userId: 1, model: 'm', parentSessionId: 'root' });
    const running = (tc: string, child: string) => store.upsertSubagentRun('root', { id: tc, sessionId: child, status: 'running', task: 't', tools: 0, seconds: 0 });
    running('orphan', 'c1'); // owned by boot-A
    // A row already `recovering` under a DIFFERENT boot with a LIVE lease = a concurrent recovery; leave it.
    running('leased', 'c2');
    db.prepare("UPDATE brain_subagent_runs SET lifecycle='recovering', owner_boot_id='boot-C', lease_until=? WHERE tool_call_id='leased'").run(Date.now() + 60_000);
    // A row `recovering` under another boot with an EXPIRED lease = that recovery died; reclaim it.
    running('stale', 'c3');
    db.prepare("UPDATE brain_subagent_runs SET lifecycle='recovering', owner_boot_id='boot-C', lease_until=? WHERE tool_call_id='stale'").run(Date.now() - 1);

    store.setDelegationBootId('boot-B');
    // Also start a genuinely live child under boot-B: it must NOT be claimed as an orphan.
    store.createSession({ id: 'c4', userId: 1, model: 'm', parentSessionId: 'root' });
    running('live-b', 'c4');

    const claimed = store.claimRecoverableRuns(30_000).map((r) => r.toolCallId).sort();
    expect(claimed).toEqual(['orphan', 'stale']); // boot-A orphan + expired-lease recovering
    const lc = (tc: string) => (db.prepare('SELECT lifecycle, owner_boot_id, attempt FROM brain_subagent_runs WHERE tool_call_id = ?').get(tc) as { lifecycle: string; owner_boot_id: string; attempt: number });
    expect(lc('orphan')).toMatchObject({ lifecycle: 'recovering', owner_boot_id: 'boot-B', attempt: 1 });
    expect(lc('leased')).toMatchObject({ lifecycle: 'recovering', owner_boot_id: 'boot-C' }); // untouched
    expect(lc('live-b')).toMatchObject({ lifecycle: 'running', owner_boot_id: 'boot-B' }); // own live work
  });

  it('completes a claimed run atomically (terminal + enqueue) and rejects a completion from a non-owner boot', () => {
    store.setDelegationBootId('boot-A');
    store.createSession({ id: 'root', userId: 1, model: 'm' });
    store.createSession({ id: 'child', userId: 1, model: 'm', parentSessionId: 'root' });
    store.upsertSubagentRun('root', { id: 'd1', sessionId: 'child', status: 'running', task: 't', tools: 0, seconds: 0, autoDeliver: true });
    store.setDelegationBootId('boot-B');
    expect(store.claimRecoverableRuns(30_000).map((r) => r.toolCallId)).toEqual(['d1']);

    const completion = { id: 'dlg-x', toolCallId: 'd1', sessionId: 'child', status: 'done' as const, task: 't', result: 'recovered answer', tools: 1, seconds: 2 };
    // A completion from a boot that does NOT hold the claim is rejected.
    store.setDelegationBootId('boot-OTHER');
    expect(store.completeRecoveredRun('root', 'd1', completion)).toBe(false);
    // The owner boot completes it: run goes terminal AND the result is enqueued in one shot.
    store.setDelegationBootId('boot-B');
    expect(store.completeRecoveredRun('root', 'd1', completion)).toBe(true);
    expect((db.prepare("SELECT lifecycle FROM brain_subagent_runs WHERE tool_call_id='d1'").get() as { lifecycle: string }).lifecycle).toBe('done');
    expect(store.pendingSubagentResults('root').map((r) => r.result)).toEqual(['recovered answer']);
  });

  it('parks a claimed run as recovery_required with a reason and notifies the parent, only for the owning boot', () => {
    store.setDelegationBootId('boot-A');
    store.createSession({ id: 'root', userId: 1, model: 'm' });
    store.createSession({ id: 'child', userId: 1, model: 'm', parentSessionId: 'root' });
    store.upsertSubagentRun('root', { id: 'd1', sessionId: 'child', status: 'running', task: 't', tools: 0, seconds: 0 });
    store.setDelegationBootId('boot-B');
    store.claimRecoverableRuns(30_000);
    const notice = { id: 'd1', toolCallId: 'd1', sessionId: 'child', status: 'error' as const, task: 't', error: 'interrupted; use DelegateContinue to resume', tools: 0, seconds: 0 };
    // A non-owner boot cannot park it, and parking is atomic with the parent notice.
    store.setDelegationBootId('boot-OTHER');
    expect(store.markRecoveryRequired('root', 'd1', 'unanswered Write in discarded suffix', notice)).toBe(false);
    store.setDelegationBootId('boot-B');
    expect(store.markRecoveryRequired('root', 'd1', 'unanswered Write in discarded suffix', notice)).toBe(true);
    const st = db.prepare("SELECT lifecycle, state, owner_boot_id FROM brain_subagent_runs WHERE tool_call_id='d1'").get() as { lifecycle: string; state: string; owner_boot_id: string | null };
    expect(st.lifecycle).toBe('recovery_required');
    expect(st.owner_boot_id).toBeNull();
    expect(JSON.parse(st.state).recoveryReason).toBe('unanswered Write in discarded suffix');
    // The parent learns about it through the durable inbox — otherwise it would wait forever.
    const pending = store.pendingSubagentResults('root');
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ status: 'error', requiresUserAction: true });
    expect(pending[0]!.error).toContain('DelegateContinue');
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

  // The last bound a delegated result passes before it is delivered to the parent. Over the ceiling it keeps
  // its END — a report's conclusion is its last paragraph — and says so in the same words the plugin uses.
  it('keeps the END of an over-long result on the delivery path, exactly as the plugin does', () => {
    store.createSession({ id: 'root', userId: 1, model: 'm' });
    store.createSession({ id: 'child', userId: 1, model: 'm', parentSessionId: 'root' });
    store.upsertSubagentRun('root', {
      id: 'delegate-1', sessionId: 'child', status: 'done', task: 'inspect', tools: 1, seconds: 1,
    });
    const conclusion = 'CONCLUSION: the lock is never released on the error path.';
    const report = `OPENING: how I looked.\n${'y'.repeat(120_000)}\n${conclusion}`;
    expect(store.enqueueSubagentResult('root', {
      id: 'dlg-long', toolCallId: 'delegate-1', sessionId: 'child', status: 'done', task: 'inspect',
      result: report, tools: 1, seconds: 1,
    })).toBe(true);

    const stored = store.pendingSubagentResults('root')[0]!.result!;
    expect(stored.endsWith(conclusion)).toBe(true);
    expect(stored).not.toContain('OPENING: how I looked.');
    expect(stored).toMatch(/^\[truncated: first \d+ chars dropped, end kept — read it in full with DelegateRead\]\n/);
    expect(stored.length).toBeLessThanOrEqual(100_000);
    expect(stored).toBe(clipTail(report, 100_000)); // the two copies must not drift
  });

  // A DAG summary is every node's result end to end, so it is the payload that really can exceed the
  // ceiling — and cutting its head costs the FIRST nodes, not the last ones the parent was waiting for.
  it('keeps the END of an over-long workflow summary too', () => {
    store.createSession({ id: 'root', userId: 1, model: 'm' });
    expect(store.upsertWorkflowRun('root', { id: 'wf-1', toolCallId: 'wfcall-1', status: 'done', nodes: [] })).toBe(true);
    const lastNode = '[write] DONE\nthe document is published.';
    const summary = `[gather] DONE\n${'y'.repeat(120_000)}\n${lastNode}`;
    expect(store.enqueueWorkflowResult('root', {
      id: 'wf-1', toolCallId: 'wfcall-1', status: 'done', result: summary,
    })).toBe(true);

    const stored = store.pendingSubagentResults('root')[0]!.result!;
    expect(stored.endsWith(lastNode)).toBe(true);
    expect(stored).not.toContain('[gather] DONE');
    expect(stored).toBe(clipTail(summary, 100_000));
  });

  describe('workflow results share the delegated-result inbox with a kind discriminator', () => {
    it('accepts a workflow completion linked to a known (parent, tool-call) DAG and reads it kind-aware', () => {
      store.createSession({ id: 'root', userId: 1, model: 'm' });
      // A durable DAG for this tool call is the linkage a workflow result validates against.
      expect(store.upsertWorkflowRun('root', { id: 'wf-1', toolCallId: 'wfcall-1', status: 'done', nodes: [] })).toBe(true);
      const completion = { id: 'wf-1', toolCallId: 'wfcall-1', title: 'Ship it', status: 'done' as const, result: 'every node done' };
      expect(store.enqueueWorkflowResult('root', completion)).toBe(true);
      expect(store.enqueueWorkflowResult('root', completion)).toBe(true); // duplicate emit is idempotent

      const pending = store.pendingSubagentResults('root');
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        kind: 'workflow', id: 'wf-1', toolCallId: 'wfcall-1', sessionId: '', workflowId: 'wf-1',
        status: 'done', task: 'Ship it', result: 'every node done', delivery: 'pending',
      });
      // Acknowledgement + retry accounting are kind-agnostic (the whole point of one shared queue).
      expect(store.acknowledgeSubagentResult('root', 'wf-1')).toBe(true);
      expect(store.pendingSubagentResults('root')).toEqual([]);
    });

    it('rejects a workflow result whose (parent, tool-call) has no durable DAG', () => {
      store.createSession({ id: 'root', userId: 1, model: 'm' });
      store.upsertWorkflowRun('root', { id: 'wf-1', toolCallId: 'wfcall-1', status: 'running', nodes: [] });
      // Right parent, but a tool call that never persisted a workflow.
      expect(store.enqueueWorkflowResult('root', { id: 'wf-x', toolCallId: 'ghost', status: 'done', result: 'x' })).toBe(false);
      // Unknown parent session entirely.
      expect(store.enqueueWorkflowResult('nope', { id: 'wf-1', toolCallId: 'wfcall-1', status: 'done', result: 'x' })).toBe(false);
      // Malformed completion (bad status / non-string body) never reaches the queue.
      expect(store.enqueueWorkflowResult('root', { id: 'wf-1', toolCallId: 'wfcall-1', status: 'weird', result: 'x' })).toBe(false);
      expect(store.enqueueWorkflowResult('root', { id: 'wf-1', toolCallId: 'wfcall-1', status: 'done', result: 42 })).toBe(false);
      expect(store.pendingSubagentResults('root')).toEqual([]);
    });

    it('collapses a cancelled workflow to an errored delivery while preserving the summary body', () => {
      store.createSession({ id: 'root', userId: 1, model: 'm' });
      store.upsertWorkflowRun('root', { id: 'wf-1', toolCallId: 'wfcall-1', status: 'cancelled', nodes: [] });
      expect(store.enqueueWorkflowResult('root', { id: 'wf-1', toolCallId: 'wfcall-1', status: 'cancelled', result: 'stopped mid-run' })).toBe(true);
      expect(store.pendingSubagentResults('root')[0]).toMatchObject({ kind: 'workflow', status: 'error', result: 'stopped mid-run' });
    });

    it('keeps sub-agent and workflow results side by side, each read as its own kind', () => {
      store.createSession({ id: 'root', userId: 1, model: 'm' });
      store.createSession({ id: 'child', userId: 1, model: 'm', parentSessionId: 'root' });
      store.upsertSubagentRun('root', { id: 'dlg-call', sessionId: 'child', status: 'done', task: 'inspect', tools: 1, seconds: 1 });
      store.upsertWorkflowRun('root', { id: 'wf-1', toolCallId: 'wf-call', status: 'done', nodes: [] });
      expect(store.enqueueSubagentResult('root', {
        id: 'dlg-1', toolCallId: 'dlg-call', sessionId: 'child', status: 'done', task: 'inspect', result: 'clear', tools: 1, seconds: 1,
      })).toBe(true);
      expect(store.enqueueWorkflowResult('root', { id: 'wf-1', toolCallId: 'wf-call', status: 'done', result: 'dag done' })).toBe(true);
      const pending = store.pendingSubagentResults('root');
      expect(pending.map((row) => row.kind).sort()).toEqual(['subagent', 'workflow']);
      expect(pending.find((row) => row.kind === 'subagent')).toMatchObject({ id: 'dlg-1', sessionId: 'child', result: 'clear' });
      expect(pending.find((row) => row.kind === 'workflow')).toMatchObject({ id: 'wf-1', sessionId: '', result: 'dag done' });
    });

    // `null` and bare scalars are valid JSON, so a payload that parses is not necessarily readable: the
    // workflow branch reads `payload.result` directly, and one such row used to throw out of the whole
    // drain — leaving every healthy pending result of that parent undelivered forever.
    it('drops a payload that is not an object without killing the rest of the drain', () => {
      store.createSession({ id: 'root', userId: 1, model: 'm' });
      store.createSession({ id: 'child', userId: 1, model: 'm', parentSessionId: 'root' });
      store.upsertSubagentRun('root', { id: 'dlg-call', sessionId: 'child', status: 'done', task: 'inspect', tools: 1, seconds: 1 });
      expect(store.enqueueSubagentResult('root', {
        id: 'dlg-1', toolCallId: 'dlg-call', sessionId: 'child', status: 'done', task: 'inspect', result: 'clear', tools: 1, seconds: 1,
      })).toBe(true);
      const corruptPayload = (resultId: string, payload: string) =>
        db.prepare(
          `INSERT INTO brain_subagent_results
             (result_id, parent_session_id, tool_call_id, child_session_id, kind, workflow_id, status, task, payload)
           VALUES (?, 'root', ?, '', 'workflow', ?, 'done', 'dag', ?)`
        ).run(resultId, `wf-call-${resultId}`, resultId, payload);
      corruptPayload('wf-null', 'null');
      corruptPayload('wf-number', '7');
      corruptPayload('wf-broken', '{oops');

      const pending = store.pendingSubagentResults('root');
      expect(pending.map((row) => row.id)).toEqual(['dlg-1']);
      expect(pending[0]).toMatchObject({ result: 'clear' });
    });

    // Dropping the row is right, dropping it SILENTLY is not: the parent is simply never woken, which is
    // indistinguishable from a delegate still working. The warning is the only trace such a loss leaves.
    it('warns about the result it drops so the loss is traceable', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        store.createSession({ id: 'root', userId: 1, model: 'm' });
        store.upsertWorkflowRun('root', { id: 'wf-1', toolCallId: 'wf-call', status: 'running', nodes: [] });
        db.prepare(
          `INSERT INTO brain_subagent_results
             (result_id, parent_session_id, tool_call_id, child_session_id, kind, workflow_id, status, task, payload)
           VALUES ('wf-1', 'root', 'wf-call', '', 'workflow', 'wf-1', 'done', 'dag', '{oops')`
        ).run();

        expect(store.pendingSubagentResults('root')).toEqual([]);
        expect(warn.mock.calls.map((call) => String(call[0])).join('\n'))
          .toMatch(/unusable payload for pending delegated result wf-1 .*parent root.*tool wf-call/);
      } finally {
        warn.mockRestore();
      }
    });
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

  it('seeds a brand-new transcript atomically and never seeds over existing rows', () => {
    store.createSession({ id: 's1', userId: 7, model: 'm' });
    const seed = [
      { id: 'h1', role: 'user', content: { role: 'user', content: 'history one' } },
      { id: 'h2', role: 'assistant', content: { role: 'assistant', content: [{ type: 'text', text: 'history two' }] } },
    ];
    expect(store.seedMessages('s1', seed)).toBe(2);
    expect(store.seedMessages('s1', [{ id: 'h3', role: 'user', content: { role: 'user', content: 'late' } }])).toBe(0);
    expect(store.getMessages('s1').map((message) => message.id)).toEqual(['h1', 'h2']);

    store.createSession({ id: 's2', userId: 7, model: 'm' });
    expect(() => store.seedMessages('s2', [
      { id: 'fresh', role: 'user', content: { role: 'user', content: 'would insert first' } },
      { id: 'h1', role: 'assistant', content: { role: 'assistant', content: [{ type: 'text', text: 'duplicate global id' }] } },
    ])).toThrow();
    expect(store.getMessages('s2')).toEqual([]); // transaction rolled the first insert back too

    store.createSession({ id: 's3', userId: 7, model: 'm' });
    expect(() => store.seedMessages('s3', [
      { id: 'bad', role: 'system', content: { role: 'system', content: 'elevate me' } },
    ])).toThrow('invalid seeded platform message');
    expect(store.getMessages('s3')).toEqual([]);

    store.createSession({ id: 's4', userId: 7, model: 'm' });
    expect(() => store.seedMessages('s4', [
      { id: '', role: 'user', content: { role: 'user', content: 'missing id' } },
    ])).toThrow('invalid seeded platform message');
    expect(store.getMessages('s4')).toEqual([]);

    store.createSession({ id: 's5', userId: 7, model: 'm' });
    expect(() => store.seedMessages('s5', [
      { id: 'bad-block', role: 'assistant', content: { role: 'assistant', content: [{}] } },
    ])).toThrow('invalid seeded platform message');
    expect(store.getMessages('s5')).toEqual([]);
  });

  it('deleteMessagesFrom removes a row and every message after it, keeping earlier ones', () => {
    store.createSession({ id: 's1', userId: 7, model: 'm' });
    store.appendMessage({ id: 'a1', sessionId: 's1', parentId: null, role: 'assistant', content: { text: 'earlier reply' } });
    store.appendMessage({ id: 'u1', sessionId: 's1', parentId: null, role: 'user', content: { text: 'aborted question' } });
    store.appendMessage({ id: 'frag', sessionId: 's1', parentId: 'u1', role: 'assistant', content: { text: 'partial answer' } });

    // Discarding the aborted turn: from the user row onward (the row + its partial assistant fragment).
    expect(store.deleteMessagesFrom('s1', 'u1')).toBe(2);
    expect(store.getMessages('s1').map((m) => m.id)).toEqual(['a1']);
  });

  it('deleteMessagesFrom returns 0 for an unknown id or a foreign session, deleting nothing', () => {
    store.createSession({ id: 's1', userId: 7, model: 'm' });
    store.createSession({ id: 's2', userId: 7, model: 'm' });
    store.appendMessage({ id: 'u1', sessionId: 's1', parentId: null, role: 'user', content: { text: 'q' } });
    expect(store.deleteMessagesFrom('s1', 'nope')).toBe(0);
    // The id exists but in another session — the session guard must stop it deleting across sessions.
    expect(store.deleteMessagesFrom('s2', 'u1')).toBe(0);
    expect(store.getMessages('s1').map((m) => m.id)).toEqual(['u1']);
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
    store.createSession({ id: 'root', userId: 7, model: 'm' }); spoke('root'); age('root');
    store.createSession({ id: 'delegated', userId: 7, model: 'm', parentSessionId: 'root' }); spoke('delegated'); age('delegated'); // child → skip
    store.createSession({ id: 'other-user', userId: 9, model: 'm' }); spoke('other-user'); age('other-user'); // not this user → skip

    expect(store.staleConversationIds(7, 30).sort()).toEqual(['old-convo', 'root']);
    // A shorter horizon than the sessions' age still returns them; a longer one excludes everything.
    expect(store.staleConversationIds(7, 365)).toEqual([]);
    // Foreign user's own aged conversation is visible only under their id.
    expect(store.staleConversationIds(9, 30)).toEqual(['other-user']);
  });

  /** Sub-agent and cron sessions wear the `brain-ch-` prefix only because they route through the channel
   *  machinery, and excluding that whole prefix is what let 2594 of 2683 sessions on the operator's
   *  instance sit outside retention's reach forever — it could see five. They are one-shot RUNS, minted
   *  fresh every  time and never returned to, so they are judged on their own age. A real platform channel is
   *  a live resource and still must not be touched. */
  it('staleConversationIds reaches finished sub-agent and cron runs, but never a real channel', () => {
    const spoke = (id: string) => store.appendMessage({ id: `${id}-m`, sessionId: id, parentId: null, role: 'user', content: { text: 'hi' } });
    const age = (id: string) => db.prepare("UPDATE brain_sessions SET updated_at = datetime('now', '-90 days') WHERE id = ?").run(id);
    const aged = (id: string, parentSessionId?: string) => {
      store.createSession({ id, userId: 7, model: 'm', ...(parentSessionId ? { parentSessionId } : {}) });
      spoke(id); age(id);
    };

    aged('brain-ch-subagent-sub-dlg-1');
    aged('brain-ch-cron-job-nightly-arch-abc');
    aged('brain-ch-discord-123#0');       // live channel → must survive
    aged('brain-ch-msteams-a:xyz');       // live channel → must survive
    aged('convo');
    // An idle channel is rolled over: the old transcript is re-keyed under a unique -arch- id and
    // mayDeliverToSession refuses it forever, so it is collectable.
    aged('brain-ch-discord-123#0-arch-mt6abc12');
    // ...but a LIVE channel whose own name contains "-arch-" is not an archive. The SQL matches
    // loosely, so without the exact predicate this row would be deleted while people still talk in it.
    aged('brain-ch-discord-team-arch-notes#0');
    // A finished delegation still hanging under a live conversation: its own age decides, or the runs
    // that accumulate under a long-lived chat would never be collected at all.
    store.createSession({ id: 'live-root', userId: 7, model: 'm' }); spoke('live-root');
    aged('brain-ch-subagent-sub-dlg-2', 'live-root');

    expect(store.staleConversationIds(7, 30).sort()).toEqual([
      'brain-ch-cron-job-nightly-arch-abc',
      'brain-ch-discord-123#0-arch-mt6abc12',
      'brain-ch-subagent-sub-dlg-1',
      'brain-ch-subagent-sub-dlg-2',
      'convo',
    ]);
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
     *  when given, the PI `$.model` the row was produced with — the per-row attribution basis). The
     *  optional `durationMs` mirrors the persistence projector's generation-timing stamp. */
    const usageMsg = (session: string, id: string, u: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number; totalTokens: number; cost?: number }, tsMs = Date.now(), model?: string, durationMs?: number) =>
      store.appendMessage({
        id, sessionId: session, parentId: null, role: 'assistant',
        content: {
          role: 'assistant',
          ...(model == null ? {} : { model }),
          ...(durationMs == null ? {} : { durationMs }),
          usage: {
            input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0,
            reasoning: u.reasoning ?? 0, totalTokens: u.totalTokens, ...(u.cost == null ? {} : { cost: { total: u.cost } }),
          },
          timestamp: tsMs,
        },
      });
    it('computes outputTps over ONLY the generations that carried timing (legacy rows dilute nothing)', () => {
      store.createSession({ id: 'brain-a', userId: 1, model: 'claude-opus-4-8' });
      // Measured: 100 output over 2000 ms → 50 tok/s. Unmeasured legacy row: output but no durationMs —
      // counting its output toward the speed would understate it, so it contributes NEITHER side.
      usageMsg('brain-a', 'm1', { output: 100, totalTokens: 200 }, Date.now(), undefined, 2000);
      usageMsg('brain-a', 'm2', { output: 900, totalTokens: 1000 });
      const [row] = store.usageByModel(1);
      expect(row!.usage.total).toBe(1200); // totals still count everything
      expect(row!.usage.outputTps).toBeCloseTo(50);
    });

    it('reports a null outputTps when no generation in the bucket carried timing', () => {
      store.createSession({ id: 'brain-a', userId: 1, model: 'claude-opus-4-8' });
      usageMsg('brain-a', 'm1', { output: 50, totalTokens: 100 });
      const [row] = store.usageByModel(1);
      expect(row!.usage.outputTps).toBeNull();
    });

    it('weights outputTps by generation duration across measured rows (not an arithmetic mean)', () => {
      store.createSession({ id: 'brain-a', userId: 1, model: 'claude-opus-4-8' });
      // 100 out / 1 s (100 tok/s) + 50 out / 5 s (10 tok/s) → Σoutput/Σms = 150/6 = 25 tok/s.
      usageMsg('brain-a', 'm1', { output: 100, totalTokens: 200 }, Date.now(), undefined, 1000);
      usageMsg('brain-a', 'm2', { output: 50, totalTokens: 100 }, Date.now(), undefined, 5000);
      const [row] = store.usageByModel(1);
      expect(row!.usage.outputTps).toBeCloseTo(25);
    });

    it('EXCLUDES an aborted generation (timing but NO output) from the tok/s denominator', () => {
      store.createSession({ id: 'brain-a', userId: 1, model: 'claude-opus-4-8' });
      usageMsg('brain-a', 'm1', { output: 5000, totalTokens: 6000 }, Date.now(), undefined, 100_000); // 50 tok/s
      // An aborted stream: pi-ai only fills `usage` from a final chunk that never arrived, yet the
      // projector still stamps the wall time. Its 45 s must not drag the model's speed down forever.
      usageMsg('brain-a', 'm2', { output: 0, totalTokens: 0 }, Date.now(), undefined, 45_000);
      const [row] = store.usageByModel(1);
      expect(row!.usage.outputTps).toBeCloseTo(50); // NOT 5000/145 s ≈ 34
    });

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

    it('keeps the same model id from two providers in two identity buckets', () => {
      store.createSession({ id: 'brain-a', userId: 1, provider: 'current', model: 'shared-model' });
      const append = (id: string, provider: string, totalTokens: number) => store.appendMessage({
        id, sessionId: 'brain-a', parentId: null, role: 'assistant',
        content: {
          role: 'assistant', provider, model: 'shared-model', timestamp: Date.now(),
          usage: { input: 0, output: totalTokens, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens },
        },
      });
      // Custom PI registry providers carry an internal `elowen-` namespace; the public identity must not.
      append('m1', 'elowen-provider-a', 100);
      append('m2', 'elowen-provider-b', 200);

      const rows = store.usageByModel(1).sort((a, b) => a.exec.localeCompare(b.exec));
      expect(rows.map((r) => [r.exec, r.usage.total])).toEqual([
        ['provider-a/shared-model', 100],
        ['provider-b/shared-model', 200],
      ]);
    });

    it('preserves usage with no provider in a separate explicit legacy bucket', () => {
      store.createSession({ id: 'brain-a', userId: 1, model: 'legacy-model' });
      usageMsg('brain-a', 'm1', { totalTokens: 100 }, Date.now(), 'legacy-model');

      expect(store.usageByModel(1)).toMatchObject([{
        id: 'elowen:legacy-model', exec: 'elowen:legacy-model', program: 'elowen',
        provider: null, model: 'legacy-model', usage: { total: 100 },
      }]);
    });

    // Provider and model must come from the SAME source. A row that names its own model but no provider
    // must NOT borrow the session's: a conversation can switch models, so the session's CURRENT provider
    // says nothing about who produced this row. Measured on live data before this was fixed, the borrowed
    // fallback filed 157M `claude-opus-5` tokens under `alibaba` — a pair that cannot exist, because
    // every compaction-rollup bucket names its model and none of them names a provider.
    // Mutation: let producingProvider fall back whenever the row's provider is missing (ignoring
    // modelPath) and this returns `session-provider/legacy-model` instead of the legacy bucket.
    it('does not borrow the session provider for a row that carries its own model', () => {
      store.createSession({ id: 'brain-a', userId: 1, provider: 'session-provider', model: 'session-model' });
      usageMsg('brain-a', 'm1', { totalTokens: 100 }, Date.now(), 'legacy-model');
      expect(store.usageByModel(1)[0]).toMatchObject({
        id: 'elowen:legacy-model', exec: 'elowen:legacy-model', provider: null, model: 'legacy-model',
      });
    });

    // …while a row carrying NEITHER field is genuinely the session's own work, so both may come from it.
    // That pairing is what keeps legacy rows (predating per-message capture) attributable at all.
    it('takes provider and model together from the session when the row carries neither', () => {
      store.createSession({ id: 'brain-a', userId: 1, provider: 'session-provider', model: 'session-model' });
      usageMsg('brain-a', 'm1', { totalTokens: 100 });
      expect(store.usageByModel(1)[0]).toMatchObject({
        id: 'session-provider/session-model', provider: 'session-provider', model: 'session-model',
      });
    });

    // The legacy reader can recover a rollup provider from the session's complete live history, and the
    // explicit backfill does the same once over that complete history. The ready write-time projection has
    // a different contract: a trigger attributes only fields present when THAT row is inserted. It must not
    // scan brain_messages, and it cannot safely depend on provider-identifying rows that may arrive later,
    // so a provider-less rollup stays in the explicit legacy bucket while the live row remains attributed.
    it('keeps a newly projected rollup bucket unresolved instead of consulting live message history', () => {
      store.createSession({ id: 'brain-a', userId: 1, provider: 'session-provider', model: 'session-model' });
      store.appendMessage({
        id: 'm1', sessionId: 'brain-a', parentId: null, role: 'assistant',
        content: {
          role: 'assistant', provider: 'row-provider', model: 'shared-model', timestamp: Date.now(),
          usage: { input: 0, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 10 },
        },
      });
      db.prepare('INSERT INTO brain_messages (id, session_id, parent_id, role, content) VALUES (?, ?, NULL, ?, ?)')
        .run('c1', 'brain-a', 'compaction', JSON.stringify({
          role: 'compactionSummary', summary: 's', tokensBefore: 1, timestamp: Date.now(),
          usageRollup: [{ model: 'shared-model', at: Date.now(), totalTokens: 100 }],
        }));

      expect(store.usageByModel(1)).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'row-provider/shared-model', provider: 'row-provider', usage: expect.objectContaining({ total: 10 }) }),
        expect.objectContaining({ id: 'elowen:shared-model', provider: null, usage: expect.objectContaining({ total: 100 }) }),
      ]));
    });

    // The whole safety property of that lookup. A session that served ONE model through TWO providers
    // cannot say which of them produced the bucket, so it must stay unresolved rather than pick one —
    // picking would re-create exactly the invented pairs the borrowing fallback was removed for.
    // Mutation: drop `HAVING COUNT(DISTINCT …) = 1` and the bucket is filed under `provider-a`.
    it('leaves a rollup bucket unresolved when the session ran that model through two providers', () => {
      store.createSession({ id: 'brain-a', userId: 1, provider: 'session-provider', model: 'session-model' });
      for (const [id, provider] of [['m1', 'provider-a'], ['m2', 'provider-b']] as const) {
        store.appendMessage({
          id, sessionId: 'brain-a', parentId: null, role: 'assistant',
          content: {
            role: 'assistant', provider, model: 'shared-model', timestamp: Date.now(),
            usage: { input: 0, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 10 },
          },
        });
      }
      db.prepare('INSERT INTO brain_messages (id, session_id, parent_id, role, content) VALUES (?, ?, NULL, ?, ?)')
        .run('c1', 'brain-a', 'compaction', JSON.stringify({
          role: 'compactionSummary', summary: 's', tokensBefore: 1, timestamp: Date.now(),
          usageRollup: [{ model: 'shared-model', at: Date.now(), totalTokens: 100 }],
        }));

      expect(store.usageByModel(1)).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'elowen:shared-model', provider: null, usage: expect.objectContaining({ total: 100 }) }),
      ]));
    });

    // The lookup is scoped to the session that produced the bucket. Another session running the same
    // model proves nothing about this one — a global lookup would happily attribute a bucket to a
    // provider the session never touched.
    // Mutation: drop `sm.session_id = m.session_id` from the join and this resolves to `other-provider`.
    it('does not recover a provider from a different session', () => {
      store.createSession({ id: 'brain-a', userId: 1, provider: 'session-provider', model: 'session-model' });
      store.createSession({ id: 'brain-b', userId: 1, provider: 'session-provider', model: 'session-model' });
      store.appendMessage({
        id: 'm1', sessionId: 'brain-b', parentId: null, role: 'assistant',
        content: {
          role: 'assistant', provider: 'other-provider', model: 'shared-model', timestamp: Date.now(),
          usage: { input: 0, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 10 },
        },
      });
      db.prepare('INSERT INTO brain_messages (id, session_id, parent_id, role, content) VALUES (?, ?, NULL, ?, ?)')
        .run('c1', 'brain-a', 'compaction', JSON.stringify({
          role: 'compactionSummary', summary: 's', tokensBefore: 1, timestamp: Date.now(),
          usageRollup: [{ model: 'shared-model', at: Date.now(), totalTokens: 100 }],
        }));

      expect(store.usageByModel(1)).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'elowen:shared-model', provider: null, usage: expect.objectContaining({ total: 100 }) }),
      ]));
    });

    it('does not strip the internal prefix from a marked configured provider id', () => {
      store.createSession({ id: 'brain-a', userId: 1, provider: 'elowen-relay', model: 'm' });
      store.appendMessage({
        id: 'm1', sessionId: 'brain-a', parentId: null, role: 'assistant',
        content: {
          role: 'assistant', provider: 'elowen-relay', providerIdentity: 'config', model: 'm', timestamp: Date.now(),
          usage: { input: 0, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 100 },
        },
      });
      expect(store.usageByModel(1)[0]).toMatchObject({ id: 'elowen-relay/m', provider: 'elowen-relay' });
      store.compactSessionMessages('brain-a', { id: 'sum', role: 'compaction', content: { role: 'compactionSummary' } }, 0);
      const divider = JSON.parse(store.getMessages('brain-a')[0]!.content) as { usageRollup: Array<Record<string, unknown>> };
      expect(divider.usageRollup).toMatchObject([{ provider: 'elowen-relay', providerIdentity: 'config' }]);
      expect(store.usageByModel(1)[0]).toMatchObject({ id: 'elowen-relay/m', provider: 'elowen-relay' });
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

    it('includes platform channel (brain-ch-*) sessions in usageByDay', () => {
      store.createSession({ id: 'brain-a', userId: 1, model: 'm' });
      usageMsg('brain-a', 'm1', { totalTokens: 100, cost: 0.1 });
      store.createSession({ id: 'brain-ch-777', userId: 1, model: 'sarah-mimo-v2.5' });
      usageMsg('brain-ch-777', 'c1', { totalTokens: 5000, cost: 0.2 });
      const tokens = store.usageByDay(1, 7).reduce((s, d) => s + d.tokens, 0);
      expect(tokens).toBe(5100); // Discord channel spend IS counted (operator-anchored)
    });

    describe('survives compaction (rollup on the divider)', () => {
      it('persists the producing provider in new rollup buckets', () => {
        store.createSession({ id: 'brain-a', userId: 1, provider: 'session-provider', model: 'shared-model' });
        store.appendMessage({
          id: 'old', sessionId: 'brain-a', parentId: null, role: 'assistant',
          content: {
            role: 'assistant', provider: 'elowen-row-provider', model: 'shared-model', timestamp: Date.now(),
            usage: { input: 0, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 100 },
          },
        });
        store.appendMessage({ id: 'keep', sessionId: 'brain-a', parentId: null, role: 'user', content: { role: 'user', content: 'keep' } });
        store.compactSessionMessages('brain-a', { id: 'sum', role: 'compaction', content: { role: 'compactionSummary' } }, 1);

        const divider = JSON.parse(store.getMessages('brain-a')[0]!.content) as { usageRollup: Array<Record<string, unknown>> };
        expect(divider.usageRollup).toMatchObject([{ provider: 'elowen-row-provider', model: 'shared-model', totalTokens: 100 }]);
        expect(store.usageByModel(1)[0]).toMatchObject({ exec: 'row-provider/shared-model', provider: 'row-provider' });
      });

      it('keeps the dropped generations timing so outputTps survives compaction', () => {
        store.createSession({ id: 'brain-a', userId: 1, model: 'claude-opus-4-8' });
        // Measured rows dropped by the compaction roll their durationMs onto the divider…
        usageMsg('brain-a', 'old1', { output: 100, totalTokens: 200 }, Date.now(), undefined, 2000);
        usageMsg('brain-a', 'old2', { output: 50, totalTokens: 100 }, Date.now(), undefined, 5000);
        // …and combine with the KEPT row's own timing: (100+50+150)/(2+5+3) s = 30 tok/s.
        usageMsg('brain-a', 'keep1', { output: 150, totalTokens: 300 }, Date.now(), undefined, 3000);
        store.compactSessionMessages('brain-a', { id: 'sum', role: 'compaction', content: { role: 'compactionSummary', summary: 's' } }, 1);
        const [row] = store.usageByModel(1);
        expect(row!.usage.outputTps).toBeCloseTo(30);
      });

      it('rolls up only the MEASURED output, so untimed dropped rows never inflate tok/s', () => {
        store.createSession({ id: 'brain-a', userId: 1, model: 'claude-opus-4-8' });
        // A legacy row predating the timing stamp: real output, no measurable speed.
        usageMsg('brain-a', 'old1', { output: 40_000, totalTokens: 41_000 });
        // One measured generation: 5000 output over 100 s → the session's honest 50 tok/s.
        usageMsg('brain-a', 'old2', { output: 5_000, totalTokens: 6_000 }, Date.now(), undefined, 100_000);
        usageMsg('brain-a', 'keep1', { output: 10, totalTokens: 20 });
        store.compactSessionMessages('brain-a', { id: 'sum', role: 'compaction', content: { role: 'compactionSummary', summary: 's' } }, 1);
        const [row] = store.usageByModel(1);
        expect(row!.usage.total).toBe(47_020);            // totals still count every dropped row
        expect(row!.usage.outputTps).toBeCloseTo(50);     // NOT 45 000 / 100 s = 450
      });

      it('reads a rollup bucket written BEFORE measuredOutput existed as unmeasured', () => {
        store.createSession({ id: 'brain-a', userId: 1, model: 'claude-opus-4-8' });
        // A pre-fix divider, shaped by hand: total output and wall time, no `measuredOutput`. How much of
        // that output was timed is unknowable, so the bucket must report "no data" — not an invented rate.
        store.appendMessage({
          id: 'sum', sessionId: 'brain-a', parentId: null, role: 'compaction',
          content: {
            role: 'compactionSummary', summary: 's',
            usageRollup: [{ model: 'claude-opus-4-8', input: 0, output: 40_000, cacheRead: 0, cacheWrite: 0, totalTokens: 41_000, reasoning: 0, at: Date.now(), durationMs: 100_000 }],
          },
        });
        expect(store.usageByModel(1)[0]!.usage.total).toBe(41_000); // spend still counted
        expect(store.usageByModel(1)[0]!.usage.outputTps).toBeNull();
        // …and it neither inflates nor dilutes a measured generation standing next to it.
        usageMsg('brain-a', 'm1', { output: 5_000, totalTokens: 6_000 }, Date.now(), undefined, 100_000);
        expect(store.usageByModel(1)[0]!.usage.outputTps).toBeCloseTo(50);
      });

      it('carries a legacy bucket through a SECOND compaction without reviving its output as measured', () => {
        store.createSession({ id: 'brain-a', userId: 1, model: 'claude-opus-4-8' });
        store.appendMessage({
          id: 'sum1', sessionId: 'brain-a', parentId: null, role: 'compaction',
          content: {
            role: 'compactionSummary', summary: 's',
            usageRollup: [{ model: 'claude-opus-4-8', input: 0, output: 40_000, cacheRead: 0, cacheWrite: 0, totalTokens: 41_000, reasoning: 0, at: Date.now(), durationMs: 100_000 }],
          },
        });
        usageMsg('brain-a', 'm1', { output: 5_000, totalTokens: 6_000 }, Date.now(), undefined, 100_000);
        usageMsg('brain-a', 'keep1', { output: 10, totalTokens: 20 });
        store.compactSessionMessages('brain-a', { id: 'sum2', role: 'compaction', content: { role: 'compactionSummary', summary: 's' } }, 1);
        const [row] = store.usageByModel(1);
        expect(row!.usage.total).toBe(47_020);
        expect(row!.usage.outputTps).toBeCloseTo(50); // the legacy 40k stays unmeasured across the chain
      });

      it('carries a measured rollup through a second compaction (speed survives chaining)', () => {
        store.createSession({ id: 'brain-a', userId: 1, model: 'claude-opus-4-8' });
        usageMsg('brain-a', 'm1', { output: 5_000, totalTokens: 6_000 }, Date.now(), undefined, 100_000);
        usageMsg('brain-a', 'k1', { output: 10, totalTokens: 20 });
        store.compactSessionMessages('brain-a', { id: 'sum1', role: 'compaction', content: { role: 'compactionSummary', summary: 's' } }, 1);
        usageMsg('brain-a', 'k2', { output: 10, totalTokens: 20 });
        store.compactSessionMessages('brain-a', { id: 'sum2', role: 'compaction', content: { role: 'compactionSummary', summary: 's' } }, 1);
        expect(store.usageByModel(1)[0]!.usage.outputTps).toBeCloseTo(50);
      });

      it('keeps dropped assistant rows spend in usageByModel + usageByDay', () => {
        store.createSession({ id: 'brain-a', userId: 1, model: 'claude-opus-4-8' });
        usageMsg('brain-a', 'old1', { input: 5, output: 2, cacheRead: 10, cacheWrite: 1, totalTokens: 100, cost: 0.1 });
        usageMsg('brain-a', 'old2', { input: 5, output: 3, cacheRead: 20, cacheWrite: 2, totalTokens: 150, cost: 0.15 });
        usageMsg('brain-a', 'keep1', { input: 5, output: 4, cacheRead: 30, cacheWrite: 3, totalTokens: 200, cost: 0.2 });
        // Compact: keep only the last row, drop old1+old2 — their spend must roll onto the divider.
        store.compactSessionMessages('brain-a', { id: 'sum', role: 'compaction', content: { role: 'compactionSummary', summary: 's' } }, 1);
        expect(store.getMessages('brain-a').map((m) => m.id)).toEqual(['sum', 'keep1']);
        const [row] = store.usageByModel(1);
        expect(row!.usage.total).toBe(450); // 100 + 150 (rolled up) + 200 (kept)
        expect(row!.usage.input).toBe(15);
        expect(row!.usage.costUsd).toBeCloseTo(0.45);
        const byDay = store.usageByDay(1, 3650);
        expect(byDay.reduce((s, d) => s + d.tokens, 0)).toBe(450);
        // The per-day view carries the same component sums the per-model view does — the dashboard's
        // daily chart states each day's composition from these fields, rolled-up rows included.
        expect(byDay.reduce((s, d) => s + d.input, 0)).toBe(15);
        expect(byDay.reduce((s, d) => s + d.output, 0)).toBe(9);
        expect(byDay.reduce((s, d) => s + d.cacheRead, 0)).toBe(60);
        expect(byDay.reduce((s, d) => s + d.cacheWrite, 0)).toBe(6);
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

      it('keeps separate day buckets and call counts when one compaction drops several days', () => {
        const dayOne = Date.parse('2026-08-24T23:59:00Z');
        const dayTwo = Date.parse('2026-08-25T00:01:00Z');
        store.createSession({ id: 'brain-a', userId: 1, provider: 'anthropic', model: 'claude-opus-5' });
        usageMsg('brain-a', 'old1', { totalTokens: 100, cost: 0.1 }, dayOne, 'claude-opus-5');
        usageMsg('brain-a', 'old2', { totalTokens: 200, cost: 0.2 }, dayTwo, 'claude-opus-5');
        store.appendMessage({ id: 'keep', sessionId: 'brain-a', parentId: null, role: 'user', content: { role: 'user', content: 'keep' } });

        store.compactSessionMessages('brain-a', { id: 'sum', role: 'compaction', content: { role: 'compactionSummary' } }, 1);

        const divider = JSON.parse(store.getMessages('brain-a')[0]!.content) as {
          usageRollup: Array<{ at: number; calls: number; totalTokens: number }>;
        };
        expect(divider.usageRollup).toHaveLength(2);
        expect(divider.usageRollup.map((bucket) => ({
          day: new Date(bucket.at).toISOString().slice(0, 10), calls: bucket.calls, total: bucket.totalTokens,
        }))).toEqual([
          { day: '2026-08-24', calls: 1, total: 100 },
          { day: '2026-08-25', calls: 1, total: 200 },
        ]);
        expect(store.usageByDay(1, 3650)).toEqual(expect.arrayContaining([
          expect.objectContaining({ day: '2026-08-24', tokens: 100 }),
          expect.objectContaining({ day: '2026-08-25', tokens: 200 }),
        ]));
      });

      it('leaves an UNDATED dropped row undated, so compaction cannot conjure spend onto a new day', () => {
        const compactMs = Date.parse('2026-06-20T00:00:00Z');
        store.createSession({ id: 'brain-a', userId: 1, model: 'claude-opus-4-8' });
        // A legacy assistant row carrying usage but NO `$.timestamp`: the day/model views exclude it
        // (`ts IS NOT NULL`) BEFORE the compaction, so they must still exclude it after — dating its
        // bucket would make a compaction add historical spend to the day it happened to run on.
        store.appendMessage({
          id: 'undated', sessionId: 'brain-a', parentId: null, role: 'assistant',
          content: { role: 'assistant', model: 'claude-opus-4-8', usage: { totalTokens: 70, cost: { total: 0.07 } } },
        });
        usageMsg('brain-a', 'keep', { totalTokens: 5, cost: 0.005 }, compactMs, 'claude-opus-4-8');
        store.compactSessionMessages('brain-a', { id: 'sum', role: 'compaction', content: { role: 'compactionSummary', summary: 's', timestamp: compactMs } }, 1);
        expect(store.usageByModel(1)[0]!.usage.total).toBe(5);
        expect(store.usageByDay(1, 3650).reduce((s, d) => s + d.tokens, 0)).toBe(5);
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

      /** The read side of this is unit-tested on its own, but nothing proved the divider ever RECEIVES the
       *  names: drop the rollup call from compaction and every other test still passes while activated
       *  deferred tools silently go back to being lost on the next respawn. */
      it('carries the names of tools activated by a dropped ToolSearch onto the divider', () => {
        store.createSession({ id: 'brain-a', userId: 1, model: 'm' });
        store.appendMessage({
          id: 'search', sessionId: 'brain-a', parentId: null, role: 'toolResult',
          content: {
            role: 'toolResult', toolCallId: 't1', toolName: 'ToolSearch', isError: false,
            content: [{ type: 'text', text: 'activated' }],
            details: { matched: ['mcp__github__create_issue', 'mcp__github__list_issues'] },
          },
        });
        store.appendMessage({ id: 'k', sessionId: 'brain-a', parentId: null, role: 'user', content: { role: 'user', content: 'next' } });
        store.compactSessionMessages('brain-a', { id: 'sum', role: 'compaction', content: { role: 'compactionSummary', summary: 's' } }, 1);

        const divider = JSON.parse(store.getMessages('brain-a')[0]!.content);
        expect(divider.activatedTools).toEqual(['mcp__github__create_issue', 'mcp__github__list_issues']);
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

  describe('corrupt message content', () => {
    // appendMessage always stringifies, so only a hand-edited DB, a truncated restore or a partial write
    // leaves a row like these. SQLite's json_extract/json_each THROW on malformed JSON, so without the
    // json_valid guards ONE such row fails the whole aggregate and every session of that user loses its
    // numbers — the bad row must contribute nothing instead.
    const raw = (id: string, sessionId: string, role: string, content: string) =>
      db.prepare('INSERT INTO brain_messages (id, session_id, parent_id, role, content) VALUES (?, ?, NULL, ?, ?)')
        .run(id, sessionId, role, content);
    const healthy = (id: string, sessionId: string, totalTokens: number, cost: number) =>
      store.appendMessage({
        id, sessionId, parentId: null, role: 'assistant',
        content: {
          role: 'assistant', model: 'claude-opus-4-8', timestamp: Date.parse('2026-01-10T00:00:00Z'),
          usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens, cost: { total: cost } },
        },
      });

    beforeEach(() => {
      store.createSession({ id: 'brain-a', userId: 1, model: 'claude-opus-4-8' });
      healthy('ok', 'brain-a', 100, 0.1);
    });

    it('isolates a malformed assistant row from usageByModel, usageByDay and tokenTotals', () => {
      raw('bad', 'brain-a', 'assistant', '{"usage": {"totalTokens": 5');
      expect(store.usageByModel(1)[0]!.usage.total).toBe(100);
      expect(store.usageByDay(1, 3650).reduce((s, d) => s + d.tokens, 0)).toBe(100);
      expect(store.tokenTotals(1)['brain-a']).toBe(100);
    });

    it('isolates a malformed compaction divider and a rollup that is not an array of buckets', () => {
      raw('bad-divider', 'brain-a', 'compaction', '{"role": "compactionSummary", "usageRollup": [');
      raw('scalar-rollup', 'brain-a', 'compaction', '{"role":"compactionSummary","usageRollup":"boom"}');
      raw('scalar-bucket', 'brain-a', 'compaction', '{"role":"compactionSummary","usageRollup":["boom"]}');
      expect(store.usageByModel(1)[0]!.usage.total).toBe(100);
      expect(store.usageByDay(1, 3650).reduce((s, d) => s + d.tokens, 0)).toBe(100);
    });

    it('reads a JSON null row as carrying no usage rather than throwing', () => {
      raw('null-row', 'brain-a', 'assistant', 'null');
      raw('null-divider', 'brain-a', 'compaction', 'null');
      expect(store.usageByModel(1)[0]!.usage.total).toBe(100);
      expect(store.tokenTotals(1)['brain-a']).toBe(100);
    });

    // Validity is not the same as the right TYPE. SQLite coerces a numeric-looking STRING in SUM(), while
    // rollupDroppedUsage() (which re-folds these very fields when a compaction drops the rows) counts only
    // real numbers — so an untyped read makes a session's historical totals CHANGE when it is compacted.
    it('ignores usage fields that are strings rather than numbers, so compaction cannot move the totals', () => {
      raw('numeric-string', 'brain-a', 'assistant', JSON.stringify({
        role: 'assistant', model: 'claude-opus-4-8', timestamp: Date.parse('2026-01-10T00:00:00Z'),
        usage: { totalTokens: '500', output: '400', cost: { total: '9.9' } }, durationMs: '1000',
      }));
      raw('word-string', 'brain-a', 'assistant', JSON.stringify({
        role: 'assistant', model: 'claude-opus-4-8', timestamp: Date.parse('2026-01-10T00:00:00Z'),
        usage: { totalTokens: 'lots' },
      }));
      const [row] = store.usageByModel(1);
      expect(row!.usage.total).toBe(100);
      expect(row!.usage.output).toBe(2);
      expect(row!.usage.costUsd).toBeCloseTo(0.1); // the "9.9" string never reaches the sum
      expect(row!.usage.outputTps).toBeNull();     // nor does a stringly-typed duration fake a speed
      expect(store.usageByDay(1, 3650).reduce((s, d) => s + d.tokens, 0)).toBe(100);
      // The session panel reads the SAME field with its own SQL: an untyped read there would show 600
      // next to the Stats page's 100 for one session, and drop back to 100 the moment it compacts.
      expect(store.tokenTotals(1)['brain-a']).toBe(100);
      // What the SQL counts must be exactly what a compaction of the same rows would carry forward.
      expect(rollupDroppedUsage(store.getMessages('brain-a'))!.reduce((s, b) => s + b.totalTokens, 0)).toBe(100);
    });

    it('ignores a rollup bucket that is a scalar or a double-serialized object', () => {
      const bucket = { model: 'claude-opus-4-8', totalTokens: 500, at: Date.parse('2026-01-10T00:00:00Z') };
      // A bucket stored as a JSON STRING containing an object: `json_valid` says yes, `json_extract` reads
      // right through it, so it used to be counted twice-serialized.
      raw('serialized-bucket', 'brain-a', 'compaction', JSON.stringify({ role: 'compactionSummary', usageRollup: [JSON.stringify(bucket)] }));
      raw('number-bucket', 'brain-a', 'compaction', JSON.stringify({ role: 'compactionSummary', usageRollup: [42] }));
      raw('string-field-bucket', 'brain-a', 'compaction', JSON.stringify({
        role: 'compactionSummary', usageRollup: [{ ...bucket, totalTokens: '500' }],
      }));
      expect(store.usageByModel(1)[0]!.usage.total).toBe(100);
      expect(store.usageByDay(1, 3650).reduce((s, d) => s + d.tokens, 0)).toBe(100);
    });

    it('keeps descendantUsage summing the healthy rows of the tree', () => {
      store.createSession({ id: 'child', userId: 1, model: 'claude-opus-4-8', parentSessionId: 'brain-a' });
      healthy('child-ok', 'child', 40, 0.04);
      raw('child-bad', 'child', 'assistant', '{"usage":');
      raw('child-bad-divider', 'child', 'compaction', 'not json at all');
      expect(store.descendantUsage('brain-a').totalTokens).toBe(40);
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
      store.createSession({ id: 'brain-ch-subagent-job', userId: 1, title: 'Subagent', model: 'm' });
      userMsg('c1', 'brain-ch-42', 'Restart NGINX please');
      userMsg('t1', 'brain-ch-subagent-job', 'Restart NGINX please');
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

    it('stores a card and reads it back whole, including an optional item clock', () => {
      const timed = { ...card('todos', 'Ship it'), items: [{ text: 'Ship it', status: 'in_progress' as const, startedAt: 123_456 }] };
      store.upsertCard('s1', timed);
      expect(store.getCards('s1')).toEqual([timed]);
      store.upsertCard('old', card('todos', 'Older card'));
      expect(store.getCards('old')).toEqual([card('todos', 'Older card')]);
    });

    it('round-trips an item\'s structured fields, and still loads a card stored without them', () => {
      const structured = {
        id: 'todos', title: 'Todos', pinned: true,
        items: [{
          text: '#4 Ship it — Luna (blocked by #2)',
          status: 'in_progress' as const,
          startedAt: 123_456,
          id: '4',
          label: 'Ship it',
          owner: 'Luna',
          blockedBy: ['2'],
        }],
      };
      store.upsertCard('s1', structured);
      expect(store.getCards('s1')).toEqual([structured]);
      // A row written before these fields existed: it must load unchanged, not gain empty ones.
      const legacy = card('todos', 'Older card');
      store.upsertCard('legacy', legacy);
      expect(store.getCards('legacy')).toEqual([legacy]);
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

  // The plan is a markdown file under ~/.config/elowen/plans, not a row — so the store owns exactly the
  // lifecycle edges the DB would have given for free: purge on delete, follow a rollover re-key, and go
  // with the user. A plan left behind is worse than an orphan spill: it is re-injected into prompts.
  describe('plan files', () => {
    const planDir = (home: string, join: (...p: string[]) => string) => join(home, '.config/elowen/plans');
    // The file is named by the derived slug, not the session id — the store must resolve it the same way.
    const planName = (sessionId: string) => `${planSlug(sessionId)}.md`;

    it('removes the conversation plan file along with its rows', async () => {
      const { mkdtempSync, mkdirSync, writeFileSync, existsSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');
      const home = mkdtempSync(join(tmpdir(), 'elowen-plan-purge-'));
      dirs.push(home);
      vi.stubEnv('HOME', home);
      try {
        store.createSession({ id: 's1', userId: 7, model: 'm' });
        store.createSession({ id: 's2', userId: 7, model: 'm' });
        const dir = planDir(home, join);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, planName('s1')), '# mine');
        writeFileSync(join(dir, planName('s2')), '# theirs');
        store.deleteSession('s1');
        expect(existsSync(join(dir, planName('s1')))).toBe(false);
        expect(existsSync(join(dir, planName('s2')))).toBe(true); // the other conversation keeps its plan
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('moves the plan file along with the re-keyed conversation', async () => {
      const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');
      const home = mkdtempSync(join(tmpdir(), 'elowen-plan-move-'));
      dirs.push(home);
      vi.stubEnv('HOME', home);
      try {
        store.createSession({ id: 'chan-x', userId: 7, model: 'm' });
        const dir = planDir(home, join);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, planName('chan-x')), '# Ship it');
        store.reassignSession('chan-x', 'arch-1');
        expect(existsSync(join(dir, planName('chan-x')))).toBe(false);
        expect(readFileSync(join(dir, planName('arch-1')), 'utf8')).toBe('# Ship it');
        // …so a later delete of the archived conversation actually cleans the plan up.
        store.deleteSession('arch-1');
        expect(existsSync(join(dir, planName('arch-1')))).toBe(false);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('removes every plan file belonging to a removed user, and only theirs', async () => {
      const { mkdtempSync, mkdirSync, writeFileSync, existsSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');
      const home = mkdtempSync(join(tmpdir(), 'elowen-plan-user-'));
      dirs.push(home);
      vi.stubEnv('HOME', home);
      try {
        store.createSession({ id: 'mine-a', userId: 7, model: 'm' });
        store.createSession({ id: 'mine-b', userId: 7, model: 'm' });
        store.createSession({ id: 'theirs', userId: 9, model: 'm' });
        const dir = planDir(home, join);
        mkdirSync(dir, { recursive: true });
        for (const id of ['mine-a', 'mine-b', 'theirs']) writeFileSync(join(dir, planName(id)), `# ${id}`);
        store.removeForUser(7);
        expect(existsSync(join(dir, planName('mine-a')))).toBe(false);
        expect(existsSync(join(dir, planName('mine-b')))).toBe(false);
        expect(existsSync(join(dir, planName('theirs')))).toBe(true);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('deleting or re-keying a conversation with no plan file is fine', () => {
      store.createSession({ id: 'a', userId: 7, model: 'm' });
      expect(() => store.reassignSession('a', 'b')).not.toThrow();
      expect(() => store.deleteSession('b')).not.toThrow();
      expect(() => store.removeForUser(7)).not.toThrow();
    });
  });

  // The files the conversation was working in ride the divider for the same reason the usage rollup
  // does: the rows that named them are about to be deleted, and nothing else records them.
  describe('working set on the compaction divider', () => {
    const fileRow = (id: string, tool: string, path: string) => ({
      id, sessionId: 's1', parentId: null, role: 'toolResult',
      content: { role: 'toolResult', toolName: tool, details: { ok: true, tool, path, contentHash: 'h' } },
    });
    const tail = () => store.appendMessage({ id: 'keep', sessionId: 's1', parentId: null, role: 'user', content: { role: 'user', content: 'carry on' } });
    const compact = () => store.compactSessionMessages('s1', { id: 'sum', role: 'compaction', content: { role: 'compactionSummary' } }, 1);
    const divider = () => JSON.parse(store.getMessages('s1').find((m) => m.role === 'compaction')!.content) as Record<string, unknown>;

    beforeEach(() => { store.createSession({ id: 's1', userId: 1, model: 'm' }); });

    it('folds the files named by the dropped rows onto the divider, newest first', () => {
      store.appendMessage(fileRow('r1', 'Read', '/a.ts'));
      store.appendMessage(fileRow('r2', 'Write', '/b.ts'));
      tail();
      compact();
      expect(divider().workingSet).toEqual([{ path: '/b.ts', wrote: true }, { path: '/a.ts', wrote: false }]);
    });

    it('leaves the divider clean when nothing dropped named a file', () => {
      store.appendMessage({ id: 'r1', sessionId: 's1', parentId: null, role: 'assistant', content: { role: 'assistant', content: 'no tools' } });
      tail();
      compact();
      expect(divider()).not.toHaveProperty('workingSet');
    });

    // The two rollups are independent: one must not suppress the other.
    it('carries the working set alongside a usage rollup', () => {
      store.appendMessage({
        id: 'r1', sessionId: 's1', parentId: null, role: 'assistant',
        content: { role: 'assistant', content: 'x', model: 'm', usage: { input: 5, output: 3, totalTokens: 8 } },
      });
      store.appendMessage(fileRow('r2', 'Edit', '/a.ts'));
      tail();
      compact();
      const d = divider();
      expect(d.workingSet).toEqual([{ path: '/a.ts', wrote: true }]);
      expect(Array.isArray(d.usageRollup)).toBe(true);
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

    // Same whitelist hazard, one level up. `background` is not display trivia: sparedChildSessionIds
    // reads it to spare a running background workflow's node sessions from a parent abort. While the
    // whitelist dropped it the sparing was dead code, so any stop or detach on the origin conversation
    // aborted every node of a background workflow that had been promised it keeps running.
    it('round-trips the background flag that parent-abort sparing depends on', () => {
      store.createSession({ id: 'root', userId: 1, model: 'm' });
      store.createSession({ id: 'child', userId: 1, model: 'm', parentSessionId: 'root' });
      expect(store.upsertWorkflowRun('root', wf({ background: true }))).toBe(true);
      expect(store.getWorkflowRuns('root')[0]?.background).toBe(true);
      // A foreground workflow must stay unflagged rather than acquire a falsy key.
      expect(store.upsertWorkflowRun('root', wf({ id: 'wf-2', toolCallId: 'call-2' }))).toBe(true);
      expect(store.getWorkflowRuns('root').find((r) => r.id === 'wf-2')?.background).toBeUndefined();
      // Malformed rejects the snapshot rather than coercing, like the node-level fields above.
      expect(store.upsertWorkflowRun('root', wf({ id: 'wf-3', toolCallId: 'call-3', background: 'yes' }))).toBe(false);
    });

    it('claims restart-orphaned workflows for the current boot, including ones with no delegation row in flight', () => {
      store.createSession({ id: 'root', userId: 1, model: 'm' });
      store.setDelegationBootId('boot-A');
      // Running under boot-A (owner stamped by the upsert)…
      expect(store.upsertWorkflowRun('root', wf({ nodes: [] }))).toBe(true);
      // …and a terminal one, which must never be claimable.
      expect(store.upsertWorkflowRun('root', wf({ id: 'wf-done', toolCallId: 'call-done', status: 'done', nodes: [] }))).toBe(true);
      // The same boot never claims its own live work.
      expect(store.claimRecoverableWorkflows()).toEqual([]);
      // A NEW boot claims the running orphan — deliberately without any brain_subagent_runs row: the old
      // sweep was gated on runningDelegationParentSessionIds, so exactly this workflow escaped it and sat
      // `running` forever.
      store.setDelegationBootId('boot-B');
      const claimed = store.claimRecoverableWorkflows();
      expect(claimed).toHaveLength(1);
      expect(claimed[0]).toMatchObject({ parentSessionId: 'root', toolCallId: 'call-1', workflowId: 'wf-1', attempt: 1 });
      // The claim is durable: a third boot bumps the attempt again (the resume-crash-loop counter).
      store.setDelegationBootId('boot-C');
      expect(store.claimRecoverableWorkflows()[0]?.attempt).toBe(2);
    });

    it('a terminal snapshot clears the claim owner so the row is never claimed again', () => {
      store.createSession({ id: 'root', userId: 1, model: 'm' });
      store.setDelegationBootId('boot-A');
      store.upsertWorkflowRun('root', wf({ nodes: [] }));
      store.upsertWorkflowRun('root', wf({ status: 'cancelled', nodes: [] }));
      store.setDelegationBootId('boot-B');
      expect(store.claimRecoverableWorkflows()).toEqual([]);
    });

    it('supersedeClaimedRun releases only a run this boot claimed, terminalizing it without a parent notice', () => {
      store.createSession({ id: 'node-sess', userId: 1, model: 'm' });
      store.createSession({ id: 'nested-child', userId: 1, model: 'm', parentSessionId: 'node-sess' });
      store.setDelegationBootId('boot-A');
      store.upsertSubagentRun('node-sess', { id: 'nested', sessionId: 'nested-child', status: 'running', task: 't', tools: 0, seconds: 0 });
      store.setDelegationBootId('boot-B');
      // Unclaimed (still lifecycle 'running' owned by boot-A): refuse — only a held claim may be released.
      expect(store.supersedeClaimedRun('node-sess', 'nested', 'why')).toBe(false);
      store.claimRecoverableRuns(30_000);
      expect(store.supersedeClaimedRun('node-sess', 'nested', 'superseded by workflow resume')).toBe(true);
      const row = db.prepare("SELECT lifecycle, owner_boot_id FROM brain_subagent_runs WHERE tool_call_id = 'nested'").get() as { lifecycle: string; owner_boot_id: string | null };
      expect(row.lifecycle).toBe('error');
      expect(row.owner_boot_id).toBeNull();
      // Deliberately NO inbox row: the node session's interrupted turn is being replaced wholesale.
      expect(store.pendingSubagentResults('node-sess')).toEqual([]);
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

  describe('tool-result spill latch rows', () => {
    const latch = (toolCallId: string, over: Partial<{ occurredAt: number; mode: 'time' | 'preview'; bytes: number; preview: string | null; path: string; placeholder: string | null }> = {}) => ({
      toolCallId, occurredAt: 1_754_600_000_000, mode: 'preview' as const, bytes: 50_007,
      preview: 'head 😀 of the output', path: `/data/tool-results/s1/${toolCallId}.v1-preview-50007.txt`,
      placeholder: `[Large tool result…] head 😀 of the output`,
      ...over,
    });
    const stored = (row: ReturnType<typeof latch>) => ({ ...row, createdAt: expect.any(String) as unknown as string });

    it('round-trips a row exactly, including a multi-byte preview, and upserts on the same key', () => {
      store.createSession({ id: 's1', userId: 7, model: 'm' });
      store.upsertToolResultSpill('s1', latch('call-1'));
      expect(store.toolResultSpills('s1')).toEqual([stored(latch('call-1'))]);
      // Upsert: an EEXIST re-latch writes the same occurrence key again — one row, latest values.
      store.upsertToolResultSpill('s1', latch('call-1', { mode: 'time', preview: null, bytes: 4_196, placeholder: '[cleared]' }));
      expect(store.toolResultSpills('s1')).toEqual([stored(latch('call-1', { mode: 'time', preview: null, bytes: 4_196, placeholder: '[cleared]' }))]);
    });

    it('two occurrences of one reused toolCallId hold two independent rows', () => {
      // Sequential id styles (`call_0`) reuse ids across turns; each cleared occurrence needs its own
      // latch row or the newer one overwrites (and later swallows) the older one's placeholder.
      store.createSession({ id: 's1', userId: 7, model: 'm' });
      store.upsertToolResultSpill('s1', latch('call_0', { occurredAt: 1_000 }));
      store.upsertToolResultSpill('s1', latch('call_0', { occurredAt: 2_000, placeholder: '[second occurrence]' }));
      expect(store.toolResultSpills('s1').map((row) => row.occurredAt)).toEqual([1_000, 2_000]);
      // Deleting by occurrence key removes exactly one of them.
      store.deleteToolResultSpill('s1', 'call_0', 1_000);
      expect(store.toolResultSpills('s1').map((row) => row.occurredAt)).toEqual([2_000]);
    });

    it('deleteSession removes the session\'s latch rows and only those', () => {
      store.createSession({ id: 's1', userId: 7, model: 'm' });
      store.createSession({ id: 's2', userId: 7, model: 'm' });
      store.upsertToolResultSpill('s1', latch('call-1'));
      store.upsertToolResultSpill('s2', latch('call-2'));
      store.deleteSession('s1');
      expect(store.toolResultSpills('s1')).toEqual([]);
      expect(store.toolResultSpills('s2')).toEqual([stored(latch('call-2'))]);
    });

    it('reassignSession moves the latch rows with their paths VERBATIM', () => {
      store.createSession({ id: 'chan-x', userId: 7, model: 'm' });
      const path = `/data/tool-results/${store.spillNamespace('chan-x')}/call-1.v1-preview-50007.txt`;
      store.upsertToolResultSpill('chan-x', latch('call-1', { path }));
      store.reassignSession('chan-x', 'arch-1');
      expect(store.toolResultSpills('chan-x')).toEqual([]);
      // The path is the one already embedded in placeholders the provider cached: rewriting a single
      // byte of it would invalidate the cached prefix of a conversation `/context` may have moved while
      // WARM. The spill dir is keyed by the immutable namespace, so the verbatim path stays true.
      expect(store.toolResultSpills('arch-1')).toEqual([stored(latch('call-1', { path }))]);
    });
  });

  describe('spill namespace', () => {
    it('is minted unique per conversation and never equals the reusable id', () => {
      store.createSession({ id: 'brain-ch-general', userId: 7, model: 'm' });
      const ns = store.spillNamespace('brain-ch-general');
      // Prefixed by the creation id for on-disk readability, suffixed for uniqueness: channel-slot ids
      // are deterministic and reused across generations, and two generations must never share a dir.
      expect(ns.startsWith('brain-ch-general-')).toBe(true);
      expect(ns).not.toBe('brain-ch-general');
    });

    it('falls back to the id for unknown sessions and pre-namespace rows', () => {
      expect(store.spillNamespace('never-created')).toBe('never-created');
      // A row minted by an older build (empty spill_ns, before the boot backfill froze it).
      store.createSession({ id: 'legacy', userId: 7, model: 'm' });
      store['db'].prepare("UPDATE brain_sessions SET spill_ns = '' WHERE id = 'legacy'").run();
      expect(store.spillNamespace('legacy')).toBe('legacy');
    });

    it('a fork gets its own namespace, never the source\'s', () => {
      store.createSession({ id: 'src', userId: 7, model: 'm' });
      store.forkSession('src', 'copy');
      expect(store.spillNamespace('copy')).not.toBe(store.spillNamespace('src'));
      expect(store.spillNamespace('copy').startsWith('copy-')).toBe(true);
    });
  });

  describe('deleteSession', () => {
    it('removes the session\'s tool-result spill dir along with its rows', async () => {
      const { mkdtempSync, mkdirSync, writeFileSync, existsSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');
      const home = mkdtempSync(join(tmpdir(), 'elowen-spill-purge-'));
      dirs.push(home);
      vi.stubEnv('HOME', home);
      try {
        store.createSession({ id: 's1', userId: 7, model: 'm' });
        store.createSession({ id: 's2', userId: 7, model: 'm' });
        const spill1 = join(home, '.config/elowen/tool-results', store.spillNamespace('s1'));
        const spill2 = join(home, '.config/elowen/tool-results', store.spillNamespace('s2'));
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
    it('keeps the spill dir in place — the namespace moves with the row, the files never do', async () => {
      const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');
      const home = mkdtempSync(join(tmpdir(), 'elowen-spill-move-'));
      dirs.push(home);
      vi.stubEnv('HOME', home);
      try {
        store.createSession({ id: 'chan-x', userId: 7, model: 'm' });
        const ns = store.spillNamespace('chan-x');
        const dir = join(home, '.config/elowen/tool-results', ns);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'call-1.txt'), 'spilled');
        store.reassignSession('chan-x', 'arch-1');
        // No rename, no rewrite: placeholders already on the wire embed paths under this exact dir, and
        // a /context bind can move a WARM conversation — moving the files would both invalidate its
        // cached prefix and (on a failed rename) strand them under the freed slot id.
        expect(store.spillNamespace('arch-1')).toBe(ns);
        expect(readFileSync(join(dir, 'call-1.txt'), 'utf8')).toBe('spilled');
        // …and a later delete of the archived conversation still cleans the same dir up.
        store.deleteSession('arch-1');
        expect(existsSync(dir)).toBe(false);
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
