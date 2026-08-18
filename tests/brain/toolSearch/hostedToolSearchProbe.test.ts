import { describe, expect, it, vi } from 'vitest';
import { probeAzureHostedToolSearch } from '../../../src/brain/hostedToolSearchProbe.js';

const provider = {
  baseUrl: 'https://example.openai.azure.com/openai/v1',
  apiKey: 'secret-key',
};
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

const firstOutput = [
  { type: 'tool_search_call', id: 'search_1', execution: 'server', call_id: null, status: 'completed' },
  { type: 'tool_search_output', id: 'search_out_1', execution: 'server', call_id: null, status: 'completed', tools: [
    { type: 'function', name: 'hosted_search_probe_echo', defer_loading: true },
  ] },
  { type: 'function_call', id: 'call_item_1', call_id: 'call_1', name: 'hosted_search_probe_echo', arguments: '{"value":"AZURE_HOSTED_OK"}' },
];

describe('probeAzureHostedToolSearch', () => {
  it('requires server search and proves replay without server blocks', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ output: firstOutput }))
      .mockResolvedValueOnce(response({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'AZURE_REPLAY_OK' }] }] }));

    await expect(probeAzureHostedToolSearch({ provider, modelId: 'deployment', fetchImpl, now: () => 123 }))
      .resolves.toEqual({ status: 'supported', reason: 'server_search_and_replay_ok', checkedAt: 123 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://example.openai.azure.com/openai/v1/responses');
    expect(fetchImpl.mock.calls[0]![1].headers).toMatchObject({ Authorization: 'Bearer secret-key' });
    const first = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(first.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'function', name: 'hosted_search_probe_echo', defer_loading: true }),
      { type: 'tool_search' },
    ]));
    const replay = JSON.parse(fetchImpl.mock.calls[1]![1].body as string);
    expect(replay.input.map((item: { type?: string }) => item.type)).toEqual([undefined, 'function_call', 'function_call_output']);
    expect(JSON.stringify(replay)).not.toContain('tool_search_call');
    expect(JSON.stringify(replay)).not.toContain('tool_search_output');
  });

  it('records an explicit provider rejection as unsupported without returning its body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ error: { message: 'tool_search is unsupported SECRET' } }, 400));
    const result = await probeAzureHostedToolSearch({ provider, modelId: 'deployment', fetchImpl, now: () => 5 });
    expect(result).toEqual({ status: 'unsupported', reason: 'http_400', checkedAt: 5 });
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('fails closed when hosted search did not execute server-side', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ output: [firstOutput[2]] }));
    await expect(probeAzureHostedToolSearch({ provider, modelId: 'deployment', fetchImpl, now: () => 8 }))
      .resolves.toEqual({ status: 'unsupported', reason: 'server_search_shape_missing', checkedAt: 8 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['incomplete search status', () => { const output = structuredClone(firstOutput); output[0]!.status = 'in_progress'; return output; }],
    ['wrong loaded tool', () => { const output = structuredClone(firstOutput); output[1]!.tools = [{ type: 'function', name: 'other', defer_loading: true }]; return output; }],
    ['wrong function arguments', () => { const output = structuredClone(firstOutput); output[2]!.arguments = '{"value":"WRONG"}'; return output; }],
  ])('rejects %s', async (_name, makeOutput) => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ output: makeOutput() }));
    await expect(probeAzureHostedToolSearch({ provider, modelId: 'deployment', fetchImpl, now: () => 10 }))
      .resolves.toEqual({ status: 'unsupported', reason: 'server_search_shape_missing', checkedAt: 10 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not downgrade a transport failure into unsupported', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network detail'));
    await expect(probeAzureHostedToolSearch({ provider, modelId: 'deployment', fetchImpl, now: () => 9 }))
      .resolves.toEqual({ status: 'error', reason: 'transport_error', checkedAt: 9 });
  });
});
