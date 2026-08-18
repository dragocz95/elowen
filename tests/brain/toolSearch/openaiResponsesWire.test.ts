import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import { convertResponsesMessages, convertResponsesTools } from '@earendil-works/pi-ai/api/openai-responses-shared';
import { splitDeferredTools } from '../../../node_modules/@earendil-works/pi-ai/dist/utils/deferred-tools.js';
import type { Api, Context, Model, Tool, Usage } from '@earendil-works/pi-ai';
import { buildBrainRegistry, inMemoryModelRuntime, resolveBrainModel, type BrainRuntimeConfig } from '../../../src/brain/providers.js';
import {
  projectOpenAIHostedToolSearchPayload,
  supportsOpenAIHostedToolSearch,
} from '../../../src/brain/session/openAiHostedToolSearch.js';
import { stripLocalToolActivations } from '../../../src/brain/session/hostedToolSearch.js';

/** GPT-5.6 ChatGPT-OAuth wire regression for SERVER-SIDE hosted tool search.
 *
 *  pi 0.84.2 has no hosted mode: it builds every currently active function as an immediate top-level tool,
 *  then exposes `onPayload`. Elowen deliberately keeps the full sender-visible set active/executable,
 *  strips legacy local-activation metadata from the request view, and uses that egress seam to mark every
 *  function deferred plus append `{type:"tool_search"}`. The provider then searches, loads and calls a
 *  matching tool in one response — no local ToolSearch model round and no additional_tools/client replay. */

const PI_AI_DIST = fileURLToPath(new URL('../../../node_modules/@earendil-works/pi-ai/dist/', import.meta.url));
const CODEX_TOOL_CALL_PROVIDERS = new Set(['openai', 'openai-codex', 'opencode']);

const zeroUsage: Usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const tool = (name: string): Tool => ({
  name, description: `${name} tool`, parameters: Type.Object({ query: Type.String() }),
});

/** Carries one OLD local ToolSearch activation: after an upgrade a real session can retain this history,
 *  but it must not make pi split DiscordApi out of the hosted catalog or replay additional_tools. */
function legacyContext(model: Model<Api>): Context {
  return {
    systemPrompt: 'sys',
    // Live hosted sessions no longer register the local ToolSearch definition.
    tools: [tool('Read'), tool('DiscordApi')],
    messages: [
      { role: 'user', content: 'list the channels', timestamp: 1 },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call_1|fc_1', name: 'ToolSearch', arguments: { query: 'select:DiscordApi' } }],
        api: model.api, provider: model.provider, model: model.id,
        usage: zeroUsage, stopReason: 'toolUse', timestamp: 2,
      },
      {
        role: 'toolResult', toolCallId: 'call_1|fc_1', toolName: 'ToolSearch',
        content: [{ type: 'text', text: 'Activated 1 tool(s): DiscordApi.' }],
        addedToolNames: ['DiscordApi'], isError: false, timestamp: 3,
      },
    ],
  };
}

/** Mirror buildRequestBody only up to pi-ai's documented onPayload seam, then run Elowen's projector. */
function buildHostedWire(model: Model<Api>, source: Context) {
  const context = { ...source, messages: stripLocalToolActivations(source.messages) };
  const compat = model.compat as { supportsAdditionalTools?: boolean; supportsToolSearch?: boolean; supportsStrictMode?: boolean };
  const mode = compat.supportsAdditionalTools ? 'additional-tools' : compat.supportsToolSearch ? 'tool-search' : undefined;
  const placement = splitDeferredTools(context, mode !== undefined);
  const input = convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {
    includeSystemPrompt: false,
    deferredTools: placement.deferred,
    deferredToolsMode: mode,
    toolOptions: { strict: null, supportsStrictMode: compat.supportsStrictMode ?? true },
  }) as unknown as Record<string, unknown>[];
  const tools = convertResponsesTools(placement.immediate, {
    strict: null, supportsStrictMode: compat.supportsStrictMode ?? true,
  }) as unknown as Record<string, unknown>[];
  const payload = projectOpenAIHostedToolSearchPayload({ model: model.id, input, tools }, model.id);
  if (!payload) throw new Error('hosted projector unexpectedly declined the GPT-5.6 payload');
  return { input: payload.input as Record<string, unknown>[], tools: payload.tools as Record<string, unknown>[] };
}

const itemsOf = (input: Record<string, unknown>[], type: string) => input.filter((item) => item.type === type);

describe('openai-codex-responses hosted-tool wire (GPT-5.6)', () => {
  let model: Model<Api>;
  beforeAll(async () => {
    const cfg: BrainRuntimeConfig = { providers: [{
      id: 'codex', label: 'ChatGPT', type: 'oauth-openai-codex', baseUrl: '', models: ['gpt-5.6-sol'], apiKey: null,
    }] };
    const registry = buildBrainRegistry(cfg, await inMemoryModelRuntime());
    model = resolveBrainModel(registry, cfg, { provider: 'codex', model: 'gpt-5.6-sol' });
  });

  it('gates the real pinned descriptor onto hosted mode', () => {
    expect(model.api).toBe('openai-codex-responses');
    expect(model.provider).toBe('openai-codex');
    expect(supportsOpenAIHostedToolSearch(model, 'oauth-openai-codex')).toBe(true);
  });

  it('sends the whole application catalog deferred plus one hosted server-search tool', () => {
    const { input, tools } = buildHostedWire(model, legacyContext(model));

    expect(tools).toEqual([
      expect.objectContaining({ type: 'function', name: 'Read', defer_loading: true }),
      expect.objectContaining({ type: 'function', name: 'DiscordApi', defer_loading: true }),
      { type: 'tool_search' },
    ]);
    expect(tools.map((entry) => entry.name).filter(Boolean)).not.toContain('ToolSearch');
    expect(itemsOf(input, 'additional_tools')).toHaveLength(0);
    expect(itemsOf(input, 'tool_search_call')).toHaveLength(0);
    expect(itemsOf(input, 'tool_search_output')).toHaveLength(0);

    // Historical local calls remain valid history, but their addedToolNames no longer control placement.
    expect(itemsOf(input, 'function_call')).toEqual([
      expect.objectContaining({ name: 'ToolSearch' }),
    ]);
    expect(itemsOf(input, 'function_call_output')).toHaveLength(1);
  });

  it('pins the egress seam it composes after pi-ai builds the provider body', () => {
    const adapter = readFileSync(`${PI_AI_DIST}api/openai-codex-responses.js`, 'utf8');
    expect(adapter).toContain('let body = buildRequestBody(model, context, options');
    expect(adapter).toContain('const nextBody = await options?.onPayload?.(body, model)');
    expect(adapter).toContain('body = nextBody');
    // pi 0.84.2 itself still has only client/additional replay — if native hosted support lands upstream,
    // this module should be deleted in favour of it rather than maintain two implementations.
    expect(adapter).not.toContain('type: "tool_search"');
  });
});
