import { describe, expect, it, vi } from 'vitest';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  ANTHROPIC_HOSTED_TOOL_SEARCH_TYPE,
  installAnthropicHostedToolSearch,
  isAnthropicHostedToolSearchModelId,
  projectAnthropicHostedToolSearchPayload,
  supportsAnthropicHostedToolSearch,
} from '../../../src/brain/session/anthropicHostedToolSearch.js';

describe('Anthropic hosted tool search — supported OAuth models', () => {
  it.each([
    ['claude-fable-5', true],
    ['claude-mythos-5', true],
    ['claude-opus-5', true],
    ['claude-opus-4-8', true],
    ['claude-opus-4-7', true],
    ['claude-opus-4-6', true],
    ['claude-opus-4-5-20251101', true],
    ['claude-sonnet-4-6', true],
    ['claude-sonnet-4-5-20250929', true],
    ['claude-haiku-4-5-20251001', true],
    ['claude-opus-4-1', false],
    ['claude-sonnet-4-0', false],
    ['claude-3-7-sonnet', false],
    ['gpt-5.6-sol', false],
  ])('classifies %s against Anthropic model compatibility', (id, expected) => {
    expect(isAnthropicHostedToolSearchModelId(id)).toBe(expected);
  });

  it('gates on the built-in Anthropic OAuth provider/API, not compatible or custom providers', () => {
    expect(supportsAnthropicHostedToolSearch({
      id: 'claude-opus-5', provider: 'anthropic', api: 'anthropic-messages',
    }, 'oauth-anthropic')).toBe(true);
    expect(supportsAnthropicHostedToolSearch({
      id: 'claude-opus-4-1', provider: 'anthropic', api: 'anthropic-messages',
    }, 'oauth-anthropic')).toBe(false);
    expect(supportsAnthropicHostedToolSearch({
      id: 'claude-opus-5', provider: 'anthropic', api: 'anthropic-messages',
    }, 'anthropic')).toBe(false); // registry labels alone are not proof of OAuth
    expect(supportsAnthropicHostedToolSearch({
      id: 'claude-opus-5', provider: 'elowen-anthropic-key', api: 'anthropic-messages',
    }, 'anthropic')).toBe(false);
    expect(supportsAnthropicHostedToolSearch({
      id: 'claude-opus-5', provider: 'anthropic', api: 'openai-completions',
    }, 'oauth-anthropic')).toBe(false);
  });

  it('defers all application functions, strips cache markers/local ToolSearch and preserves other server tools', () => {
    const payload = {
      model: 'claude-opus-5',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [
        { name: 'Read', description: 'read', input_schema: { type: 'object' } },
        { name: 'AllowedPluginTool', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } },
        { name: 'ToolSearch', input_schema: { type: 'object' } },
        { type: 'web_search_20260318', name: 'web_search', max_uses: 2 },
        { type: ANTHROPIC_HOSTED_TOOL_SEARCH_TYPE, name: 'tool_search_tool_bm25' },
      ],
    };

    const projected = projectAnthropicHostedToolSearchPayload(payload, 'claude-opus-5');
    expect(projected?.tools).toEqual([
      { type: ANTHROPIC_HOSTED_TOOL_SEARCH_TYPE, name: 'tool_search_tool_bm25' },
      { type: 'web_search_20260318', name: 'web_search', max_uses: 2 },
      { name: 'Read', description: 'read', input_schema: { type: 'object' }, defer_loading: true },
      { name: 'AllowedPluginTool', input_schema: { type: 'object' }, defer_loading: true },
    ]);
    expect(JSON.stringify(projected)).not.toContain('ToolSearch');
    expect(JSON.stringify(projected)).not.toContain('cache_control');
    expect(projected?.messages).toBe(payload.messages);
  });

  it('leaves requests with no application functions alone', () => {
    expect(projectAnthropicHostedToolSearchPayload(
      { model: 'claude-opus-5', messages: [] }, 'claude-opus-5',
    )).toBeUndefined();
    expect(projectAnthropicHostedToolSearchPayload({
      model: 'claude-opus-5', messages: [], tools: [{ type: 'web_search_20260318', name: 'web_search' }],
    }, 'claude-opus-5')).toBeUndefined();
    expect(projectAnthropicHostedToolSearchPayload({
      model: 'claude-opus-4-1', messages: [], tools: [{ name: 'Read', input_schema: {} }],
    }, 'claude-opus-5')).toBeUndefined(); // compaction/model-route request
    expect(projectAnthropicHostedToolSearchPayload({
      input: [], tools: [{ name: 'Read', input_schema: {} }],
    }, 'claude-opus-5')).toBeUndefined();
  });

  it('registers context scrub + provider projection as one extension', () => {
    const handlers = new Map<string, (event: never) => unknown>();
    const pi = {
      on: vi.fn((event: string, handler: (event: never) => unknown) => { handlers.set(event, handler); }),
    } as unknown as ExtensionAPI;
    installAnthropicHostedToolSearch(pi, 'claude-opus-5');

    expect([...handlers.keys()]).toEqual(['context', 'before_provider_request']);
    const context = handlers.get('context')?.({
      messages: [{ role: 'toolResult', addedToolNames: ['x'], content: [] }],
    } as never) as { messages: Record<string, unknown>[] };
    expect(context.messages[0]).not.toHaveProperty('addedToolNames');
    const payload = handlers.get('before_provider_request')?.({
      payload: {
        model: 'claude-opus-5', messages: [],
        tools: [{ name: 'Read', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } }],
      },
    } as never) as { tools: Record<string, unknown>[] };
    expect(payload.tools).toEqual([
      { type: ANTHROPIC_HOSTED_TOOL_SEARCH_TYPE, name: 'tool_search_tool_bm25' },
      { name: 'Read', input_schema: { type: 'object' }, defer_loading: true },
    ]);
  });
});
