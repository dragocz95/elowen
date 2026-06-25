import { describe, it, expect, beforeEach } from 'vitest';
import webpush from 'web-push';
import { openDb } from '../../src/store/db.js';
import { PushSubscriptionStore } from '../../src/store/pushSubscriptionStore.js';
import { PushSender, type Deliver } from '../../src/push/pushSender.js';
import { buildStalled } from '../../src/push/messages.js';

// Real VAPID keys: setVapidDetails validates the key format, so a placeholder wouldn't pass.
const KEYS = webpush.generateVAPIDKeys();
const payload = buildStalled({ missionId: 'm-e1', epicTitle: 'Epic' });

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
    expect(subs.listForUser(1)).toHaveLength(0);
  });

  it('keeps the endpoint on a transient 500', async () => {
    const deliver: Deliver = async () => { throw Object.assign(new Error('boom'), { statusCode: 500 }); };
    await new PushSender(subs, () => KEYS, deliver).sendToUsers([1], payload);
    expect(subs.listForUser(1)).toHaveLength(1);
  });

  it('is a no-op when VAPID keys are not configured', async () => {
    let calls = 0;
    const deliver: Deliver = async () => { calls++; };
    await new PushSender(subs, () => null, deliver).sendToUsers([1], payload);
    expect(calls).toBe(0);
  });
});
