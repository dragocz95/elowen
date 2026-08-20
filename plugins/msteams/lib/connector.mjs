// Bot Connector REST client: outbound auth (Entra client-credentials, cached) + the handful of
// conversation calls the adapter drives. Hand-rolled over global fetch, like the Discord adapter's
// REST layer — the protocol is small and an SDK would bring its own middleware model.
import { TokenSource } from './token.mjs';

const SCOPE = 'https://api.botframework.com/.default';

/** Retry pause on a 429, capped so a stuck rate limit can't wedge a turn. */
const MAX_RETRY_AFTER_MS = 15_000;

export function retryAfterMs(value, attempt = 0, now = Date.now()) {
  const seconds = Number(value);
  const requested = Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1000
    : Math.max(Date.parse(String(value ?? '')) - now, 0);
  const fallback = 1000 * (2 ** attempt);
  return Math.min(Math.max(requested || fallback, 1000), MAX_RETRY_AFTER_MS);
}

/** The flag that makes a post visible to one person instead of the whole conversation. */
function targetedQuery(targeted) {
  return targeted ? '?isTargetedActivity=true' : '';
}

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

  /** One connector call against the activity's serviceUrl. 429 waits Retry-After with bounded retries. */
  async call(serviceUrl, method, path, body, attempt = 0, maxRetries = 1) {
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
    if (res.status === 429 && attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, retryAfterMs(res.headers.get('retry-after'), attempt)));
      return this.call(serviceUrl, method, path, body, attempt + 1, maxRetries);
    }
    if (!res.ok) throw new Error(`connector ${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  /** Reply threaded under an inbound activity; returns the new activity id.
   *
   *  `targeted` answers a targeted message PRIVATELY — only the person who sent it sees the reply. It is
   *  a different call, not a different payload: without the query flag the same activity is posted to the
   *  whole channel, which for an answer to a message nobody else could see is a disclosure, not a bug in
   *  formatting. The activity must then carry `recipient`; Teams rejects it with 400 otherwise. */
  async reply(serviceUrl, conversationId, replyToId, activity, targeted = false) {
    const out = await this.call(serviceUrl, 'POST', `/v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(replyToId)}${targetedQuery(targeted)}`, activity);
    return out?.id;
  }

  /** Free-standing message into a conversation; returns the new activity id. */
  async send(serviceUrl, conversationId, activity, targeted = false) {
    const out = await this.call(serviceUrl, 'POST', `/v3/conversations/${encodeURIComponent(conversationId)}/activities${targetedQuery(targeted)}`, activity);
    return out?.id;
  }

  /** Edit a previously sent bot message in place (the live-trace transport). */
  async update(serviceUrl, conversationId, activityId, activity) {
    await this.call(serviceUrl, 'PUT', `/v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}`, activity);
  }

  async remove(serviceUrl, conversationId, activityId) {
    await this.call(serviceUrl, 'DELETE', `/v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}`);
  }

  /** Add a bot-owned reaction to an activity. */
  async addReaction(serviceUrl, conversationId, activityId, reactionType) {
    await this.call(serviceUrl, 'PUT', `/v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}/reactions/${encodeURIComponent(reactionType)}`, undefined, 0, 3);
  }

  /** Remove a bot-owned reaction from an activity. */
  async deleteReaction(serviceUrl, conversationId, activityId, reactionType) {
    await this.call(serviceUrl, 'DELETE', `/v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}/reactions/${encodeURIComponent(reactionType)}`, undefined, 0, 3);
  }

  /** Push the bytes of a consented file to the one-shot URL Teams handed us.
   *
   *  This one deliberately does NOT go through `call`: the upload URL is pre-authenticated, and Microsoft
   *  answers 401 when an Authorization header rides along — so the bot's bearer, correct on every other
   *  call in this client, is the one thing that must not be sent. One request, so the range is the whole
   *  file; splitting into 320 KiB fragments only becomes necessary past 60 MiB, far above our cap. */
  async upload(uploadUrl, data) {
    const url = String(uploadUrl);
    // A bare `fetch failed` says nothing: undici hides the real reason (DNS, TLS, reset, timeout) in the
    // cause chain, so a transport failure was indistinguishable from a refusal. Name the host and unwind
    // that chain — the URL itself never goes to the log, it is a pre-authenticated one-shot credential.
    const host = (() => { try { return new URL(url).host; } catch { return 'invalid-url'; } })();
    const attempt = async () => {
      const started = Date.now();
      try {
        const res = await fetch(url, {
          method: 'PUT',
          headers: {
            // No content-length: it is a forbidden request header, computed from the body. Setting it by
            // hand made undici reject the request before the network with `invalid content-length header`,
            // so every consented file failed instantly. A plain `node` script accepts it — the daemon
            // wraps global fetch (openrouterMeter), and the re-dispatch is where the duplicate is caught.
            'content-type': 'application/octet-stream',
            'content-range': `bytes 0-${data.length - 1}/${data.length}`,
          },
          body: data,
        });
        if (!res.ok) throw new Error(`file upload → ${res.status}: ${(await res.text()).slice(0, 200)}`);
        this.log?.info?.(`msteams file upload ok: ${data.length} B to ${host} in ${Date.now() - started} ms`);
      } catch (error) {
        // Both halves matter: the code says WHICH undici guard fired, the message says WHY. Logging only
        // the code left `UND_ERR_INVALID_ARG` with no hint at which argument was rejected.
        const chain = [];
        for (let e = error; e && chain.length < 4; e = e.cause) {
          chain.push([e.code ?? e.errno, String(e.message ?? '').slice(0, 120)].filter(Boolean).join(': '));
        }
        const body = `${data?.constructor?.name ?? typeof data}/${data?.byteLength ?? data?.length ?? '?'}B`;
        error.uploadDetail = `${host}, body ${body}, url ${url.length} chars, after ${Date.now() - started} ms — ${chain.join(' ← ')}`;
        throw error;
      }
    };
    try {
      await attempt();
    } catch (error) {
      // Retry ONLY a transport failure, never a rejection: an HTTP status means the service saw the bytes
      // and answered, so resending them would upload the file twice. `fetch` throwing means it never got
      // that far, and Teams' upload URL stays valid until it does.
      if (!/^file upload → \d/.test(String(error?.message ?? ''))) {
        this.log?.warn?.(`msteams file upload retrying after transport failure (${error.uploadDetail ?? error?.message})`);
        await attempt();
        return;
      }
      throw error;
    }
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
