import { describe, it, expect } from 'vitest';
import { EmbeddingService, type ProviderResolver, type EmbeddingConfig } from '../../src/embeddings/embeddingService.js';

/** A configured provider the resolver returns for id 'openai'. */
const resolveProvider: ProviderResolver = (id) =>
  id === 'openai'
    ? { id: 'openai', label: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' }
    : null;

/** Build a fake fetch that asserts the request and returns a canned Response. */
const fakeFetch = (
  handler: (url: string, init: RequestInit) => { status?: number; body: unknown; nonJson?: boolean },
): typeof fetch =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const { status = 200, body, nonJson } = handler(url, init ?? {});
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (nonJson) throw new SyntaxError('Unexpected token < in JSON');
        return body;
      },
    } as Response;
  }) as unknown as typeof fetch;

const cfg = (over: Partial<EmbeddingConfig> = {}): EmbeddingConfig => ({ providerId: 'openai', model: 'text-embedding-3-small', ...over });

describe('EmbeddingService', () => {
  it('embed returns the exact Float32 vector from the response', async () => {
    let seenUrl = '';
    let seenAuth: string | undefined;
    let seenBody: { model?: string; input?: string[] } = {};
    const svc = new EmbeddingService({
      resolveProvider,
      fetchImpl: fakeFetch((url, init) => {
        seenUrl = url;
        seenAuth = (init.headers as Record<string, string>).authorization;
        seenBody = JSON.parse(init.body as string);
        return { body: { data: [{ embedding: [0.1, 0.2, 0.3] }] } };
      }),
    });
    const vec = await svc.embed(cfg(), 'hello');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(Array.from(vec)).toEqual([Math.fround(0.1), Math.fround(0.2), Math.fround(0.3)]);
    expect(seenUrl).toBe('https://api.openai.com/v1/embeddings');
    expect(seenAuth).toBe('Bearer sk-test');
    expect(seenBody).toEqual({ model: 'text-embedding-3-small', input: ['hello'] });
  });

  it('embedBatch maps N inputs -> N vectors in order', async () => {
    const svc = new EmbeddingService({
      resolveProvider,
      fetchImpl: fakeFetch(() => ({
        body: { data: [{ embedding: [1, 1] }, { embedding: [2, 2] }, { embedding: [3, 3] }] },
      })),
    });
    const vecs = await svc.embedBatch(cfg(), ['a', 'b', 'c']);
    expect(vecs).toHaveLength(3);
    expect(Array.from(vecs[0])).toEqual([1, 1]);
    expect(Array.from(vecs[1])).toEqual([2, 2]);
    expect(Array.from(vecs[2])).toEqual([3, 3]);
  });

  it('embedBatch on empty input makes no request and returns []', async () => {
    let called = false;
    const svc = new EmbeddingService({
      resolveProvider,
      fetchImpl: fakeFetch(() => { called = true; return { body: {} }; }),
    });
    expect(await svc.embedBatch(cfg(), [])).toEqual([]);
    expect(called).toBe(false);
  });

  it('forwards dimensions in the request body when set', async () => {
    let seenBody: { dimensions?: number } = {};
    const svc = new EmbeddingService({
      resolveProvider,
      fetchImpl: fakeFetch((_url, init) => {
        seenBody = JSON.parse(init.body as string);
        return { body: { data: [{ embedding: [0, 0, 0, 0] }] } };
      }),
    });
    await svc.embed(cfg({ dimensions: 4 }), 'x');
    expect(seenBody.dimensions).toBe(4);
  });

  it('throws on HTTP 500', async () => {
    const svc = new EmbeddingService({
      resolveProvider,
      fetchImpl: fakeFetch(() => ({ status: 500, body: {} })),
    });
    await expect(svc.embed(cfg(), 'x')).rejects.toThrow(/HTTP 500/);
  });

  it('throws on malformed (non-JSON) body', async () => {
    const svc = new EmbeddingService({
      resolveProvider,
      fetchImpl: fakeFetch(() => ({ body: null, nonJson: true })),
    });
    await expect(svc.embed(cfg(), 'x')).rejects.toThrow(/non-JSON/);
  });

  it('throws when the provider cannot be resolved', async () => {
    const svc = new EmbeddingService({
      resolveProvider,
      fetchImpl: fakeFetch(() => ({ body: { data: [{ embedding: [1] }] } })),
    });
    await expect(svc.embed(cfg({ providerId: 'ghost' }), 'x')).rejects.toThrow(/provider not found/);
  });

  it('throws on dimensions mismatch (wrong-width vector must not reach storage)', async () => {
    const svc = new EmbeddingService({
      resolveProvider,
      fetchImpl: fakeFetch(() => ({ body: { data: [{ embedding: [0.1, 0.2] }] } })),
    });
    await expect(svc.embed(cfg({ dimensions: 3 }), 'x')).rejects.toThrow(/dimension mismatch/);
  });

  it('throws on an empty vector (it would count as embedded but never match anything)', async () => {
    const svc = new EmbeddingService({
      resolveProvider,
      fetchImpl: fakeFetch(() => ({ body: { data: [{ embedding: [] }] } })),
    });
    await expect(svc.embed(cfg(), 'x')).rejects.toThrow(/non-empty finite/);
  });

  it('throws on a non-finite component (NaN/Infinity would poison every score)', async () => {
    const infinite = new EmbeddingService({
      resolveProvider,
      fetchImpl: fakeFetch(() => ({ body: { data: [{ embedding: [1, Number.POSITIVE_INFINITY] }] } })),
    });
    await expect(infinite.embed(cfg(), 'x')).rejects.toThrow(/non-empty finite/);
    const notANumber = new EmbeddingService({
      resolveProvider,
      fetchImpl: fakeFetch(() => ({ body: { data: [{ embedding: [1, Number.NaN] }] } })),
    });
    await expect(notANumber.embed(cfg(), 'x')).rejects.toThrow(/non-empty finite/);
  });

  it('works with a local baseUrl endpoint and no providerId', async () => {
    let seenUrl = '';
    let seenAuth: string | undefined;
    const svc = new EmbeddingService({
      resolveProvider: () => { throw new Error('resolver must not be called for explicit baseUrl'); },
      fetchImpl: fakeFetch((url, init) => {
        seenUrl = url;
        seenAuth = (init.headers as Record<string, string>).authorization;
        return { body: { data: [{ embedding: [9, 9] }] } };
      }),
    });
    const vec = await svc.embed({ baseUrl: 'http://localhost:1234', model: 'nomic-embed', apiKey: 'local-key' }, 'x');
    expect(Array.from(vec)).toEqual([9, 9]);
    expect(seenUrl).toBe('http://localhost:1234/v1/embeddings');
    expect(seenAuth).toBe('Bearer local-key');
  });

  it('local baseUrl without apiKey omits the authorization header', async () => {
    let hasAuth = true;
    const svc = new EmbeddingService({
      resolveProvider,
      fetchImpl: fakeFetch((_url, init) => {
        hasAuth = 'authorization' in (init.headers as Record<string, string>);
        return { body: { data: [{ embedding: [1] }] } };
      }),
    });
    await svc.embed({ baseUrl: 'http://localhost:1234', model: 'm' }, 'x');
    expect(hasAuth).toBe(false);
  });

  // A caller (ToolSearch's 1.5 s semantic budget) must be able to abort a hung request instead of
  // waiting out the 30 s internal cap. The caller's signal has to reach the REQUEST: the stub models a
  // real endpoint by honoring the signal it is handed and never answering on its own, so the only way
  // this resolves is the caller's abort arriving at fetch.
  it('rejects as soon as the caller aborts, even while the endpoint hangs', async () => {
    const controller = new AbortController();
    controller.abort();
    let fetchStarted = false;
    const svc = new EmbeddingService({
      resolveProvider,
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        fetchStarted = true;
        await new Promise<never>((_, reject) => {
          const signal = init?.signal;
          const abort = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
          // A real fetch rejects an already-aborted signal immediately — the `abort` event never
          // fires for one, so the state check comes first.
          if (signal?.aborted) { abort(); return; }
          signal?.addEventListener('abort', abort);
        });
      }) as unknown as typeof fetch,
    });
    await expect(svc.embedBatch(cfg(), ['x'], controller.signal)).rejects.toThrow();
    expect(fetchStarted).toBe(true);
  });
});
