import type { BrainProviderEntry } from './providers.js';

export type HostedToolSearchProbeStatus = 'supported' | 'unsupported' | 'error';
export interface HostedToolSearchProbeResult {
  status: HostedToolSearchProbeStatus;
  reason: string;
  checkedAt: number;
}

interface ProbeOptions {
  provider: Pick<BrainProviderEntry, 'baseUrl' | 'apiKey'>;
  modelId: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const probeTool = {
  type: 'function',
  name: 'hosted_search_probe_echo',
  description: 'A harmless capability probe. Echo the exact value requested by the user.',
  defer_loading: true,
  strict: true,
  parameters: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  },
} as const;
const tools = [probeTool, { type: 'tool_search' as const }];

const safeJson = (text: string): Record<string, unknown> | undefined => {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
};

const outputItems = (body: Record<string, unknown> | undefined): Record<string, unknown>[] =>
  Array.isArray(body?.output) ? body.output.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object') : [];

const outputText = (body: Record<string, unknown> | undefined): string => {
  for (const item of outputItems(body)) {
    if (item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const block of item.content) {
      if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'output_text'
        && typeof (block as { text?: unknown }).text === 'string') return (block as { text: string }).text;
    }
  }
  return '';
};

const unsupported400 = (status: number, body: string): boolean => {
  if (status !== 400) return false;
  const text = body.toLowerCase();
  return text.includes('tool_search') || text.includes('tool search')
    || text.includes('defer_loading') || text.includes('unsupported tool') || text.includes('unknown tool');
};

/** Probe one configured Azure Responses deployment without touching any session or production tool. */
export async function probeAzureHostedToolSearch(options: ProbeOptions): Promise<HostedToolSearchProbeResult> {
  const checkedAt = (options.now ?? Date.now)();
  const apiKey = options.provider.apiKey;
  if (!apiKey) return { status: 'error', reason: 'api_key_missing', checkedAt };
  const endpoint = `${options.provider.baseUrl.replace(/\/+$/, '')}/responses`;
  const doFetch = options.fetchImpl ?? fetch;
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
    accept: 'application/json',
  };
  const base = {
    model: options.modelId,
    store: false,
    tools,
    tool_choice: 'auto',
    parallel_tool_calls: false,
  };
  const user = {
    role: 'user',
    content: [{ type: 'input_text', text: 'Find hosted_search_probe_echo and call it with value AZURE_HOSTED_OK.' }],
  };

  const send = async (body: Record<string, unknown>): Promise<{ response: Response; text: string; json?: Record<string, unknown> }> => {
    const response = await doFetch(endpoint, {
      method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    return { response, text, json: safeJson(text) };
  };

  try {
    const first = await send({
      ...base,
      instructions: 'Use hosted tool search to find hosted_search_probe_echo and call it once. Do not answer in text.',
      input: [user],
    });
    if (!first.response.ok) {
      return {
        status: unsupported400(first.response.status, first.text) ? 'unsupported' : 'error',
        reason: `http_${first.response.status}`,
        checkedAt,
      };
    }
    const items = outputItems(first.json);
    const searchCall = items.find((item) => item.type === 'tool_search_call');
    const searchOutput = items.find((item) => item.type === 'tool_search_output');
    const call = items.find((item) => item.type === 'function_call' && item.name === probeTool.name);
    const loadedTools = Array.isArray(searchOutput?.tools)
      ? searchOutput.tools.filter((tool): tool is Record<string, unknown> => !!tool && typeof tool === 'object')
      : [];
    const callArguments = typeof call?.arguments === 'string' ? safeJson(call.arguments) : undefined;
    if (!searchCall || searchCall.execution !== 'server' || searchCall.call_id !== null || searchCall.status !== 'completed'
      || !searchOutput || searchOutput.execution !== 'server' || searchOutput.call_id !== null || searchOutput.status !== 'completed'
      || !loadedTools.some((tool) => tool.type === 'function' && tool.name === probeTool.name && tool.defer_loading === true)
      || !call || typeof call.call_id !== 'string' || callArguments?.value !== 'AZURE_HOSTED_OK') {
      return { status: 'unsupported', reason: 'server_search_shape_missing', checkedAt };
    }

    // PI intentionally persists only the function call, not server search blocks. Prove that exact replay
    // remains accepted before enabling hosted mode for the deployment.
    const second = await send({
      ...base,
      instructions: 'After the tool result, reply exactly AZURE_REPLAY_OK.',
      input: [
        user,
        call,
        { type: 'function_call_output', call_id: call.call_id, output: JSON.stringify({ echoed: 'AZURE_HOSTED_OK' }) },
      ],
    });
    if (!second.response.ok) {
      return {
        status: unsupported400(second.response.status, second.text) ? 'unsupported' : 'error',
        reason: `replay_http_${second.response.status}`,
        checkedAt,
      };
    }
    if (!outputText(second.json).includes('AZURE_REPLAY_OK')) {
      return { status: 'unsupported', reason: 'replay_not_completed', checkedAt };
    }
    return { status: 'supported', reason: 'server_search_and_replay_ok', checkedAt };
  } catch (error) {
    const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'transport_error';
    return { status: 'error', reason, checkedAt };
  }
}
