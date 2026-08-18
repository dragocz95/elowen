import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import { convertResponsesMessages, convertResponsesTools } from '@earendil-works/pi-ai/api/openai-responses-shared';
// Not on pi-ai's exports map, so reached by file path (a relative path bypasses the map). The adjacent
// .d.ts keeps this typed.
import { splitDeferredTools } from '../../../node_modules/@earendil-works/pi-ai/dist/utils/deferred-tools.js';
import type { Api, Context, Model, Tool, Usage } from '@earendil-works/pi-ai';
import { buildBrainRegistry, inMemoryModelRuntime, resolveBrainModel, type BrainRuntimeConfig } from '../../../src/brain/providers.js';

/** GPT-5.6 wire regression for native deferred-tool loading.
 *
 *  Whatever the path, pi-ai's openai-codex-responses adapter keeps a ToolSearch-activated deferred tool OUT
 *  of the top-level `tools` array — that is what keeps the cached tool prefix byte-stable across
 *  activations. Where it puts the schema instead depends on the model's compat flags: since 0.84.2
 *  `supportsAdditionalTools` anchors it to the transcript as one `additional_tools` item (our catalog's
 *  path), `supportsToolSearch` alone replays the older `tool_search_call`/`tool_search_output` pair whose
 *  schema carries `defer_loading: true`, and a model with neither falls back to appending the schema to
 *  top-level `tools` (a cache-hostile prefix rewrite). All three branches are pinned here through pi-ai's
 *  REAL conversion path — the exact exported functions buildRequestBody composes — not a reimplementation;
 *  a source assertion below ties the mirrored call shape to the adapter so a pi-ai upgrade that changes the
 *  glue fails this file instead of silently drifting. */

const PI_AI_DIST = fileURLToPath(new URL('../../../node_modules/@earendil-works/pi-ai/dist/', import.meta.url));

/** Same value as the adapter's CODEX_TOOL_CALL_PROVIDERS (not exported; pinned by the source assertion). */
const CODEX_TOOL_CALL_PROVIDERS = new Set(['openai', 'openai-codex', 'opencode']);

const zeroUsage: Usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const tool = (name: string): Tool => ({
  name,
  description: `${name} tool`,
  parameters: Type.Object({ query: Type.String() }),
});

/** A conversation in which the model already activated the deferred `DiscordApi` via ToolSearch: the
 *  toolResult carries PI's recorded `addedToolNames`, the load point both native paths read. */
function contextAfterActivation(model: Model<Api>): Context {
  return {
    systemPrompt: 'sys',
    tools: [tool('ToolSearch'), tool('Read'), tool('DiscordApi')],
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

type WireCompat = { supportsAdditionalTools?: boolean; supportsToolSearch?: boolean; supportsStrictMode?: boolean };

/** The mode ladder buildRequestBody applies (openai-codex-responses.js:371): message-anchored
 *  `additional_tools` wins where the model supports it, tool-search items are the older path, and a model
 *  with neither flag gets no deferral at all. Mirrored, not imported — it is inline in the adapter. */
const deferredToolsMode = (compat?: WireCompat): 'additional-tools' | 'tool-search' | undefined =>
  compat?.supportsAdditionalTools ? 'additional-tools' : compat?.supportsToolSearch ? 'tool-search' : undefined;

/** The exact composition buildRequestBody performs for tools + input (openai-codex-responses.js:368):
 *  split on whether a deferral mode exists at all, convert messages with the deferred map AND that mode,
 *  convert only the immediate tools to the top level. Passing the map without the mode places NOTHING —
 *  the schema then reaches the model through neither path, so the mode is not optional here. */
function buildWirePlacement(model: Model<Api>, context: Context) {
  const compat = model.compat as WireCompat | undefined;
  const mode = deferredToolsMode(compat);
  const placement = splitDeferredTools(context, mode !== undefined);
  const input = convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {
    includeSystemPrompt: false,
    deferredTools: placement.deferred,
    deferredToolsMode: mode,
    toolOptions: { strict: null, supportsStrictMode: compat?.supportsStrictMode ?? true },
  }) as unknown as Record<string, unknown>[];
  const tools = convertResponsesTools(placement.immediate, {
    strict: null, supportsStrictMode: compat?.supportsStrictMode ?? true,
  }) as unknown as Record<string, unknown>[];
  return { input, tools };
}

const itemsOf = (input: Record<string, unknown>[], type: string) => input.filter((item) => item.type === type);
const toolNames = (tools: Record<string, unknown>[]) => tools.map((t) => t.name);

describe('openai-codex-responses deferred-tool wire (GPT-5.6)', () => {
  let model: Model<Api>;
  beforeAll(async () => {
    const cfg: BrainRuntimeConfig = { providers: [{
      id: 'codex', label: 'ChatGPT', type: 'oauth-openai-codex', baseUrl: '', models: ['gpt-5.6-sol'], apiKey: null,
    }] };
    const registry = buildBrainRegistry(cfg, await inMemoryModelRuntime());
    model = resolveBrainModel(registry, cfg, { provider: 'codex', model: 'gpt-5.6-sol' });
  });

  it('ships gpt-5.6 descriptors with both deferral flags in the pinned catalog', () => {
    expect(model.api).toBe('openai-codex-responses');
    const compat = model.compat as WireCompat;
    expect(compat.supportsToolSearch).toBe(true);
    // Present since pi-ai 0.84.2 and it OUTRANKS tool search, so the live wire is the anchored path below.
    expect(compat.supportsAdditionalTools).toBe(true);
    expect(deferredToolsMode(compat)).toBe('additional-tools');
  });

  it('keeps an activated deferred tool OUT of top-level tools and anchors it to the transcript', () => {
    const { input, tools } = buildWirePlacement(model, contextAfterActivation(model));

    // (a) the activated tool is not in the top-level tools array — the cached tool prefix is unchanged.
    expect(toolNames(tools)).toEqual(expect.arrayContaining(['ToolSearch', 'Read']));
    expect(toolNames(tools)).not.toContain('DiscordApi');

    // (b) the schema rides in a single message-anchored additional_tools item instead.
    const anchored = itemsOf(input, 'additional_tools');
    expect(anchored).toHaveLength(1);
    expect(anchored[0]?.role).toBe('developer');
    const loaded = anchored[0]?.tools as Record<string, unknown>[];
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.name).toBe('DiscordApi');

    // …appended AFTER the ToolSearch function_call_output, i.e. at the end of the context, where it does
    // not disturb any earlier cached span.
    const anchorIndex = input.findIndex((item) => item.type === 'additional_tools');
    const resultIndex = input.findIndex((item) => item.type === 'function_call_output');
    expect(resultIndex).toBeGreaterThanOrEqual(0);
    expect(anchorIndex).toBeGreaterThan(resultIndex);
  });

  it('replays tool_search items for a model that only supports the older path', () => {
    const searchOnly = {
      ...model,
      compat: { ...(model.compat as Record<string, unknown>), supportsAdditionalTools: undefined },
    } as Model<Api>;
    const { input, tools } = buildWirePlacement(searchOnly, contextAfterActivation(searchOnly));

    expect(toolNames(tools)).not.toContain('DiscordApi');
    const calls = itemsOf(input, 'tool_search_call');
    const outputs = itemsOf(input, 'tool_search_output');
    expect(calls).toHaveLength(1);
    expect(outputs).toHaveLength(1);
    expect(calls[0]?.call_id).toBe(outputs[0]?.call_id);

    // On this path the loaded schema carries defer_loading itself, which is what keeps the API from
    // folding it into the cached tool prefix.
    const loaded = outputs[0]?.tools as Record<string, unknown>[];
    expect(loaded[0]?.name).toBe('DiscordApi');
    expect(loaded[0]?.defer_loading).toBe(true);
  });

  it('falls back to top-level tools when the model supports neither deferral path', () => {
    const withoutFlags = {
      ...model,
      compat: {
        ...(model.compat as Record<string, unknown>),
        supportsAdditionalTools: undefined,
        supportsToolSearch: undefined,
      },
    } as Model<Api>;
    const { input, tools } = buildWirePlacement(withoutFlags, contextAfterActivation(withoutFlags));

    // (d) the activated tool lands in top-level tools — the cache-hostile branch the supportsToolSearch
    // warning in providers.ts exists to surface.
    expect(toolNames(tools)).toContain('DiscordApi');
    expect(itemsOf(input, 'additional_tools')).toHaveLength(0);
    expect(itemsOf(input, 'tool_search_call')).toHaveLength(0);
    expect(itemsOf(input, 'tool_search_output')).toHaveLength(0);
    expect(tools.some((t) => t.defer_loading === true)).toBe(false);
  });

  it('mirrors the adapter glue it re-composes (source pin against pi-ai drift)', () => {
    const adapter = readFileSync(`${PI_AI_DIST}api/openai-codex-responses.js`, 'utf8');
    // buildRequestBody derives the mode from compat, gates the split on it and feeds BOTH the deferred map
    // and the mode into the conversion; if any of that moves in a pi-ai upgrade, the placement mirrored
    // above no longer matches what ships on the wire and this file must be revisited.
    expect(adapter).toContain('model.compat?.supportsAdditionalTools');
    expect(adapter).toContain('"additional-tools"');
    expect(adapter).toContain('splitDeferredTools(context, deferredToolsMode !== undefined)');
    expect(adapter).toContain('deferredTools: toolPlacement.deferred');
    expect(adapter).toContain('deferredToolsMode,');
    expect(adapter).toContain('CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"])');
  });
});
