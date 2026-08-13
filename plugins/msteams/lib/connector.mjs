// Bot Connector REST client: outbound auth (Entra client-credentials, cached) + the handful of
// conversation calls the adapter drives. Hand-rolled over global fetch, like the Discord adapter's
// REST layer — the protocol is small and an SDK would bring its own middleware model.
import { TokenSource } from './token.mjs';

const SCOPE = 'https://api.botframework.com/.default';

/** Retry-once pause on a 429, capped so a stuck rate limit can't wedge a turn. */
const MAX_RETRY_AFTER_MS = 15_000;

export class ConnectorClient {
  constructor(cfg, logger) {
    this.cfg = cfg;
    this.log = logger;
    // `oauthTokenUrl` is the E2E seam — a fake Bot Framework serves its own token endpoint.
    this.tokens = new TokenSource(cfg, SCOPE, 'oauthTokenUrl');
  }

  /** A valid bearer for the connector audience. */
  async token() {
    return this.tokens.token();
  }

  /** One connector call against the activity's serviceUrl. 429 waits Retry-After once, then rethrows. */
  async call(serviceUrl, method, path, body, attempt = 0) {
    const base = String(serviceUrl ?? '').replace(/\/+$/, '');
    if (!base) throw new Error('connector call without a serviceUrl');
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.token()}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 429 && attempt === 0) {
      const wait = Math.min(Math.max(Number(res.headers.get('retry-after')) || 1, 1) * 1000, MAX_RETRY_AFTER_MS);
      await new Promise((r) => setTimeout(r, wait));
      return this.call(serviceUrl, method, path, body, 1);
    }
    if (!res.ok) throw new Error(`connector ${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  /** Reply threaded under an inbound activity; returns the new activity id. */
  async reply(serviceUrl, conversationId, replyToId, activity) {
    const out = await this.call(serviceUrl, 'POST', `/v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(replyToId)}`, activity);
    return out?.id;
  }

  /** Free-standing message into a conversation; returns the new activity id. */
  async send(serviceUrl, conversationId, activity) {
    const out = await this.call(serviceUrl, 'POST', `/v3/conversations/${encodeURIComponent(conversationId)}/activities`, activity);
    return out?.id;
  }

  /** Edit a previously sent bot message in place (the live-trace transport). */
  async update(serviceUrl, conversationId, activityId, activity) {
    await this.call(serviceUrl, 'PUT', `/v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}`, activity);
  }

  async remove(serviceUrl, conversationId, activityId) {
    await this.call(serviceUrl, 'DELETE', `/v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}`);
  }

  /** The transient "…" indicator Teams shows while the agent works. */
  async typing(serviceUrl, conversationId) {
    await this.call(serviceUrl, 'POST', `/v3/conversations/${encodeURIComponent(conversationId)}/activities`, { type: 'typing' });
  }

  /** Conversation roster — carries each member's UPN/email without any Graph permission. */
  async member(serviceUrl, conversationId, userId) {
    return this.call(serviceUrl, 'GET', `/v3/conversations/${encodeURIComponent(conversationId)}/members/${encodeURIComponent(userId)}`);
  }

  /** The full conversation roster (all members with name/id/UPN). */
  async members(serviceUrl, conversationId) {
    return this.call(serviceUrl, 'GET', `/v3/conversations/${encodeURIComponent(conversationId)}/members`);
  }

  /** Page through the conversations the bot participates in on this service host. */
  async conversations(serviceUrl, continuationToken) {
    const suffix = continuationToken ? `?continuationToken=${encodeURIComponent(continuationToken)}` : '';
    return this.call(serviceUrl, 'GET', `/v3/conversations${suffix}`);
  }

  /** Open (or rejoin) a conversation — Teams returns the existing personal chat for a known user pair.
   *  Returns the conversation id. */
  async createConversation(serviceUrl, payload) {
    const out = await this.call(serviceUrl, 'POST', '/v3/conversations', payload);
    return out?.id;
  }

  /** Download an authenticated attachment (Teams file/image URLs on the connector host need our bearer).
   *  Rejects oversized attachments WITHOUT buffering them into memory first: a declared Content-Length
   *  over the cap is rejected before any body byte is read, and — since Content-Length can be absent or
   *  understated — the body is also streamed with a running counter that aborts the instant the cap is
   *  crossed, instead of via `res.arrayBuffer()` which pulls the whole response before any size check. */
  async download(url, maxBytes) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${await this.token()}` } });
    if (!res.ok) throw new Error(`attachment download → ${res.status}`);
    const declared = Number(res.headers.get('content-length'));
    if (maxBytes && Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel().catch(() => {});
      throw new Error('attachment exceeds the configured size cap');
    }
    if (!maxBytes || !res.body) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (maxBytes && buf.byteLength > maxBytes) throw new Error('attachment exceeds the configured size cap');
      return buf;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error('attachment exceeds the configured size cap');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c)));
  }
}
