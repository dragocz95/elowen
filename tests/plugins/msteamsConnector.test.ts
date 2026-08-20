// ConnectorClient.download must reject an oversized Teams attachment WITHOUT buffering it into memory
// first — a declared Content-Length over the cap should short-circuit before any body byte is read, and
// even without a (trustworthy) Content-Length the body must be streamed with a hard running-byte abort
// rather than pulled whole via `res.arrayBuffer()`.
import { describe, it, expect, afterEach } from 'vitest';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const log = { info() {}, warn() {}, error() {} };

async function loadConnector() {
  const { ConnectorClient } = await import(join(repoRoot, 'plugins/msteams/lib/connector.mjs')) as {
    ConnectorClient: new (cfg: Record<string, unknown>, logger: typeof log) => {
      download: (url: string, maxBytes: number) => Promise<Buffer>;
      addReaction: (serviceUrl: string, conversationId: string, activityId: string, reactionType: string) => Promise<void>;
      deleteReaction: (serviceUrl: string, conversationId: string, activityId: string, reactionType: string) => Promise<void>;
      token: () => Promise<string>;
    };
  };
  const client = new ConnectorClient({ appId: 'a', appPassword: 'b', tenantId: 't' }, log);
  Object.assign(client, { token: async () => 'tok' });
  return client;
}

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('ConnectorClient message reactions', () => {
  it('honors Retry-After seconds and dates with an exponential fallback and cap', async () => {
    const { retryAfterMs } = await import(join(repoRoot, 'plugins/msteams/lib/connector.mjs')) as {
      retryAfterMs: (value: string | null, attempt?: number, now?: number) => number;
    };
    const now = Date.parse('2026-08-19T12:00:00Z');
    expect(retryAfterMs('2', 0, now)).toBe(2000);
    expect(retryAfterMs('Wed, 19 Aug 2026 12:00:07 GMT', 0, now)).toBe(7000);
    expect(retryAfterMs(null, 2, now)).toBe(4000);
    expect(retryAfterMs('60', 0, now)).toBe(15_000);
  });

  it('adds and removes the bot reaction through the official Connector routes', async () => {
    const client = await loadConnector();
    const calls: { url: string; method: string; body?: unknown }[] = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), method: String(init?.method), body: init?.body });
      return { ok: true, status: 204, headers: { get: () => null }, text: async () => '' };
    }) as unknown as typeof fetch;

    await client.addReaction('https://smba.example.test/', 'a:conv/1', 'activity/1', '1f440_eyes');
    await client.deleteReaction('https://smba.example.test/', 'a:conv/1', 'activity/1', '1f440_eyes');

    expect(calls).toEqual([
      { url: 'https://smba.example.test/v3/conversations/a%3Aconv%2F1/activities/activity%2F1/reactions/1f440_eyes', method: 'PUT', body: undefined },
      { url: 'https://smba.example.test/v3/conversations/a%3Aconv%2F1/activities/activity%2F1/reactions/1f440_eyes', method: 'DELETE', body: undefined },
    ]);
  });
});

describe('ConnectorClient.download size guard', () => {
  it('rejects a declared-oversized attachment without ever reading the body', async () => {
    const client = await loadConnector();
    let arrayBufferCalled = false;
    let cancelCalled = false;
    globalThis.fetch = (async () => ({
      ok: true,
      headers: { get: (h: string) => (h.toLowerCase() === 'content-length' ? '10485760' : null) }, // 10MB
      arrayBuffer: async () => { arrayBufferCalled = true; return new ArrayBuffer(10 * 1024 * 1024); },
      body: { cancel: async () => { cancelCalled = true; } },
    })) as unknown as typeof fetch;

    await expect(client.download('https://x/test.png', 5 * 1024 * 1024)).rejects.toThrow(/exceeds the configured size cap/);
    expect(arrayBufferCalled).toBe(false); // the whole point: no full-body buffering before the check
    expect(cancelCalled).toBe(true);
  });

  it('streams the body and aborts as soon as the running total crosses the cap, without pulling it all', async () => {
    const client = await loadConnector();
    const CHUNK = new Uint8Array(1024 * 1024); // 1MB
    let pulls = 0;
    let cancelled = false;
    const reader = {
      read: async () => {
        pulls++;
        if (pulls > 5) return { done: true, value: undefined };
        return { done: false, value: CHUNK };
      },
      cancel: async () => { cancelled = true; },
      releaseLock: () => {},
    };
    globalThis.fetch = (async () => ({
      ok: true,
      headers: { get: () => null }, // no Content-Length — must fall back to streaming
      arrayBuffer: async () => { throw new Error('arrayBuffer should not be used on the streaming path'); },
      body: { getReader: () => reader },
    })) as unknown as typeof fetch;

    await expect(client.download('https://x/test.png', 2 * 1024 * 1024)).rejects.toThrow(/exceeds the configured size cap/);
    expect(cancelled).toBe(true);
    // Cap is 2MB (2 chunks); the read loop must stop right after crossing it, not after all 5 chunks.
    expect(pulls).toBeLessThanOrEqual(3);
  });

  it('still returns the buffer for an attachment within the cap', async () => {
    const client = await loadConnector();
    const CHUNK = new Uint8Array(10);
    let calls = 0;
    const reader = {
      read: async () => (calls++ === 0 ? { done: false, value: CHUNK } : { done: true, value: undefined }),
      cancel: async () => {},
      releaseLock: () => {},
    };
    globalThis.fetch = (async () => ({
      ok: true,
      headers: { get: () => null },
      body: { getReader: () => reader },
    })) as unknown as typeof fetch;

    const buf = await client.download('https://x/test.png', 1024);
    expect(buf.byteLength).toBe(10);
  });
});

/** A consented file goes to a one-shot pre-authenticated URL. `fetch` rejecting there means the bytes
 *  never reached the service, which is both worth retrying and worth naming: the bare "fetch failed"
 *  undici throws hid the reason (DNS, TLS, reset) and made a dropped connection look like a refusal. */
describe('ConnectorClient.upload transport failures', () => {
  async function uploader(logger = log) {
    const { ConnectorClient } = await import(join(repoRoot, 'plugins/msteams/lib/connector.mjs')) as {
      ConnectorClient: new (cfg: Record<string, unknown>, logger: typeof log) => {
        upload: (url: string, data: Buffer) => Promise<void>;
        token: () => Promise<string>;
      };
    };
    const client = new ConnectorClient({ appId: 'a', appPassword: 'b', tenantId: 't' }, logger);
    Object.assign(client, { token: async () => 'tok' });
    return client;
  }

  it('retries once when the connection never reached the service, then succeeds', async () => {
    const client = await uploader();
    let calls = 0;
    globalThis.fetch = (async () => {
      if (++calls === 1) {
        const err = new Error('fetch failed');
        (err as Error & { cause?: unknown }).cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
        throw err;
      }
      return { ok: true, status: 201, text: async () => '' };
    }) as unknown as typeof fetch;

    await client.upload('https://chettyai-my.sharepoint.com/personal/x/upload', Buffer.alloc(8));
    expect(calls).toBe(2);
  });

  /** `content-length` is a forbidden request header the runtime derives from the body. Sending it by hand
   *  made undici reject every consented upload with `invalid content-length header` before any byte left
   *  the process — invisible to a plain `node` probe, because the daemon wraps global fetch. */
  it('lets the runtime set content-length instead of declaring it', async () => {
    const client = await uploader();
    let sent: Record<string, string> = {};
    globalThis.fetch = (async (_url: string, init: { headers: Record<string, string> }) => {
      sent = init.headers;
      return { ok: true, status: 201, text: async () => '' };
    }) as unknown as typeof fetch;

    await client.upload('https://x/upload', Buffer.alloc(64));
    expect(Object.keys(sent).map((k) => k.toLowerCase())).not.toContain('content-length');
    expect(sent['content-range']).toBe('bytes 0-63/64'); // the range Teams does require stays
  });

  it('never resends after an HTTP rejection — the service already took the bytes', async () => {
    const client = await uploader();
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return { ok: false, status: 409, text: async () => 'conflict' }; }) as unknown as typeof fetch;

    await expect(client.upload('https://x/upload', Buffer.alloc(4))).rejects.toThrow(/409/);
    expect(calls).toBe(1);
  });

  it('names the host and the unwound cause instead of a bare "fetch failed"', async () => {
    const warnings: string[] = [];
    const client = await uploader({ info() {}, warn: (m: string) => { warnings.push(m); }, error() {} } as unknown as typeof log);
    globalThis.fetch = (async () => {
      const err = new Error('fetch failed');
      (err as Error & { cause?: unknown }).cause = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
      throw err;
    }) as unknown as typeof fetch;

    const failure = await client.upload('https://chettyai-my.sharepoint.com/personal/x/upload', Buffer.alloc(16)).catch((e: Error & { uploadDetail?: string }) => e);
    expect(failure.uploadDetail).toContain('chettyai-my.sharepoint.com');
    expect(failure.uploadDetail).toContain('ENOTFOUND'); // the cause undici buries
    expect(failure.uploadDetail).toContain("16B");
    expect(warnings.join(' ')).toContain('retrying'); // the retry is visible, not silent
    expect(failure.uploadDetail).not.toContain('/personal/x/upload'); // the one-shot URL stays out of the log
  });
});
