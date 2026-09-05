import { describe, expect, it, vi } from 'vitest';
import { stream } from '@earendil-works/pi-ai/api/anthropic-messages';
import type { Api, Model } from '@earendil-works/pi-ai';
import { buildBrainRegistry, inMemoryModelRuntime, type BrainRuntimeConfig } from '../../src/brain/providers.js';

// The production failure this pins (workflow wf-874c3ca5, 5 Sep 2026): a workflow node on claude-opus-5
// answered with [text, thinking, thinking, tool_use], and its SECOND provider call in the same turn came
// back "400 messages.1.content.2: `thinking` or `redacted_thinking` blocks in the latest assistant message
// cannot be modified" — the node died on the spot, twice, including on WorkflowResume.
//
// pi 0.85.0 fixed it upstream for managed-effort Anthropic models: the request now carries
// thinking.block_binding.prefix_mismatch_behavior = "drop_block", so Anthropic DROPS a thinking block whose
// prefix no longer matches instead of rejecting the whole request. This test replays the exact history
// shape against pi's real transport with a scripted fetch: it fails the moment that binding stops being
// sent, or the model stops being a managed-effort one, which is what would bring the 400 back.
const SIGNATURE_A = 'signed-thinking-a';
const SIGNATURE_B = 'signed-thinking-b';

const sse = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-opus-5","usage":{"input_tokens":10,"output_tokens":1}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"done"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join('');

/** The node's first assistant answer, in pi's own message shape, followed by its tool result — the history
 *  the failing second call carried. */
const history = [
  { role: 'user', content: [{ type: 'text', text: 'Fix the review findings.' }] },
  {
    role: 'assistant',
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-opus-5',
    providerThinkingLevel: 'high',
    content: [
      { type: 'text', text: 'I will start by getting oriented.' },
      { type: 'thinking', thinking: 'first', thinkingSignature: SIGNATURE_A },
      { type: 'thinking', thinking: 'second', thinkingSignature: SIGNATURE_B },
      { type: 'toolCall', id: 'toolu_1', name: 'Bash', arguments: { command: 'git status' } },
    ],
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    stopReason: 'toolUse',
  },
  { role: 'toolResult', toolCallId: 'toolu_1', toolName: 'Bash', content: [{ type: 'text', text: 'clean' }], isError: false },
];

async function capturedRequest(model: Model<Api>): Promise<Record<string, unknown>> {
  const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) =>
    new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
  const events = stream(model, { messages: history, tools: [] } as never, {
    apiKey: 'sk-ant-test',
    thinkingEnabled: true,
    effort: 'high',
    fetch: fetch as never,
  } as never);
  for await (const event of events) {
    if (event.type === 'error') throw new Error(event.error.errorMessage ?? 'provider error');
  }
  expect(fetch).toHaveBeenCalledTimes(1);
  const body = fetch.mock.calls[0]![1]?.body;
  return JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body as Uint8Array));
}

describe('Anthropic signed-thinking prefix mismatch', () => {
  const opus5 = async (): Promise<Model<Api>> => {
    const cfg: BrainRuntimeConfig = {
      providers: [{ id: 'claude', label: 'Claude', type: 'oauth-anthropic', baseUrl: '', models: ['claude-opus-5'], apiKey: null }],
      // An operator pin re-registers the whole built-in provider through catalogDefinition, which is the
      // only thing carrying compat.supportsMidConvoEffort forward — and that flag is what makes pi send the
      // binding at all. A pin that dropped it would revive the production 400 with nothing else changed.
      contextWindows: { 'claude/claude-opus-5': 900_000 },
    };
    const model = buildBrainRegistry(cfg, await inMemoryModelRuntime()).find('anthropic', 'claude-opus-5');
    expect(model).toBeDefined();
    return model!;
  };

  it('asks Anthropic to drop a mismatching thinking block instead of rejecting the turn', async () => {
    const payload = await capturedRequest(await opus5());
    expect(payload.thinking).toMatchObject({
      type: 'adaptive',
      block_binding: { prefix_mismatch_behavior: 'drop_block' },
    });
  });

  // The binding rides on the model descriptor's managed-effort flag, which is what the assertion above is
  // really checking. A model without it (Opus 4.8, the tier Elowen used to clone Opus 5 from) still sends
  // the pre-0.85 shape — so the test above cannot pass for an unrelated reason.
  it('sends no prefix binding for a model that is not managed-effort', async () => {
    const cfg: BrainRuntimeConfig = {
      providers: [{ id: 'claude', label: 'Claude', type: 'oauth-anthropic', baseUrl: '', models: ['claude-opus-4-8'], apiKey: null }],
    };
    const model = buildBrainRegistry(cfg, await inMemoryModelRuntime()).find('anthropic', 'claude-opus-4-8');
    expect(model).toBeDefined();
    const payload = await capturedRequest(model!);
    expect((payload.thinking as { block_binding?: unknown }).block_binding).toBeUndefined();
  });

  it('still sends the assistant thinking blocks verbatim on the second call of a turn', async () => {
    const payload = await capturedRequest(await opus5());
    const messages = payload.messages as { role: string; content?: { type: string; signature?: string }[] }[];
    const assistant = messages.find((message) => message.role === 'assistant');
    expect(assistant?.content?.map((block) => block.type)).toEqual(['text', 'thinking', 'thinking', 'tool_use']);
    expect(assistant?.content?.filter((block) => block.type === 'thinking').map((block) => block.signature))
      .toEqual([SIGNATURE_A, SIGNATURE_B]);
  });
});
