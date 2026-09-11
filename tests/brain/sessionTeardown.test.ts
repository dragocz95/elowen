import { beforeAll, describe, it, expect, vi } from 'vitest';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { BrainService } from '../../src/brain/brainService.js';
import { processRegistry, type ProcessHandle } from '../../src/brain/processRegistry.js';
import { IDLE_LIVE_SESSION_TTL_MS } from '../../src/brain/service/liveSessionReaper.js';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { PluginRegistryProvider } from '../../src/plugins/pluginsProvider.js';
import { inMemoryModelRuntime } from '../../src/brain/providers.js';

// Teardown of ONE conversation happens on three paths — the client stop, the user-facing delete and the
// admin delete — and each used to release a different subset of what a conversation owns. These are the
// three holes that opened up between them: a stop that disposed the parent even when the abort failed, an
// admin delete that left the active pointer and the card cache naming a row it had just removed, and a
// delete that stopped the shell processes of the delegated tree while the agent turns themselves ran on.

let sharedRuntime: ModelRuntime;
beforeAll(async () => { sharedRuntime = await inMemoryModelRuntime(); });

/** Same fake-PI harness the other BrainService suites use (see idleLiveSessionLifecycle.test.ts). */
function fakeDeps() {
  const listeners: ((e: unknown) => void)[] = [];
  const messages: { role: string; content: string }[] = [];
  const session = {
    sessionId: 'sess-1',
    prompt: vi.fn(async (t: string, options?: { preflightResult?: (success: boolean) => void }) => {
      options?.preflightResult?.(true);
      messages.push({ role: 'user', content: t }, { role: 'assistant', content: `echo:${t}` });
      listeners.forEach((l) => l({ type: 'agent_end', willRetry: false, messages: [{ role: 'assistant', content: `echo:${t}` }] }));
    }),
    subscribe: (l: (e: unknown) => void) => { listeners.push(l); return () => {}; },
    setModel: vi.fn(), dispose: vi.fn(), abort: vi.fn(async () => {}),
    sendCustomMessage: vi.fn(async () => {}),
    abortCompaction: vi.fn(), abortBranchSummary: vi.fn(), messages, isStreaming: false,
    _checkCompaction: vi.fn(async () => false),
    __queue: [] as string[],
    __emitQueue: () => listeners.forEach((l) => l({ type: 'queue_update', steering: session.__queue.slice(), followUp: [] })),
    steer: vi.fn(async (t: string) => { session.__queue.push(t); session.__emitQueue(); }),
    setSteeringMode: vi.fn(),
    getSteeringMessages: () => session.__queue,
    getFollowUpMessages: () => [] as string[],
    get pendingMessageCount() { return session.__queue.length; },
    clearQueue: vi.fn(() => { const s = session.__queue.slice(); session.__queue.length = 0; session.__emitQueue(); return { steering: s, followUp: [] }; }),
    __contextUsage: undefined as { tokens: number; contextWindow: number; percent: number } | undefined,
    getContextUsage(this: { __contextUsage?: { tokens: number; contextWindow: number; percent: number } }) { return this.__contextUsage; },
    compact: vi.fn(async () => {}),
    __tools: [] as { name: string }[],
    __active: [] as string[],
    // A real PI session always exposes its RENDERED prompt; the compaction threshold measures the
    // never-shrinking prefill off it, so a fake without one is simply incomplete.
    systemPrompt: '',
    getAllTools(this: { __tools: { name: string }[] }) { return this.__tools; },
    getActiveToolNames(this: { __active: string[] }) { return this.__active; },
    setActiveToolsByName: vi.fn(function (this: { __active: string[] }, names: string[]) { this.__active = names; }),
    model: undefined as unknown,
    agent: { streamFunction: vi.fn() },
    thinkingLevel: '' as string,
    supportsThinking: () => true,
    getAvailableThinkingLevels: () => ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    setThinkingLevel: vi.fn(function (this: { thinkingLevel: string }, l: string) { session.thinkingLevel = l; }),
  };
  const createSession = vi.fn(async (opts: { customTools?: { name: string }[]; model?: unknown }) => {
    session.__tools = opts.customTools ?? [];
    session.__active = session.__tools.map((t) => t.name);
    session.model = opts.model;
    return { session };
  });
  return {
    store: new BrainStore(openDb(':memory:')),
    runtime: sharedRuntime,
    users: { ensureAdvisorToken: () => 'full-token', get: () => ({ name: 'Filip', username: 'filip' }) },
    config: { providers: [{ id: 'relay', label: 'Relay', type: 'openai' as const, baseUrl: 'http://x/v1', models: ['m'], apiKey: 'k' }] },
    prompts: { render: vi.fn((name: string, vars: Record<string, string>) => `PERSONA:${name}:${vars.userName}`) },
    url: 'http://x',
    createSession,
    resourceLoaderFactory: () => undefined,
    session,
  };
}

const POLICY = { allowedProjectIds: 'all' as const, allowedPaths: () => [] };

type RegistryInternals = {
  sessions: {
    has(id: string): boolean;
    isDisposing(id: string): boolean;
    setChildRunning(parentSessionId: string, childSessionId: string, running: boolean): void;
    hasActiveChildren(parentSessionId: string): boolean;
    activeIdFor(userId: number): string | undefined;
  };
  cards: { set(sessionId: string, raw: unknown): unknown; forSession(sessionId: string): unknown[] };
};

const internalsOf = (svc: BrainService): RegistryInternals => svc as unknown as RegistryInternals;

describe('stopSession — a failed abort must not dispose the parent anyway', () => {
  it('keeps the conversation live and surfaces the failure when the work could not be stopped', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    const { sessionId } = await svc.start(1);
    // PI refuses to unwind the turn (a stuck tool, a controller that never settles). Everything the abort
    // cascade should have torn down — foreground delegates, the workflow engine, the PI turn — is still up.
    d.session.abort.mockImplementation(async () => { throw new Error('PI would not unwind'); });

    await expect(svc.stopSession(1)).rejects.toThrow(/PI would not unwind/);

    // Disposing here would leave that work running with no parent to deliver into.
    expect(d.session.dispose).not.toHaveBeenCalled();
    expect(internalsOf(svc).sessions.has(sessionId)).toBe(true);
    expect(internalsOf(svc).sessions.isDisposing(sessionId)).toBe(false); // and not pinned on the slow path
  });

  it('still stops and disposes when the abort succeeds', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    const { sessionId } = await svc.start(1);

    await expect(svc.stopSession(1)).resolves.toEqual({ stopped: true, disposed: true });

    expect(d.session.dispose).toHaveBeenCalled();
    expect(internalsOf(svc).sessions.has(sessionId)).toBe(false);
  });
});

describe('deleting a conversation releases everything it owns', () => {
  it('a FAILED delete leaves the live session collectable instead of pinning it forever', async () => {
    // deleteSession fences the conversation with markDisposing before it queues on the session lock, and
    // the teardown inside that lock now refuses on an unconfirmed process kill. A marker nothing clears
    // makes reapableNow() false for the rest of the daemon's life: one live session pinned per failed
    // delete, in a process that runs for weeks.
    const t0 = 1_800_000_000_000;
    const d = fakeDeps();
    // A wedged runner never answers the sweep, so the teardown refuses rather than drop rows whose
    // processes may still be running. Nothing local is left behind, so the session itself is quiet.
    d.subagentRunner = {
      killSessionProcesses: () => Promise.reject(new Error('the sub-agent runner did not answer the process request in time')),
    };
    const svc = new BrainService(d as never);
    const { sessionId } = await svc.start(1);
    await svc.send({ userId: 1, text: 'hello' }); // a spoken conversation the reaper is allowed to collect

    await expect(svc.deleteSession(1, sessionId)).rejects.toThrow('did not answer the process request in time');
    expect(internalsOf(svc).sessions.has(sessionId)).toBe(true);
    expect(internalsOf(svc).sessions.isDisposing(sessionId)).toBe(false);
    // The observable consequence of a stranded marker: reapableNow() reads it, so the idle reaper would
    // skip this unwatched, idle session for the rest of the daemon's life.
    expect(await svc.reapIdleLiveSessions(t0)).toEqual([]);
    expect(await svc.reapIdleLiveSessions(t0 + IDLE_LIVE_SESSION_TTL_MS)).toEqual([sessionId]);
  });

  it('REFUSES the delete while a process kill is unconfirmed — the rows stay retryable', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    const created = await svc.start(1);
    // A local handle the sweep cannot stop: the registry must retain it and the delete must abort
    // while the session row (and its ownership) still exists.
    const stubborn: ProcessHandle = {
      id: 'bg-stubborn', command: 'sleep 30', cwd: '/w', startedAt: '2026-01-01T00:00:00.000Z',
      accountUserId: 1, sessionId: created.sessionId, completionMode: 'job',
      running: () => true, exitCode: () => null, readAll: () => '',
      kill: () => Promise.reject(new Error('guest cancellation failed')),
    };
    processRegistry.register(stubborn);
    try {
      await expect(svc.deleteManagedSession(1, created.sessionId)).rejects.toThrow('unconfirmed local process');
      // Nothing was deleted: the row survives and the delete can simply be repeated once the process
      // stops cooperating or is stopped by other means.
      expect(d.store.getSession(created.sessionId)).not.toBeUndefined();
      expect(processRegistry.get('bg-stubborn')).toBeDefined();
      // Once the kill lands, the SAME delete goes through.
      stubborn.kill = () => Promise.resolve();
      await expect(svc.deleteManagedSession(1, created.sessionId)).resolves.toBe(1);
      expect(processRegistry.get('bg-stubborn')).toBeUndefined();
    } finally { processRegistry.remove('bg-stubborn'); }
  });

  it('clears the active pointer when the admin panel deletes the active conversation', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    const first = await svc.start(1);
    await svc.send({ userId: 1, text: 'first' });
    const second = await svc.start(1, { fresh: true });
    await svc.send({ userId: 1, text: 'second' });

    await expect(svc.deleteManagedSession(1, second.sessionId)).resolves.toBe(1);

    // The pointer must not survive the row it names: every pointer-based call (the web dock, a platform
    // turn) resolves through it, and the next one RESURRECTED the deleted conversation as an empty shell.
    expect(internalsOf(svc).sessions.activeIdFor(1)).toBeUndefined();
    await svc.send({ userId: 1, text: 'after the delete' });
    expect(d.store.getSession(second.sessionId)).toBeUndefined(); // the delete stuck
    const landed = d.store.getMessages(first.sessionId).map((row) => JSON.stringify(row.content));
    expect(landed.some((content) => content.includes('after the delete'))).toBe(true);
  });

  it('drops the deleted conversation\'s card cache', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    const { sessionId } = await svc.start(1);
    internalsOf(svc).cards.set(sessionId, { id: 'todo', items: [{ text: 'step one', status: 'pending' }] });
    expect(internalsOf(svc).cards.forSession(sessionId)).toHaveLength(1);

    await expect(svc.deleteManagedSession(1, sessionId)).resolves.toBe(1);

    // The store rows went with the conversation; a stale cache would re-serve them to whatever conversation
    // next lands on this id (the default `brain-<uid>` is minted again on the very next start).
    expect(internalsOf(svc).cards.forSession(sessionId)).toEqual([]);
  });

  it('aborts the delegated child and cancels the workflow engine of a deleted parent', async () => {
    const d = fakeDeps();
    const reg = new PluginRegistry();
    const ctx = reg.contextFor('subagent', {}, { info() {}, warn() {}, error() {} });
    const cancelled: string[] = [];
    ctx.registerControl('workflow', {
      cancelForSession: ({ sessionId }: { sessionId: string }) => { cancelled.push(sessionId); return { cancelled: 1 }; },
      detachForeground: () => ({ detached: 0 }),
      activeCount: () => 0,
      isWorkflowLive: () => false,
      addNodesFromSession: () => { throw new Error('unused'); },
      resumeInterrupted: async () => ({ resumed: false }),
    });
    (d as unknown as { plugins: unknown }).plugins = new PluginRegistryProvider(async () => reg);
    const svc = new BrainService(d as never);
    const { sessionId } = await svc.start(1);
    // A delegated child running under this parent — its result has nowhere to land once the parent is gone.
    await svc.channelSend({ channelId: 'subagent-sub-dlg-1', ownerUserId: 1, policy: POLICY }, 'dig');
    internalsOf(svc).sessions.setChildRunning(sessionId, 'brain-ch-subagent-sub-dlg-1', true);
    d.session.abort.mockClear(); // count only the aborts the delete itself issues

    await svc.deleteSession(1, sessionId);

    await vi.waitFor(() => {
      // The DAG stops launching nodes into a deleted inbox — the parent's engine first, then the child's
      // own (the channel abort cascades the same cancel down the tree it tears down).
      expect(cancelled[0]).toBe(sessionId);
      // A child is deregistered only once its own channel abort has RESOLVED, so this is what proves the
      // child's turn itself was unwound rather than only the shell processes underneath it.
      expect(internalsOf(svc).sessions.hasActiveChildren(sessionId)).toBe(false);
    });
    expect(d.session.abort).toHaveBeenCalled();
  });

  it('sweeps runner-held background processes for every session of the deleted tree', async () => {
    // A child hosted in the runner keeps its Bash handles in the RUNNER's registry; the local sweep
    // cannot reach them, and the session rows (ownership) disappear right after — so the runner sweep
    // must fire for each tree node BEFORE the rows go.
    const d = fakeDeps();
    const swept: string[] = [];
    d.subagentRunner = {
      killSessionProcesses: async (sessionId: string) => { swept.push(sessionId); return 1; },
    };
    const svc = new BrainService(d as never);
    const { sessionId } = await svc.start(1);
    const child = 'brain-ch-subagent-sub-dlg-1';
    d.store.createSession({ id: child, userId: 1, model: 'm', parentSessionId: sessionId });
    d.store.upsertSubagentRun(sessionId, { id: 'call-1', sessionId: child, status: 'running', task: 'dig', tools: 0, seconds: 0 });

    await svc.deleteSession(1, sessionId);

    expect(swept).toEqual(expect.arrayContaining([sessionId, child]));
  });

  it('does not race a turn that is already in flight on the deleted conversation', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    const { sessionId } = await svc.start(1);

    const order: string[] = [];
    const dropRows = d.store.deleteSession.bind(d.store);
    vi.spyOn(d.store, 'deleteSession').mockImplementation((id: string) => { order.push(`dropped:${id}`); dropRows(id); });

    // Park a turn inside PI's prompt(): it holds the session lock and has not persisted its reply yet.
    const runPrompt = d.session.prompt.getMockImplementation();
    let releaseTurn: (() => void) | undefined;
    let admitTurn: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => { admitTurn = resolve; });
    d.session.prompt.mockImplementation(async (text, options) => {
      admitTurn();
      await new Promise<void>((resolve) => { releaseTurn = resolve; });
      await runPrompt?.(text, options);
      order.push('turn settled');
    });
    // PI unwinds its run when the teardown interrupts it — and, in the unserialized delete this covers,
    // when the record is disposed out from under the running turn.
    d.session.abort.mockImplementation(async () => { releaseTurn?.(); });
    d.session.dispose.mockImplementation(() => { releaseTurn?.(); });

    const sending = svc.send({ userId: 1, text: 'mid-flight' });
    await inFlight;

    await svc.deleteSession(1, sessionId);
    await expect(sending).resolves.toBeUndefined(); // interrupting the turn must not blow it up either

    // The delete interrupts the turn and then WAITS for it, instead of tearing the conversation down
    // underneath it: an unserialized delete dropped the row first, and the turn's own agent_end then
    // persisted its reply into a conversation that no longer existed — an orphan row nothing collects,
    // because brain_messages has no FK cascade onto brain_sessions.
    expect(d.store.getSession(sessionId)).toBeUndefined();
    expect(d.store.getMessages(sessionId)).toHaveLength(0);
    expect(order).toEqual(['turn settled', `dropped:${sessionId}`]);
  });
});

// The admin oversight register ("Všechny konverzace") spans every account. That is a deliberate widening
// of what an admin sees, so the boundary it must NOT cross is pinned here: reading and deleting reach
// across accounts, posting never does.
describe('admin oversight register', () => {
  function withUsers(d: ReturnType<typeof fakeDeps>) {
    const db = (d.store as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => void } } }).db;
    db.prepare("INSERT INTO users (id,username,password_hash,name) VALUES (1,'admin','x','')").run();
    db.prepare("INSERT INTO users (id,username,password_hash,name) VALUES (2,'bob','x','Bob Novák')").run();
    db.prepare("INSERT INTO users (id,username,password_hash,name) VALUES (3,'carol','x','')").run();
  }

  it('lists every account\'s conversations and labels each with its owner', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    withUsers(d);
    await svc.start(1); await svc.send({ userId: 1, text: 'mine' });
    const foreign = await svc.start(2); await svc.send({ userId: 2, text: 'theirs' });
    await svc.start(3); await svc.send({ userId: 3, text: 'nameless' });

    const rows = svc.listManagedSessions(1);
    const owners = new Map(rows.map((r) => [r.id, r.ownerLabel]));
    expect(owners.get(foreign.sessionId)).toBe('Bob Novák');
    // Display name wins, username is the fallback -- both resolved by JOIN, so a rename follows.
    expect([...owners.values()]).toContain('carol');
    expect(rows.map((r) => r.ownerId).sort()).toEqual([1, 2, 3]);
  });

  it('deletes a foreign conversation only when the caller asks to cross accounts', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    withUsers(d);
    const foreign = await svc.start(2); await svc.send({ userId: 2, text: 'theirs' });

    // The default stays owner-scoped, so no existing caller silently gained reach.
    await expect(svc.deleteManagedSession(1, foreign.sessionId)).resolves.toBe(0);
    expect(d.store.getSession(foreign.sessionId)).toBeTruthy();

    await expect(svc.deleteManagedSession(1, foreign.sessionId, 'any')).resolves.toBe(1);
    expect(d.store.getSession(foreign.sessionId)).toBeUndefined();
  });

  /** "Delete all" deletes what the caller was shown, and the register shows every account — so the scope
   *  has to be said out loud rather than assumed. The DEFAULT stays owner-scoped, which is not politeness:
   *  the other caller of this method is account deletion (routes/auth.ts), and a default that crossed
   *  accounts would wipe the whole instance when one person is removed. */
  it('"delete all" stays owner-scoped by default and crosses accounts only when asked', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    withUsers(d);
    const own = await svc.start(1); await svc.send({ userId: 1, text: 'mine' });
    const foreign = await svc.start(2); await svc.send({ userId: 2, text: 'theirs' });

    await expect(svc.deleteAllManagedSessions(1)).resolves.toBe(1);
    expect(d.store.getSession(own.sessionId)).toBeUndefined();
    expect(d.store.getSession(foreign.sessionId)).toBeTruthy();

    // The cross-account register's own button, which the route only reaches for an admin.
    await expect(svc.deleteAllManagedSessions(1, 'any')).resolves.toBe(1);
    expect(d.store.getSession(foreign.sessionId)).toBeUndefined();
  });

  it('reads a foreign transcript only with anyOwner, and never accepts a post into it', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    withUsers(d);
    const foreign = await svc.start(2); await svc.send({ userId: 2, text: 'theirs' });

    expect(() => svc.messagesOf(1, foreign.sessionId)).toThrow(/unknown session/);
    expect(svc.messagesOf(1, foreign.sessionId, { anyOwner: true }).length).toBeGreaterThan(0);

    // The escape hatch is READ-only: the send path has its own ownership check and must stay closed,
    // or an admin would post into someone else's conversation under that person's identity.
    expect(() => svc.messagesPage(1, foreign.sessionId, { limit: 10 })).toThrow(/unknown session/);
  });
});
