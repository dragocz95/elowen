import { describe, expect, it } from 'vitest';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import {
  buildContextBreakdown,
  residentContextUsageOf,
  useLocalResidentContextEstimate,
  type ContextMessage,
  type ContextSnapshot,
} from '../../src/brain/contextBreakdown.js';

/** Messages are sized by PI's chars/4 heuristic, so every fixture below uses a length that is a clean
 *  multiple of 4 — the expected token counts are then hand-computable and the assertions stay literal. */
const user = (chars: number): ContextMessage => ({
  role: 'user',
  content: [{ type: 'text', text: 'u'.repeat(chars) }],
  timestamp: 0,
});

const assistant = (chars: number, calls: { name: string; arguments: Record<string, unknown> }[] = []): ContextMessage => ({
  role: 'assistant',
  content: [
    { type: 'text', text: 'a'.repeat(chars) },
    ...calls.map((call) => ({ type: 'toolCall' as const, id: call.name, name: call.name, arguments: call.arguments })),
  ],
  api: 'anthropic-messages',
  provider: 'anthropic',
  model: 'test-model',
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: 'stop',
  timestamp: 0,
});

const toolResult = (toolName: string, chars: number): ContextMessage => ({
  role: 'toolResult',
  toolCallId: toolName,
  toolName,
  content: [{ type: 'text', text: 'r'.repeat(chars) }],
  isError: false,
  timestamp: 0,
});

const custom = (chars: number): ContextMessage => ({
  role: 'custom',
  customType: 'internal',
  content: [{ type: 'text', text: 'c'.repeat(chars) }],
  display: false,
  timestamp: 0,
});

const snapshot = (over: Partial<ContextSnapshot> = {}): ContextSnapshot => ({
  model: 'test-model',
  contextWindow: 1_000,
  reportedTokens: null,
  systemPrompt: '',
  tools: [],
  messages: [],
  compactAtTokens: null,
  ...over,
});

/** A conversation with something in every category: 100 system, 35 tool schemas, 20 user, 14 assistant
 *  (40 text chars + the `Bash` call's 16), 55 tool output and 4 injected — 228 estimated in a 1k window. */
const populated = (): ContextSnapshot => snapshot({
  systemPrompt: 'S'.repeat(400),
  tools: [
    { name: 'Bash', description: 'd'.repeat(96) },   // 100 chars → 25
    { name: 'Read', description: 'd'.repeat(36) },   //  40 chars → 10
  ],
  messages: [
    user(80),                                        // 20
    assistant(40, [{ name: 'Bash', arguments: { cmd: 'ls' } }]), // (40 + 4 + 12) / 4 → 14
    toolResult('Bash', 200),                         // 50
    toolResult('Read', 20),                          //  5
    custom(16),                                      //  4
  ],
});

describe('context breakdown — categories', () => {
  it('measures every category and sums them into the estimated total', () => {
    const result = buildContextBreakdown(populated());

    expect(result.categories.map((c) => [c.id, c.tokens])).toEqual([
      ['system', 100], ['tools', 35], ['user', 20], ['assistant', 14], ['toolResults', 55], ['other', 4],
    ]);
    // The window is 1k, so each share is the token count divided by ten (floating point, hence closeTo).
    for (const category of result.categories) expect(category.percent).toBeCloseTo(category.tokens / 10);
    expect(result.categories.reduce((total, c) => total + c.tokens, 0)).toBe(result.estimatedTokens);
    expect(result.estimatedTokens).toBe(228);
    expect(result.percent).toBeCloseTo(22.8);
  });

  it('accounts for the rest of the window as free space', () => {
    const result = buildContextBreakdown(populated());
    expect(result.free).toEqual({ tokens: 772, percent: 77.2 });
    expect(result.free.tokens + result.estimatedTokens).toBe(result.contextWindow);
  });

  it('never reports negative free space when the estimate overshoots the window', () => {
    const result = buildContextBreakdown(snapshot({ contextWindow: 10, systemPrompt: 'S'.repeat(400) }));
    expect(result.estimatedTokens).toBe(100);
    expect(result.free).toEqual({ tokens: 0, percent: 0 });
  });

  it('omits a category with no data instead of emitting a zero-width bar', () => {
    const result = buildContextBreakdown(snapshot({ tools: [{ name: 'Read', description: 'd'.repeat(36) }] }));
    expect(result.categories).toEqual([{ id: 'tools', tokens: 10, percent: 1 }]);
  });

  it('keeps the provider count and the compaction threshold as reported, never blended into the estimate', () => {
    const result = buildContextBreakdown(snapshot({ reportedTokens: 4_321, compactAtTokens: 800, systemPrompt: 'S'.repeat(400) }));
    expect(result.reportedTokens).toBe(4_321);
    expect(result.compactAtTokens).toBe(800);
    expect(result.estimatedTokens).toBe(100);
  });
});

describe('resident context ownership', () => {
  it('keeps Anthropic hosted-search status stable across cumulative usage spikes', () => {
    let cumulative = 478_000;
    const session = {
      model: { contextWindow: 1_000_000 },
      systemPrompt: 's'.repeat(400_000),
      getAllTools: () => [],
      getActiveToolNames: () => [],
      messages: [user(240_000)],
      getContextUsage: () => ({ tokens: cumulative, contextWindow: 1_000_000, percent: cumulative / 10_000 }),
    } as unknown as AgentSession;
    useLocalResidentContextEstimate(session);

    expect(residentContextUsageOf(session)).toEqual({ tokens: 160_000, contextWindow: 1_000_000, percent: 16 });
    cumulative = 254_000;
    expect(residentContextUsageOf(session)).toEqual({ tokens: 160_000, contextWindow: 1_000_000, percent: 16 });
  });

  it('includes raw hosted blocks omitted from PI message content', () => {
    const hosted = { type: 'server_tool_use', id: 'srv_1', name: 'tool_search', input: { query: 'x' } };
    const message = assistant(0) as ContextMessage & { anthropicHostedToolReplay: unknown };
    message.anthropicHostedToolReplay = { v: 1, content: [hosted] };
    const result = buildContextBreakdown(snapshot({ messages: [message] }));
    const expected = Math.ceil(JSON.stringify(hosted).length / 4);
    expect(result.estimatedTokens).toBe(expected);
    expect(result.categories).toEqual([{ id: 'assistant', tokens: expected, percent: expected / 10 }]);
  });

  it('retains provider-backed context usage for ordinary sessions', () => {
    const session = {
      getContextUsage: () => ({ tokens: 123_456, contextWindow: 200_000, percent: 61.728 }),
    } as unknown as AgentSession;
    expect(residentContextUsageOf(session)).toEqual({ tokens: 123_456, contextWindow: 200_000, percent: 61.728 });
  });
});

describe('context breakdown — empty session', () => {
  it('degrades to zeroes rather than dividing by an unknown window', () => {
    const result = buildContextBreakdown(snapshot({ contextWindow: 0 }));
    expect(result).toMatchObject({
      estimatedTokens: 0,
      percent: 0,
      categories: [],
      tools: [],
      free: { tokens: 0, percent: 0 },
      reportedTokens: null,
      compactAtTokens: null,
    });
  });
});

describe('context breakdown — tool ranking', () => {
  it('ranks tools by their total cost, largest first', () => {
    const result = buildContextBreakdown(populated());
    expect(result.tools.map((tool) => tool.name)).toEqual(['Bash', 'Read']);
    expect(result.tools[0]).toEqual({
      name: 'Bash', schemaTokens: 25, callTokens: 4, resultTokens: 50, tokens: 79, percent: 7.9, active: true,
    });
    expect(result.tools[1]).toMatchObject({ name: 'Read', schemaTokens: 10, callTokens: 0, resultTokens: 5, tokens: 15 });
  });

  it('breaks a tie on the name so the order is stable between reads', () => {
    const result = buildContextBreakdown(snapshot({
      messages: [toolResult('zebra', 40), toolResult('alpha', 40)],
    }));
    expect(result.tools.map((tool) => tool.name)).toEqual(['alpha', 'zebra']);
  });

  it('still lists a tool whose schema is no longer advertised — its output occupies the window', () => {
    const result = buildContextBreakdown(snapshot({
      tools: [{ name: 'Read', description: 'd'.repeat(36) }],
      messages: [toolResult('WebFetch', 400)],
    }));
    expect(result.tools.map((tool) => [tool.name, tool.active, tool.schemaTokens])).toEqual([
      ['WebFetch', false, 0],
      ['Read', true, 10],
    ]);
  });

  it('leaves a tool that costs nothing out of the ranking', () => {
    const result = buildContextBreakdown(snapshot({ tools: [{ name: '' }], messages: [user(80)] }));
    expect(result.tools).toEqual([]);
  });
});
