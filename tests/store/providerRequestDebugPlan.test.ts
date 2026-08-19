import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { ProviderRequestStore } from '../../src/store/providerRequestStore.js';

function plansOf(run: (store: ProviderRequestStore) => void): string[] {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES (7, 'admin', 'x')").run();
  const brain = new BrainStore(db);
  brain.createSession({ id: 's1', userId: 7, model: 'model', provider: 'provider' });
  const attempt = brain.providerRequests.start({
    sessionId: 's1', turnId: 'turn-1', kind: 'chat', configuredProvider: 'provider',
    wireProvider: 'wire', api: 'api', model: 'model', payload: { messages: [{ role: 'user', content: 'hello' }] },
  });
  brain.providerRequests.finish({ requestId: attempt.requestId, status: 'succeeded' });

  const plans: string[] = [];
  const original = db.prepare.bind(db);
  (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
    const statement = original(sql);
    if (!/^\s*SELECT/i.test(sql)) return statement;
    const explain = original(`EXPLAIN QUERY PLAN ${sql}`);
    return new Proxy(statement, {
      get(target, property, receiver) {
        if (property !== 'all' && property !== 'get') return Reflect.get(target, property, receiver);
        return (...params: unknown[]) => {
          plans.push(...(explain.all(...params) as { detail: string }[]).map((row) => row.detail));
          return (target[property] as (...args: unknown[]) => unknown)(...params);
        };
      },
    });
  }) as typeof db.prepare;
  run(brain.providerRequests);
  return plans;
}

describe('provider request debug query plans', () => {
  it('lists sessions from session/summary indexes without scanning or extracting brain_messages', () => {
    const plan = plansOf((store) => { store.debugSessions({ limit: 20, status: 'succeeded' }); }).join('\n');
    expect(plan).not.toMatch(/brain_messages/i);
    expect(plan).not.toMatch(/json_extract/i);
    expect(plan).toMatch(/idx_brain_sessions_debug_updated/i);
    expect(plan).not.toMatch(/SCAN s(?! USING INDEX idx_brain_sessions_debug_updated)/i);
    expect(plan).not.toMatch(/USE TEMP B-TREE FOR ORDER BY/i);
    expect(plan).toMatch(/idx_brain_provider_requests_session_status/i);
  });

  it('lists requests through the session sequence index without touching brain_messages', () => {
    const plan = plansOf((store) => { store.debugRequests('s1', { limit: 20 }); }).join('\n');
    expect(plan).not.toMatch(/brain_messages/i);
    expect(plan).not.toMatch(/json_extract/i);
    expect(plan).toMatch(/idx_brain_provider_requests_session_seq/i);
  });
});
