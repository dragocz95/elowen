import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { rehydrate } from '../../src/brain/persistence.js';
import { planFilePath, toolResultSpillDir } from '../../src/shared/paths.js';
import { readPlan } from '../../src/brain/continuity/planStore.js';
import { seedPlan } from '../helpers/plan.js';

/** `/clear` empties ONE conversation without deleting it. The durable half is what makes it stick: a
 *  rehydrate (respawn, daemon restart, resume) rebuilds the model's context from `brain_messages` alone,
 *  so anything left there — or in the sidecars a respawn re-reads — comes straight back. */

const SESSION = 'brain-1';
const OTHER = 'brain-2';
let home: string;

function seedConversation(store: BrainStore, sessionId: string): void {
  store.appendMessage({ id: `${sessionId}-u1`, sessionId, parentId: null, role: 'user', content: { role: 'user', content: 'the secret is hunter2' } });
  store.appendMessage({ id: `${sessionId}-a1`, sessionId, parentId: null, role: 'assistant', content: { role: 'assistant', content: 'noted' } });
  store.appendMessage({ id: `${sessionId}-t1`, sessionId, parentId: null, role: 'toolResult', content: { role: 'toolResult', content: 'ran the tests' } });
  store.appendPendingMessage({ id: `${sessionId}-p1`, sessionId, role: 'assistant', content: { role: 'assistant', content: 'half a sentence' } });
  store.appendSessionEvent(sessionId, 'model', 'gpt-5.5');
  store.upsertCard(sessionId, { id: 'todo', title: 'Plan', items: [{ text: 'ship it', status: 'pending' }], pinned: true });
  store.upsertToolResultSpill(sessionId, {
    toolCallId: 'call-1', occurredAt: 1, mode: 'preview', bytes: 12, preview: 'output',
    path: join(toolResultSpillDir(process.env, store.spillNamespace(sessionId)), 'call-1.txt'), placeholder: '[cleared]',
  });
  seedPlan(sessionId, '1. read the code\n2. change it');
}

beforeEach(() => {
  home = mkdtempSync(`${tmpdir()}/elowen-clear-`);
  process.env.HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.HOME;
});

describe('BrainStore.clearSessionHistory', () => {
  it('empties every table a respawn reads back, so a rehydrate returns no messages at all', () => {
    const store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: SESSION, userId: 7, title: 'Deploy plan', model: 'gpt-5.5', provider: 'openai' });
    seedConversation(store, SESSION);
    expect(rehydrate(store, SESSION, home).buildSessionContext().messages.length).toBeGreaterThan(0);

    store.clearSessionHistory(SESSION);

    expect(store.getMessages(SESSION)).toEqual([]);
    // The provisional mid-turn row goes too: settlePartialTurn would otherwise graduate it into durable
    // history on the very next spawn, resurrecting the turn the clear was meant to remove.
    expect(store.pendingMessages(SESSION)).toEqual([]);
    expect(store.getSessionEvents(SESSION)).toEqual([]);
    expect(store.getCards(SESSION)).toEqual([]);
    expect(store.toolResultSpills(SESSION)).toEqual([]);
    expect(store.lastMessageAt(SESSION)).toBeUndefined();
    expect(rehydrate(store, SESSION, home).buildSessionContext().messages).toEqual([]);
  });

  it('keeps the conversation itself — id, title, model, provider and spill namespace', () => {
    const store = new BrainStore(openDb(':memory:'));
    const created = store.createSession({ id: SESSION, userId: 7, title: 'Deploy plan', model: 'gpt-5.5', provider: 'openai' });
    seedConversation(store, SESSION);

    store.clearSessionHistory(SESSION);

    const row = store.getSession(SESSION);
    expect(row).toMatchObject({ id: SESSION, user_id: 7, title: 'Deploy plan', model: 'gpt-5.5', provider: 'openai' });
    expect(store.spillNamespace(SESSION)).toBe(created.spill_ns);
  });

  it('removes the plan file and the spill directory — the two context sources that live outside SQLite', () => {
    const store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: SESSION, userId: 7, model: 'gpt-5.5' });
    seedConversation(store, SESSION);
    const spillDir = toolResultSpillDir(process.env, store.spillNamespace(SESSION));
    mkdirSync(spillDir, { recursive: true });
    writeFileSync(join(spillDir, 'call-1.txt'), 'the cleared tool output', 'utf8');
    expect(readPlan(SESSION)).toContain('read the code');

    store.clearSessionHistory(SESSION);

    expect(readPlan(SESSION)).toBeUndefined();
    expect(existsSync(planFilePath(process.env, SESSION))).toBe(false);
    expect(existsSync(spillDir)).toBe(false);
  });

  it('touches only the target conversation', () => {
    const store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: SESSION, userId: 7, model: 'gpt-5.5' });
    store.createSession({ id: OTHER, userId: 7, model: 'gpt-5.5' });
    seedConversation(store, SESSION);
    seedConversation(store, OTHER);

    store.clearSessionHistory(SESSION);

    expect(store.getMessages(OTHER)).toHaveLength(4); // 3 settled + the provisional mid-turn row
    expect(store.pendingMessages(OTHER)).toHaveLength(1);
    expect(store.getSessionEvents(OTHER)).toHaveLength(1);
    expect(store.getCards(OTHER)).toHaveLength(1);
    expect(store.toolResultSpills(OTHER)).toHaveLength(1);
    expect(readPlan(OTHER)).toContain('read the code');
  });

  it('keeps the child conversations and a persistent goal — they are not this transcript', () => {
    const store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: SESSION, userId: 7, model: 'gpt-5.5' });
    store.createSession({ id: OTHER, userId: 7, model: 'gpt-5.5', parentSessionId: SESSION });
    store.upsertGoal({ sessionId: SESSION, userId: 7, goal: 'keep the build green', turnBudget: 5 });
    seedConversation(store, SESSION);

    store.clearSessionHistory(SESSION);

    // The child conversation is another transcript with its own id: clearing the parent must not delete
    // it, nor orphan it the way a parent DELETE does.
    expect(store.getSession(OTHER)).toMatchObject({ id: OTHER, parent_session_id: SESSION });
    expect(store.getGoal(SESSION)?.goal).toBe('keep the build green');
  });

  /** The parent-side delegation bookkeeping describes calls made from the transcript being deleted, and a
   *  respawned PI session restarts its `call_N` tool-call ids. A surviving row therefore both reports work
   *  the empty transcript never did and holds the `UNIQUE (parent_session_id, tool_call_id)` slot the NEXT
   *  delegation needs — which is how a later child's result becomes undeliverable. */
  it('sweeps the parent-side delegation rows so the next delegation can still deliver its result', () => {
    const store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: SESSION, userId: 7, model: 'gpt-5.5' });
    store.createSession({ id: OTHER, userId: 7, model: 'gpt-5.5', parentSessionId: SESSION });
    const run = { id: 'call_0', sessionId: OTHER, task: 'audit the routes', status: 'done', tools: 2, seconds: 3 };
    expect(store.upsertSubagentRun(SESSION, run)).toBe(true);
    expect(store.enqueueSubagentResult(SESSION, { ...run, toolCallId: 'call_0', result: 'the old answer' })).toBe(true);
    store.acknowledgeSubagentResult(SESSION, 'call_0');
    expect(store.getSubagentRuns(SESSION)).toHaveLength(1);

    store.clearSessionHistory(SESSION);

    expect(store.getSubagentRuns(SESSION)).toEqual([]);
    // The freshly cleared conversation delegates again and PI mints `call_0` a second time: without the
    // sweep this insert loses to the stale row and the child's answer is dropped.
    expect(store.upsertSubagentRun(SESSION, { ...run, task: 'audit the store' })).toBe(true);
    expect(store.enqueueSubagentResult(SESSION, { ...run, toolCallId: 'call_0', task: 'audit the store', result: 'the new answer' })).toBe(true);
    expect(store.pendingSubagentResults(SESSION).map((r) => r.result)).toEqual(['the new answer']);
  });

  /** A cleared conversation has no messages, which is how a never-used shell looks too — and those are
   *  hidden from the pickers and swept by dropIfUnspoken/pruneEmptyConversations. `cleared_at` is the only
   *  durable evidence left that this one WAS used. */
  it('stamps cleared_at so the emptied conversation is not mistaken for an unused shell', () => {
    const store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: SESSION, userId: 7, title: 'Deploy plan', model: 'gpt-5.5' });
    store.createSession({ id: OTHER, userId: 7, model: 'gpt-5.5' }); // opened, never spoken in
    seedConversation(store, SESSION);
    expect(store.unspokenSessionIds(7)).toEqual(new Set([OTHER]));

    store.clearSessionHistory(SESSION);

    expect(store.getSession(SESSION)?.cleared_at).toBeTruthy();
    // Still listed (it is a real conversation), while the untouched empty shell is still withheld.
    expect(store.unspokenSessionIds(7)).toEqual(new Set([OTHER]));
  });
});
