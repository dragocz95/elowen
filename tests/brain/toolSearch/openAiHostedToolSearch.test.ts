import { describe, expect, it, vi } from 'vitest';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  installOpenAIHostedToolSearch,
  isGpt54OrLater,
  projectOpenAIHostedToolSearchPayload,
  stripLocalToolActivations,
  supportsOpenAIHostedToolSearch,
} from '../../../src/brain/session/openAiHostedToolSearch.js';
import { applyToolVisibility } from '../../../src/brain/session/capabilities.js';

describe('OpenAI hosted tool search — GPT-5.4+ ChatGPT OAuth', () => {
  it.each([
    ['gpt-5.4', true],
    ['gpt-5.4-codex', true],
    ['gpt-5.6-luna', true],
    ['gpt-6', true],
    ['gpt-5.3-codex-spark', false],
    ['gpt-4.9', false],
    ['gpt-image-2', false],
    ['claude-opus-5', false],
  ])('classifies %s against the documented 5.4 floor', (id, expected) => {
    expect(isGpt54OrLater(id)).toBe(expected);
  });

  it('gates on the ChatGPT OAuth registry/API, never Azure, API-key OpenAI or a relay', () => {
    expect(supportsOpenAIHostedToolSearch({
      id: 'gpt-5.6-luna', provider: 'openai-codex', api: 'openai-codex-responses',
    })).toBe(true);
    expect(supportsOpenAIHostedToolSearch({
      id: 'gpt-5.3-codex-spark', provider: 'openai-codex', api: 'openai-codex-responses',
    })).toBe(false);
    expect(supportsOpenAIHostedToolSearch({
      id: 'gpt-5.6-luna', provider: 'azure-openai', api: 'openai-responses',
    })).toBe(false);
    expect(supportsOpenAIHostedToolSearch({
      id: 'gpt-5.6-luna', provider: 'openai', api: 'openai-responses',
    })).toBe(false);
    expect(supportsOpenAIHostedToolSearch({
      id: 'gpt-5.6-luna', provider: 'relay', api: 'openai-codex-responses',
    })).toBe(false);
  });

  it('defers every sender-visible function, removes local ToolSearch and appends one server search tool', () => {
    // `DeniedPluginTool` is intentionally ABSENT: the projector consumes the already-visible body rather
    // than rebuilding from PI's full registry, so a role-hidden schema cannot leak back in here.
    const payload = {
      model: 'gpt-5.6-luna',
      input: [{ role: 'user', content: [] }],
      tools: [
        { type: 'function', name: 'Read', parameters: { type: 'object' }, strict: null },
        { type: 'function', name: 'AllowedPluginTool', parameters: { type: 'object' }, strict: true },
        { type: 'function', name: 'ToolSearch', parameters: { type: 'object' } },
        { type: 'custom', name: 'GrammarTool', format: { type: 'grammar' } },
        { type: 'tool_search' }, // defensive idempotence — replaced, never duplicated
      ],
    };

    const projected = projectOpenAIHostedToolSearchPayload(payload);
    expect(projected).toBeDefined();
    expect(projected?.tools).toEqual([
      { type: 'function', name: 'Read', parameters: { type: 'object' }, strict: null, defer_loading: true },
      { type: 'function', name: 'AllowedPluginTool', parameters: { type: 'object' }, strict: true, defer_loading: true },
      { type: 'custom', name: 'GrammarTool', format: { type: 'grammar' } },
      { type: 'tool_search' },
    ]);
    expect(JSON.stringify(projected)).not.toContain('DeniedPluginTool');
    expect(JSON.stringify(projected)).not.toContain('ToolSearch');
    expect((projected?.tools as { type?: string }[]).filter((tool) => tool.type === 'tool_search')).toHaveLength(1);
    // Input/history is byte-for-byte untouched by the payload projection.
    expect(projected?.input).toBe(payload.input);
  });

  it('projects the live sender-visible slice, not the session registry, for a shared-channel role', () => {
    const registry = [
      { name: 'Read' },
      { name: 'AllowedPluginTool' },
      { name: 'DeniedPluginTool' },
    ];
    let active = registry.map((tool) => tool.name);
    const session = {
      getAllTools: () => registry,
      getActiveToolNames: () => active,
      setActiveToolsByName: (names: string[]) => { active = names; },
    };

    // The shared sender's role grants one plugin tool. Built-ins remain visible by design; the other
    // plugin schema must disappear BEFORE pi-ai builds the body the hosted projector consumes.
    applyToolVisibility(
      session,
      new Set(['AllowedPluginTool', 'DeniedPluginTool']),
      { allow: new Set(['AllowedPluginTool']) },
    );
    const payload = projectOpenAIHostedToolSearchPayload({
      input: [],
      tools: active.map((name) => ({ type: 'function', name })),
    });

    expect(active).toEqual(['Read', 'AllowedPluginTool']);
    expect((payload?.tools as { name?: string }[]).map((tool) => tool.name).filter(Boolean)).toEqual([
      'Read', 'AllowedPluginTool',
    ]);
    expect(JSON.stringify(payload)).not.toContain('DeniedPluginTool');
  });

  it('leaves compaction/text-only payloads and unsupported tool kinds alone', () => {
    expect(projectOpenAIHostedToolSearchPayload({ model: 'gpt-5.6-luna', input: [] })).toBeUndefined();
    expect(projectOpenAIHostedToolSearchPayload({
      model: 'gpt-5.6-luna', input: [], tools: [{ type: 'custom', name: 'GrammarTool' }],
    })).toBeUndefined();
    expect(projectOpenAIHostedToolSearchPayload({ messages: [], tools: [{ type: 'function', name: 'x' }] })).toBeUndefined();
  });

  it('strips legacy addedToolNames only from the provider view', () => {
    const original = [
      { role: 'user', content: 'hello' },
      { role: 'toolResult', toolName: 'ToolSearch', addedToolNames: ['DiscordApi'], content: [] },
      { role: 'toolResult', toolName: 'Read', content: [] },
    ];
    const projected = stripLocalToolActivations(original);

    expect(projected).toEqual([
      original[0],
      { role: 'toolResult', toolName: 'ToolSearch', content: [] },
      original[2],
    ]);
    expect(original[1]).toHaveProperty('addedToolNames', ['DiscordApi']); // persisted source untouched
    expect(projected[0]).toBe(original[0]);
    expect(projected[2]).toBe(original[2]);
  });

  it('registers both seams as one provider-owned extension', () => {
    const handlers = new Map<string, (event: never) => unknown>();
    const pi = {
      on: vi.fn((event: string, handler: (event: never) => unknown) => { handlers.set(event, handler); }),
    } as unknown as ExtensionAPI;
    installOpenAIHostedToolSearch(pi);

    expect([...handlers.keys()]).toEqual(['context', 'before_provider_request']);
    const context = handlers.get('context')?.({
      messages: [{ role: 'toolResult', addedToolNames: ['x'], content: [] }],
    } as never) as { messages: Record<string, unknown>[] };
    expect(context.messages[0]).not.toHaveProperty('addedToolNames');
    const payload = handlers.get('before_provider_request')?.({
      payload: { input: [], tools: [{ type: 'function', name: 'Read' }] },
    } as never) as { tools: Record<string, unknown>[] };
    expect(payload.tools).toEqual([
      { type: 'function', name: 'Read', defer_loading: true },
      { type: 'tool_search' },
    ]);
  });
});
