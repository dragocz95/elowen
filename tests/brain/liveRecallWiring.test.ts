import { describe, it, expect, vi } from 'vitest';
import { BrainSessionFactory } from '../../src/brain/session/factory.js';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { installLiveRecall } from '../../src/brain/session/liveRecall.js';
import { currentMemoryRecallScope, runWithPolicy } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';

/** End-to-end over the WIRING, not over a stubbed module: build a real session through
 *  BrainSessionFactory with a liveRecall spec, capture the extension factories it hands to the resource
 *  loader, run them against a recording extension API, and drive the resulting `context` handler.
 *
 *  The unit tests prove the recall logic; this proves the logic is actually reachable. Between the two
 *  sits every way a feature can be correct and still do nothing: never registered, registered on the
 *  wrong event, or handed options the spawner never populated. */

interface CapturedHandlers { context?: (e: { messages: unknown }) => Promise<{ messages: unknown } | undefined> }

async function buildWithLiveRecall(
  retrieve: (q: string) => Promise<{ id: number; body: string; kind: string; importance: number }[]>,
  alreadyInContext: Set<number> = new Set<number>(),
): Promise<CapturedHandlers> {
  const session = {
    sessionId: 'brain-1',
    agent: {} as Record<string, unknown>,
    subscribe: () => () => {},
    messages: [] as unknown[],
    setSteeringMode: vi.fn(),
  };

  const handlers: CapturedHandlers = {};
  const factory = new BrainSessionFactory({
    store: new BrainStore(openDb(':memory:')),
    createSession: vi.fn(async () => ({ session })) as never,
    // Stand in for the real loader: run whatever extension factories the session assembly produced
    // against a recording API, so the test sees exactly what pi would have registered.
    // The default loader is module-private, so stand in for it exactly as it does: take the liveRecall
    // options the session assembly passed down and install the extension from them. If the factory ever
    // stops forwarding them, `options.liveRecall` is undefined here and every assertion below fails.
    resourceLoaderFactory: (options: { liveRecall?: Parameters<typeof installLiveRecall>[1] }) => {
      if (options.liveRecall) {
        const pi = { on: (event: string, fn: unknown) => { if (event === 'context') handlers.context = fn as CapturedHandlers['context']; } };
        installLiveRecall(pi as never, options.liveRecall);
      }
      return undefined;
    },
  });

  await factory.create({
    sessionId: session.sessionId, ownerUserId: 1,
    runtime: undefined,
    model: { id: 'test-model', provider: 'anthropic', contextWindow: 200_000 },
    cwd: process.cwd(), systemPrompt: 'sp', appendSystemPrompt: [], skills: [], tools: [],
    autoCompact: false,
    liveRecall: {
      budget: () => ({ passes: 10, count: 8, bytes: 6000 }),
      enabled: () => true,
      retrieve: async (q: string) => retrieve(q),
      alreadyInContext: () => alreadyInContext,
    },
  } as never);

  return handlers;
}

const POLICY: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };

describe('live recall wiring — a real session reaches the recall pass', () => {
  it('registers the context extension when the spec asks for recall', async () => {
    const handlers = await buildWithLiveRecall(async () => []);
    expect(typeof handlers.context).toBe('function');
  });

  it('injects a memory found from mid-turn work, through the real assembly', async () => {
    const seen: string[] = [];
    const handlers = await buildWithLiveRecall(async (q) => {
      seen.push(q);
      return q.includes('release.sh')
        ? [{ id: 7, body: 'Deployment runs through release.sh', kind: 'fact', importance: 4 }]
        : [];
    });
    if (!handlers.context) throw new Error('context handler was never registered');

    const messages = [
      { role: 'user', content: 'fix it' },
      { role: 'assistant', content: 'looking into the deploy path' },
      { role: 'toolResult', content: 'bash: ./release.sh --dry-run exited 2' },
    ];
    // The retrieval is non-blocking: the first call only STARTS the search and injects nothing; the
    // second call consumes the settled result.
    const during = await handlers.context({ messages });
    expect(during).toBeUndefined();
    await new Promise((resolve) => { setImmediate(resolve); });
    const out = await handlers.context({ messages });
    const result = (out?.messages ?? []) as { role?: string; content?: unknown }[];

    // The query came from the WORK, not from "fix it" — the whole reason this feature exists.
    expect(seen[0]).toContain('release.sh');
    expect(seen[0]).not.toContain('fix it');

    expect(result).toHaveLength(messages.length + 1);
    expect(String(result[3]?.content)).toContain('Deployment runs through release.sh');
    // Everything before the appended block is untouched, so the provider's cached prefix still matches.
    expect(JSON.stringify(result.slice(0, messages.length))).toBe(JSON.stringify(messages));
  });

  it('leaves a memory alone when turn-start recall already put it in this context window', async () => {
    // The two recall paths were tested in complete isolation before this, which is exactly how they
    // could both be correct and still print the same memory twice into one prompt. Seeding the shared
    // set stands in for the turn-start pass having already delivered id 7.
    const shared = new Set<number>([7]);
    const handlers = await buildWithLiveRecall(async (q) => (q.includes('release.sh')
      ? [{ id: 7, body: 'Deployment runs through release.sh', kind: 'fact', importance: 4 }]
      : []), shared);
    if (!handlers.context) throw new Error('context handler was never registered');

    const messages = [
      { role: 'user', content: 'fix it' },
      { role: 'assistant', content: 'looking into the deploy path' },
      { role: 'toolResult', content: 'bash: ./release.sh --dry-run exited 2' },
    ];
    await handlers.context({ messages });
    await new Promise((resolve) => { setImmediate(resolve); });
    const out = await handlers.context({ messages });

    // Nothing appended: the search still ran and still matched, but the model can already read it.
    expect(out).toBeUndefined();
  });

  it('adds what it injected to the set turn-start recall reads', async () => {
    const shared = new Set<number>();
    const handlers = await buildWithLiveRecall(async (q) => (q.includes('release.sh')
      ? [{ id: 7, body: 'Deployment runs through release.sh', kind: 'fact', importance: 4 }]
      : []), shared);
    if (!handlers.context) throw new Error('context handler was never registered');

    const messages = [
      { role: 'user', content: 'fix it' },
      { role: 'assistant', content: 'looking into the deploy path' },
      { role: 'toolResult', content: 'bash: ./release.sh --dry-run exited 2' },
    ];
    await handlers.context({ messages });
    await new Promise((resolve) => { setImmediate(resolve); });
    await handlers.context({ messages });

    // The other direction of the same contract: without this the next turn's turn-start recall would
    // reprint what mid-turn recall just delivered.
    expect([...shared]).toEqual([7]);
  });

  it('reads the current turn scope at each hook after the cwd changes', async () => {
    let handler: CapturedHandlers['context'];
    const seenProjects: (number | null)[] = [];
    const pi = { on: (event: string, fn: unknown) => { if (event === 'context') handler = fn as CapturedHandlers['context']; } };
    installLiveRecall(pi as never, {
      budget: () => ({ passes: 10, count: 2, bytes: 1000 }),
      enabled: () => true,
      retrieve: async () => {
        seenProjects.push(currentMemoryRecallScope()?.projectId ?? null);
        return [];
      },
      alreadyInContext: () => new Set<number>(),
    });
    const context = handler;
    if (!context) throw new Error('context handler was never registered');
    const first = [
      { role: 'user', content: 'first request' },
      { role: 'assistant', content: 'checking the first project now' },
      { role: 'toolResult', content: 'first project produced enough detail to search memory' },
    ];
    const second = [
      ...first,
      { role: 'user', content: 'second request' },
      { role: 'assistant', content: 'checking the second project now' },
      { role: 'toolResult', content: 'second project produced enough detail to search memory' },
    ];

    await runWithPolicy(POLICY, () => context({ messages: first }), {
      memoryRecallScope: { projectId: 1, categoryIds: new Set([1]) },
    });
    await new Promise((resolve) => { setImmediate(resolve); });
    await runWithPolicy(POLICY, () => context({ messages: second }), {
      memoryRecallScope: { projectId: 2, categoryIds: new Set([2]) },
    });

    expect(seenProjects).toEqual([1, 2]);
  });

  it('registers nothing when the spec carries no recall options', async () => {
    const session = { sessionId: 'brain-1', agent: {}, subscribe: () => () => {}, messages: [], setSteeringMode: vi.fn() };
    const handlers: CapturedHandlers = {};
    const factory = new BrainSessionFactory({
      store: new BrainStore(openDb(':memory:')),
      createSession: vi.fn(async () => ({ session })) as never,
      resourceLoaderFactory: (options: { liveRecall?: Parameters<typeof installLiveRecall>[1] }) => {
        if (options.liveRecall) {
          const pi = { on: (event: string, fn: unknown) => { if (event === 'context') handlers.context = fn as CapturedHandlers['context']; } };
          installLiveRecall(pi as never, options.liveRecall);
        }
        return undefined;
      },
    });
    await factory.create({
      sessionId: 'brain-1', ownerUserId: 1, runtime: undefined,
      model: { id: 'test-model', provider: 'anthropic', contextWindow: 200_000 },
      cwd: process.cwd(), systemPrompt: 'sp', appendSystemPrompt: [], skills: [], tools: [],
      autoCompact: false,
    } as never);

    expect(handlers.context).toBeUndefined();
  });
});
