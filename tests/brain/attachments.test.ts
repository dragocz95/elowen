import { describe, expect, it, vi } from 'vitest';
import { ClientAttachments } from '../../src/brain/service/attachments.js';

describe('ClientAttachments stable client grace cache', () => {
  it('bounds only detached identities while never evicting a live transport', () => {
    let now = 0;
    const attachments = new ClientAttachments({ maxDetached: 2, detachedTtlMs: 100, now: () => now });
    const listener = () => {};
    const live = () => {};
    const attachThenDrop = (clientId: string, fn: () => void): void => {
      attachments.attach(1, `brain-${clientId}`, fn, vi.fn(), clientId);
      attachments.detachTransport(fn);
      now += 1;
    };

    attachments.attach(1, 'brain-live', live, vi.fn(), 'live');
    attachThenDrop('a', listener);
    attachThenDrop('b', () => {});
    attachThenDrop('c', () => {});

    expect(attachments.release(1, 'a')).toEqual({ accepted: true }); // oldest detached binding hit the cap
    expect(attachments.release(1, 'b')).toEqual({ accepted: true, sessionId: 'brain-b' });
    expect(attachments.release(1, 'c')).toEqual({ accepted: true, sessionId: 'brain-c' });
    expect(attachments.release(1, 'live')).toEqual({ accepted: true, sessionId: 'brain-live' }); // active bindings are never pruned
  });

  it('expires a detached binding after the grace TTL', () => {
    let now = 0;
    const attachments = new ClientAttachments({ maxDetached: 10, detachedTtlMs: 50, now: () => now });
    const listener = () => {};
    attachments.attach(1, 'brain-a', listener, vi.fn(), 'a');
    attachments.detachTransport(listener);
    now = 50;
    expect(attachments.release(1, 'a')).toEqual({ accepted: true });
  });

  it('rejects a stale SSE generation after a newer start claimed another session', () => {
    const attachments = new ClientAttachments();
    const oldListener = () => {};
    attachments.claim(1, 'cli-a', 'brain-A', 1);
    expect(attachments.attach(1, 'brain-A', oldListener, () => attachments.detachTransport(oldListener), 'cli-a', 1)).toBe(true);
    attachments.claim(1, 'cli-a', 'brain-B', 2);

    const staleListener = () => {};
    expect(attachments.attach(1, 'brain-A', staleListener, () => {}, 'cli-a', 1)).toBe(false);
    expect(attachments.attachedCount('brain-A')).toBe(0);
    expect(attachments.attachedCount('brain-B')).toBe(0); // B is claimed but its replacement SSE is not open yet
    expect(attachments.release(1, 'cli-a')).toEqual({ accepted: true, sessionId: 'brain-B' });
  });

  it('keeps a generation tombstone after stop so delayed starts and sends cannot resurrect it', () => {
    const attachments = new ClientAttachments();
    attachments.claim(1, 'cli-a', 'brain-A', 2);
    expect(attachments.release(1, 'cli-a', 2)).toEqual({ accepted: true, sessionId: 'brain-A' });

    expect(attachments.claim(1, 'cli-a', 'brain-old', 1)).toMatchObject({ accepted: false, closed: true });
    expect(attachments.claim(1, 'cli-a', 'brain-A', 2)).toMatchObject({ accepted: false, closed: true });
    expect(attachments.authorizeRequest(1, 'cli-a', 'brain-A', 2)).toBe(false);

    // A genuinely new start generation is the only operation allowed to reopen this stable identity.
    expect(attachments.claim(1, 'cli-a', 'brain-B', 3)).toMatchObject({ accepted: true, sessionId: 'brain-B' });
    expect(attachments.authorizeRequest(1, 'cli-a', 'brain-B', 3)).toBe(true);
  });

  it('records stop-before-start and failed-start generations without retaining them as current targets', () => {
    const attachments = new ClientAttachments();
    expect(attachments.release(1, 'cli-a', 4)).toEqual({ accepted: true });
    expect(attachments.claim(1, 'cli-a', 'brain-late', 4)).toMatchObject({ accepted: false, closed: true });

    const next = attachments.claim(1, 'cli-a', 'brain-next', 5);
    expect(next.accepted).toBe(true);
    attachments.cancelClaim(1, 'cli-a', next.generation);
    expect(attachments.claimedSession(1, 'cli-a')).toBeUndefined();
    expect(attachments.release(1, 'cli-a', 5)).toEqual({ accepted: true }); // stop still cleans fallback
    expect(attachments.claim(1, 'cli-a', 'brain-next', 5)).toMatchObject({ accepted: false, closed: true });
    expect(attachments.claim(1, 'cli-a', 'brain-newest', 6).accepted).toBe(true);
  });

  it('ignores an older stop and reserves a default-start candidate only until its SSE has attached', () => {
    const attachments = new ClientAttachments();
    attachments.claim(1, 'cli-a', 'brain-A', 2);
    expect(attachments.availableForDefaultStart('brain-A')).toBe(false);
    expect(attachments.release(1, 'cli-a', 1)).toEqual({ accepted: false });
    expect(attachments.claimedSession(1, 'cli-a')).toBe('brain-A');

    const listener = () => {};
    attachments.attach(1, 'brain-A', listener, () => attachments.detachTransport(listener), 'cli-a', 2);
    expect(attachments.availableForDefaultStart('brain-A')).toBe(false); // live SSE holds it
    attachments.detachTransport(listener);
    expect(attachments.availableForDefaultStart('brain-A')).toBe(true); // grace identity alone does not
  });
});
