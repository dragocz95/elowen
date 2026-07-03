import { describe, it, expect } from 'vitest';
import { HookAuditBuffer, type HookAuditEntry } from '../../src/shared/hookAudit.js';

function entry(over: Partial<HookAuditEntry> = {}): HookAuditEntry {
  return {
    ts: 1,
    plugin: 'p',
    hook: 'brain.turn.beforeSend',
    durationMs: 5,
    outcome: 'ok',
    ...over,
  };
}

describe('HookAuditBuffer', () => {
  it('records and returns entries newest-first via recent()', () => {
    const b = new HookAuditBuffer();
    b.record(entry({ ts: 1 }));
    b.record(entry({ ts: 2 }));
    b.record(entry({ ts: 3 }));
    expect(b.recent().map((e) => e.ts)).toEqual([3, 2, 1]);
  });

  it('evicts the oldest once the cap is exceeded (cap+1 keeps newest)', () => {
    const b = new HookAuditBuffer(3);
    b.record(entry({ ts: 1 }));
    b.record(entry({ ts: 2 }));
    b.record(entry({ ts: 3 }));
    b.record(entry({ ts: 4 }));
    const got = b.recent();
    expect(got.map((e) => e.ts)).toEqual([4, 3, 2]);
    expect(got.some((e) => e.ts === 1)).toBe(false);
  });

  it('clamps a non-positive cap to 1', () => {
    const b = new HookAuditBuffer(0);
    b.record(entry({ ts: 1 }));
    b.record(entry({ ts: 2 }));
    expect(b.recent().map((e) => e.ts)).toEqual([2]);
  });

  it('forPlugin filters by plugin and returns newest-first', () => {
    const b = new HookAuditBuffer();
    b.record(entry({ ts: 1, plugin: 'a' }));
    b.record(entry({ ts: 2, plugin: 'b' }));
    b.record(entry({ ts: 3, plugin: 'a' }));
    b.record(entry({ ts: 4, plugin: 'b' }));
    expect(b.forPlugin('a').map((e) => e.ts)).toEqual([3, 1]);
    expect(b.forPlugin('b').map((e) => e.ts)).toEqual([4, 2]);
    expect(b.forPlugin('missing')).toEqual([]);
  });

  it('recent(limit) bounds the tail to the newest N', () => {
    const b = new HookAuditBuffer();
    for (let i = 1; i <= 5; i++) b.record(entry({ ts: i }));
    expect(b.recent(2).map((e) => e.ts)).toEqual([5, 4]);
    expect(b.recent(100).map((e) => e.ts)).toEqual([5, 4, 3, 2, 1]);
  });

  it('forPlugin(limit) bounds that plugin\'s tail to the newest N', () => {
    const b = new HookAuditBuffer();
    for (let i = 1; i <= 4; i++) b.record(entry({ ts: i, plugin: 'a' }));
    b.record(entry({ ts: 5, plugin: 'b' }));
    expect(b.forPlugin('a', 2).map((e) => e.ts)).toEqual([4, 3]);
  });

  it('preserves outcome and changed fields verbatim', () => {
    const b = new HookAuditBuffer();
    b.record(entry({ ts: 1, outcome: 'rejected' }));
    b.record(entry({ ts: 2, outcome: 'ok', changed: 'turnContext' }));
    b.record(entry({ ts: 3, outcome: 'timeout' }));
    const got = b.recent();
    expect(got[0]).toMatchObject({ ts: 3, outcome: 'timeout' });
    expect(got[1]).toMatchObject({ ts: 2, outcome: 'ok', changed: 'turnContext' });
    expect(got[2]).toMatchObject({ ts: 1, outcome: 'rejected' });
    expect(got[1].changed).toBe('turnContext');
  });
});
