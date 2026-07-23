// Bot Connector REST client: outbound auth (Entra client-credentials, cached) + the handful of
// conversation calls the adapter drives. Hand-rolled over global fetch, like the Discord adapter's
// REST layer — the protocol is small and an SDK would bring its own middleware model.
const SCOPE = 'https://api.botframework.com/.default';

/** Retry-once pause on a 429, capped so a stuck rate limit can't wedge a turn. */
const MAX_RETRY_AFTER_MS = 15_000;

export class ConnectorClient {
  constructor(cfg, logger) {
    this.cfg = cfg;
    this.log = logger;
    this.cached = null; // { token, expiresAt }
    this.refreshing = null;
  }

  /** The OAuth token endpoint — tenant-scoped for a single-tenant app registration. The cfg override is
   *  the E2E seam (a fake Bot Framework serves its own token endpoint). */
  tokenUrl() {
    const seam = String(this.cfg.oauthTokenUrl ?? '').trim();
    return seam || `https://login.microsoftonline.com/${encodeURIComponent(String(this.cfg.tenantId ?? ''))}/oauth2/v2.0/token`;
  }

  /** A valid bearer for the connector, refreshed ~60s before expiry; concurrent callers share one refresh. */
  async token() {
    if (this.cached && Date.now() < this.cached.expiresAt - 60_000) return this.cached.token;
    this.refreshing ??= (async () => {
      try {
        const body = new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: String(this.cfg.appId ?? ''),
          client_secret: String(this.cfg.appPassword ?? ''),
          scope: SCOPE,
        });
        const res = await fetch(this.tokenUrl(), {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        });
        if (!res.ok) throw new Error(`token endpoint ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const data = await res.json();
        if (typeof data?.access_token !== 'string') throw new Error('token endpoint returned no access_token');
        const ttlSeconds = Number(data.expires_in) || 3600;
        this.cached = { token: data.access_token, expiresAt: Date.now() + ttlSeconds * 1000 };
        return this.cached.token;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
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

  /** Download an authenticated attachment (Teams file/image URLs on the connector host need our bearer). */
  async download(url, maxBytes) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${await this.token()}` } });
    if (!res.ok) throw new Error(`attachment download → ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (maxBytes && buf.byteLength > maxBytes) throw new Error('attachment exceeds the configured size cap');
    return buf;
  }
}
