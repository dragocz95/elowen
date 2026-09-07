import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ModelRegistry } from '@earendil-works/pi-coding-agent';
import type { Api, Model } from '@earendil-works/pi-ai';
import { inMemoryModelRuntime } from '../../src/brain/providers.js';

/** The REAL Anthropic wire, captured off a loopback socket.
 *
 *  Every other provider fake in this suite hands `streamSimple` a pi-ai `Context` and projects it into a
 *  body itself, which is fine for observing an extension but useless as a golden reference: the projection
 *  is the test's own opinion of what the wire looks like, so roles, tool call ids, image blocks and the
 *  coalescing of tool results are all invisible to it. Here pi-ai's own `anthropic-messages` provider runs
 *  end to end and POSTs to this server, so what lands in `bodies` is the request byte for byte — after the
 *  whole `transformContext` chain, after every `before_provider_request` handler, and after the converter.
 *
 *  The response is the minimal SSE handshake pi-ai's stream reader accepts: one text block and a stop. */
export interface AnthropicWire {
  runtime: Awaited<ReturnType<typeof inMemoryModelRuntime>>;
  model: Model<Api>;
  /** Request bodies in the order they were sent. */
  bodies: WireBody[];
  close: () => Promise<void>;
}

interface WireBody extends Record<string, unknown> {
  model: string;
  messages: { role: string; content: unknown }[];
  tools?: { name?: string }[];
  system?: unknown;
}

/** What the fake assistant answers on one request: plain text, or a call to one of the session's tools. */
export type WireReply = { text: string } | { toolCall: { id: string; name: string } };

const frame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function sse(reply: WireReply): string {
  const block = 'toolCall' in reply
    ? { type: 'tool_use', id: reply.toolCall.id, name: reply.toolCall.name, input: {} }
    : { type: 'text', text: '' };
  return [
    frame('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-x', content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 },
      },
    }),
    frame('content_block_start', { type: 'content_block_start', index: 0, content_block: block }),
    frame('content_block_delta', {
      type: 'content_block_delta', index: 0,
      delta: 'toolCall' in reply
        ? { type: 'input_json_delta', partial_json: '{}' }
        : { type: 'text_delta', text: reply.text },
    }),
    frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
    frame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'toolCall' in reply ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: { output_tokens: 2 },
    }),
    frame('message_stop', { type: 'message_stop' }),
  ].join('');
}

export async function anthropicWire(options: {
  modelId?: string;
  /** The answer to each request, 1-based. Defaults to a plain "ok", which ends the turn. */
  replyFor?: (call: number) => WireReply | undefined;
} = {}): Promise<AnthropicWire> {
  const bodies: WireBody[] = [];
  let call = 0;
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      call += 1;
      try { bodies.push(JSON.parse(raw) as WireBody); }
      catch { /* a malformed body is a failure the assertions will show */ }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse(options.replyFor?.(call) ?? { text: 'ok' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  const runtime = await inMemoryModelRuntime();
  const registry = new ModelRegistry(runtime);
  const modelId = options.modelId ?? 'claude-x';
  // Registered under the `anthropic` provider name on purpose: the session factory keys cache breakpoints
  // and the cache watch on exactly that name, so this is the wiring a real Anthropic conversation gets.
  registry.registerProvider('anthropic', {
    name: 'Anthropic (loopback)', api: 'anthropic-messages', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k',
    models: [{
      id: modelId, name: modelId, reasoning: false, input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 512,
    }],
  });
  const model = registry.find('anthropic', modelId);
  if (!model) throw new Error('loopback anthropic model missing');

  return {
    runtime,
    model,
    bodies,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}
