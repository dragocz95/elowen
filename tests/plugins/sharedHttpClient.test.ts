import { describe, it, expect, vi } from 'vitest';
// @ts-expect-error — plain ESM shared helper, no type declarations (same as the other plugins/_shared modules)
import { createHttpClient, HttpError } from '../../plugins/_shared/httpClient.mjs';

type FetchCall = { url: string; init: RequestInit };

/** A fetch stub that answers from a scripted queue and records what it was asked for. */
function stubFetch(script: (call: number, init: RequestInit) => Response | Promise<Response> | Error) {
  const calls: FetchCall[] = [];
  const impl = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const answer = await script(calls.length, init);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { impl, calls };
}

/** A response that arrives after `ms` unless the request's signal fires first — which is what a real
 *  fetch does, and the only way a timeout test can observe anything. */
const slowly = (ms: number, init: RequestInit, res: Response) => new Promise<Response>((resolve, reject) => {
  const timer = setTimeout(() => resolve(res), ms);
  init.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal!.reason ?? new Error('aborted')); }, { once: true });
});

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('shared plugin HTTP client', () => {
  it('joins the base url, serializes the query and parses a JSON answer', async () => {
    const { impl, calls } = stubFetch(() => json({ id: 7 }));
    const api = createHttpClient({ baseUrl: 'https://api.example.com/v1/', headers: { authorization: 'Bearer t' }, fetchImpl: impl });
    const res = await api.get('/contacts', { query: { q: 'ann', tag: ['a', 'b'], skip: undefined } });
    expect(res.data).toEqual({ id: 7 });
    expect(calls[0]!.url).toBe('https://api.example.com/v1/contacts?q=ann&tag=a&tag=b');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer t');
  });

  it('reports an invalid JSON body as an error instead of throwing from the parser', async () => {
    const { impl } = stubFetch(() => new Response('{not json', { status: 200, headers: { 'content-type': 'application/json' } }));
    const api = createHttpClient({ fetchImpl: impl });
    const res = await api.get('https://x.test/');
    // The caller still learns the request succeeded AND gets the raw text to look at.
    expect(res.data).toBeUndefined();
    expect(res.text).toBe('{not json');
  });

  it('turns a failure into data: status, parsed body and a readable message', async () => {
    const { impl } = stubFetch(() => json({ error: 'no such contact' }, 404));
    const api = createHttpClient({ fetchImpl: impl });
    const err = await api.get('https://x.test/c/1').catch((e: unknown) => e) as HttpError;
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(404);
    expect(err.data).toEqual({ error: 'no such contact' });
    expect(err.message).toContain('404');
  });

  it('does not repeat a write, and does repeat an idempotent read', async () => {
    const post = stubFetch(() => json({ error: 'busy' }, 503));
    const postApi = createHttpClient({ fetchImpl: post.impl, maxRetries: 3, maxBackoffMs: 1 });
    await postApi.post('https://x.test/orders', { total: 10 }).catch(() => undefined);
    // A retried POST is a second order. One attempt, always.
    expect(post.calls).toHaveLength(1);

    const get = stubFetch((n) => (n < 3 ? json({ error: 'busy' }, 503) : json({ ok: true })));
    const getApi = createHttpClient({ fetchImpl: get.impl, maxRetries: 3, maxBackoffMs: 1 });
    expect((await getApi.get('https://x.test/orders')).data).toEqual({ ok: true });
    expect(get.calls).toHaveLength(3);
  });

  it('repeats a write only when the caller vouches for it', async () => {
    const { impl, calls } = stubFetch((n) => (n < 2 ? json({}, 503) : json({ ok: true })));
    const api = createHttpClient({ fetchImpl: impl, maxRetries: 3, maxBackoffMs: 1 });
    await api.post('https://x.test/search', { q: 'a' }, { retry: true });
    expect(calls).toHaveLength(2);
  });

  it('gives up immediately on a status that repeating cannot fix', async () => {
    const { impl, calls } = stubFetch(() => json({ error: 'bad key' }, 401));
    const api = createHttpClient({ fetchImpl: impl, maxRetries: 3, maxBackoffMs: 1 });
    await api.get('https://x.test/me').catch(() => undefined);
    // Repeating a rejected credential just spends the rate limit on the same answer.
    expect(calls).toHaveLength(1);
  });

  it('waits as long as the server asked, and never longer than its own ceiling', async () => {
    const waits: number[] = [];
    const { impl } = stubFetch((n) => (n < 3 ? json({}, 429, { 'retry-after': n === 1 ? '2' : '3600' }) : json({ ok: true })));
    const api = createHttpClient({
      fetchImpl: impl, maxRetries: 3, maxBackoffMs: 5,
      onRetry: ({ delayMs }: { delayMs: number }) => waits.push(delayMs),
    });
    await api.get('https://x.test/rate');
    // 2 s and an hour both clamp to the 5 ms ceiling here: a far end must not be able to park a turn.
    expect(waits).toEqual([5, 5]);
  });

  it('honours the caller\'s abort instead of finishing its own timeout', async () => {
    const controller = new AbortController();
    const { impl, calls } = stubFetch(async () => { controller.abort(); throw new Error('aborted'); });
    const api = createHttpClient({ fetchImpl: impl, maxRetries: 3, maxBackoffMs: 1 });
    const err = await api.get('https://x.test/slow', { signal: controller.signal }).catch((e: unknown) => e) as HttpError;
    expect(err.aborted).toBe(true);
    // A cancelled tool call must stop, not retry three more times on the user's behalf.
    expect(calls).toHaveLength(1);
  });

  it('reports a cancel that lands during the backoff wait the same way as one during the request', async () => {
    const controller = new AbortController();
    const { impl, calls } = stubFetch(() => json({}, 503));
    const api = createHttpClient({ fetchImpl: impl, maxRetries: 3, maxBackoffMs: 50, onRetry: () => controller.abort() });
    const err = await api.get('https://x.test/slow', { signal: controller.signal }).catch((e: unknown) => e) as HttpError;
    // Not a fourth retryable failure: a caller branching on `aborted` must see the cancel it asked for.
    expect(err).toBeInstanceOf(HttpError);
    expect(err.aborted).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('reports a timeout as a failure with no status, and retries it for a read', async () => {
    const { impl, calls } = stubFetch(async (n, init) => (n < 3 ? slowly(50, init, json({}, 200)) : json({ ok: true })));
    const api = createHttpClient({ fetchImpl: impl, timeoutMs: 5, maxRetries: 3, maxBackoffMs: 1 });
    expect((await api.get('https://x.test/slow')).data).toEqual({ ok: true });
    expect(calls).toHaveLength(3);

    const always = stubFetch(async (_n, init) => slowly(50, init, json({})));
    const slow = createHttpClient({ fetchImpl: always.impl, timeoutMs: 5, maxRetries: 0 });
    const err = await slow.get('https://x.test/slow').catch((e: unknown) => e) as HttpError;
    expect(err.timedOut).toBe(true);
    expect(err.status).toBeNull();
  });

  it('never exceeds its concurrency ceiling, however hard it is pushed', async () => {
    let inFlight = 0;
    let peak = 0;
    const impl = async (): Promise<Response> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return json({ ok: true });
    };
    const api = createHttpClient({ fetchImpl: impl, maxConcurrent: 3 });
    await Promise.all(Array.from({ length: 20 }, (_, i) => api.get(`https://x.test/${i}`)));
    expect(peak).toBe(3);
  });

  it('tells the retry hook the safe facts and nothing that carries a credential', async () => {
    const onRetry = vi.fn();
    const { impl } = stubFetch((n) => (n < 2 ? json({}, 503) : json({ ok: true })));
    const api = createHttpClient({ baseUrl: 'https://x.test', headers: { authorization: 'Bearer secret-token' }, fetchImpl: impl, maxBackoffMs: 1, onRetry });
    await api.get('/thing');
    const reported = onRetry.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(reported).sort()).toEqual(['attempt', 'delayMs', 'method', 'status']);
    expect(JSON.stringify(reported)).not.toContain('secret-token');
  });

  it('passes a multipart body through instead of serializing it into a string', async () => {
    const { impl, calls } = stubFetch(() => json({ ok: true }));
    const api = createHttpClient({ fetchImpl: impl });
    const form = new FormData();
    form.append('file', new Blob(['x']), 'a.ogg');
    await api.post('https://x.test/upload', form);
    // JSON.stringify(FormData) is "{}", which would upload nothing and look like it worked.
    expect(calls[0]!.init.body).toBe(form);
    expect((calls[0]!.init.headers as Record<string, string>)['content-type']).toBeUndefined();
  });

  it('sends a plain object as JSON without the caller spelling it out', async () => {
    const { impl, calls } = stubFetch(() => json({ ok: true }));
    const api = createHttpClient({ fetchImpl: impl });
    await api.post('https://x.test/c', { name: 'Ann' });
    expect(calls[0]!.init.body).toBe('{"name":"Ann"}');
    expect((calls[0]!.init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });
});
