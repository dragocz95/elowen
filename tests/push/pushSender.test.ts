import { describe, it, expect, beforeEach } from 'vitest';
import webpush from 'web-push';
import { openDb } from '../../src/store/db.js';
import { PushSubscriptionStore } from '../../src/store/pushSubscriptionStore.js';
import { PushSender, vapidContact, type Deliver } from '../../src/push/pushSender.js';
import type { PushPayload } from '../../src/push/messages.js';

// Real VAPID keys: setVapidDetails validates the key format, so a placeholder wouldn't pass.
const KEYS = webpush.generateVAPIDKeys();
const payload: PushPayload = { kind: 'stalled', title: 'Mise se zastavila', body: 'Epic čeká na vaši pozornost.', missionId: 'm-e1', actions: [{ action: 'open', title: 'Otevřít' }], url: '/escalations' };

let subs: PushSubscriptionStore;
beforeEach(() => {
  subs = new PushSubscriptionStore(openDb(':memory:'));
  subs.upsert(1, { endpoint: 'https://push/1', keys: { p256dh: 'p', auth: 'a' } });
});

describe('PushSender', () => {
  it('delivers to each of the users\' endpoints', async () => {
    const sent: string[] = [];
    const deliver: Deliver = async (rec) => { sent.push(rec.endpoint); };
    await new PushSender(subs, () => KEYS, deliver).sendToUsers([1], payload);
    expect(sent).toEqual(['https://push/1']);
  });

  it('prunes a dead endpoint on a 410', async () => {
    const deliver: Deliver = async () => { throw Object.assign(new Error('gone'), { statusCode: 410 }); };
    await new PushSender(subs, () => KEYS, deliver).sendToUsers([1], payload);
    expect(subs.listForUsers([1])).toHaveLength(0);
  });

  it('keeps the endpoint on a transient 500', async () => {
    const deliver: Deliver = async () => { throw Object.assign(new Error('boom'), { statusCode: 500 }); };
    await new PushSender(subs, () => KEYS, deliver).sendToUsers([1], payload);
    expect(subs.listForUsers([1])).toHaveLength(1);
  });

  it('is a no-op when VAPID keys are not configured', async () => {
    let calls = 0;
    const deliver: Deliver = async () => { calls++; };
    await new PushSender(subs, () => null, deliver).sendToUsers([1], payload);
    expect(calls).toBe(0);
  });
});


/** The VAPID `sub` claim decides whether a push is delivered at all. Apple validates it and answers
 *  403 BadJwtToken for an address that cannot exist — and because the sender only logs failures, the
 *  shipped `mailto:push@elowen.local` made every Apple push vanish while looking successful. These
 *  assert the address we sign with is always one that could actually be reached. */
describe('vapidContact', () => {
  it('never returns an unreachable address, whatever it is given', () => {
    // The regression itself: `.local` is reserved for mDNS and resolves nowhere on the public internet.
    for (const input of [undefined, '', '   ', 'push@elowen.local', 'not-a-url', 'http://example.com']) {
      const c = vapidContact(input, input);
      expect(c === 'https://github.com/dragocz95/elowen' || c.startsWith('https://') || c.startsWith('mailto:')).toBe(true);
      expect(c).not.toContain('.local');
    }
  });

  it('prefers what the operator configured', () => {
    expect(vapidContact('mailto:ops@example.com', 'https://elowen.example.com')).toBe('mailto:ops@example.com');
    expect(vapidContact('https://status.example.com', 'https://elowen.example.com')).toBe('https://status.example.com');
    expect(vapidContact('  mailto:ops@example.com  ')).toBe('mailto:ops@example.com');
  });

  it('ignores a configured value that is not a usable scheme', () => {
    // A bare email or hostname would be signed verbatim and rejected, so it must not win over the
    // fallback just because someone typed something.
    expect(vapidContact('ops@example.com', 'https://elowen.example.com')).toBe('https://elowen.example.com');
    expect(vapidContact('example.com')).toBe('https://github.com/dragocz95/elowen');
  });

  it('borrows a public instance URL, but never a private one', () => {
    expect(vapidContact(undefined, 'https://elowen.example.com')).toBe('https://elowen.example.com');
    // Each of these is reachable only from inside the network the daemon runs on.
    for (const url of ['https://elowen.local', 'https://box.internal', 'https://localhost', 'https://elowen.localhost', 'http://elowen.example.com']) {
      expect(vapidContact(undefined, url)).toBe('https://github.com/dragocz95/elowen');
    }
  });
});
