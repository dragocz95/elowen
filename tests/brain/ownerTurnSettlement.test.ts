import { beforeAll, describe, it, expect, vi } from 'vitest';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { BrainService } from '../../src/brain/brainService.js';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { UsageOriginStore, billSettledTurn } from '../../src/store/usageOriginStore.js';
import { inMemoryModelRuntime } from '../../src/brain/providers.js';
import type { ClientOrigin } from '../../src/api/clientIp.js';
import type { OriginTurnUsage } from '../../src/store/usageOriginStore.js';

/** What an OWNER turn does besides answering, against a real BrainStore and a real UsageOriginStore.
 *
 *  The owner surface and a room settle through one helper on purpose, so the cases here are the ones the
 *  room cannot exercise: the idle rollover that moves a turn to a fresh conversation mid-flight, the
 *  guards that can still refuse a turn after it was announced, and the steer path. */

const WEB: ClientOrigin = { value: '203.0.113.9', kind: 'ip', trusted: true };
const AT = Date.UTC(2026, 7, 24, 10, 0);

let sharedRuntime: ModelRuntime;
beforeAll(async () => { sharedRuntime = await inMemoryModelRuntime(); });

/** Same fake-PI harness the other BrainService suites use (see idleLiveSessionLifecycle.test.ts), plus the
 *  three settlement wirings the daemon supplies: the origin rollup, the activity feed and the billing. */
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
    setModel: vi.fn(),
    // A disposed PI session takes its subscription with it. The harness reuses ONE session object across
    // spawns, so without this the archived conversation's subscription would still be listening when the
    // rolled-over session answers, and every turn after a rollover would settle twice.
    dispose: vi.fn(() => { listeners.length = 0; }),
    abort: vi.fn(async () => {}),
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
  const db = openDb(':memory:');
  const store = new BrainStore(db);
  const usageOrigins = new UsageOriginStore(db);
  const activity: { actorUserId: number | null; surface: string; target: string }[] = [];
  return {
    store, usageOrigins,
    runtime: sharedRuntime,
    users: { ensureAdvisorToken: () => 'full-token', get: () => ({ name: 'Filip', username: 'filip' }) },
    config: { providers: [{ id: 'relay', label: 'Relay', type: 'openai' as const, baseUrl: 'http://x/v1', models: ['m'], apiKey: 'k' }] },
    prompts: { render: vi.fn((name: string, vars: Record<string, string>) => `PERSONA:${name}:${vars.userName}`) },
    url: 'http://x',
    createSession,
    resourceLoaderFactory: () => undefined,
    session,
    // Wired exactly as the daemon wires them (brainCore).
    recordActivity: (e: { actorUserId: number | null; surface: string; target: string }) => { activity.push(e); },
    onTurnSettled: (sessionId: string, usage: OriginTurnUsage) => {
      billSettledTurn(usageOrigins, (id) => store.getSession(id)?.user_id, sessionId, usage, AT);
    },
    activity,
    /** The rollup as the admin view reads it: [account, address, turns]. */
    billed: () => usageOrigins.topOrigins({ group: 'pair' }).map((r) => [r.userId, r.origin, r.turns]),
  };
}

/** Push every stored message far enough into the past that the idle rollover is due on the next turn. */
const ageTranscript = (store: BrainStore): void => {
  store.db.prepare(`UPDATE brain_messages SET created_at = datetime('now', '-3 hours')`).run();
};

describe('an owner turn that changes conversation mid-flight is still attributed to its surface', () => {
  // The idle rollover archives the transcript and mints a FRESH session id, and settlement happens under
  // that new id. A pin left on the pre-lock id is found by nobody, so the first turn after every rollover
  // used to record as `internal` against the row owner instead of the surface the person was sitting at.
  it('follows the idle rollover, so the turn after it is not recorded as `internal`', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1);
    await svc.send({ userId: 1, text: 'first', origin: WEB, surface: 'web' });
    const before = svc.status(1).sessionId;
    ageTranscript(d.store);

    await svc.send({ userId: 1, text: 'after a long lunch', origin: WEB, surface: 'web' });

    expect(svc.status(1).sessionId, 'the rollover must actually have happened').not.toBe(before);
    expect(d.billed()).toEqual([[1, WEB.value, 2]]);
  });
});

describe('the activity feed reports work that actually runs', () => {
  // The feed is streamed live to attached browsers, so a row for work that was refused a line later is
  // not merely untidy: it says somebody is working when nobody is, once per dropped nudge.
  it('does not announce a system nudge that is dropped because the session is busy', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1);
    d.session.isStreaming = true;

    await svc.send({ userId: 1, text: 'your command finished', internal: { kind: 'systemNudge' } } as never);

    expect(d.activity).toEqual([]);
  });

  it('still announces a turn that runs', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1);

    await svc.send({ userId: 1, text: 'hello', surface: 'web' });

    expect(d.activity).toEqual([{ actorUserId: 1, surface: 'web', target: svc.status(1).sessionId }]);
  });
});

describe('a message steered into a running turn settles like the room surface settles one', () => {
  // Owner steer returned before any settlement while a room stamped the writer, so the two surfaces
  // disagreed about a message that reached the model either way — the divergence this shared settlement
  // exists to remove.
  it('stamps the writer for a message folded into somebody\'s running turn', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1);
    await svc.send({ userId: 1, text: 'start something long' });
    const sessionId = svc.status(1).sessionId!;
    d.store.db.prepare('UPDATE brain_sessions SET last_writer_user_id = NULL').run();
    d.session.isStreaming = true;

    await svc.send({ userId: 1, text: 'also check the logs' });

    expect(d.session.steer).toHaveBeenCalled();
    expect(d.store.getSession(sessionId)!.last_writer_user_id).toBe(1);
  });
});
