import { describe, it, expect } from 'vitest';
import { WebSocketTicketStore } from '../../src/plugins/wsTickets.js';

describe('WebSocketTicketStore', () => {
  it('spends a ticket on the first redeem attempt, successful or not', () => {
    const store = new WebSocketTicketStore();
    const { ticket } = store.issue({ plugin: 'demo', userId: 7, payload: { sessionId: 'a' } });
    expect(store.redeem(ticket)).toMatchObject({ plugin: 'demo', userId: 7, payload: { sessionId: 'a' } });
    // A ticket in a URL can end up in a referrer or a proxy log; a second use must be worthless.
    expect(store.redeem(ticket)).toBeUndefined();
  });

  it('refuses an expired ticket and still consumes it', () => {
    const store = new WebSocketTicketStore();
    const { ticket } = store.issue({ plugin: 'demo', userId: 1, ttlMs: 0 });
    expect(store.redeem(ticket)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('caps the TTL at five minutes so a ticket is never a long-lived credential in a URL', () => {
    const store = new WebSocketTicketStore();
    const before = Date.now();
    const { expiresAt } = store.issue({ plugin: 'demo', userId: 1, ttlMs: 60 * 60_000 });
    expect(expiresAt - before).toBeLessThanOrEqual(5 * 60_000);
  });

  it('defaults to a 30-second TTL', () => {
    const store = new WebSocketTicketStore();
    const before = Date.now();
    const { expiresAt } = store.issue({ plugin: 'demo', userId: 1 });
    expect(expiresAt - before).toBeGreaterThan(25_000);
    expect(expiresAt - before).toBeLessThanOrEqual(30_000);
  });

  it('stays bounded, dropping the oldest ticket rather than the daemon', () => {
    const store = new WebSocketTicketStore();
    const first = store.issue({ plugin: 'demo', userId: 1, ttlMs: 60_000 }).ticket;
    for (let i = 0; i < 1000; i++) store.issue({ plugin: 'demo', userId: 1, ttlMs: 60_000 });
    expect(store.size).toBeLessThanOrEqual(1000);
    expect(store.redeem(first)).toBeUndefined();
  });
});
