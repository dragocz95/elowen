import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventBus } from '../../src/api/sse.js';

afterEach(() => vi.restoreAllMocks());

describe('EventBus', () => {
  it('fans out published events and unsubscribes', () => {
    const bus = new EventBus();
    const got: unknown[] = [];
    const off = bus.subscribe((event) => got.push(event));
    bus.publish({ type: 'plugin', plugin: 'demo', kind: 'first', projectId: null, data: null });
    off();
    bus.publish({ type: 'plugin', plugin: 'demo', kind: 'second', projectId: null, data: null });
    expect(got).toEqual([{ type: 'plugin', plugin: 'demo', kind: 'first', projectId: null, data: null }]);
  });

  it('isolates a throwing subscriber so the rest still receive the event', () => {
    const bus = new EventBus();
    const got: unknown[] = [];
    bus.subscribe(() => { throw new Error('boom'); });
    bus.subscribe((event) => got.push(event));
    const event = { type: 'plugins' } as const;
    expect(() => bus.publish(event)).not.toThrow();
    expect(got).toEqual([event]);
  });
});
