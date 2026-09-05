import { describe, expect, it, vi } from 'vitest';
import { ClientAttachments } from '../../src/brain/service/attachments.js';

describe('ClientAttachments client visibility', () => {
  it('separates "attached" from "watching" so a hidden tab still counts as attached', () => {
    const attachments = new ClientAttachments();
    const tab = (): void => {};
    attachments.attach(1, 'brain-s', tab, vi.fn(), 'web-tab');

    expect(attachments.attachedCount('brain-s')).toBe(1);
    expect(attachments.watchingCount('brain-s')).toBe(1);

    expect(attachments.setClientVisibility(1, 'web-tab', true)).toBe(true);
    // The stream is still held — every lifecycle rule keyed on attachment must see no change — but the
    // turn-complete push now knows nobody is reading, which is the whole point.
    expect(attachments.attachedCount('brain-s')).toBe(1);
    expect(attachments.watchingCount('brain-s')).toBe(0);

    expect(attachments.setClientVisibility(1, 'web-tab', false)).toBe(true);
    expect(attachments.watchingCount('brain-s')).toBe(1);
  });

  it('does not let one hidden tab silence a second tab that is watching', () => {
    const attachments = new ClientAttachments();
    const phone = (): void => {};
    const desktop = (): void => {};
    attachments.attach(1, 'brain-s', phone, vi.fn(), 'phone');
    attachments.attach(1, 'brain-s', desktop, vi.fn(), 'desktop');

    attachments.setClientVisibility(1, 'phone', true);
    expect(attachments.watchingCount('brain-s')).toBe(1);
  });

  it('clears the hidden mark on detach, and refuses an id with no live transport', () => {
    const attachments = new ClientAttachments();
    const tab = (): void => {};
    attachments.attach(1, 'brain-s', tab, vi.fn(), 'web-tab');
    attachments.setClientVisibility(1, 'web-tab', true);
    attachments.detachTransport(tab);

    // A reconnect mints a NEW listener; a leftover mark keyed on the dead one would keep the fresh
    // stream looking unwatched forever.
    const reconnected = (): void => {};
    attachments.attach(1, 'brain-s', reconnected, vi.fn(), 'web-tab');
    expect(attachments.watchingCount('brain-s')).toBe(1);

    // Another user's id, and an id nobody holds, must not register anything.
    expect(attachments.setClientVisibility(2, 'web-tab', true)).toBe(false);
    expect(attachments.setClientVisibility(1, 'ghost', true)).toBe(false);
    expect(attachments.watchingCount('brain-s')).toBe(1);
  });
});

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

  // A teardown that counts only LIVE streams disposes the conversation out from under a client that has
  // been handed it and is still opening its SSE. A `--resume` into a running turn is exactly that shape,
  // and it ends with the resumed terminal watching a dead session until some later send respawns it.
  it('reports a claimed-but-not-yet-streaming start as occupancy in its own right', () => {
    const attachments = new ClientAttachments();
    expect(attachments.hasPendingStartClaim('brain-A')).toBe(false);

    attachments.claim(1, 'cli-a', 'brain-A', 2);
    expect(attachments.hasPendingStartClaim('brain-A')).toBe(true);
    expect(attachments.attachedCount('brain-A')).toBe(0); // the gap itself: claimed, nothing streaming yet
    expect(attachments.hasPendingStartClaim('brain-B')).toBe(false); // scoped to the claimed conversation

    const listener = () => {};
    attachments.attach(1, 'brain-A', listener, () => attachments.detachTransport(listener), 'cli-a', 2);
    expect(attachments.hasPendingStartClaim('brain-A')).toBe(false); // the live stream took over the claim
  });
});

// The idle rollover consults this to leave a conversation a CLI still has OPEN alone. Explicit web bindings
// may use stable client ids for attachment identity, but they never pin the CLI rollover policy.
describe('ClientAttachments.hasLiveStableClient', () => {
  it('is true only while an identified client\'s transport is actually attached', () => {
    const attachments = new ClientAttachments();
    const listener = () => {};
    expect(attachments.hasLiveStableClient('brain-A')).toBe(false); // nobody there

    attachments.attach(1, 'brain-A', listener, () => attachments.detachTransport(listener), 'cli-1', 1);
    expect(attachments.hasLiveStableClient('brain-A')).toBe(true);

    // The binding deliberately outlives its socket for a grace TTL (so a racing stop can still resolve it),
    // but a client that has gone away must NOT keep the conversation pinned open.
    attachments.detachTransport(listener);
    expect(attachments.hasLiveStableClient('brain-A')).toBe(false);
  });

  it('an anonymous subscriber (the web dock) never counts — it creates no stable binding', () => {
    const attachments = new ClientAttachments();
    const listener = () => {};
    attachments.attach(1, 'brain-A', listener, vi.fn()); // no clientId — the web's /brain/stream
    expect(attachments.attachedCount('brain-A')).toBe(1); // it IS attached…
    expect(attachments.hasLiveStableClient('brain-A')).toBe(false); // …but it is not a terminal
  });

  it('keeps explicit web and CLI stable bindings on opposite rollover semantics', () => {
    const web = new ClientAttachments();
    const webListener = () => {};
    web.attach(1, 'brain-web', webListener, vi.fn(), 'web-1', 1, 'web');
    expect(web.hasLiveStableClient('brain-web')).toBe(false);

    const cli = new ClientAttachments();
    const cliListener = () => {};
    cli.attach(1, 'brain-cli', cliListener, vi.fn(), 'cli-1', 1, 'cli');
    expect(cli.hasLiveStableClient('brain-cli')).toBe(true);
  });

  it('follows a rolled-over conversation onto its replacement session', () => {
    const attachments = new ClientAttachments();
    const listener = () => {};
    attachments.attach(1, 'brain-old', listener, vi.fn(), 'cli-1', 1);
    attachments.retarget('brain-old', 'brain-new');
    expect(attachments.hasLiveStableClient('brain-old')).toBe(false);
    expect(attachments.hasLiveStableClient('brain-new')).toBe(true);
  });

  it('is scoped to the conversation asked about, not to "any CLI anywhere"', () => {
    const attachments = new ClientAttachments();
    const listener = () => {};
    attachments.attach(1, 'brain-A', listener, vi.fn(), 'cli-1', 1);
    expect(attachments.hasLiveStableClient('brain-B')).toBe(false);
  });
});
