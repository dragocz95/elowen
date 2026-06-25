import webpush from 'web-push';
import type { PushSubscriptionStore, PushSubscriptionRecord } from '../store/pushSubscriptionStore.js';
import type { PushPayload } from './messages.js';
import { logger } from '../shared/logger.js';

const log = logger('push-sender');

/** Delivers one push to one endpoint. Real impl wraps web-push; tests inject a fake. Throws on
 *  failure; a `{statusCode}` of 404/410 signals a dead endpoint to prune. */
export type Deliver = (rec: PushSubscriptionRecord, payload: string) => Promise<void>;

const realDeliver: Deliver = (rec, payload) =>
  webpush.sendNotification({ endpoint: rec.endpoint, keys: { p256dh: rec.p256dh, auth: rec.auth } }, payload).then(() => undefined);

/** Sends web-push notifications to a set of users' devices. Resilient: a failed send is logged and
 *  skipped (never thrown), and a dead endpoint (404/410) is pruned so it isn't retried forever. */
export class PushSender {
  constructor(
    private subs: PushSubscriptionStore,
    private keys: () => { publicKey: string; privateKey: string } | null,
    private deliver: Deliver = realDeliver,
  ) {}

  async sendToUsers(userIds: number[], payload: PushPayload): Promise<void> {
    const keys = this.keys();
    if (!keys) return; // VAPID not configured → no-op (web push simply unavailable)
    // contact is informational only; the daemon has no real address — a mailto is required by spec.
    webpush.setVapidDetails('mailto:push@orca.local', keys.publicKey, keys.privateKey);
    const body = JSON.stringify(payload);
    for (const rec of this.subs.listForUsers(userIds)) {
      try {
        await this.deliver(rec, body);
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) this.subs.remove(rec.endpoint); // gone → prune
        else log.error(`push send failed for endpoint (status ${code ?? '?'})`, e);
      }
    }
  }
}
