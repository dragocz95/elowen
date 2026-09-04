import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { UsageOriginStore } from '../../src/store/usageOriginStore.js';
import { withOriginUsage } from '../../src/inference/originUsage.js';

const usage = { input: 11, output: 7, cacheRead: 3, cacheWrite: 2, total: 23, cost: 0.035 };

describe('secondary inference origin accounting', () => {
  it('writes usage through usage_by_origin without consuming the current turn pin', async () => {
    const db = openDb(':memory:');
    const origins = new UsageOriginStore(db);
    const origin = { value: '203.0.113.9', kind: 'ip' as const, trusted: true };
    origins.recordRequest('brain-session', 4, origin, Date.UTC(2026, 8, 4));
    const client = withOriginUsage({
      model: 'provider/model',
      decide: async () => ({ text: 'answer', usage }),
    }, {
      origins,
      userId: 4,
      origin: origins.pinnedOrigin('brain-session')!,
      now: () => Date.UTC(2026, 8, 4, 10),
    });

    expect((await client.decide('prompt')).text).toBe('answer');
    expect(origins.pinnedOrigin('brain-session')).toEqual(origin);
    expect(origins.topOrigins({ group: 'pair' })).toMatchObject([{
      userId: 4, origin: '203.0.113.9', turns: 1,
      input: 11, output: 7, cacheRead: 3, cacheWrite: 2, tokens: 23, cost: 0.035,
    }]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage_by_origin'").get()).toBeTruthy();
    db.close();
  });
});
