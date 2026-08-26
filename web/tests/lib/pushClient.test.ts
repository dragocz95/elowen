import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { actionToRequest, isPushSupported, enablePush, disablePush } from '../../lib/pushClient';

describe('actionToRequest', () => {
  it('opens the authenticated deep-link for every action without calling a retired API', () => {
    expect(actionToRequest('approve', { url: '/chat' })).toEqual({ kind: 'open', url: '/chat' });
    expect(actionToRequest('rerun', {})).toEqual({ kind: 'open', url: '/' });
    expect(actionToRequest('open', { url: 'https://github.com/example/repo/pull/1' }))
      .toEqual({ kind: 'open', url: 'https://github.com/example/repo/pull/1' });
  });
});

describe('isPushSupported', () => {
  it('is false when the APIs are missing (jsdom default)', () => {
    expect(isPushSupported()).toBe(false);
  });
});

// A valid VAPID public key (base64url) so urlBase64ToUint8Array can decode it.
const VAPID = 'BEzQXl5tQ0lT2cQbJ8K3oJ7t6r0Yy1pXn8xqZ9aQ0V3oQ2y5h7gK1p9aZ8xqJ7t6r0Yy1pXn8xqZ9aQ0V3oQ2y5h7g';

describe('enablePush / disablePush', () => {
  const subscribe = vi.fn();
  const unsubscribe = vi.fn();
  const requests: { url: string; body: unknown }[] = [];
  const server = setupServer(
    http.get('*/api/push/vapid-public-key', () => HttpResponse.json({ publicKey: VAPID })),
    http.post('*/api/push/subscribe', async ({ request }) => { requests.push({ url: '/subscribe', body: await request.json() }); return HttpResponse.json({ ok: true }, { status: 201 }); }),
    http.post('*/api/push/unsubscribe', async ({ request }) => { requests.push({ url: '/unsubscribe', body: await request.json() }); return HttpResponse.json({ ok: true }); }),
  );
  beforeAll(() => {
    server.listen();
    const fakeSub = { endpoint: 'https://push/abc', toJSON: () => ({ endpoint: 'https://push/abc', keys: { p256dh: 'p', auth: 'a' } }), unsubscribe };
    const reg = { pushManager: { subscribe: subscribe.mockResolvedValue(fakeSub), getSubscription: vi.fn().mockResolvedValue(fakeSub) } };
    vi.stubGlobal('navigator', { serviceWorker: { register: vi.fn().mockResolvedValue(reg), getRegistration: vi.fn().mockResolvedValue(reg) } });
    vi.stubGlobal('PushManager', class {});
    vi.stubGlobal('Notification', { requestPermission: vi.fn().mockResolvedValue('granted') });
    unsubscribe.mockResolvedValue(true);
  });
  afterEach(() => { requests.length = 0; server.resetHandlers(); });
  afterAll(() => { server.close(); vi.unstubAllGlobals(); });

  it('enablePush subscribes and POSTs the subscription to the daemon', async () => {
    const result = await enablePush();
    expect(result).toBe('granted');
    expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    expect(requests).toEqual([{ url: '/subscribe', body: { endpoint: 'https://push/abc', keys: { p256dh: 'p', auth: 'a' } } }]);
  });

  it('disablePush unsubscribes and POSTs the endpoint', async () => {
    await disablePush();
    expect(unsubscribe).toHaveBeenCalled();
    expect(requests).toEqual([{ url: '/unsubscribe', body: { endpoint: 'https://push/abc' } }]);
  });
});
