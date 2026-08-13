import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { queryInt, readBoundedBody } from '../../src/api/validation.js';

describe('readBoundedBody', () => {
  /** Run one request through a route that reads its body with the given cap. */
  async function read(req: Request, max: number): Promise<{ status: number; length: number | null }> {
    const app = new Hono();
    app.all('/x', async (c) => {
      const buf = await readBoundedBody(c, max);
      return buf === null ? c.json({ over: true }, 413) : c.json({ length: buf.length });
    });
    const res = await app.request(req);
    const body = await res.json() as { length?: number };
    return { status: res.status, length: body.length ?? null };
  }

  it('refuses a body whose declared content-length is over the cap, before reading it', async () => {
    const req = new Request('http://x/x', {
      method: 'POST', body: 'tiny',
      headers: { 'content-length': String(10 * 1024 * 1024) },
    });
    expect(await read(req, 1024)).toEqual({ status: 413, length: null });
  });

  // The case a content-length check alone cannot catch: a CHUNKED body declares no size at all, so
  // without the running total the whole stream lands in memory and the cap bounds only the answer.
  it('refuses a chunked body that crosses the cap while streaming', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 8; i++) controller.enqueue(new Uint8Array(512));
        controller.close();
      },
    });
    const req = new Request('http://x/x', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
    expect(await read(req, 1024)).toEqual({ status: 413, length: null });
  });

  it('reads a body within the cap unchanged, and tolerates no body at all', async () => {
    expect(await read(new Request('http://x/x', { method: 'POST', body: 'hello' }), 1024))
      .toEqual({ status: 200, length: 5 });
    expect(await read(new Request('http://x/x'), 1024)).toEqual({ status: 200, length: 0 });
  });
});

describe('queryInt', () => {
  it('falls back when the param is absent, empty, or non-numeric (never NaN to a store)', () => {
    expect(queryInt(undefined, { fallback: 7 })).toBe(7);
    expect(queryInt('', { fallback: 7 })).toBe(7);
    expect(queryInt('abc', { fallback: 7 })).toBe(7);
    expect(queryInt('abc', { fallback: undefined })).toBeUndefined();
    expect(queryInt(undefined, { fallback: undefined })).toBeUndefined();
  });

  it('floors and clamps a present value to [min, max]', () => {
    expect(queryInt('12.9', { fallback: 0 })).toBe(12);
    expect(queryInt('1000', { min: 1, max: 500, fallback: 30 })).toBe(500);
    expect(queryInt('0', { min: 1, max: 500, fallback: 30 })).toBe(1);
    expect(queryInt('50', { min: 1, max: 500, fallback: 30 })).toBe(50);
    expect(queryInt('-5', { min: 0, fallback: undefined })).toBe(0);
  });
});
