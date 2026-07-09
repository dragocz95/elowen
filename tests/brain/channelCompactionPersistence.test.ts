import { describe, it, expect, vi } from 'vitest';
import { ChannelSessionService } from '../../src/brain/channels.js';
import { channelSessionId } from '../../src/brain/sessionId.js';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { openDb, type Db } from '../../src/store/db.js';
import { projectEvent, projectUserTurn, rehydrate } from '../../src/brain/persistence.js';

/** A finished-turn PI agent_end event carrying a single assistant reply (what the factory projects). */
const agentEnd = (text: string) => ({ type: 'agent_end', willRetry: false, messages: [{ role: 'assistant', content: text }] });

/** A live channel brain whose PI compaction replaces session.messages with [summary, ...framed tail] —
 *  the tail deliberately carries ephemeral live-prompt framing that must NEVER reach the store. */
function fakeChannel(sessionId: string, events: unknown[]) {
  const brain = {
    sessionId,
    model: 'kimi',
    providerId: 'moonshot',
    thinkingLevel: undefined as string | undefined,
    autoCompactAt: 0.8,
    pluginToolNames: new Set<string>(),
    turnSender: undefined as number | undefined,
    interactedAt: undefined as number | undefined,
    listeners: new Set<(e: unknown) => void>([(e) => events.push(e)]),
    turnContext: () => '',
    session: {
      isStreaming: false,
      __usage: { tokens: 50, contextWindow: 8000, percent: 1 } as { tokens: number; contextWindow: number; percent: number },
      getContextUsage() { return this.__usage; },
      messages: [] as { role?: string; content?: unknown }[],
      prompt: vi.fn(),
      compact: vi.fn(async () => {
        brain.session.messages = [
          { role: 'compactionSummary', summary: 'q1/a1 summarized', tokensBefore: 500 },
          { role: 'user', content: '<user_memories>leak</user_memories>\n\n<context>x</context>\n\ngo' },
          { role: 'assistant', content: 'reply-go' },
        ];
      }),
      getAllTools: () => [] as { name: string }[],
      getActiveToolNames: () => [] as string[],
      setActiveToolsByName: () => {},
    },
  };
  return brain;
}

describe('ChannelSessionService — compaction persistence (survives rehydrate)', () => {
  it('/compact mirrors PI\'s shrunk context into the store (clean tail, older log gone) and fires `compacted`', async () => {
    const db: Db = openDb(':memory:');
    const store = new BrainStore(db);
    const channelId = 'discord-c1';
    const sessionId = channelSessionId(channelId);
    store.createSession({ id: sessionId, userId: 1, model: 'kimi' });
    // A clean pre-compaction channel log (persisted exactly like owner chat).
    projectUserTurn(store, sessionId, 'q1');
    projectEvent(store, sessionId, agentEnd('a1') as never);
    projectUserTurn(store, sessionId, 'go');
    projectEvent(store, sessionId, agentEnd('reply-go') as never);
    expect(store.getMessages(sessionId)).toHaveLength(4);

    const events: unknown[] = [];
    const ch = fakeChannel(sessionId, events);
    const registry = { channelGet: (id: string) => (id === channelId ? ch : undefined), withLock: <K>(_id: string, fn: () => Promise<K>) => fn() };
    const svc = new ChannelSessionService({ registry, store } as never);

    const res = await svc.compact(channelId);

    expect(res?.compacted).toBe(true);
    // Store collapsed to divider + the CLEAN kept tail — the framed live text never landed.
    const rows = store.getMessages(sessionId);
    expect(rows.map((r) => r.role)).toEqual(['compaction', 'user', 'assistant']);
    expect(JSON.parse(rows[1]!.content)).toMatchObject({ content: 'go' });
    expect(JSON.stringify(rows.map((r) => JSON.parse(r.content)))).not.toContain('user_memories');
    // Only the kept tail survives as real turns — the pre-compaction q1/a1 rows are gone (the summary
    // still references them, so assert on the non-divider rows rather than a substring of the whole set).
    expect(rows.filter((r) => r.role !== 'compaction').map((r) => JSON.parse(r.content).content)).toEqual(['go', 'reply-go']);
    // Attached channel clients (web read-only preview) were told to collapse.
    expect(events.some((e) => (e as { type?: string }).type === 'compacted')).toBe(true);

    // The compaction survives a rehydrate (LRU eviction / restart) — the shrunk context comes back, not
    // the full pre-compaction log, so the channel does not immediately re-compact.
    const sm = rehydrate(store, sessionId, process.cwd());
    const ctx = sm.buildSessionContext();
    expect(ctx.messages).toHaveLength(3);
    expect(ctx.messages[0]).toMatchObject({ role: 'compactionSummary', summary: 'q1/a1 summarized' });
  });

  it('auto-compact at the threshold persists the shrunk context (same path as owner chat)', async () => {
    const db: Db = openDb(':memory:');
    const store = new BrainStore(db);
    const registry = new LiveSessionRegistry<ReturnType<typeof fakeChannel>>();
    const channelId = 'discord-c1';
    const sessionId = channelSessionId(channelId);
    store.createSession({ id: sessionId, userId: 1, model: 'kimi', title: 'Chan' }); // titled → titler skipped
    projectUserTurn(store, sessionId, 'q1');
    projectEvent(store, sessionId, agentEnd('a1') as never);

    const events: unknown[] = [];
    const ch = fakeChannel(sessionId, events);
    // The turn fills the window past the 0.8 auto-compact threshold and persists its reply (mirrors the
    // projectEvent wiring the real factory installs on the session).
    ch.session.prompt = vi.fn(async () => {
      ch.session.messages.push({ role: 'assistant', content: 'reply-go' });
      projectEvent(store, sessionId, agentEnd('reply-go') as never);
      ch.session.__usage = { tokens: 7000, contextWindow: 8000, percent: 87 };
    });
    registry.channelTouch(channelId, ch);

    const spawn = vi.fn(); // never called — the live session is reused
    const svc = new ChannelSessionService({ registry, store, spawn, users: { get: () => ({ username: 'o' }) } } as never);

    await svc.send({ channelId, ownerUserId: 1, policy: { allowedProjectIds: 'all' as const, allowedPaths: () => [] } }, 'go');

    expect(ch.session.compact).toHaveBeenCalledOnce(); // threshold crossed → auto-compact fired
    // Persisted the shrunk context: divider + clean tail (go/reply-go); the pre-compaction q1/a1 are gone.
    const rows = store.getMessages(sessionId);
    expect(rows.map((r) => r.role)).toEqual(['compaction', 'user', 'assistant']);
    expect(JSON.parse(rows[1]!.content)).toMatchObject({ content: 'go' });
    expect(JSON.stringify(rows.map((r) => JSON.parse(r.content)))).not.toContain('user_memories');
    expect(rows.filter((r) => r.role !== 'compaction').map((r) => JSON.parse(r.content).content)).toEqual(['go', 'reply-go']);
    expect(events.some((e) => (e as { type?: string }).type === 'compacted')).toBe(true);
  });
});
