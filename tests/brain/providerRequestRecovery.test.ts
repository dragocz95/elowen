import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { ProviderRequestRecorder } from '../../src/brain/session/providerRequestRecorder.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { openDb } from '../../src/store/db.js';
import { setLogSink, type LogLevel } from '../../src/shared/logger.js';

const model = { provider: 'p', api: 'a', id: 'm' } as Model<Api>;
afterEach(() => { vi.restoreAllMocks(); setLogSink(undefined); });

function fixture() {
  const db = openDb(':memory:');
  const brain = new BrainStore(db);
  brain.createSession({ id: 's1', userId: 1, model: 'm' });
  brain.createSession({ id: 's2', userId: 1, model: 'm' });
  const store = brain.providerRequests;
  const recorder = () => new ProviderRequestRecorder({ store, sessionId: 's1', configuredProvider: 'p', enabled: () => true });
  return { db, store, recorder };
}

describe('provider capture recovery after failed closure', () => {
  it.each(['same recorder', 'rehydrated recorder'])('heals an orphan on the next turn using %s', (mode) => {
    const { db, store, recorder } = fixture();
    try {
      const first = recorder();
      const id = first.startRemoteCompaction(model, { input: 'first' })!;
      const sibling = store.start({ sessionId: 's2', turnId: '1', kind: 'chat', configuredProvider: 'p', wireProvider: 'p', api: 'a', model: 'm', payload: {} });
      const failure = vi.spyOn(store, 'finish').mockImplementation(() => {
        throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY_SNAPSHOT' });
      });
      expect(() => first.finishRemoteCompaction(id, { response: 'done' })).not.toThrow();
      expect(store.row(id)?.status).toBe('pending');
      failure.mockRestore();
      const logs: { level: LogLevel; message: string }[] = [];
      setLogSink({ push: (entry) => { if (entry.scope === 'provider-request-recorder') logs.push(entry); } });
      const next = mode === 'same recorder' ? first : recorder();
      next.observe({ type: 'agent_start' });
      const nextId = next.startRemoteCompaction(model, { input: 'second' });
      expect(nextId).toBeTypeOf('string');
      expect(nextId).not.toBe(id);
      next.finishRemoteCompaction(nextId!, { response: 'ok' });
      expect(store.row(id)).toMatchObject({ status: 'interrupted', error_code: 'capture_failed' });
      expect(store.row(nextId!)).toMatchObject({ status: 'succeeded', seq: 2, retry_of: null });
      expect(store.row(sibling.requestId)?.status).toBe('pending');
      expect(logs.some((entry) => entry.level === 'warn' && entry.message.includes(id))).toBe(true);
      expect(logs.some((entry) => entry.level === 'error')).toBe(false);
      expect(db.prepare("SELECT request_count, error_count FROM brain_request_session_summary WHERE session_id = 's1'").get())
        .toEqual({ request_count: 2, error_count: 1 });
    } finally { db.close(); }
  });

  it('heals ordinary chat captures without changing the provider payload or terminal message', async () => {
    const { db, store, recorder } = fixture();
    try {
      const live = recorder();
      const payload = { messages: [{ role: 'user', content: 'hello' }] };
      const answer: AssistantMessage = {
        role: 'assistant', content: [{ type: 'text', text: 'done' }], api: model.api, provider: model.provider,
        model: model.id, stopReason: 'stop', timestamp: Date.now(),
        usage: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const streamSimple: ModelRuntime['streamSimple'] = (_model, _context, options) => {
        const out = createAssistantMessageEventStream();
        void (async () => {
          try {
            expect(await options?.onPayload?.(payload, model)).toEqual(payload);
            await options?.onResponse?.({ status: 200, headers: {} }, model);
            out.push({ type: 'done', reason: 'stop', message: answer });
          } finally { out.end(); }
        })();
        return out;
      };
      const runtime = live.wrapRuntime({ streamSimple } as ModelRuntime);
      const turn = async () => {
        live.observe({ type: 'agent_start' });
        const events = [];
        for await (const event of runtime.streamSimple(model, { messages: [] }, {})) events.push(event);
        expect(events).toEqual([{ type: 'done', reason: 'stop', message: answer }]);
        live.observe({ type: 'message_end', message: answer });
      };
      const failure = vi.spyOn(store, 'finish').mockImplementation(() => {
        throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
      });
      await turn();
      expect(store.rows('s1').map((row) => row.status)).toEqual(['pending']);
      failure.mockRestore();
      await turn();
      expect(store.rows('s1').map((row) => row.status)).toEqual(['interrupted', 'succeeded']);
    } finally { db.close(); }
  });

  it('keeps capture errors nonfatal and includes the SQLite code in diagnostics', () => {
    const { db, store, recorder } = fixture();
    try {
      const logs: string[] = [];
      setLogSink({ push: (entry) => logs.push(entry.message) });
      vi.spyOn(store, 'start').mockImplementation(() => {
        throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
      });
      expect(recorder().startRemoteCompaction(model, {})).toBeUndefined();
      expect(logs.some((line) => line.includes('SQLITE_BUSY'))).toBe(true);
    } finally { db.close(); }
  });
});
