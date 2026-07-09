import { describe, it, expect } from 'vitest';
import { createMeteredFetch, newCostMeter, runWithMeter } from '../../src/brain/openrouterMeter.js';

/** A streamed OpenRouter-style SSE response: a couple of content deltas, then a final usage frame
 *  carrying the provider-reported `cost` (what pi-ai would otherwise discard), then [DONE]. */
function openRouterStream(cost: number): Response {
  const frames = [
    'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" there"}}]}\n\n',
    `data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"cost":${cost}}}\n\n`,
    'data: [DONE]\n\n',
  ];
  const body = new ReadableStream<Uint8Array>({
    start(c) { const enc = new TextEncoder(); for (const f of frames) c.enqueue(enc.encode(f)); c.close(); },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function drain(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let out = '';
  for (;;) { const { value, done } = await reader.read(); if (done) break; out += dec.decode(value, { stream: true }); }
  return out;
}

describe('createMeteredFetch', () => {
  it('captures OpenRouter usage.cost into the ambient meter and passes the stream through unchanged', async () => {
    let sentBody: unknown;
    const base = (async (_url: never, init?: RequestInit) => { sentBody = init?.body; return openRouterStream(0.0042); }) as unknown as typeof fetch;
    const fetchImpl = createMeteredFetch(base);

    const meter = newCostMeter();
    const text = await runWithMeter(meter, async () => {
      const res = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'x', stream: true }) });
      return drain(res);
    });

    // Reported cost captured, provenance marked USD.
    expect(meter.reported).toBe(true);
    expect(meter.costUsd).toBeCloseTo(0.0042);
    expect(meter.currency).toBe('USD');
    // The SSE bytes reached the consumer untouched (sniff never alters the stream).
    expect(text).toContain('"content":"hi"');
    expect(text).toContain('[DONE]');
    // The request body was rewritten to ask OpenRouter for usage accounting.
    expect(JSON.parse(sentBody as string)).toMatchObject({ usage: { include: true } });
  });

  it('sums cost across multiple completions in one run (tool-call round-trips)', async () => {
    const base = (async () => openRouterStream(0.01)) as unknown as typeof fetch;
    const fetchImpl = createMeteredFetch(base);
    const meter = newCostMeter();
    await runWithMeter(meter, async () => {
      for (let i = 0; i < 3; i++) await drain(await fetchImpl('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', body: '{}' }));
    });
    expect(meter.costUsd).toBeCloseTo(0.03);
  });

  it('meters an OpenRouter-backed proxy (non-openrouter host) WITHOUT rewriting its body', async () => {
    // cliproxyapi returns OpenRouter's cost natively in the same usage frame, so we sniff it — but must
    // NOT inject the openrouter-only `usage:{include:true}` flag into a proxy/plain-OpenAI request.
    let sentBody: unknown;
    const base = (async (_url: never, init?: RequestInit) => { sentBody = init?.body; return openRouterStream(0.009); }) as unknown as typeof fetch;
    const fetchImpl = createMeteredFetch(base);
    const meter = newCostMeter();
    await runWithMeter(meter, async () => {
      await drain(await fetchImpl('https://ai.coresynth.io/v1/chat/completions', { method: 'POST', body: '{"model":"sarah-mimo-v2.5","stream":true}' }));
    });
    expect(meter.reported).toBe(true);
    expect(meter.costUsd).toBeCloseTo(0.009);
    expect(sentBody).toBe('{"model":"sarah-mimo-v2.5","stream":true}'); // body untouched — no accounting flag
  });

  it('leaves non-OpenRouter requests untouched (no body rewrite, no metering)', async () => {
    let sentBody: unknown;
    const base = (async (_url: never, init?: RequestInit) => { sentBody = init?.body; return new Response('ok', { status: 200 }); }) as unknown as typeof fetch;
    const fetchImpl = createMeteredFetch(base);
    const meter = newCostMeter();
    await runWithMeter(meter, async () => {
      const res = await fetchImpl('https://api.anthropic.com/v1/messages', { method: 'POST', body: '{"model":"x"}' });
      expect(await res.text()).toBe('ok');
    });
    expect(sentBody).toBe('{"model":"x"}'); // unchanged
    expect(meter.reported).toBe(false);
  });

  it('does not meter when there is no active run (still injects the accounting flag)', async () => {
    let sentBody: unknown;
    const base = (async (_url: never, init?: RequestInit) => { sentBody = init?.body; return openRouterStream(0.5); }) as unknown as typeof fetch;
    const fetchImpl = createMeteredFetch(base);
    const res = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', body: '{}' });
    await drain(res);
    expect(JSON.parse(sentBody as string)).toMatchObject({ usage: { include: true } });
  });
});
